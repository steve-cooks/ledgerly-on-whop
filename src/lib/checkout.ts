import { z } from "zod";
import { sql } from "./db";
import { env } from "./env";
import { whop } from "./whop";

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
