// Reconcile one seller (or all): Whop payments/transfers/payouts/balance vs the local ledger.
//   pnpm reconcile seller_us_mira        exit code 1 if anything is off (cron/CI friendly)
//   pnpm reconcile --all
//   pnpm reconcile --all --fix         first pull payout state from Whop (webhooks can miss transitions)
import "./_setup";
import { sql } from "@/lib/db";
import { reconcileSeller, repairPayouts } from "@/lib/reconcile";

async function main() {
  const fix = process.argv.includes("--fix");
  const arg = process.argv.slice(2).find((a) => a !== "--fix");
  const sellers =
    arg === "--all" || !arg
      ? (await sql()`select external_id from sellers where whop_account_id is not null order by external_id`).map((r) => r.external_id)
      : [arg];
  let ok = true;
  for (const s of sellers) {
    if (fix) await repairPayouts(s);
    const r = await reconcileSeller(s);
    ok &&= r.ok;
    console.log(JSON.stringify(r, null, 2));
  }
  process.exitCode = ok ? 0 : 1;
}
main().finally(() => sql().end());
