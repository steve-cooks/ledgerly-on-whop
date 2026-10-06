// Part 1 · Step 3d: transfer flow. Sell on Ledgerly's own account; the seller's share is
// transferred automatically when payment.succeeded arrives.
//   pnpm tsx examples/assessment/scripts/03d-platform-checkout.ts
import "../../../scripts/_setup";
import { createCheckout } from "@/lib/checkout";
import { sql } from "@/lib/db";
import { saveEvidence } from "./_evidence";

async function main() {
  const order = await createCheckout({
    sellerExternalId: "seller_br_batida",
    title: "Batida Vol. 1 Sample Pack",
    sku: "batida-vol-1",
    price: 10,
    currency: "usd",
  });
  saveEvidence("03-transfer/checkout", order);
  console.log(JSON.stringify(order, null, 2));
}
main().finally(() => sql().end());
