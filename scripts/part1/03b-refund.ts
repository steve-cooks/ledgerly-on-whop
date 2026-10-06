// Part 1 · Step 3b: full refund of the direct charge, then trace where the fee went.
//   pnpm tsx scripts/part1/03b-refund.ts pay_xxx
import "../_setup";
import { whop } from "@/lib/whop";
import { saveEvidence } from "../_evidence";

async function main() {
  const id = process.argv[2];
  const payment = await whop().payments.refund({ id }, { idempotencyKey: `ledgerly:refund:${id}:full` });
  saveEvidence("03-direct-charge/refund-response", payment);
  console.log(JSON.stringify({ id: payment.id, status: payment.status, refunded_amount: (payment as { refunded_amount?: unknown }).refunded_amount }, null, 2));
}
main();
