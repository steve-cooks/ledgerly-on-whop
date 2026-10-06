import { sql } from "./db";
import { env } from "./env";
import { transferState } from "./transfers";
import { applyPayout } from "./webhook-handlers";
import { whop } from "./whop";

/**
 * Reconciliation: diff one seller's money at Whop against Ledgerly's local records.
 *
 *  1. Every Whop payment, transfer and payout has a local twin with the same amount, currency
 *     and state, and every local record exists at Whop.
 *  2. Every paid platform-collected order has been paid out to the seller in full (confirmed
 *     transfers = the share we owe), with no overpayment.
 *  3. The seller's ledger balance equals their Whop balance, per currency.
 */

export type Discrepancy = {
  kind: "payment" | "transfer" | "payout" | "obligation" | "balance";
  id: string;
  problem:
    | "missing_locally"
    | "missing_at_whop"
    | "amount_mismatch"
    | "state_mismatch"
    | "unsettled"
    | "underpaid"
    | "overpaid";
  whop?: unknown;
  local?: unknown;
};

export type Keyed = { id: string; amount: number; currency?: string; state: string };

const cents = (n: number) => Math.round(n * 100);

/** Pure two-way diff of Whop records against local ones, keyed by Whop id. */
export function diffRecords(kind: Discrepancy["kind"], whopRows: Keyed[], localRows: Keyed[]): Discrepancy[] {
  const out: Discrepancy[] = [];
  const local = new Map(localRows.map((r) => [r.id, r]));
  const remote = new Map(whopRows.map((r) => [r.id, r]));
  for (const w of whopRows) {
    const l = local.get(w.id);
    if (!l) out.push({ kind, id: w.id, problem: "missing_locally", whop: w });
    else if (cents(w.amount) !== cents(l.amount) || (w.currency ?? l.currency) !== (l.currency ?? w.currency))
      out.push({ kind, id: w.id, problem: "amount_mismatch", whop: w, local: l });
    else if (w.state !== l.state) out.push({ kind, id: w.id, problem: "state_mismatch", whop: w, local: l });
  }
  for (const l of localRows) if (!remote.has(l.id)) out.push({ kind, id: l.id, problem: "missing_at_whop", local: l });
  return out;
}

/** Pure: what each paid platform order is owed vs what has been confirmed sent. */
export function obligationDiscrepancies(
  orders: { id: string; status: string; seller_share: number | null; age_minutes: number }[],
  confirmedCentsByOrder: Map<string, number>,
  graceMinutes = 60,
): Discrepancy[] {
  const out: Discrepancy[] = [];
  for (const o of orders) {
    if (o.status !== "paid") continue;
    const sent = confirmedCentsByOrder.get(o.id) ?? 0;
    if (o.seller_share == null) {
      if (o.age_minutes > graceMinutes) out.push({ kind: "obligation", id: o.id, problem: "unsettled", local: { sent: sent / 100 } });
      continue;
    }
    const owed = cents(o.seller_share);
    if (sent < owed && o.age_minutes > graceMinutes)
      out.push({ kind: "obligation", id: o.id, problem: "underpaid", local: { owed: owed / 100, sent: sent / 100 } });
    if (sent > owed) out.push({ kind: "obligation", id: o.id, problem: "overpaid", local: { owed: owed / 100, sent: sent / 100 } });
  }
  return out;
}

/** Map Whop's payment status/substatus pair onto our order states. */
export function paymentState(p: { status?: string | null; substatus?: string | null }) {
  if (p.substatus === "refunded") return "refunded";
  if (p.substatus === "partially_refunded") return "partially_refunded";
  if (p.status === "paid") return "paid";
  if (p.substatus === "failed" || p.status === "failed") return "failed";
  return p.status ?? "unknown";
}

async function all<T>(page: AsyncIterable<T>) {
  const rows: T[] = [];
  for await (const r of page) rows.push(r);
  return rows;
}

export type WhopPayment = {
  id: string;
  status?: string | null;
  substatus?: string | null;
  currency?: string | null;
  total?: { amount: string } | null;
  subtotal?: { amount: string } | null;
  refunded_amount?: { amount: string } | null;
  metadata?: Record<string, unknown> | null;
};

/** Ledgerly's own payments (platform-collected sales). Fetch once per run and share it. */
export async function fetchPlatformPayments() {
  return (await all(await whop().payments.list({ account_id: env().WHOP_PLATFORM_ACCOUNT_ID, first: 100 }))) as WhopPayment[];
}

export async function reconcileSeller(externalId: string, shared?: { platformPayments?: WhopPayment[] }) {
  const db = sql();
  const [seller] = await db`select * from sellers where external_id = ${externalId}`;
  if (!seller?.whop_account_id) throw new Error(`seller ${externalId} is not onboarded`);
  const sellerAccount: string = seller.whop_account_id;

  // ── Whop side ────────────────────────────────────────────────────────────────────────────
  // Direct charges live on the seller's account; platform-collected sales live on Ledgerly's,
  // tagged with the seller in metadata.
  const [sellerPayments, platformPayments, transfers, payouts, account] = await Promise.all([
    all(await whop().payments.list({ account_id: sellerAccount, first: 100 })),
    shared?.platformPayments ?? fetchPlatformPayments(),
    all(await whop().transfers.list({ destination_id: sellerAccount, first: 100 })),
    all(await whop().payouts.list({ account_id: sellerAccount, first: 100 })),
    whop().accounts.retrieve({ id: sellerAccount }),
  ]);
  const payments = [
    ...(sellerPayments as WhopPayment[]),
    ...platformPayments.filter((p) => p.metadata?.seller_external_id === externalId),
  ].filter((p) => paymentState(p) !== "failed" && p.status !== "open" && p.status !== "draft");

  // ── Local side ───────────────────────────────────────────────────────────────────────────
  const [orders, localTransfers, localPayouts, balances] = await Promise.all([
    db`select *, extract(epoch from now() - updated_at) / 60 as age_minutes from orders
       where seller_external_id = ${externalId} and whop_payment_id is not null and status <> 'failed'`,
    db`select * from seller_transfers where seller_external_id = ${externalId} and whop_transfer_id is not null`,
    db`select * from payouts where seller_external_id = ${externalId}`,
    db`select currency, coalesce(sum(amount), 0)::numeric as balance from ledger_entries
       where seller_external_id = ${externalId} group by currency`,
  ]);

  // Compare the item price (subtotal): tax added on top at checkout isn't part of the order.
  const discrepancies = [
    ...diffRecords(
      "payment",
      payments.map((p) => ({
        id: p.id,
        amount: Number(p.subtotal?.amount ?? p.total?.amount ?? 0),
        currency: (p.currency ?? "usd").toLowerCase(),
        state: `${paymentState(p)} / refunded ${Number(p.refunded_amount?.amount ?? 0).toFixed(2)}`,
      })),
      orders.map((o) => ({
        id: o.whop_payment_id,
        amount: Number(o.amount),
        currency: o.currency,
        // A disputed order is still 'paid' at Whop; its dispute shows up in the balance check.
        state: `${o.status === "disputed" ? "paid" : o.status} / refunded ${Number(o.refunded_amount).toFixed(2)}`,
      })),
    ),
    ...diffRecords(
      "transfer",
      (transfers as { id: string; amount: number; currency?: string; status?: string }[]).map((t) => ({
        id: t.id,
        amount: Number(t.amount),
        currency: (t.currency ?? "usd").toLowerCase(),
        state: transferState(t.status),
      })),
      localTransfers.map((t) => ({ id: t.whop_transfer_id, amount: Number(t.amount), currency: t.currency, state: t.status })),
    ),
    ...diffRecords(
      "payout",
      (payouts as { id: string; amount: string | number; currency?: string; status?: string }[]).map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        currency: (p.currency ?? "usd").toLowerCase(),
        state: p.status ?? "unknown",
      })),
      localPayouts.map((p) => ({ id: p.whop_payout_id, amount: Number(p.amount), currency: p.currency, state: p.status })),
    ),
  ];

  // What platform-collected orders owe the seller vs confirmed order-share transfers.
  const confirmed = new Map<string, number>();
  for (const t of localTransfers) {
    if (t.purpose === "order_share" && t.status === "completed" && t.order_id) {
      confirmed.set(t.order_id, (confirmed.get(t.order_id) ?? 0) + cents(Number(t.amount)));
    }
  }
  discrepancies.push(
    ...obligationDiscrepancies(
      orders
        .filter((o) => o.flow === "platform")
        .map((o) => ({
          id: o.id,
          status: o.status,
          seller_share: o.seller_share == null ? null : Number(o.seller_share),
          age_minutes: Number(o.age_minutes),
        })),
      confirmed,
    ),
  );

  // Seller balance, per currency: Whop's total (available + pending + reserve) vs our ledger.
  const whopBalance = new Map<string, number>();
  for (const b of (account.balances ?? []) as { symbol?: string; balance?: string | number }[]) {
    const c = (b.symbol ?? "").toLowerCase();
    whopBalance.set(c, (whopBalance.get(c) ?? 0) + Number(b.balance ?? 0));
  }
  const localBalance = new Map(balances.map((b) => [b.currency as string, Number(b.balance)]));
  for (const c of new Set([...whopBalance.keys(), ...localBalance.keys()])) {
    const w = whopBalance.get(c) ?? 0;
    const l = localBalance.get(c) ?? 0;
    if (cents(w) !== cents(l)) discrepancies.push({ kind: "balance", id: `${sellerAccount}:${c}`, problem: "amount_mismatch", whop: w, local: l });
  }

  return {
    seller: externalId,
    account: sellerAccount,
    checked: { payments: payments.length, transfers: transfers.length, payouts: payouts.length },
    balance: Object.fromEntries([...whopBalance].map(([c, w]) => [c, { whop: w, local: localBalance.get(c) ?? 0 }])),
    ok: discrepancies.length === 0,
    discrepancies,
  };
}

// Lifecycle order of payout statuses. Repair never moves a payout backwards.
const PAYOUT_RANK: Record<string, number> = { requested: 0, in_review: 0, processing: 1, completed: 2, failed: 2, canceled: 2, denied: 2, reversed: 3 };

/**
 * Repair: pull payout state from Whop for a seller. Webhooks don't always cover every
 * transition (a real payout reached "completed" with no payout.updated for it).
 *
 * Each payout is compared under a row lock and changed only if (a) Whop's state differs, (b)
 * it isn't a step backwards, and (c) nothing wrote the row since this read started (a webhook
 * that arrived meanwhile wins; the next run looks again). It then goes through the webhook
 * handler's own applyPayout, so the ledger follows the same rules.
 */
export async function repairPayouts(externalId: string) {
  const db = sql();
  const [seller] = await db`select * from sellers where external_id = ${externalId}`;
  if (!seller?.whop_account_id) return 0;
  const [{ now: readStartedAt }] = await db`select now()`;
  const payouts = (await all(await whop().payouts.list({ account_id: seller.whop_account_id, first: 100 }))) as unknown as Record<string, unknown>[];
  let repaired = 0;
  for (const p of payouts) {
    await db.begin(async (tx) => {
      const [local] = await tx`select * from payouts where whop_payout_id = ${String(p.id)} for update`;
      if (local) {
        if (new Date(local.updated_at) >= new Date(readStartedAt)) return;
        const same = local.status === p.status && local.status_detail === p.status_detail && cents(Number(local.amount)) === cents(Number(p.amount));
        if (same || (PAYOUT_RANK[String(p.status)] ?? 0) < (PAYOUT_RANK[local.status] ?? 0)) return;
      }
      // Stamp it newer than anything recorded so applyPayout accepts it.
      const at = new Date(Math.max(Date.now(), local ? new Date(local.last_event_at).getTime() + 1 : 0)).toISOString();
      await applyPayout(tx, p, at, seller.whop_account_id, externalId);
      repaired++;
    });
  }
  return repaired;
}
