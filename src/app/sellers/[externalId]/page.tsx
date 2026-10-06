import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Avatar, Badge, Card, COUNTRY_NAMES, Page, SiteHeader, flag } from "@/components/ui";
import { getSellerOverview } from "@/lib/seller-overview";
import { currentSeller, isOperator } from "@/lib/seller-session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Seller onboarding" };

const CAPABILITY_LABELS: Record<string, string> = {
  accept_card_payments: "Accept card payments",
  accept_bank_payments: "Accept bank payments",
  standard_payout: "Standard bank payouts",
  instant_payout: "Instant payouts",
  crypto_payout: "Crypto payouts",
  transfer: "Send transfers",
};

export default async function SellerPage({
  params,
  searchParams,
}: {
  params: Promise<{ externalId: string }>;
  searchParams: Promise<{ onboarding?: string }>;
}) {
  const { externalId } = await params;
  const { onboarding } = await searchParams;
  // Onboarding returns sellers here before they're signed in to Ledgerly: show details only to
  // that seller or an operator, and a plain confirmation to everyone else.
  if (!(await isOperator()) && (await currentSeller()) !== externalId) {
    return (
      <>
        <SiteHeader section="Seller onboarding" />
        <Page>
          <div className="mx-auto max-w-lg">
            <Card
              title={onboarding === "refresh" ? "This link expired" : "Thanks, your details were submitted"}
              description={
                onboarding === "refresh"
                  ? "Ask Ledgerly for a new onboarding link."
                  : "Whop is reviewing them. Your verification status appears in your Ledgerly seller dashboard."
              }
            />
          </div>
        </Page>
      </>
    );
  }
  const s = await getSellerOverview(externalId);
  if (!s) notFound();
  const verified = s.identity === "approved";

  return (
    <>
      <SiteHeader section="Seller onboarding" />
      <Page>
        <div className="mx-auto max-w-2xl space-y-6">
          {onboarding === "done" && (
            <p className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-ink">
              Thanks! Your details were submitted. This page shows your live status from Whop.
            </p>
          )}
          {onboarding === "refresh" && (
            <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">
              That onboarding link expired. Ask Ledgerly for a fresh one.
            </p>
          )}

          <div className="flex items-center gap-4">
            <Avatar name={s.title} />
            <div className="flex-1">
              <h1 className="text-2xl font-semibold tracking-tight">{s.title}</h1>
              <p className="text-sm text-muted">
                {flag(s.country)} {COUNTRY_NAMES[s.country] ?? s.country} · <span className="font-mono text-xs">{s.accountId}</span>
              </p>
            </div>
            <Badge tone={verified ? "good" : "warn"}>{verified ? "Verified" : "Verification needed"}</Badge>
          </div>

          <Card title="Identity verification" description="Whop verifies every seller before money can leave their balance.">
            <p className="text-sm">
              Status: <span className="font-medium">{s.identity.replace("_", " ")}</span>
            </p>
          </Card>

          <Card title="Required actions">
            {s.requiredActions.length === 0 ? (
              <p className="text-sm text-accent-ink">Nothing left to do.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {s.requiredActions.map((a) => (
                  <li key={a.action} className="flex items-center justify-between">
                    {a.title}
                    <Badge tone="warn">{a.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="What this account can do">
            <ul className="grid gap-2 sm:grid-cols-2">
              {Object.entries(CAPABILITY_LABELS).map(([key, label]) => {
                const v = s.capabilities[key] ?? "inactive";
                return (
                  <li key={key} className="flex items-center justify-between rounded-xl border border-line px-3 py-2.5 text-sm">
                    {label}
                    <Badge tone={v === "active" ? "good" : v === "pending" ? "warn" : "neutral"}>{v}</Badge>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      </Page>
    </>
  );
}
