import type { Handler, HandlerContext } from "./webhooks";

type Money = { amount: string; currency: string };
type Obj = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : null);
const money = (v: unknown) => (v && typeof v === "object" && "amount" in v ? (v as Money) : null);
const ref = (o: Obj, key: string) => str(o[`${key}_id`]) ?? str((o[key] as Obj | undefined)?.id);

/** The Ledgerly order a payment belongs to: our metadata first, then the checkout id. */
async function findOrder({ tx }: HandlerContext, payment: Obj) {
  const meta = (payment.metadata ?? {}) as Obj;
  const orderId = str(meta.ledgerly_order_id);
  const checkoutId = str(payment.checkout_configuration_id);
  const paymentId = str(payment.id);
  const [order] = await tx`
    select * from orders
    where (${orderId}::uuid is not null and id = ${orderId}::uuid)
       or (${checkoutId}::text is not null and checkout_configuration_id = ${checkoutId})
       or (${paymentId}::text is not null and whop_payment_id = ${paymentId})
    limit 1`;
  return order;
}

const paymentSucceeded: Handler = async (ctx) => {
  const { tx, event } = ctx;
  const p = event.data;
  const order = await findOrder(ctx, p);
  if (!order) return; // not a Ledgerly order (e.g. a top-up); recorded in webhook_events only

  // Forward-only: a late or replayed payment.succeeded must never undo a refund or dispute.
  await tx`
    update orders set whop_payment_id = ${str(p.id)}, updated_at = now(),
      status = case when status in ('pending', 'failed') then 'paid' else status end
    where id = ${order.id}`;

  // Direct charges land on the seller's account, so the seller's ledger mirrors their Whop
  // balance: the sale, Ledgerly's fee, and Whop's processing fees (taken from Whop's own
  // amount_after_fees, never recomputed). Platform orders land on Ledgerly; the seller's
  // ledger moves when the transfer completes.
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

const paymentFailed: Handler = async (ctx) => {
  const order = await findOrder(ctx, ctx.event.data);
  if (!order || order.status !== "pending") return;
  await ctx.tx`update orders set status = 'failed', updated_at = now() where id = ${order.id}`;
};

const refundCreated: Handler = async ({ tx, event }) => {
  const r = event.data;
  const paymentId = ref(r, "payment");
  if (!paymentId || !str(r.id)) return;
  const [order] = await tx`select * from orders where whop_payment_id = ${paymentId}`;
  if (!order) return;
  const amount = Number(money(r.amount)?.amount ?? r.amount ?? 0);

  // Record each refund once; only a genuinely new refund moves the order.
  const inserted = await tx`
    insert into refunds (whop_refund_id, order_id, amount, currency)
    values (${str(r.id)}, ${order.id}, ${amount}, ${order.currency})
    on conflict (whop_refund_id) do nothing
    returning whop_refund_id`;
  if (inserted.length === 0) return;

  await tx`
    update orders set
      refunded_amount = (select coalesce(sum(amount), 0) from refunds where order_id = ${order.id}),
      status = case when (select coalesce(sum(amount), 0) from refunds where order_id = ${order.id}) >= amount
                    then 'refunded' else 'partially_refunded' end,
      updated_at = now()
    where id = ${order.id}`;

  if (order.flow === "direct") {
    await tx`
      insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
      values (${`refund:${r.id}`}, ${order.seller_external_id}, 'refund', ${-amount}, ${order.currency}, ${str(r.id)},
              ${str(r.created_at) ?? event.timestamp})
      on conflict (entry_key) do nothing`;
  }
};

/**
 * Whop sends transfer.completed once per participant (origin and destination), with different
 * webhook ids. Business effects key on the transfer id, so the second delivery is a no-op.
 */
const transferCompleted: Handler = async ({ tx, event }) => {
  const t = event.data;
  const id = str(t.id);
  const key = str(((t.metadata ?? {}) as Obj).ledgerly_transfer_key);
  if (!id) return;
  const [row] = await tx`
    update seller_transfers set status = 'completed', whop_transfer_id = ${id}, updated_at = now()
    where whop_transfer_id = ${id} or (${key}::text is not null and idempotence_key = ${key})
    returning *`;
  if (!row) return; // not a Ledgerly seller transfer
  await tx`
    insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
    values (${`transfer:${id}`}, ${row.seller_external_id}, 'transfer_in', ${Number(row.amount)}, ${row.currency}, ${id},
            ${str(t.created_at) ?? event.timestamp})
    on conflict (entry_key) do nothing`;
};

const FAILED_PAYOUT = new Set(["failed", "canceled", "denied", "reversed"]);

/**
 * payout.created / payout.updated (and legacy withdrawal.*, which carry the same wdrl_ id).
 * Whop sends several updates per payout, sometimes identical apart from the webhook id, and
 * doesn't guarantee order. So: one row per payout, only move forward in event time, and post
 * to the ledger once per payout (plus once more if it fails and the money comes back).
 */
const payoutEvent: Handler = async ({ tx, event, accountId, sellerExternalId }) => {
  const p = event.data;
  const id = str(p.id);
  if (!id) return;
  const status = str(p.status) ?? "unknown";
  const amount = Number(p.amount ?? 0);
  const currency = str(p.currency) ?? "usd";
  const at = event.timestamp;

  await tx`
    insert into payouts (whop_payout_id, seller_external_id, whop_account_id, status, status_detail, amount, currency,
                         fee_amount, net_amount, last_event_at)
    values (${id}, ${sellerExternalId}, ${accountId ?? ""}, ${status}, ${str(p.status_detail)}, ${amount}, ${currency},
            ${p.fee_amount == null ? null : Number(p.fee_amount)}, ${p.net_amount == null ? null : Number(p.net_amount)}, ${at})
    on conflict (whop_payout_id) do update set
      status = excluded.status, status_detail = excluded.status_detail, fee_amount = excluded.fee_amount,
      net_amount = excluded.net_amount, last_event_at = excluded.last_event_at, updated_at = now()
    where payouts.last_event_at < excluded.last_event_at`;

  if (!sellerExternalId) return; // payouts by Ledgerly itself aren't seller ledger movements
  await tx`
    insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
    values (${`payout:${id}`}, ${sellerExternalId}, 'payout', ${-amount}, ${currency}, ${id}, ${str(p.created_at) ?? at})
    on conflict (entry_key) do nothing`;
  if (FAILED_PAYOUT.has(status)) {
    await tx`
      insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
      values (${`payout:${id}:reversal`}, ${sellerExternalId}, 'payout_reversal', ${amount}, ${currency}, ${id}, ${at})
      on conflict (entry_key) do nothing`;
  }
};

/** account.updated: mirror status (e.g. suspended) onto our seller row. */
const accountUpdated: Handler = async ({ tx, event }) => {
  const a = event.data;
  const id = str(a.id);
  if (!id) return;
  await tx`update sellers set whop_status = ${str(a.status)}, updated_at = now() where whop_account_id = ${id}`;
};

export const handlers: Partial<Record<string, Handler>> = {
  "payment.succeeded": paymentSucceeded,
  "payment.failed": paymentFailed,
  "refund.created": refundCreated,
  "transfer.completed": transferCompleted,
  "payout.created": payoutEvent,
  "payout.updated": payoutEvent,
  "withdrawal.created": payoutEvent,
  "withdrawal.updated": payoutEvent,
  "account.updated": accountUpdated,
};
