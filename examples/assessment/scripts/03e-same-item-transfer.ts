// Part 1 · Step 3 (re-run): the SAME item as the direct charge ("Golden Hour Preset Pack"),
// sold on Ledgerly's own account; the Brazilian seller's share is transferred automatically.
// Run after the purchase to save the evidence:
//   pnpm ledgerly checkout --seller seller_br_batida --title "Golden Hour Preset Pack" \
//     --sku golden-hour-preset-pack --price 10 --request-key assessment-same-item-1
//   pnpm tsx examples/assessment/scripts/03e-same-item-transfer.ts <order-id>
import "../../../scripts/_setup";
import { sql } from "@/lib/db";
import { whop } from "@/lib/whop";
import { saveEvidence } from "./_evidence";

async function main() {
  const [order] = await sql()`select * from orders where id = ${process.argv[2]}`;
  const transfers = await sql()`select idempotence_key, amount, status, whop_status, whop_transfer_id, purpose from seller_transfers where order_id = ${order.id}`;
  const payment = await whop().payments.retrieve({ id: order.whop_payment_id });
  const fees = await whop().payments.listFees({ id: order.whop_payment_id });
  const out = {
    order: { id: order.id, title: order.title, flow: order.flow, amount: order.amount, platform_fee: order.platform_fee, seller_share: order.seller_share, status: order.status, request_key: order.request_key },
    payment: { id: payment.id, account_id: (payment as { account_id?: string }).account_id, total: payment.total, amount_after_fees: (payment as { amount_after_fees?: unknown }).amount_after_fees },
    fees: fees.data.map((f) => ({ origin: f.origin, amount: f.amount.amount })),
    transfers,
  };
  saveEvidence("03-transfer/same-item", out);
  console.log(JSON.stringify(out, null, 2));
}
main().finally(() => sql().end());
