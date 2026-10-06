import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Avatar, Badge, Card, COUNTRY_NAMES, Page, SiteHeader, flag } from "@/components/ui";
import { getSellerOverview } from "@/lib/seller-overview";
import { currentSeller } from "@/lib/seller-session";
import { PayoutBalance, PayoutWithdraw, PayoutActivity, WalletProvider } from "./payout-portal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage({
  params,
  searchParams,
}: {
  params: Promise<{ externalId: string }>;
  searchParams: Promise<{ portal?: string }>;
}) {
  const { externalId } = await params;
  const { portal } = await searchParams;
  const signedIn = await currentSeller();
  if (signedIn !== externalId) {
    return (
      <>
        <SiteHeader section="Seller Hub" />
        <Page>
          <Card title="Sign in required" description="Open your Ledgerly sign-in link to view your payouts." />
        </Page>
      </>
    );
  }
  const s = await getSellerOverview(externalId);
  if (!s) notFound();
  const portalHref = `/api/sellers/${encodeURIComponent(externalId)}/payouts-portal`;

  return (
    <>
      <SiteHeader
        section="Seller Hub"
        right={
          <span className="flex items-center gap-2 text-sm text-muted">
            Signed in as <span className="font-medium text-ink">{s.title}</span>
          </span>
        }
      />
      <Page>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <Avatar name={s.title} />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{s.title}</h1>
              <p className="mt-0.5 text-sm text-muted">
                {flag(s.country)} {COUNTRY_NAMES[s.country] ?? s.country} ·{" "}
                {s.collectionMode === "direct" ? "Paid directly at checkout" : "Paid out by Ledgerly"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={s.identity === "approved" ? "good" : "warn"}>
              {s.identity === "approved" ? "Identity verified" : "Verification needed"}
            </Badge>
            <Badge tone={s.canWithdraw ? "good" : "warn"}>{s.canWithdraw ? "Withdrawals enabled" : "Withdrawals locked"}</Badge>
            {s.status === "suspended" && <Badge tone="bad">Suspended</Badge>}
          </div>
        </div>

        {portal === "expired" && (
          <p className="mt-6 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">
            Your Whop payouts portal session expired. Open it again from the panel on the right.
          </p>
        )}

        <WalletProvider externalId={externalId} accountId={s.accountId}>
          <div className="mt-8 grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card title="Balance" description="Sales settle 1–2 business days after purchase.">
                <PayoutBalance />
              </Card>
              <Card title="Withdraw" description="Send your available balance to your bank or wallet.">
                <PayoutWithdraw />
              </Card>
            </div>

            <div className="space-y-6">
              <Card title="Payout fees" description="Charged when you withdraw.">
                {s.payoutFees ? (
                  <div className="divide-y divide-line">
                    <FeeRow label="Standard bank" sub="1–3 business days" rail={s.payoutFees.standard} />
                    <FeeRow label="Instant bank" sub="Minutes, via RTP" rail={s.payoutFees.instant} />
                    <FeeRow label="Crypto (USDT)" sub="Minutes" rail={s.payoutFees.crypto} />
                  </div>
                ) : (
                  <p className="text-sm text-muted">Fees are unavailable right now. The withdraw form shows the exact fee before you confirm.</p>
                )}
                {!s.canInstant && (
                  <p className="mt-3 text-xs leading-relaxed text-subtle">Instant bank payouts aren&apos;t enabled on your account yet.</p>
                )}
              </Card>

              {s.requiredActions.length > 0 && (
                <Card title="To do" description="Finish these to keep getting paid.">
                  <ul className="space-y-2 text-sm">
                    {s.requiredActions.map((a) => (
                      <li key={a.action} className="flex items-start gap-2">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />
                        {a.title}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card title="Prefer Whop's portal?" description="Manage payout methods and withdrawals on a page hosted by Whop.">
                <a
                  href={portalHref}
                  className="inline-flex w-full items-center justify-center rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-bg"
                >
                  Open hosted payouts portal ↗
                </a>
              </Card>
            </div>

            <div className="lg:col-span-3">
              {/* Whop's activity element renders its own heading and filters. */}
              <Card>
                <PayoutActivity />
              </Card>
            </div>
          </div>
        </WalletProvider>
      </Page>
    </>
  );
}

type Rail = { known: boolean; whopFixed: number; whopPct: number; markupFixed: number; markupPct: number };

function feeText(fixed: number, pct: number) {
  const parts = [pct ? `${pct}%` : "", fixed ? `$${fixed.toFixed(2)}` : ""].filter(Boolean);
  return parts.length ? parts.join(" + ") : "Free";
}

function FeeRow({ label, sub, rail }: { label: string; sub: string; rail: Rail }) {
  const hasMarkup = rail.markupFixed > 0 || rail.markupPct > 0;
  return (
    <div className="flex items-start justify-between gap-4 py-3 text-sm">
      <div>
        <p className="font-medium text-ink">{label}</p>
        <p className="text-xs text-subtle">{sub}</p>
      </div>
      <div className="text-right tabular">
        <p className="font-medium text-ink">{rail.known ? feeText(rail.whopFixed, rail.whopPct) : "Shown at withdrawal"}</p>
        {rail.known && hasMarkup && <p className="text-xs text-accent-ink">+ {feeText(rail.markupFixed, rail.markupPct)} Ledgerly</p>}
      </div>
    </div>
  );
}
