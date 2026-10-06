import { z } from "zod";
import { sql } from "./db";
import { env } from "./env";
import { whop } from "./whop";
import { transferToSeller } from "./transfers";

// Whop's minimum charge and our own ceiling for a single digital good.
const MIN_PRICE = 1;
const MAX_PRICE = 10_000;
const CURRENCIES = ["usd", "eur", "brl"] as const;

export const CheckoutInput = z.object({
  sellerExternalId: z.string().min(1),
  title: z.string().min(1).max(100),
  // Stable id of the item in Ledgerly's catalog; Whop finds-or-creates the product by it.
  sku: z.string().regex(/^[a-z0-9-]{3,80}$/),
  price: z.number().finite().min(MIN_PRICE).max(MAX_PRICE),
  currency: z.enum(CURRENCIES).default("usd"),
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
 * Direct charge: the buyer pays the seller's connected account and Ledgerly's 8% comes off
 * as an application fee. Sellers on the 'platform' collection mode are refused here; they're
 * only ever paid through Ledgerly-collected payments + transfers.
 */
export async function createDirectCheckout(raw: CheckoutInput) {
  const input = CheckoutInput.parse(raw);
  const db = sql();

  const [seller] = await db`select * from sellers where external_id = ${input.sellerExternalId}`;
  if (!seller?.whop_account_id) throw new Error(`seller ${input.sellerExternalId} is not onboarded`);
  if (seller.collection_mode !== "direct") {
    throw new Error(`seller ${input.sellerExternalId} may not take payments directly`);
  }

  const { price, fee } = platformFee(input.price);

  const [order] = await db`
    insert into orders (seller_external_id, flow, title, amount, currency, platform_fee)
    values (${seller.external_id}, 'direct', ${input.title}, ${price}, ${input.currency}, ${fee})
    returning id`;

  // The current API's inline plan has no application fee or inline product; Whop still accepts
  // the legacy fields (product.external_identifier is required with them).
  const checkout = await whop().checkoutConfigurations.create(
    {
      account_id: seller.whop_account_id,
      plan: {
        plan_type: "one_time",
        initial_price: price,
        currency: input.currency,
        visibility: "hidden",
        // Legacy compatibility fields, not in the SDK's type:
        ...({
          application_fee_amount: fee,
          product: { title: input.title, external_identifier: `ledgerly-${input.sku}` },
        } as object),
      },
      redirect_url: `${env().APP_URL}/orders/${order.id}`,
      metadata: { ledgerly_order_id: order.id, seller_external_id: seller.external_id, flow: "direct" },
    },
    { idempotencyKey: `ledgerly:checkout:${order.id}` },
  );

  await db`update orders set checkout_configuration_id = ${checkout.id}, updated_at = now() where id = ${order.id}`;
  return { orderId: order.id as string, checkoutId: checkout.id, purchaseUrl: checkout.purchase_url, price, fee };
}

/**
 * Platform-collected sale: the buyer pays Ledgerly's own account (Ledgerly is merchant of
 * record) and the seller's share is moved later with a transfer. Used for sellers who may
 * never take payments directly, and works for any seller.
 */
export async function createPlatformCheckout(raw: CheckoutInput) {
  const input = CheckoutInput.parse(raw);
  const db = sql();
  const [seller] = await db`select * from sellers where external_id = ${input.sellerExternalId}`;
  if (!seller?.whop_account_id) throw new Error(`seller ${input.sellerExternalId} is not onboarded`);

  const { price, fee } = platformFee(input.price);
  const [order] = await db`
    insert into orders (seller_external_id, flow, title, amount, currency, platform_fee)
    values (${seller.external_id}, 'platform', ${input.title}, ${price}, ${input.currency}, ${fee})
    returning id`;

  const checkout = await whop().checkoutConfigurations.create(
    {
      account_id: env().WHOP_PLATFORM_ACCOUNT_ID,
      plan: {
        plan_type: "one_time",
        initial_price: price,
        currency: input.currency,
        visibility: "hidden",
        ...({ product: { title: input.title, external_identifier: `ledgerly-${input.sku}` } } as object),
      },
      redirect_url: `${env().APP_URL}/orders/${order.id}`,
      metadata: { ledgerly_order_id: order.id, seller_external_id: seller.external_id, flow: "platform" },
    },
    { idempotencyKey: `ledgerly:checkout:${order.id}` },
  );

  await db`update orders set checkout_configuration_id = ${checkout.id}, updated_at = now() where id = ${order.id}`;
  return { orderId: order.id as string, checkoutId: checkout.id, purchaseUrl: checkout.purchase_url, price, fee };
}

/**
 * Seller's share of a platform-collected sale, at parity with a direct charge:
 * gross - Whop's processing fees on the payment - Ledgerly's 8%.
 *
 * Excluded: sales tax (collected from the buyer on top of the price and remitted, so it was
 * never the seller's money) and the tax-service fee (a cost of Ledgerly being merchant of
 * record; direct charges don't incur it).
 */
const NOT_SELLER_COSTS = new Set(["application_fee", "sales_tax_remittance", "stripe_sales_tax_fee"]);

export async function sellerShare(paymentId: string, gross: number, platformFeeAmount: number) {
  const fees = await whop().payments.listFees({ id: paymentId });
  const sellerFeeCents = fees.data
    .filter((f) => !NOT_SELLER_COSTS.has(f.origin) && !f.origin.includes("tax"))
    .reduce((sum, f) => sum + Math.round(Number(f.amount.amount) * 100), 0);
  const shareCents = Math.round(gross * 100) - sellerFeeCents - Math.round(platformFeeAmount * 100);
  return { share: shareCents / 100, sellerFees: sellerFeeCents / 100, fees: fees.data };
}

/**
 * Pay the seller what they're owed for a paid platform order, minus what's already been sent.
 * Idempotent: the transfer key embeds the target total, so re-running at the same target never
 * pays twice, and a corrected formula produces exactly one adjustment transfer.
 */
export async function settlePlatformOrder(orderId: string) {
  const db = sql();
  const [order] = await db`select * from orders where id = ${orderId}`;
  if (!order || order.flow !== "platform") throw new Error(`order ${orderId} is not a platform order`);
  if (order.status !== "paid" || !order.whop_payment_id) return { skipped: `order is ${order.status}` };

  const { share, sellerFees } = await sellerShare(order.whop_payment_id, Number(order.amount), Number(order.platform_fee));
  const [{ sent }] = await db`
    select coalesce(sum(amount), 0)::numeric as sent from seller_transfers
    where order_id = ${order.id} and whop_transfer_id is not null`;
  const dueCents = Math.round(share * 100) - Math.round(Number(sent) * 100);
  if (dueCents <= 0) return { skipped: "seller already paid", share, sent: Number(sent) };

  const first = Number(sent) === 0;
  const result = await transferToSeller({
    sellerExternalId: order.seller_external_id,
    amount: dueCents / 100,
    currency: order.currency,
    key: first ? `order:${order.id}:share` : `order:${order.id}:share:to-${Math.round(share * 100)}`,
    purpose: "order_share",
    orderId: order.id,
  });
  return { ...result, share, sellerFees, platformFee: Number(order.platform_fee), alreadySent: Number(sent), sentNow: dueCents / 100 };
}
