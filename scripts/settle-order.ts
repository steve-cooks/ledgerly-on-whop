// Settle (or true-up) one platform order: pnpm tsx scripts/settle-order.ts <order-uuid> [evidence-name]
import "./_setup";
import { sql } from "@/lib/db";
import { settlePlatformOrder } from "@/lib/checkout";
import { saveEvidence } from "./_evidence";

settlePlatformOrder(process.argv[2])
  .then((r) => {
    if (process.argv[3]) saveEvidence(process.argv[3], r);
    console.log(JSON.stringify({ ...r, transfer: undefined }, null, 2));
  })
  .finally(() => sql().end());
