import { sql } from "./db";
import { env } from "./env";
import { whop } from "./whop";

/**
 * Reconciliation: diff one seller's money at Whop against Ledgerly's local records.
 *
 * Checks, per object type, that every Whop record has a local twin with the same amount and
 * state, and every local record exists at Whop. Then checks the seller's ledger balance
 * against their Whop balance. Anything off is a discrepancy with enough detail to act on.
 */

export type Discrepancy = {
  kind: "payment" | "transfer" | "payout" | "balance";
  id: string;
  problem: "missing_locally" | "missing_at_whop" | "amount_mismatch" | "state_mismatch";
  whop?: unknown;
  local?: unknown;
};

export type Keyed = { id: string; amount: number; state: string };

const cents = (n: number) => Math.round(n * 100);

/** Pure two-way diff of Whop records against local ones, keyed by Whop id. */
export function diffRecords(kind: Discrepancy["kind"], whopRows: Keyed[], localRows: Keyed[]): Discrepancy[] {
  const out: Discrepancy[] = [];
  const local = new Map(localRows.map((r) => [r.id, r]));
  const remote = new Map(whopRows.map((r) => [r.id, r]));
  for (const w of whopRows) {
    const l = local.get(w.id);
    if (!l) out.push({ kind, id: w.id, problem: "missing_locally", whop: w });
    else if (cents(w.amount) !== cents(l.amount)) out.push({ kind, id: w.id, problem: "amount_mismatch", whop: w, local: l });
    else if (w.state !== l.state) out.push({ kind, id: w.id, problem: "state_mismatch", whop: w, local: l });
  }
  for (const l of localRows) if (!remote.has(l.id)) out.push({ kind, id: l.id, problem: "missing_at_whop", local: l });
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

type WhopPayment = {
  id: string;
  status?: string | null;
  substatus?: string | null;
  total?: { amount: string } | null;
  subtotal?: { amount: string } | null;
  refunded_amount?: { amount: string } | null;
  metadata?: Record<string, unknown> | null;
};

export async function reconcileSeller(externalId: string) {
  const db = sql();
  const [seller] = await db`select * from sellers where external_id = ${externalId}`;
  if (!seller?.whop_account_id) throw new Error(`seller ${externalId} is not onboarded`);
  const sellerAccount: string = seller.whop_account_id;
  const platform = env().WHOP_PLATFORM_ACCOUNT_ID;

  // ── Whop side ────────────────────────────────────────────────────────────────────────────
  // Direct charges live on the seller's account; platform-collected sales live on Ledgerly's,
  // tagged with the seller in metadata.
  const [sellerPayments, platformPayments, transfers, payouts, account] = await Promise.all([
    all(await whop().payments.list({ account_id: sellerAccount, first: 100 })),
    all(await whop().payments.list({ account_id: platform, first: 100 })),
    all(await whop().transfers.list({ destination_id: sellerAccount, first: 100 })),
    all(await whop().payouts.list({ account_id: sellerAccount, first: 100 })),
    whop().accounts.retrieve({ id: sellerAccount }),
  ]);
  const payments = [
    ...(sellerPayments as WhopPayment[]),
    ...(platformPayments as WhopPayment[]).filter((p) => p.metadata?.seller_external_id === externalId),
  ].filter((p) => paymentState(p) !== "failed" && p.status !== "open" && p.status !== "draft");

  // ── Local side ───────────────────────────────────────────────────────────────────────────
  const [orders, localTransfers, localPayouts, [{ balance }]] = await Promise.all([
    db`select * from orders where seller_external_id = ${externalId} and whop_payment_id is not null and status <> 'failed'`,
    db`select * from seller_transfers where seller_external_id = ${externalId} and whop_transfer_id is not null`,
    db`select * from payouts where seller_external_id = ${externalId}`,
    db`select coalesce(sum(amount), 0)::numeric as balance from ledger_entries where seller_external_id = ${externalId}`,
  ]);

  // Compare the item price (subtotal): tax added on top at checkout isn't part of the order.
  const discrepancies = [
    ...diffRecords(
      "payment",
      payments.map((p) => ({
        id: p.id,
        amount: Number(p.subtotal?.amount ?? p.total?.amount ?? 0),
        state: `${paymentState(p)} / refunded ${Number(p.refunded_amount?.amount ?? 0).toFixed(2)}`,
      })),
      orders.map((o) => ({
        id: o.whop_payment_id,
        amount: Number(o.amount),
        state: `${o.status} / refunded ${Number(o.refunded_amount).toFixed(2)}`,
      })),
    ),
    ...diffRecords(
      "transfer",
      (transfers as { id: string; amount: number; status?: string }[])
        .filter((t) => t.status === "succeeded")
        .map((t) => ({ id: t.id, amount: Number(t.amount), state: "completed" })),
      localTransfers.map((t) => ({ id: t.whop_transfer_id, amount: Number(t.amount), state: t.status })),
    ),
    ...diffRecords(
      "payout",
      (payouts as { id: string; amount: string | number; status?: string }[]).map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        state: p.status ?? "unknown",
      })),
      localPayouts.map((p) => ({ id: p.whop_payout_id, amount: Number(p.amount), state: p.status })),
    ),
  ];

  // Seller balance: Whop's total (available + pending + reserve) vs the sum of our ledger.
  const whopBalance = (account.balances ?? [])
    .filter((b: { symbol?: string }) => (b.symbol ?? "").toUpperCase() === "USD")
    .reduce((s: number, b: { balance?: string | number }) => s + Number(b.balance ?? 0), 0);
  if (cents(whopBalance) !== cents(Number(balance))) {
    discrepancies.push({ kind: "balance", id: sellerAccount, problem: "amount_mismatch", whop: whopBalance, local: Number(balance) });
  }

  return {
    seller: externalId,
    account: sellerAccount,
    checked: { payments: payments.length, transfers: transfers.length, payouts: payouts.length },
    balance: { whop: whopBalance, local: Number(balance) },
    ok: discrepancies.length === 0,
    discrepancies,
  };
}
