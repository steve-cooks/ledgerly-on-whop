import { sql } from "./db";
import { env } from "./env";
import { ConflictError } from "./errors";
import { whop } from "./whop";

export type TransferPurpose = "order_share" | "refund_funding" | "payout_advance";

/** Whop transfer status → ours. Only "completed" counts as money the seller has. */
export function transferState(whopStatus: string | null | undefined): "pending" | "completed" | "failed" {
  if (whopStatus === "succeeded") return "completed";
  if (whopStatus === "failed") return "failed";
  return "pending";
}

/**
 * Move money from Ledgerly's balance to a seller's connected account.
 *
 * `key` is the business intent (e.g. `order:<id>:share`). The first call records the intent
 * (seller, amount, currency, purpose); every retry under the same key sends exactly that
 * intent, and a retry that asks for something different is refused. Whop's idempotence_key is
 * the same value, so a lost response can be retried without paying twice.
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
    insert into seller_transfers (seller_external_id, order_id, amount, currency, idempotence_key, purpose)
    values (${seller.external_id}, ${args.orderId ?? null}, ${args.amount}, ${args.currency}, ${args.key}, ${args.purpose})
    on conflict (idempotence_key) do nothing`;
  const [intent] = await db`select * from seller_transfers where idempotence_key = ${args.key}`;
  if (
    intent.seller_external_id !== seller.external_id ||
    Math.round(Number(intent.amount) * 100) !== Math.round(args.amount * 100) ||
    intent.currency !== args.currency ||
    intent.purpose !== args.purpose
  ) {
    throw new ConflictError(`transfer key ${args.key} was already used for a different transfer`);
  }
  if (intent.whop_transfer_id) {
    return { transferId: intent.whop_transfer_id as string, status: intent.status as string, replayed: true };
  }

  const transfer = await whop().transfers.create(
    {
      origin_id: env().WHOP_PLATFORM_ACCOUNT_ID,
      destination_id: seller.whop_account_id,
      amount: Number(intent.amount),
      currency: intent.currency,
      idempotence_key: args.key,
      notes: `Ledgerly ${intent.purpose.replace("_", " ")}`,
      metadata: {
        ledgerly_transfer_key: args.key,
        seller_external_id: seller.external_id,
        purpose: intent.purpose,
        ...(intent.order_id ? { ledgerly_order_id: intent.order_id } : {}),
      },
    },
    { idempotencyKey: args.key },
  );

  const t = transfer as { id: string; status?: string };
  const status = transferState(t.status);
  await db`
    update seller_transfers set whop_transfer_id = ${t.id}, whop_status = ${t.status ?? null}, status = ${status}, updated_at = now()
    where idempotence_key = ${args.key}`;
  return { transferId: t.id, status, replayed: false };
}

/** Ask Whop about transfers we still consider in flight (webhooks can be late or missing). */
export async function refreshPendingTransfers(olderThanMinutes = 5) {
  const db = sql();
  const rows = await db`
    select idempotence_key, whop_transfer_id from seller_transfers
    where status = 'pending' and whop_transfer_id is not null
      and updated_at < now() - make_interval(mins => ${olderThanMinutes})`;
  for (const r of rows) {
    const t = (await whop().transfers.retrieve({ id: r.whop_transfer_id })) as { status?: string };
    await db`
      update seller_transfers set whop_status = ${t.status ?? null}, status = ${transferState(t.status)}, updated_at = now()
      where idempotence_key = ${r.idempotence_key} and status = 'pending'`;
  }
  return rows.length;
}
