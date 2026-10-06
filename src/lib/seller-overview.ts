import { sql } from "./db";
import { whop } from "./whop";

export type SellerOverview = Awaited<ReturnType<typeof getSellerOverview>>;

/** Our seller row plus the Whop account facts a seller-facing page needs. */
export async function getSellerOverview(externalId: string) {
  const [seller] = await sql()`select * from sellers where external_id = ${externalId}`;
  if (!seller?.whop_account_id) return null;
  const [account, fees] = await Promise.all([
    whop().accounts.retrieve({ id: seller.whop_account_id }),
    whop().accounts.fees.retrieve({ account_id: seller.whop_account_id }).catch(() => null),
  ]);
  const caps = (account.capabilities ?? {}) as Record<string, string>;
  const verification = (account.verification ?? {}) as { individual?: { status?: string } | null; business?: { status?: string } | null };
  const identity = verification.individual?.status ?? verification.business?.status ?? "not_started";
  return {
    externalId: seller.external_id as string,
    country: seller.country as string,
    collectionMode: seller.collection_mode as "direct" | "platform",
    feeBps: seller.fee_bps as number | null, // null = platform default
    accountId: seller.whop_account_id as string,
    title: account.title ?? seller.external_id,
    status: (account as { status?: string }).status ?? "active",
    identity,
    canWithdraw: caps.standard_payout === "active",
    canInstant: caps.instant_payout === "active",
    requiredActions: ((account.required_actions ?? []) as { action: string; title: string; status: string }[]).map((a) => ({
      action: a.action,
      title: a.title,
      status: a.status,
    })),
    capabilities: caps,
    payoutFees: payoutFees(fees),
  };
}

type FeeLine = { percentage?: number | null; fixed?: { amount: string } | null };

/** Whop's base fee + Ledgerly's markup for the rails we show sellers. */
function payoutFees(fees: unknown) {
  if (!fees) return null; // lookup failed: show "unavailable", never "free"
  const f = (fees ?? {}) as { payouts?: Record<string, FeeLine>; markups?: { payouts?: Record<string, FeeLine> } };
  const amt = (l?: FeeLine) => Number(l?.fixed?.amount ?? 0);
  const pct = (l?: FeeLine) => Number(l?.percentage ?? 0);
  const rail = (key: string) => ({
    // Whop didn't return this rail's fee: show it as unknown, never as free.
    known: Boolean(f.payouts?.[key]),
    whopFixed: amt(f.payouts?.[key]),
    whopPct: pct(f.payouts?.[key]),
    markupFixed: amt(f.markups?.payouts?.[key]),
    markupPct: pct(f.markups?.payouts?.[key]),
  });
  return { standard: rail("next_day_bank"), instant: rail("rtp"), crypto: rail("crypto") };
}
