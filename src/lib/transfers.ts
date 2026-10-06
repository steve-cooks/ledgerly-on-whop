import type postgres from "postgres";
import { sql } from "./db";
import { env } from "./env";
import { ConflictError, whopErrorSummary } from "./errors";
import { whop } from "./whop";
import type { Tx } from "./webhooks";

export type TransferPurpose = "order_share" | "refund_funding" | "payout_advance";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Whop transfer status → ours. Only "completed" counts as money the seller has. */
export function transferState(whopStatus: string | null | undefined): "pending" | "completed" | "failed" {
  if (whopStatus === "succeeded") return "completed";
  if (whopStatus === "failed") return "failed";
  return "pending";
}

// 4xx answers where Whop may still have acted (or will): the outcome is unknown, not "no".
const UNKNOWN_OUTCOME = new Set([408, 409, 425, 429]);

/** Whop definitely refused the request, so no transfer exists for it. */
export function isDefiniteRejection(err: unknown) {
  const status = (err as { statusCode?: number })?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 && !UNKNOWN_OUTCOME.has(status);
}

type TransferArgs = {
  sellerExternalId: string;
  amount: number;
  currency: string;
  key: string;
  purpose: TransferPurpose;
  orderId?: string;
};

/**
 * Record a transfer intent under its key, or return the one already recorded. A different
 * intent (seller, amount, currency, purpose) under a used key is refused.
 */
export async function reserveTransfer(db: postgres.Sql | Tx, args: TransferArgs) {
  if (!(args.amount > 0)) throw new Error("amount must be positive");
  await db`
    insert into seller_transfers (seller_external_id, order_id, amount, currency, idempotence_key, purpose)
    values (${args.sellerExternalId}, ${args.orderId ?? null}, ${args.amount}, ${args.currency}, ${args.key}, ${args.purpose})
    on conflict (idempotence_key) do nothing`;
  const [intent] = await db`select * from seller_transfers where idempotence_key = ${args.key}`;
  if (
    intent.seller_external_id !== args.sellerExternalId ||
    Math.round(Number(intent.amount) * 100) !== Math.round(args.amount * 100) ||
    intent.currency !== args.currency ||
    intent.purpose !== args.purpose
  ) {
    throw new ConflictError(`transfer key ${args.key} was already used for a different transfer`);
  }
  return intent as Row;
}

/**
 * Move money from Ledgerly's balance to a seller's connected account.
 *
 * `key` is the business intent (e.g. `order:<id>:share`). The first call records the intent;
 * every retry under the same key sends exactly that intent, and a retry that asks for
 * something different is refused. Whop's idempotence_key is the same value, so a lost
 * response can be retried without paying twice.
 */
export async function transferToSeller(args: TransferArgs) {
  const [seller] = await sql()`select * from sellers where external_id = ${args.sellerExternalId}`;
  if (!seller?.whop_account_id) throw new Error(`seller ${args.sellerExternalId} is not onboarded`);
  const intent = await reserveTransfer(sql(), args);
  if (intent.whop_transfer_id || intent.status !== "pending") {
    return { transferId: intent.whop_transfer_id as string | null, status: intent.status as string, replayed: true };
  }
  return dispatchTransfer(intent);
}

/**
 * Send a recorded intent to Whop under its own key. Safe to repeat for the same intent.
 *  - Whop answered with a transfer: its state is applied (applyTransferState).
 *  - Whop refused the request (4xx): no transfer exists. The intent is marked failed with the
 *    reason; a new attempt needs a new key (Whop replays a refused key's answer for 24h).
 *  - No answer (timeout, 5xx, 429): unknown. The intent stays pending and
 *    refreshPendingTransfers sends it again under the same key.
 */
export async function dispatchTransfer(intent: Row) {
  const db = sql();
  const [seller] = await db`select whop_account_id from sellers where external_id = ${intent.seller_external_id}`;
  let transfer: { id: string; status?: string };
  try {
    transfer = (await whop().transfers.create(
      {
        origin_id: env().WHOP_PLATFORM_ACCOUNT_ID,
        destination_id: seller.whop_account_id,
        amount: Number(intent.amount),
        currency: intent.currency,
        idempotence_key: intent.idempotence_key,
        notes: `Ledgerly ${String(intent.purpose).replace("_", " ")}`,
        metadata: {
          ledgerly_transfer_key: intent.idempotence_key,
          seller_external_id: intent.seller_external_id,
          purpose: intent.purpose,
          ...(intent.order_id ? { ledgerly_order_id: intent.order_id } : {}),
        },
      },
      { idempotencyKey: intent.idempotence_key },
    )) as { id: string; status?: string };
  } catch (err) {
    if (!isDefiniteRejection(err)) throw err;
    const reason = JSON.stringify(whopErrorSummary(err));
    await db`
      update seller_transfers set status = 'failed', last_error = ${reason}, updated_at = now()
      where idempotence_key = ${intent.idempotence_key} and status = 'pending' and whop_transfer_id is null`;
    return { transferId: null, status: "failed", replayed: false, error: reason };
  }
  const row = await db.begin((tx) =>
    applyTransferState(tx, { key: intent.idempotence_key, id: transfer.id, whopStatus: transfer.status }),
  );
  return { transferId: transfer.id, status: (row?.status as string) ?? transferState(transfer.status), replayed: false };
}

/**
 * The one place a transfer's state changes: the create response, polling and both webhooks
 * all come through here.
 *  - Forward only: pending → failed → completed. Completed is final, and nothing returns to
 *    pending, so a slow create response can't undo what a webhook already recorded. A failed
 *    transfer can still complete: Whop may retry it under the same id.
 *  - A completed transfer credits the seller's ledger once, keyed on the transfer id.
 * Returns the row, or undefined if the transfer isn't one of Ledgerly's.
 */
export async function applyTransferState(
  tx: Tx,
  t: { id: string; key?: string | null; whopStatus?: string | null; at?: string | null },
) {
  const next = transferState(t.whopStatus);
  const key = t.key ?? null;
  await tx`
    update seller_transfers set
      whop_transfer_id = coalesce(whop_transfer_id, ${t.id}), whop_status = ${t.whopStatus ?? null},
      status = ${next}, last_error = null, updated_at = now()
    where (whop_transfer_id = ${t.id} or (${key}::text is not null and idempotence_key = ${key}))
      and (status = 'pending' or (status = 'failed' and ${next} = 'completed'))`;
  const [row] = await tx`
    select * from seller_transfers
    where whop_transfer_id = ${t.id} or (${key}::text is not null and idempotence_key = ${key})`;
  if (row?.status === "completed") {
    await tx`
      insert into ledger_entries (entry_key, seller_external_id, kind, amount, currency, whop_object_id, occurred_at)
      values (${`transfer:${t.id}`}, ${row.seller_external_id}, 'transfer_in', ${Number(row.amount)}, ${row.currency}, ${t.id},
              ${t.at ?? new Date().toISOString()})
      on conflict (entry_key) do nothing`;
  }
  return row as Row | undefined;
}

/**
 * Settle transfers webhooks haven't settled (they can be late or missing):
 *  - pending with a Whop id: ask Whop for its status;
 *  - pending without one (the create call never got an answer): send it again under the same
 *    key, which returns the original transfer if Whop did create it;
 *  - failed with a Whop id, for two weeks: Whop may still retry it to success.
 * Each transfer is isolated: one error is reported and the rest still run.
 */
export async function refreshPendingTransfers(opts: { olderThanMinutes?: number; deadline?: number } = {}) {
  const db = sql();
  const rows = await db`
    select * from seller_transfers
    where updated_at < now() - make_interval(mins => ${opts.olderThanMinutes ?? 5})
      and (status = 'pending'
           or (status = 'failed' and whop_transfer_id is not null and created_at > now() - interval '14 days'))
    order by (status = 'pending') desc, updated_at`;
  const changed: { key: string; status: string }[] = [];
  const errors: string[] = [];
  let checked = 0;
  for (const r of rows) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    checked++;
    try {
      let status: string | undefined;
      if (r.whop_transfer_id) {
        const t = (await whop().transfers.retrieve({ id: r.whop_transfer_id })) as { status?: string };
        status = (await db.begin((tx) => applyTransferState(tx, { id: r.whop_transfer_id, key: r.idempotence_key, whopStatus: t.status })))?.status;
      } else {
        status = (await dispatchTransfer(r)).status;
      }
      if (status && status !== r.status) changed.push({ key: r.idempotence_key, status });
    } catch (err) {
      const summary = whopErrorSummary(err);
      errors.push(`${r.idempotence_key}: ${summary ? JSON.stringify(summary) : (err as Error).message}`);
    }
  }
  return { checked, remaining: rows.length - checked, changed, errors };
}
