import { DeferredEvent } from "./errors";
import type { Handler, Tx } from "./webhooks";

/**
 * Business effects of each Whop event. Every handler:
 *  - runs inside the event's transaction and never calls Whop;
 *  - keys its effects on the Whop object (payment, refund, transfer, payout, dispute id), so a
 *    duplicate delivery under another webhook id changes nothing;
 *  - only moves state forward, with the transition guarded in the SQL itself;
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
    update orders set
      refunded_amount = (select coalesce(sum(amount), 0) from refunds where order_id = ${order.id} and booked_at is not null),
      status = case
        when status = 'disputed' then status
        when (select coalesce(sum(amount), 0) from refunds where order_id = ${order.id} and booked_at is not null) >= amount
          then 'refunded'
        else 'partially_refunded' end,
      updated_at = now()
    where id = ${order.id}`;

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
 * dispute.created / dispute.updated. An open dispute holds the order: not deliverable, and no
 * seller share is paid out (settlement only pays 'paid' orders). A won dispute releases it.
 * Whop's dispute debits and fees are left to reconciliation (they show as a balance diff).
 */
const disputeEvent: Handler = async ({ tx, event }) => {
  const d = event.data;
  const disputeId = str(d.id);
  const paymentId = ref(d, "payment");
  if (!disputeId || !paymentId) return;
  const order = await lockOrderByPaymentId(tx, paymentId);
  if (!order) throw new DeferredEvent(`payment ${paymentId} not known yet`);

  const status = str(d.status) ?? "open";
  await tx`
    insert into disputes (whop_dispute_id, order_id, status, amount, currency)
    values (${disputeId}, ${order.id}, ${status}, ${Number(money(d.amount)?.amount ?? d.amount ?? 0)}, ${order.currency})
    on conflict (whop_dispute_id) do update set status = excluded.status, updated_at = now()`;

  if (status === "won") {
    await tx`
      update orders set status = 'paid', updated_at = now()
      where id = ${order.id} and status = 'disputed'
        and not exists (select 1 from disputes where order_id = ${order.id} and status <> 'won')`;
  } else {
    await tx`
      update orders set status = 'disputed', updated_at = now()
      where id = ${order.id} and status in ('paid', 'partially_refunded')`;
  }
};

// ── Transfers ───────────────────────────────────────────────────────────────────────────────

/**
 * transfer.completed / transfer.failed. Whop sends one per participant (origin and
 * destination) under different webhook ids; effects key on the transfer id.
 */
const transferCompleted: Handler = async ({ tx, event }) => {
  const t = event.data;
  const id = str(t.id);
  const key = str(((t.metadata ?? {}) as Obj).ledgerly_transfer_key);
  if (!id) return;
  const [row] = await tx`
    update seller_transfers set status = 'completed', whop_transfer_id = ${id}, whop_status = ${str(t.status)}, updated_at = now()
    where whop_transfer_id = ${id} or (${key}::text is not null and idempotence_key = ${key})
    returning *`;
  if (!row) return; // not a Ledgerly seller transfer
  await tx`
    insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
    values (${`transfer:${id}`}, ${row.seller_external_id}, 'transfer_in', ${Number(row.amount)}, ${row.currency}, ${id},
            ${str(t.created_at) ?? event.timestamp})
    on conflict (entry_key) do nothing`;
};

const transferFailed: Handler = async ({ tx, event }) => {
  const t = event.data;
  const id = str(t.id);
  const key = str(((t.metadata ?? {}) as Obj).ledgerly_transfer_key);
  if (!id) return;
  // A transfer can fail and later succeed under the same id; completed always wins.
  await tx`
    update seller_transfers set status = 'failed', whop_transfer_id = ${id}, whop_status = ${str(t.status)}, updated_at = now()
    where (whop_transfer_id = ${id} or (${key}::text is not null and idempotence_key = ${key})) and status <> 'completed'`;
};

// ── Payouts ─────────────────────────────────────────────────────────────────────────────────

const payoutEvent: Handler = ({ tx, event, accountId, sellerExternalId }) =>
  applyPayout(tx, event.data, event.timestamp, accountId, sellerExternalId);

/**
 * Upsert one payout (payout.* and legacy withdrawal.*, which share the wdrl_ id) and keep the
 * seller's ledger in step. Used by the webhook and by reconciliation repair, because Whop
 * doesn't always send a webhook for the final state.
 *
 *  - The row only moves to a newer state (event time); a stale event changes nothing.
 *  - The withdrawal itself is posted once per payout.
 *  - A reversal is posted only when Whop says the money came back (status reversed, or
 *    failure.funds_returned_at set), never just because the status reads "failed".
 */
export async function applyPayout(tx: Tx, p: Obj, at: string, accountId: string | null, sellerExternalId: string | null) {
  const id = str(p.id);
  if (!id) return;
  const status = str(p.status) ?? "unknown";
  const amount = Number(p.amount ?? 0);
  const currency = str(p.currency) ?? "usd";

  const accepted = await tx`
    insert into payouts (whop_payout_id, seller_external_id, whop_account_id, status, status_detail, amount, currency,
                         fee_amount, net_amount, last_event_at)
    values (${id}, ${sellerExternalId}, ${accountId ?? ""}, ${status}, ${str(p.status_detail)}, ${amount}, ${currency},
            ${p.fee_amount == null ? null : Number(p.fee_amount)}, ${p.net_amount == null ? null : Number(p.net_amount)}, ${at})
    on conflict (whop_payout_id) do update set
      status = excluded.status, status_detail = excluded.status_detail, amount = excluded.amount,
      fee_amount = excluded.fee_amount, net_amount = excluded.net_amount, last_event_at = excluded.last_event_at, updated_at = now()
    where payouts.last_event_at < excluded.last_event_at
    returning whop_payout_id`;
  if (accepted.length === 0 || !sellerExternalId) return;

  await tx`
    insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
    values (${`payout:${id}`}, ${sellerExternalId}, 'payout', ${-amount}, ${currency}, ${id}, ${str(p.created_at) ?? at})
    on conflict (entry_key) do nothing`;

  const fundsReturned = status === "reversed" || Boolean(str(((p.failure ?? {}) as Obj).funds_returned_at));
  if (fundsReturned) {
    await tx`
      insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
      values (${`payout:${id}:reversal`}, ${sellerExternalId}, 'payout_reversal', ${amount}, ${currency}, ${id}, ${at})
      on conflict (entry_key) do nothing`;
  }
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
  "transfer.completed": transferCompleted,
  "transfer.failed": transferFailed,
  "payout.created": payoutEvent,
  "payout.updated": payoutEvent,
  "withdrawal.created": payoutEvent,
  "withdrawal.updated": payoutEvent,
  "account.updated": accountUpdated,
};
