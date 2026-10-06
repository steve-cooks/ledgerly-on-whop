// Part 1 · Step 3d: transfer flow. Sell on Ledgerly's own account; the seller's share is
// transferred automatically when payment.succeeded arrives.
//   pnpm tsx scripts/part1/03d-platform-checkout.ts
import "../_setup";
import { createPlatformCheckout } from "@/lib/checkout";
import { sql } from "@/lib/db";
import { saveEvidence } from "../_evidence";

async function main() {
  const order = await createPlatformCheckout({
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
