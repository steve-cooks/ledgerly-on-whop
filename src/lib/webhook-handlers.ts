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

  await tx`
    update orders set status = 'paid', whop_payment_id = ${str(p.id)}, updated_at = now()
    where id = ${order.id}`;

  // Direct charges land on the seller's account: post the sale and Ledgerly's fee to the seller.
  // Platform orders land on Ledgerly; the seller's ledger moves when the transfer completes.
  if (order.flow === "direct") {
    const at = str(p.paid_at) ?? event.timestamp;
    const total = money(p.total);
    const amount = total ? Number(total.amount) : Number(order.amount);
    await tx`
      insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
      values
        (${`payment:${p.id}:sale`}, ${order.seller_external_id}, 'sale', ${amount}, ${order.currency}, ${str(p.id)}, ${at}),
        (${`payment:${p.id}:platform_fee`}, ${order.seller_external_id}, 'platform_fee', ${-Number(order.platform_fee)}, ${order.currency}, ${str(p.id)}, ${at})
      on conflict (entry_key) do nothing`;
  }
};

const paymentFailed: Handler = async (ctx) => {
  const order = await findOrder(ctx, ctx.event.data);
  if (!order || order.status !== "pending") return;
  await ctx.tx`update orders set status = 'failed', updated_at = now() where id = ${order.id}`;
};

const refundCreated: Handler = async (ctx) => {
  const { tx, event } = ctx;
  const r = event.data;
  const paymentId = ref(r, "payment");
  if (!paymentId) return;
  const [order] = await tx`select * from orders where whop_payment_id = ${paymentId}`;
  if (!order) return;

  const amount = Number(money(r.amount)?.amount ?? r.amount ?? 0);
  const refunded = Number(order.refunded_amount) + amount;
  const status = refunded >= Number(order.amount) ? "refunded" : "partially_refunded";
  await tx`update orders set refunded_amount = ${refunded}, status = ${status}, updated_at = now() where id = ${order.id}`;

  if (order.flow === "direct") {
    await tx`
      insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
      values (${`refund:${r.id}`}, ${order.seller_external_id}, 'refund', ${-amount}, ${order.currency}, ${str(r.id)},
              ${str(r.created_at) ?? event.timestamp})
      on conflict (entry_key) do nothing`;
  }
};

export const handlers: Partial<Record<string, Handler>> = {
  "payment.succeeded": paymentSucceeded,
  "payment.failed": paymentFailed,
  "refund.created": refundCreated,
};
