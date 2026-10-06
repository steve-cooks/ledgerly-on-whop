// Where did a payment's money land? Payment, its fee lines, and financial activity on the
// seller's and Ledgerly's ledgers for that payment.
//   pnpm tsx scripts/money-trace.ts pay_xxx <evidence-name>
import "./_setup";
import { whop } from "@/lib/whop";
import { capture, saveEvidence } from "./_evidence";

async function main() {
  const [paymentId, name] = process.argv.slice(2);
  const platform = process.env.WHOP_PLATFORM_ACCOUNT_ID!;
  const payment = await whop().payments.retrieve({ id: paymentId });
  const seller = (payment as { account_id?: string }).account_id ?? null;

  const fees = await capture(() => whop().payments.listFees({ id: paymentId }));
  const activity: Record<string, unknown> = {};
  for (const [label, id] of [["seller", seller], ["ledgerly", platform]] as const) {
    if (!id) continue;
    activity[label] = await capture(() =>
      // payment_id / resource_id filters return nothing in practice, so read the recent feed.
      whop().financialActivity.list({ account_id: id, include_resource: false, limit: 50 }),
    );
  }
  const balances: Record<string, unknown> = {};
  for (const [label, id] of [["seller", seller], ["ledgerly", platform]] as const) {
    if (id) balances[label] = (await whop().accounts.retrieve({ id })).balances;
  }

  const out = { payment, fees, activity, balances };
  if (name) saveEvidence(name, out);
  console.log(JSON.stringify(out, null, 2));
}
main();
