// Snapshot balances for Ledgerly + sellers (accounts endpoint only: no owner PII).
//   pnpm tsx examples/assessment/scripts/balances.ts <evidence-name>
import "../../../scripts/_setup";
import { whop } from "@/lib/whop";
import { saveEvidence } from "./_evidence";
import { SELLERS } from "./sellers";
import { sql } from "@/lib/db";

async function main() {
  const rows = await sql()`select external_id, whop_account_id from sellers order by external_id`;
  const ids = [
    ["ledgerly_platform", process.env.WHOP_PLATFORM_ACCOUNT_ID!],
    ...rows.filter((r) => SELLERS.some((s) => s.externalId === r.external_id)).map((r) => [r.external_id, r.whop_account_id]),
  ];
  const out: Record<string, unknown> = { taken_at: new Date().toISOString() };
  for (const [name, id] of ids) {
    const a = await whop().accounts.retrieve({ id });
    out[name] = { id, balances: a.balances, total_usd: a.total_usd };
  }
  if (process.argv[2]) saveEvidence(process.argv[2], out);
  console.log(JSON.stringify(out, null, 2));
}
main().finally(() => sql().end());
