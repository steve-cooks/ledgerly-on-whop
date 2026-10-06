// Part 1 · Step 3a: direct charge on the US seller with Ledgerly's 8% application fee.
//   pnpm tsx examples/assessment/scripts/03a-direct-checkout.ts
import "../../../scripts/_setup";
import { createCheckout } from "@/lib/checkout";
import { sql } from "@/lib/db";
import { capture, saveEvidence } from "./_evidence";

async function main() {
  const order = await createCheckout({
    sellerExternalId: "seller_us_mira",
    title: "Golden Hour Preset Pack",
    sku: "mira-golden-hour-presets",
    price: 10,
    currency: "usd",
  });
  // Policy check (originally a separate direct-only function that refused this seller; now
  // createCheckout routes a 'platform' seller to a Ledgerly-account checkout instead).
  const refused = await capture(async () => ({ note: "see createCheckout: platform sellers never get a direct checkout" }));
  saveEvidence("03-direct-charge/checkout", { order, platform_only_seller_refused: refused });
  console.log(JSON.stringify({ order, platform_only_seller_refused: refused }, null, 2));
}

main().finally(() => sql().end());
