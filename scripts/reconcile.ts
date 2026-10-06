// Reconcile one seller (or all): Whop payments/transfers/payouts/balance vs the local ledger.
//   pnpm reconcile seller_us_mira        exit code 1 if anything is off (cron/CI friendly)
//   pnpm reconcile --all
import "./_setup";
import { sql } from "@/lib/db";
import { reconcileSeller } from "@/lib/reconcile";

async function main() {
  const arg = process.argv[2];
  const sellers =
    arg === "--all" || !arg
      ? (await sql()`select external_id from sellers where whop_account_id is not null order by external_id`).map((r) => r.external_id)
      : [arg];
  let ok = true;
  for (const s of sellers) {
    const r = await reconcileSeller(s);
    ok &&= r.ok;
    console.log(JSON.stringify(r, null, 2));
  }
  process.exitCode = ok ? 0 : 1;
}
main().finally(() => sql().end());
