import { z } from "zod";
import { sql } from "./db";
import { env } from "./env";
import { ConflictError } from "./errors";
import { whop } from "./whop";
import { dispatchTransfer, reserveTransfer } from "./transfers";
import { applyDeferredForPayment } from "./webhook-processor";

// Whop's minimum charge and our own ceiling for a single digital good.
const MIN_PRICE = 1;
const MAX_PRICE = 10_000;
// USD only for now: settlement, transfers and reconciliation are USD. See HANDOVER.md before
// adding EUR/BRL (reconciliation has to become per-currency first).
const CURRENCIES = ["usd"] as const;

export const CheckoutInput = z.object({
  sellerExternalId: z.string().min(1),
  title: z.string().min(1).max(100),
  // Stable id of the item in Ledgerly's catalog; Whop finds-or-creates the product by it.
  sku: z.string().regex(/^[a-z0-9-]{3,80}$/),
  price: z.number().finite().min(MIN_PRICE).max(MAX_PRICE),
  currency: z.enum(CURRENCIES).default("usd"),
  // Ledgerly's own id for this purchase attempt. Retrying with the same key returns the same
  // order and checkout instead of creating a second one.
  requestKey: z.string().min(1).max(200).optional(),
  // The marketplace product this order is for (its file is delivered once the order is paid).
  productId: z.uuid().optional(),
});
export type CheckoutInput = z.input<typeof CheckoutInput>;

/** Integer-cent math so 8% of 10.00 is exactly 0.80, never 0.7999999. */
export function platformFee(price: number, bps = env().PLATFORM_FEE_BPS) {
  const cents = Math.round(price * 100);
  if (Math.abs(cents - price * 100) > 1e-6) throw new Error("price has more than 2 decimals");
  const feeCents = Math.round((cents * bps) / 10_000);
  if (feeCents <= 0) throw new Error("fee rounds to zero; price too low for the take rate");
  if (feeCents >= cents) throw new Error("fee must be less than the price");
  return { price: cents / 100, fee: feeCents / 100, sellerGross: (cents - feeCents) / 100 };
}

/**
 * Create a checkout with Ledgerly's 8%. The flow follows the seller's policy:
 *  - direct: the buyer pays the seller's connected account; Whop takes Ledgerly's fee as an
 *    application fee. The seller is the merchant.
 *  - platform: the buyer pays Ledgerly's account (Ledgerly is the merchant); the seller's share
 *    is transferred after payment (settlePlatformOrder). Sellers on this policy can never be
 *    given a direct checkout by this service.
 */
export async function createCheckout(raw: CheckoutInput) {
  const input = CheckoutInput.parse(raw);
  const db = sql();
  const [seller] = await db`select * from sellers where external_id = ${input.sellerExternalId}`;
  if (!seller?.whop_account_id) throw new Error(`seller ${input.sellerExternalId} is not onboarded`);
  const flow = seller.collection_mode as "direct" | "platform";
  const { price, fee } = platformFee(input.price);

  // Get-or-create in one statement, so two concurrent requests with one key share one order.
  const [created] = await db`
    insert into orders (seller_external_id, flow, title, sku, amount, currency, platform_fee, request_key, product_id)
    values (${seller.external_id}, ${flow}, ${input.title}, ${input.sku}, ${price}, ${input.currency}, ${fee}, ${input.requestKey ?? null}, ${input.productId ?? null})
    on conflict (request_key) do nothing
    returning *`;
  if (created) return finishCheckout(created, seller);

  // The key was used before: it must be the same purchase.
  const [existing] = await db`select * from orders where request_key = ${input.requestKey!}`;
  const same =
    existing.seller_external_id === seller.external_id &&
    existing.title === input.title &&
    (existing.sku ?? input.sku) === input.sku &&
    (existing.product_id ?? null) === (input.productId ?? null) &&
    Math.round(Number(existing.amount) * 100) === Math.round(price * 100) &&
    existing.currency === input.currency;
  if (!same) throw new ConflictError(`requestKey ${input.requestKey} was already used for a different checkout`);
  if (existing.purchase_url) return orderResult(existing);
  // A previous attempt stopped before Whop answered: finish it under the same idempotency key.
  return finishCheckout({ ...existing, sku: existing.sku ?? input.sku }, seller);
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function finishCheckout(order: Row, seller: Row) {
  const direct = order.flow === "direct";
  const accountId: string = direct ? seller.whop_account_id : env().WHOP_PLATFORM_ACCOUNT_ID;
  const externalId = `ledgerly-${order.sku}`;
  // The first sale of a SKU on an account creates its Whop product inline; later ones must
  // reference it by id (re-sending the inline product to a seller's account is refused).
  const productId = await findWhopProduct(accountId, externalId);
  const checkout = await whop().checkoutConfigurations.create(
    {
      account_id: accountId,
      plan: {
        plan_type: "one_time",
        initial_price: Number(order.amount),
        currency: order.currency,
        visibility: "hidden",
        ...(productId ? { product_id: productId } : {}),
        // Legacy fields the current SDK types don't include; Whop still honours them, and
        // product.external_identifier is required alongside product.
        ...({
          ...(productId ? {} : { product: { title: order.title, external_identifier: externalId } }),
          ...(direct ? { application_fee_amount: Number(order.platform_fee) } : {}),
        } as object),
      },
      redirect_url: `${env().APP_URL}/orders/${order.id}`,
      metadata: { ledgerly_order_id: order.id, seller_external_id: seller.external_id, flow: order.flow },
    },
    { idempotencyKey: `ledgerly:checkout:${order.id}` },
  );
  if (!productId) await rememberWhopProduct(accountId, externalId, (checkout as { plan?: { id?: string } }).plan?.id);
  const [saved] = await sql()`
    update orders set checkout_configuration_id = ${checkout.id}, purchase_url = ${checkout.purchase_url ?? null}, updated_at = now()
    where id = ${order.id} returning *`;
  return orderResult(saved);
}

/** Our SKU's Whop product on this account: saved mapping first, then a lookup at Whop. */
async function findWhopProduct(accountId: string, externalId: string): Promise<string | null> {
  const [known] = await sql()`
    select whop_product_id from whop_products where account_id = ${accountId} and external_identifier = ${externalId}`;
  if (known) return known.whop_product_id;
  try {
    let seen = 0;
    for await (const p of await whop().products.list({ account_id: accountId, first: 100 })) {
      const product = p as { id: string; external_identifier?: string | null };
      if (product.external_identifier === externalId) {
        await saveWhopProduct(accountId, externalId, product.id);
        return product.id;
      }
      if (++seen >= 500) break;
    }
  } catch (err) {
    console.error("whop product lookup failed", accountId, (err as Error).message);
  }
  return null;
}

/** After a checkout created the product inline, remember its id. Best effort: a miss is found by lookup next time. */
async function rememberWhopProduct(accountId: string, externalId: string, planId: string | undefined) {
  if (!planId) return;
  try {
    const plan = (await whop().plans.retrieve({ id: planId })) as { product?: { id?: string } | null };
    if (plan.product?.id) await saveWhopProduct(accountId, externalId, plan.product.id);
  } catch (err) {
    console.error("whop product remember failed", accountId, (err as Error).message);
  }
}

async function saveWhopProduct(accountId: string, externalId: string, productId: string) {
  await sql()`
    insert into whop_products (account_id, external_identifier, whop_product_id)
    values (${accountId}, ${externalId}, ${productId})
    on conflict do nothing`;
}

function orderResult(order: Row) {
  return {
    orderId: order.id as string,
    checkoutId: order.checkout_configuration_id as string,
    purchaseUrl: order.purchase_url as string,
    price: Number(order.amount),
    fee: Number(order.platform_fee),
    flow: order.flow as "direct" | "platform",
  };
}

/**
 * Seller's share of a platform-collected sale, under the same fee policy as a direct charge:
 * gross − Whop's processing fees on the payment − Ledgerly's 8%.
 *
 * Excluded: sales tax (collected from the buyer on top of the price and remitted, so it was
 * never the seller's money) and the tax-service fee (a cost of Ledgerly being merchant of
 * record; direct charges don't incur it).
 */
const NOT_SELLER_COSTS = new Set(["application_fee", "sales_tax_remittance", "stripe_sales_tax_fee"]);

type FeeLine = { origin: string; amount: { amount: string } };

/** Pure: the seller's share given Whop's fee lines for the payment. */
export function computeSellerShare(fees: FeeLine[], gross: number, platformFeeAmount: number) {
  const sellerFeeCents = fees
    .filter((f) => !NOT_SELLER_COSTS.has(f.origin) && !f.origin.includes("tax"))
    .reduce((sum, f) => sum + Math.round(Number(f.amount.amount) * 100), 0);
  const shareCents = Math.round(gross * 100) - sellerFeeCents - Math.round(platformFeeAmount * 100);
  return { share: shareCents / 100, sellerFees: sellerFeeCents / 100 };
}

/**
 * Pay the seller what they're owed for a paid platform order, minus what's already confirmed
 * or in flight. Idempotent:
 *  - refunds or disputes already waiting in the inbox for this payment are applied first;
 *  - eligibility is checked and the transfer intent recorded in one transaction, with the
 *    order locked, so a refund or dispute webhook can't slip in between;
 *  - the share is computed once from Whop's fee lines and stored on the order;
 *  - a transfer still in flight blocks a second one;
 *  - a transfer Whop created and then failed blocks too: Whop can retry it to success under
 *    the same id, so a replacement could pay twice. An operator who has confirmed with Whop
 *    that it's dead passes replaceFailed. A request Whop refused outright (no transfer was
 *    created) is retried automatically under a new key.
 */
export async function settlePlatformOrder(orderId: string, opts: { replaceFailed?: boolean } = {}) {
  const db = sql();
  const [order] = await db`select * from orders where id = ${orderId}`;
  if (!order || order.flow !== "platform") throw new Error(`order ${orderId} is not a platform order`);
  if (order.status !== "paid" || !order.whop_payment_id) return { skipped: `order is ${order.status}` };

  const unapplied = await applyDeferredForPayment(order.whop_payment_id);
  if (unapplied > 0) return { skipped: `${unapplied} webhook event(s) for this payment can't be applied yet` };
  const [{ status }] = await db`select status from orders where id = ${order.id}`;
  if (status !== "paid") return { skipped: `order is ${status}` };

  let share = order.seller_share == null ? null : Number(order.seller_share);
  if (share == null) {
    const fees = await whop().payments.listFees({ id: order.whop_payment_id });
    share = computeSellerShare(fees.data, Number(order.amount), Number(order.platform_fee)).share;
    await db`update orders set seller_share = ${share}, updated_at = now() where id = ${order.id} and seller_share is null`;
    share = Number((await db`select seller_share from orders where id = ${order.id}`)[0].seller_share);
  }
  if (share <= 0) return { skipped: "nothing left for the seller after fees", share };
  const shareCents = Math.round(share * 100);

  type Step = { done: Record<string, unknown> } | { intent: Row; sentCents: number };
  const step: Step = await db.begin(async (tx): Promise<Step> => {
    const [locked] = await tx`select status from orders where id = ${order.id} for update`;
    if (locked.status !== "paid") return { done: { skipped: `order is ${locked.status}`, share } };
    const transfers = await tx`
      select status, amount, whop_transfer_id from seller_transfers where order_id = ${order.id} and purpose = 'order_share'`;
    if (transfers.some((t) => t.status === "pending")) return { done: { skipped: "a transfer is still in flight", share } };
    const failedAtWhop = transfers.filter((t) => t.status === "failed" && t.whop_transfer_id);
    if (failedAtWhop.length && !opts.replaceFailed) {
      const ids = failedAtWhop.map((t) => t.whop_transfer_id).join(", ");
      return { done: { blocked: `transfer ${ids} failed at Whop and may still succeed; confirm with Whop, then settle with --replace-failed`, share } };
    }
    const sentCents = transfers
      .filter((t) => t.status === "completed")
      .reduce((s, t) => s + Math.round(Number(t.amount) * 100), 0);
    if (sentCents > shareCents) return { done: { overpaid: (sentCents - shareCents) / 100, share } };
    if (sentCents === shareCents) return { done: { skipped: "seller already paid", share } };

    const attempts = transfers.filter((t) => t.status === "failed").length;
    const key =
      sentCents === 0 && attempts === 0
        ? `order:${order.id}:share`
        : `order:${order.id}:share:to-${shareCents}${attempts ? `:attempt-${attempts + 1}` : ""}`;
    const intent = await reserveTransfer(tx, {
      sellerExternalId: order.seller_external_id,
      amount: (shareCents - sentCents) / 100,
      currency: order.currency,
      key,
      purpose: "order_share",
      orderId: order.id,
    });
    return { intent, sentCents };
  });
  if ("done" in step) return step.done;

  const result = await dispatchTransfer(step.intent);
  return { ...result, share, alreadySent: step.sentCents / 100, sentNow: (shareCents - step.sentCents) / 100 };
}
