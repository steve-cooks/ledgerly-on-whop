import { DeferredEvent } from "./errors";
import { applyTransferState } from "./transfers";
import type { Handler, Tx } from "./webhooks";

/**
 * Business effects of each Whop event. Every handler:
 *  - runs inside the event's transaction and never calls Whop;
 *  - keys its effects on the Whop object (payment, refund, transfer, payout, dispute id), so a
 *    duplicate delivery under another webhook id changes nothing;
 *  - only moves state forward, with the transition guarded in the SQL itself, or derives the
 *    state from canonical rows (an order's refunds and disputes);
 *  - throws DeferredEvent when the event's subject isn't known yet (it is retried later).
 */

type Money = { amount: string; currency: string };
type Obj = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : null);
const money = (v: unknown) => (v && typeof v === "object" && "amount" in v ? (v as Money) : null);
const ref = (o: Obj, key: string) => str(o[`${key}_id`]) ?? str((o[key] as Obj | undefined)?.id);

/** The Ledgerly order a payment belongs to: our metadata first, then the checkout id. Locked. */
async function findOrderForPayment(tx: Tx, payment: Obj) {
  const meta = (payment.metadata ?? {}) as Obj;
  const orderId = str(meta.ledgerly_order_id);
  const checkoutId = str(payment.checkout_configuration_id);
  const paymentId = str(payment.id);
  const [order] = await tx`
    select * from orders
    where (${orderId}::uuid is not null and id = ${orderId}::uuid)
       or (${checkoutId}::text is not null and checkout_configuration_id = ${checkoutId})
       or (${paymentId}::text is not null and whop_payment_id = ${paymentId})
    limit 1
    for update`;
  return order;
}

/** The order for an object that only references a payment id (refunds, disputes). Locked. */
async function lockOrderByPaymentId(tx: Tx, paymentId: string) {
  const [order] = await tx`select * from orders where whop_payment_id = ${paymentId} for update`;
  return order;
}

// Dispute statuses that no longer hold the order. Every other status (needs_response,
// under_review, their warning_ variants, lost) keeps it held.
const RELEASED_DISPUTE_SQL = "('won', 'prevented', 'warning_closed')";

/**
 * Derive a paid order's status from its canonical facts instead of from the last event: any
 * unreleased dispute holds it; otherwise booked refunds decide. Orders that were never paid
 * are left alone.
 */
async function refreshOrderStatus(tx: Tx, orderId: string) {
  await tx.unsafe(
    `update orders o set updated_at = now(), status = case
       when exists (select 1 from disputes d where d.order_id = o.id and d.status not in ${RELEASED_DISPUTE_SQL}) then 'disputed'
       when o.refunded_amount >= o.amount then 'refunded'
       when o.refunded_amount > 0 then 'partially_refunded'
       else 'paid' end
     where o.id = $1 and o.status not in ('pending', 'failed')`,
    [orderId],
  );
}

// ── Payments ────────────────────────────────────────────────────────────────────────────────

const paymentSucceeded: Handler = async ({ tx, event }) => {
  const p = event.data;
  const order = await findOrderForPayment(tx, p);
  if (!order) return; // not a Ledgerly order (e.g. a top-up): recorded in webhook_events only

  // Forward-only: a late or replayed payment.succeeded must never undo a refund or dispute.
  await tx`
    update orders set whop_payment_id = ${str(p.id)}, updated_at = now(),
      status = case when status in ('pending', 'failed') then 'paid' else status end
    where id = ${order.id}`;
  await refreshOrderStatus(tx, order.id);

  // Direct charges land on the seller's account, so the seller's ledger mirrors their Whop
  // balance: the sale, Ledgerly's fee, and Whop's processing fees (from Whop's own
  // amount_after_fees, never recomputed). Platform orders land on Ledgerly; the seller's ledger
  // moves when their transfer completes.
  if (order.flow === "direct") {
    const at = str(p.paid_at) ?? event.timestamp;
    const gross = Number(money(p.total)?.amount ?? order.amount);
    const net = Number(money(p.amount_after_fees)?.amount ?? gross - Number(order.platform_fee));
    const whopFees = Math.round((gross - net - Number(order.platform_fee)) * 100) / 100;
    await tx`
      insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
      values
        (${`payment:${p.id}:sale`}, ${order.seller_external_id}, 'sale', ${gross}, ${order.currency}, ${str(p.id)}, ${at}),
        (${`payment:${p.id}:platform_fee`}, ${order.seller_external_id}, 'platform_fee', ${-Number(order.platform_fee)}, ${order.currency}, ${str(p.id)}, ${at}),
        (${`payment:${p.id}:processing_fee`}, ${order.seller_external_id}, 'processing_fee', ${-whopFees}, ${order.currency}, ${str(p.id)}, ${at})
      on conflict (entry_key) do nothing`;
  }
};

const paymentFailed: Handler = async ({ tx, event }) => {
  const order = await findOrderForPayment(tx, event.data);
  if (!order) return;
  // The guard is in the UPDATE, so a success committed in between is never overwritten.
  await tx`update orders set status = 'failed', updated_at = now() where id = ${order.id} and status = 'pending'`;
};

// ── Refunds ─────────────────────────────────────────────────────────────────────────────────

/** refund.created / refund.updated. Money moves only when a refund has succeeded, once. */
const refundEvent: Handler = async ({ tx, event }) => {
  const r = event.data;
  const refundId = str(r.id);
  const paymentId = ref(r, "payment");
  if (!refundId || !paymentId) return;
  const order = await lockOrderByPaymentId(tx, paymentId);
  if (!order) throw new DeferredEvent(`payment ${paymentId} not known yet`);

  const amount = Number(money(r.amount)?.amount ?? r.amount ?? 0);
  const status = str(r.status) ?? "succeeded";
  await tx`
    insert into refunds (whop_refund_id, order_id, amount, currency, status)
    values (${refundId}, ${order.id}, ${amount}, ${order.currency}, ${status})
    on conflict (whop_refund_id) do update set status = excluded.status`;
  if (status !== "succeeded") return;

  const booked = await tx`
    update refunds set booked_at = now() where whop_refund_id = ${refundId} and booked_at is null returning amount`;
  if (booked.length === 0) return; // already applied

  // The order row is locked, so concurrent refunds on one order apply one at a time.
  await tx`
    update orders set updated_at = now(),
      refunded_amount = (select coalesce(sum(amount), 0) from refunds where order_id = ${order.id} and booked_at is not null)
    where id = ${order.id}`;
  await refreshOrderStatus(tx, order.id);

  if (order.flow === "direct") {
    await tx`
      insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
      values (${`refund:${refundId}`}, ${order.seller_external_id}, 'refund', ${-amount}, ${order.currency}, ${refundId},
              ${str(r.created_at) ?? event.timestamp})
      on conflict (entry_key) do nothing`;
  }
};

// ── Disputes ────────────────────────────────────────────────────────────────────────────────

/**
 * dispute.created / dispute.updated. An unreleased dispute holds the order: not deliverable,
 * and no seller share is paid out (settlement only pays 'paid' orders). Events apply in source
 * order, so a replayed older event can't reopen a dispute that was won. Once released, the
 * order's status comes from its refunds again, so a refund during the dispute still counts.
 * Whop's dispute debits and fees are left to reconciliation (they show as a balance diff).
 */
const disputeEvent: Handler = async ({ tx, event }) => {
  const d = event.data;
  const disputeId = str(d.id);
  const paymentId = ref(d, "payment");
  if (!disputeId || !paymentId) return;
  const order = await lockOrderByPaymentId(tx, paymentId);
  if (!order) throw new DeferredEvent(`payment ${paymentId} not known yet`);

  const status = str(d.status) ?? "needs_response";
  const at = str(d.updated_at) ?? event.timestamp;
  await tx`
    insert into disputes (whop_dispute_id, order_id, status, amount, currency, source_updated_at)
    values (${disputeId}, ${order.id}, ${status}, ${Number(money(d.amount)?.amount ?? d.amount ?? 0)}, ${order.currency}, ${at})
    on conflict (whop_dispute_id) do update set
      status = excluded.status, amount = excluded.amount, source_updated_at = excluded.source_updated_at, updated_at = now()
    where disputes.source_updated_at is null or disputes.source_updated_at < excluded.source_updated_at`;
  await refreshOrderStatus(tx, order.id);
};

// ── Transfers ───────────────────────────────────────────────────────────────────────────────

/**
 * transfer.completed / transfer.failed. Whop sends one per participant (origin and
 * destination) under different webhook ids; applyTransferState keys on the transfer id and
 * only moves forward, so the second copy changes nothing.
 */
const transferEvent =
  (whopStatus: "succeeded" | "failed"): Handler =>
  async ({ tx, event }) => {
    const t = event.data;
    const id = str(t.id);
    if (!id) return;
    const key = str(((t.metadata ?? {}) as Obj).ledgerly_transfer_key);
    await applyTransferState(tx, { id, key, whopStatus, at: str(t.created_at) ?? event.timestamp });
  };

// ── Payouts ─────────────────────────────────────────────────────────────────────────────────

const payoutEvent: Handler = ({ tx, event, accountId, sellerExternalId }) =>
  applyPayout(tx, event.data, event.timestamp, accountId, sellerExternalId);

// Payouts in these states took nothing out of the seller's balance in the end.
const NOT_PAID_OUT = new Set(["denied", "canceled", "reversed"]);

/** What a payout has taken from the seller's balance, given its current state (pure). */
export function payoutDebit(p: { status: string; amount: number; fundsReturnedAt?: string | null }) {
  if (p.fundsReturnedAt || NOT_PAID_OUT.has(p.status)) return 0;
  return p.amount;
}

/**
 * Upsert one payout (payout.* and legacy withdrawal.*, which share the wdrl_ id) and keep the
 * seller's ledger in step. Used by the webhook and by reconciliation repair, because Whop
 * doesn't always send a webhook for the final state.
 *
 *  - The row only moves to a newer state (`at`); a stale event changes nothing.
 *  - The ledger holds what the payout has taken from the balance in its current state
 *    (payoutDebit): the amount while it's on its way or paid, nothing once denied, canceled,
 *    reversed or returned. A change posts the difference as an adjustment, so a changed
 *    amount or a denied payout never leaves a stale debit.
 */
export async function applyPayout(tx: Tx, p: Obj, at: string, accountId: string | null, sellerExternalId: string | null) {
  const id = str(p.id);
  if (!id) return;
  const status = str(p.status) ?? "unknown";
  const amount = Number(p.amount ?? 0);
  const currency = str(p.currency) ?? "usd";

  // The upsert also locks the payout row, so two events for one payout post one at a time.
  const accepted = await tx`
    insert into payouts (whop_payout_id, seller_external_id, whop_account_id, status, status_detail, amount, currency,
                         fee_amount, net_amount, last_event_at, updated_at)
    values (${id}, ${sellerExternalId}, ${accountId ?? ""}, ${status}, ${str(p.status_detail)}, ${amount}, ${currency},
            ${p.fee_amount == null ? null : Number(p.fee_amount)}, ${p.net_amount == null ? null : Number(p.net_amount)}, ${at}, clock_timestamp())
    on conflict (whop_payout_id) do update set
      status = excluded.status, status_detail = excluded.status_detail, amount = excluded.amount,
      fee_amount = excluded.fee_amount, net_amount = excluded.net_amount, last_event_at = excluded.last_event_at,
      updated_at = clock_timestamp() -- wall-clock write time; payout repair compares against it
    where payouts.last_event_at < excluded.last_event_at
    returning whop_payout_id`;
  if (accepted.length === 0 || !sellerExternalId) return;

  const target = -payoutDebit({ status, amount, fundsReturnedAt: str(((p.failure ?? {}) as Obj).funds_returned_at) });
  const [posted] = await tx`
    select coalesce(sum(amount), 0)::numeric as total, count(*)::int as n from ledger_entries
    where whop_object_id = ${id} and kind in ('payout', 'payout_reversal')`;
  const deltaCents = Math.round(target * 100) - Math.round(Number(posted.total) * 100);
  if (deltaCents === 0) return;
  const first = posted.n === 0;
  await tx`
    insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
    values (${first ? `payout:${id}` : `payout:${id}:adj-${posted.n}`}, ${sellerExternalId},
            ${deltaCents < 0 ? "payout" : "payout_reversal"}, ${deltaCents / 100}, ${currency}, ${id},
            ${first ? (str(p.created_at) ?? at) : at})
    on conflict (entry_key) do nothing`;
}

// ── Accounts ────────────────────────────────────────────────────────────────────────────────

/** account.updated: mirror status (e.g. suspended) onto our seller row. */
const accountUpdated: Handler = async ({ tx, event }) => {
  const id = str(event.data.id);
  if (!id) return;
  await tx`update sellers set whop_status = ${str(event.data.status)}, updated_at = now() where whop_account_id = ${id}`;
};

export const handlers: Partial<Record<string, Handler>> = {
  "payment.succeeded": paymentSucceeded,
  "payment.failed": paymentFailed,
  "refund.created": refundEvent,
  "refund.updated": refundEvent,
  "dispute.created": disputeEvent,
  "dispute.updated": disputeEvent,
  "transfer.completed": transferEvent("succeeded"),
  "transfer.failed": transferEvent("failed"),
  "payout.created": payoutEvent,
  "payout.updated": payoutEvent,
  "withdrawal.created": payoutEvent,
  "withdrawal.updated": payoutEvent,
  "account.updated": accountUpdated,
};
