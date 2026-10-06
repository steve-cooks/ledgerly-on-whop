import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ModeToggle, OperatorNotice, ReminderButton, formatDate, modeExplainer, requestTime, timeAgo } from "@/components/operator-controls";
import { Avatar, Badge, Card, COUNTRY_NAMES, Page, SiteHeader, flag } from "@/components/ui";
import { REMINDER_VISIBLE_MS, lastReminder, whopDashboardUrl } from "@/lib/operator";
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
  searchParams: Promise<{ onboarding?: string; notice?: string; seller?: string }>;
}) {
  const { externalId } = await params;
  const { onboarding, notice, seller: noticeSeller } = await searchParams;
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
                  ? "Sign in to your Ledgerly seller account to get a new one."
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
  const isSeller = (await currentSeller()) === externalId;
  const needsVerification = !verified || s.requiredActions.length > 0;
  const operator = await isOperator();
  const reminder = await lastReminder(externalId);
  const now = requestTime();
  const recentReminder = reminder && now - reminder.sent_at.getTime() < REMINDER_VISIBLE_MS ? reminder : null;
  const back = `/sellers/${encodeURIComponent(externalId)}`;
  const explain = modeExplainer();

  return (
    <>
      <SiteHeader section="Seller onboarding" />
      <Page>
        <div className="mx-auto max-w-2xl space-y-6">
          {operator && notice && <OperatorNotice notice={notice} seller={noticeSeller} now={now} />}
          {onboarding === "done" && (
            <p className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-ink">
              Thanks! Your details were submitted. This page shows your live status from Whop.
            </p>
          )}
          {onboarding === "refresh" && (
            <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">
              That onboarding link expired. {isSeller ? "Get a new one below." : "The seller can get a new one from this page."}
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

          {operator && (
            <Card
              title="Operator tools"
              description="Only Ledgerly staff see this."
              action={
                <a
                  href={whopDashboardUrl(s.accountId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="whitespace-nowrap text-sm font-medium text-accent-ink hover:underline"
                >
                  Open in Whop ↗
                </a>
              }
            >
              <div className="divide-y divide-line">
                <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <p className="font-medium text-ink">Verification reminder</p>
                    <p className="text-muted">
                      {reminder ? `Last sent ${timeAgo(reminder.sent_at, now)} by ${reminder.sent_by}.` : "No reminder sent yet."} The seller sees it
                      on this page.
                    </p>
                  </div>
                  {needsVerification ? (
                    <ReminderButton externalId={externalId} back={back} lastSentAt={reminder?.sent_at ?? null} now={now} />
                  ) : (
                    <Badge tone="good">Nothing to chase</Badge>
                  )}
                </div>
                <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <p className="font-medium text-ink">Payment mode</p>
                    <p className="text-muted">{explain[s.collectionMode]} Applies to new purchases.</p>
                  </div>
                  <ModeToggle externalId={externalId} mode={s.collectionMode} back={back} />
                </div>
              </div>
            </Card>
          )}

          {isSeller && (
            <a
              href={`/sellers/${encodeURIComponent(externalId)}/payouts`}
              className={`flex items-center justify-between rounded-2xl border px-5 py-4 text-sm transition ${
                needsVerification ? "border-line bg-surface hover:bg-bg" : "border-accent bg-accent-soft hover:opacity-90"
              }`}
            >
              <span>
                <span className="block font-medium text-ink">Seller Hub</span>
                <span className="text-muted">
                  {needsVerification ? "See your balance now. Withdrawals unlock once you're verified." : "Your balance, withdrawals and payout history."}
                </span>
              </span>
              <span className="font-medium text-accent-ink">Open →</span>
            </a>
          )}

          <Card title="Identity verification" description="Whop verifies every seller before money can leave their balance.">
            <p className="text-sm">
              Status: <span className="font-medium">{s.identity.replace("_", " ")}</span>
            </p>
            {isSeller && needsVerification && recentReminder && (
              <p className="mt-4 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">
                Ledgerly asked you to finish verification on {formatDate(recentReminder.sent_at)}. Withdrawals unlock once Whop has verified
                you.
              </p>
            )}
            {isSeller && needsVerification && (
              <a
                href={`/api/sellers/${encodeURIComponent(externalId)}/onboarding-link`}
                className="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-ink"
              >
                {onboarding === "refresh" ? "Get a new link" : "Continue verification on Whop"} ↗
              </a>
            )}
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
