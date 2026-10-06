// Part 1 · Step 3c: Ledgerly fronts the refund. Transfer the payment amount to the seller,
// then refund the buyer from the seller's (now funded) balance.
//   pnpm tsx examples/assessment/scripts/03c-fund-refund.ts pay_xxx
import "../../../scripts/_setup";
import { transferToSeller } from "@/lib/transfers";
import { whop } from "@/lib/whop";
import { sql } from "@/lib/db";
import { capture, saveEvidence } from "./_evidence";

async function main() {
  const paymentId = process.argv[2];
  const [order] = await sql()`select * from orders where whop_payment_id = ${paymentId}`;
  const funding = await transferToSeller({
    sellerExternalId: order.seller_external_id,
    amount: Number(order.amount),
    currency: order.currency,
    key: `order:${order.id}:refund_funding`,
    purpose: "refund_funding",
    orderId: order.id,
  });
  const sellerAfterTransfer = await whop().accounts.retrieve({ id: (await sql()`select whop_account_id from sellers where external_id=${order.seller_external_id}`)[0].whop_account_id });
  const refund = await capture(() =>
    whop().payments.refund({ id: paymentId }, { idempotencyKey: `ledgerly:refund:${paymentId}:full` }),
  );
  saveEvidence("03-direct-charge/refund-funding-transfer", funding);
  saveEvidence("03-direct-charge/refund", { seller_balances_after_transfer: sellerAfterTransfer.balances, refund });
  console.log(JSON.stringify({ funding: { id: funding.transferId, replayed: funding.replayed }, seller_balances: sellerAfterTransfer.balances, refund: refund.ok ? { status: refund.result.status } : refund }, null, 2));
}
main().finally(() => sql().end());
