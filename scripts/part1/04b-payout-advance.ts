// Part 1 · Step 4b: advance Mira $5 from Ledgerly so a real withdrawal can be recorded today
// (her own sale proceeds are pending until settlement).
//   pnpm tsx scripts/part1/04b-payout-advance.ts
import "../_setup";
import { transferToSeller } from "@/lib/transfers";
import { sql } from "@/lib/db";
import { saveEvidence } from "../_evidence";

transferToSeller({
  sellerExternalId: "seller_us_mira",
  amount: 5,
  currency: "usd",
  key: "seller_us_mira:payout_advance:2026-10-06",
  purpose: "payout_advance",
})
  .then((r) => {
    saveEvidence("04-payouts/payout-advance", r);
    console.log(r.transferId, r.replayed);
  })
  .finally(() => sql().end());
