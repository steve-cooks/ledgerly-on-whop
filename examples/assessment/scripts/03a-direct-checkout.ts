// Part 1 · Step 3a: direct charge on the US seller with Ledgerly's 8% application fee.
//   pnpm tsx examples/assessment/scripts/03a-direct-checkout.ts
import "../../../scripts/_setup";
import { createDirectCheckout } from "@/lib/checkout";
import { sql } from "@/lib/db";
import { capture, saveEvidence } from "./_evidence";

async function main() {
  const order = await createDirectCheckout({
    sellerExternalId: "seller_us_mira",
    title: "Golden Hour Preset Pack",
    sku: "mira-golden-hour-presets",
    price: 10,
    currency: "usd",
  });
  // Policy check: the platform-only seller must be refused a direct checkout.
  const refused = await capture(() =>
    createDirectCheckout({ sellerExternalId: "seller_br_batida", title: "Batida Vol. 1", sku: "batida-vol-1", price: 10 }),
  );
  saveEvidence("03-direct-charge/checkout", { order, platform_only_seller_refused: refused });
  console.log(JSON.stringify({ order, platform_only_seller_refused: refused }, null, 2));
}

main().finally(() => sql().end());
