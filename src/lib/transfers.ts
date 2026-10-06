import { sql } from "./db";
import { env } from "./env";
import { whop } from "./whop";

export type TransferPurpose = "order_share" | "refund_funding";

/**
 * Move money from Ledgerly's balance to a seller's connected account.
 *
 * `key` must be deterministic for the business event (e.g. `order:<id>:share`), so a retry
 * after a timeout or crash can never pay twice: it is our unique key in seller_transfers and
 * Whop's idempotence_key.
 */
export async function transferToSeller(args: {
  sellerExternalId: string;
  amount: number;
  currency: string;
  key: string;
  purpose: TransferPurpose;
  orderId?: string;
}) {
  const db = sql();
  const [seller] = await db`select * from sellers where external_id = ${args.sellerExternalId}`;
  if (!seller?.whop_account_id) throw new Error(`seller ${args.sellerExternalId} is not onboarded`);
  if (!(args.amount > 0)) throw new Error("amount must be positive");

  await db`
    insert into seller_transfers (seller_external_id, order_id, amount, currency, idempotence_key)
    values (${seller.external_id}, ${args.orderId ?? null}, ${args.amount}, ${args.currency}, ${args.key})
    on conflict (idempotence_key) do nothing`;
  const [row] = await db`select * from seller_transfers where idempotence_key = ${args.key}`;
  if (row.whop_transfer_id) return { transferId: row.whop_transfer_id as string, replayed: true };

  const transfer = await whop().transfers.create(
    {
      origin_id: env().WHOP_PLATFORM_ACCOUNT_ID,
      destination_id: seller.whop_account_id,
      amount: args.amount,
      currency: args.currency,
      idempotence_key: args.key,
      notes: `Ledgerly ${args.purpose.replace("_", " ")}`,
      metadata: {
        ledgerly_transfer_key: args.key,
        seller_external_id: seller.external_id,
        purpose: args.purpose,
        ...(args.orderId ? { ledgerly_order_id: args.orderId } : {}),
      },
    },
    { idempotencyKey: args.key },
  );

  const id = (transfer as { id: string }).id;
  await db`update seller_transfers set whop_transfer_id = ${id}, updated_at = now() where idempotence_key = ${args.key}`;
  return { transferId: id, replayed: false, transfer };
}
