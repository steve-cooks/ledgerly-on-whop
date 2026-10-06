// Part 1 · Step 5c: a small direct checkout used to produce a REAL payment.failed (declined card).
//   pnpm tsx examples/assessment/scripts/05c-decline-checkout.ts
import "../../../scripts/_setup";
import { createCheckout } from "@/lib/checkout";
import { sql } from "@/lib/db";
import { saveEvidence } from "./_evidence";

createCheckout({ sellerExternalId: "seller_us_mira", title: "Mira Mini Preset", sku: "mira-mini-preset", price: 2 })
  .then((o) => {
    saveEvidence("05-webhooks/decline-checkout", o);
    console.log(JSON.stringify(o, null, 2));
  })
  .finally(() => sql().end());
