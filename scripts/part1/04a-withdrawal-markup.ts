// Part 1 · Step 4a: Ledgerly charges +$0.50 on instant (RTP) withdrawals, for every seller.
//   pnpm tsx scripts/part1/04a-withdrawal-markup.ts
import "../_setup";
import { whop } from "@/lib/whop";
import { saveEvidence } from "../_evidence";

async function main() {
  const platform = process.env.WHOP_PLATFORM_ACCOUNT_ID!;
  const updated = await whop().accounts.fees.update({
    account_id: platform,
    child_markups: { payouts: { rtp: { fixed: 0.5, percentage: 0 } } },
    notes: "Ledgerly instant payout premium",
  });
  const mira = await whop().accounts.fees.retrieve({ account_id: "biz_9ejVCcyqXnAYeV" });
  const pick = (f: unknown) => (f as { child_markups?: unknown; markups?: { payouts?: unknown } });
  const out = {
    platform_child_markups: pick(updated).child_markups,
    mira_markups_payouts: pick(mira).markups?.payouts,
  };
  saveEvidence("04-payouts/withdrawal-markup", out);
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => console.error(e.statusCode, JSON.stringify(e.body ?? e.message)));
