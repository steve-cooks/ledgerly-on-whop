import Link from "next/link";
import type { ReactNode } from "react";
import { ModeToggle, OperatorNotice, ReminderButton, feeLabel, modeExplainer, requestTime, timeAgo } from "@/components/operator-controls";
import { Badge, Card, Page, SiteHeader, flag, money } from "@/components/ui";
import { sql } from "@/lib/db";
import { listSellers, needsVerification, verificationLabel, whopDashboardUrl } from "@/lib/operator";
import { currentOperator } from "@/lib/seller-session";

export const dynamic = "force-dynamic";

const SIGNIN_ERRORS: Record<string, string> = {
  not_team: "That Whop account isn't on Ledgerly's team. Ask an owner to add you in Whop (Settings → Team), then try again.",
  cancelled: "Sign-in was cancelled on Whop.",
  expired: "That sign-in expired or was opened in another browser. Please try again.",
  failed: "Whop couldn't complete the sign-in. Please try again.",
  unavailable: "Sign in with Whop isn't set up on this deployment yet.",
};

type Search = { signin?: string; q?: string; filter?: string; page?: string; notice?: string; seller?: string };

/** The console's own URL with the given list state (no notice), for links and form returns. */
function consoleHref(state: { q?: string; filter?: string; page?: number }) {
  const p = new URLSearchParams();
  if (state.filter && state.filter !== "needs_verification") p.set("filter", state.filter);
  if (state.q) p.set("q", state.q);
  if (state.page && state.page > 1) p.set("page", String(state.page));
  const qs = p.toString();
  return qs ? `/?${qs}` : "/";
}

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const operator = await currentOperator();
  const params = await searchParams;
  if (!operator) {
    const { signin } = params;
    const error = signin ? (SIGNIN_ERRORS[signin] ?? SIGNIN_ERRORS.failed) : null;
    return (
      <>
        <SiteHeader section="Operator console" />
        <Page>
          <div className="mx-auto mt-6 max-w-md space-y-4 sm:mt-16">
            <Card>
              <div className="space-y-5 py-2 text-center">
                <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-ink text-lg font-bold text-white">L</div>
                <div className="space-y-1.5">
                  <h1 className="text-xl font-semibold tracking-tight">Ledgerly operator console</h1>
                  <p className="text-sm text-muted">Sellers, orders and payment operations. For members of Ledgerly&apos;s Whop team.</p>
                </div>
                {error && <p className="rounded-xl bg-warn-soft px-4 py-3 text-left text-sm text-warn">{error}</p>}
                <a
                  href="/api/auth/whop/start"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm font-medium text-white transition hover:opacity-90"
                >
                  Sign in with Whop
                </a>
                <p className="text-xs leading-relaxed text-subtle">
                  You&apos;ll confirm on Whop, then come straight back. Owners, admins, managers and support staff on Ledgerly&apos;s Whop team can sign in.
                </p>
              </div>
            </Card>
            <p className="text-center text-xs text-subtle">Selling on Ledgerly? Your payouts are in your Ledgerly seller dashboard.</p>
          </div>
        </Page>
      </>
    );
  }
  const [list, orders, events, runs] = await Promise.all([
    listSellers({ q: params.q, filter: params.filter, page: params.page }),
    sql()`select * from orders where whop_payment_id is not null order by created_at desc limit 8`,
    sql()`select count(*)::int as n, count(*) filter (where processed_at is not null)::int as processed from webhook_events`,
    sql()`select * from job_runs where job = 'ops' order by started_at desc limit 1`,
  ]);
  const lastRun = runs[0];
  const now = requestTime();
  const back = consoleHref({ q: list.q, filter: list.filter, page: list.page });
  const explain = modeExplainer();
  const first = (list.page - 1) * 25 + 1;
  const last = first + list.rows.length - 1;

  return (
    <>
      <SiteHeader
        section="Operator console"
        right={
          <form action="/api/auth/signout" method="post" className="flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">
              Signed in as <span className="font-medium text-ink">{operator.name}</span>
            </span>
            <button type="submit" className="rounded-lg border border-line px-3 py-1.5 font-medium text-ink transition hover:bg-bg">
              Sign out
            </button>
          </form>
        }
      />
      <Page>
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Ledgerly on Whop</h1>
            <p className="mt-2 max-w-2xl text-muted">
              Chase verification and set how each seller gets paid. Balances, payments, refunds and compliance live in Whop&apos;s dashboard.
            </p>
          </div>
          <a
            href={whopDashboardUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center justify-center rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-bg"
          >
            All sellers in Whop ↗
          </a>
        </div>

        {params.notice && (
          <div className="mb-6">
            <OperatorNotice notice={params.notice} seller={params.seller} now={now} />
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Needs verification" description="Sellers Whop hasn't fully verified yet.">
            <p className="text-3xl font-semibold tabular">{list.counts.needsVerification}</p>
            <p className="text-sm text-muted">{q(list.q)}of {list.counts.all} sellers</p>
          </Card>
          <Card title="Webhooks" description="Signed and stored; each one applied once.">
            <p className="text-3xl font-semibold tabular">{events[0].processed}</p>
            <p className="text-sm text-muted">of {events[0].n} events processed</p>
          </Card>
          <Card title="Books vs Whop" description="Hourly: sync payouts, reconcile every seller, settle shares.">
            {lastRun ? (
              <div className="space-y-2">
                <Badge tone={lastRun.ok ? "good" : "bad"}>{lastRun.ok ? "All sellers match" : "Needs attention"}</Badge>
                <p className="text-xs text-muted">
                  Run #{lastRun.id} ·{" "}
                  {new Date(lastRun.started_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted">No run yet.</p>
            )}
          </Card>

          <Card
            title="Sellers"
            description="Verification is mirrored from Whop; payment mode and Ledgerly fee apply to new purchases only."
            className="lg:col-span-3"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <nav className="inline-flex rounded-xl border border-line bg-bg p-1 text-sm" aria-label="Filter sellers">
                {(
                  [
                    ["needs_verification", "Needs verification", list.counts.needsVerification],
                    ["all", "All sellers", list.counts.all],
                  ] as const
                ).map(([value, label, n]) => (
                  <Link
                    key={value}
                    href={consoleHref({ q: list.q, filter: value })}
                    aria-current={list.filter === value ? "page" : undefined}
                    className={`rounded-lg px-3 py-1.5 font-medium transition ${
                      list.filter === value ? "bg-surface text-ink shadow-[0_1px_2px_rgba(15,26,23,0.08)]" : "text-muted hover:text-ink"
                    }`}
                  >
                    {label} <span className="tabular text-subtle">{n}</span>
                  </Link>
                ))}
              </nav>
              <form action="/" method="get" className="flex gap-2" role="search">
                {list.filter !== "needs_verification" && <input type="hidden" name="filter" value={list.filter} />}
                <input
                  type="search"
                  name="q"
                  defaultValue={list.q}
                  placeholder="Search id, email or name"
                  aria-label="Search sellers"
                  className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-subtle focus:border-accent sm:w-64"
                />
                <button type="submit" className="rounded-xl border border-line px-3 py-2 text-sm font-medium text-ink transition hover:bg-bg">
                  Search
                </button>
              </form>
            </div>

            <dl className="mt-4 grid gap-1 text-xs text-muted sm:grid-cols-2">
              <div>
                <dt className="inline font-medium text-ink">Direct: </dt>
                <dd className="inline">{explain.direct}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-ink">Platform: </dt>
                <dd className="inline">{explain.platform}</dd>
              </div>
            </dl>

            {list.rows.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
                {list.q
                  ? `No sellers match “${list.q}”.`
                  : list.filter === "needs_verification"
                    ? "Every seller is verified. Nothing to chase."
                    : "No sellers yet."}
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-subtle">
                    <tr>
                      <th className="py-2 font-medium">Seller</th>
                      <th className="py-2 font-medium">Verification</th>
                      <th className="py-2 font-medium">Payment mode</th>
                      <th className="py-2 font-medium">Ledgerly fee</th>
                      <th className="py-2 font-medium">Last reminder</th>
                      <th className="py-2 text-right font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {list.rows.map((s) => {
                      const v = verificationLabel(s);
                      return (
                        <tr key={s.external_id} className="align-middle">
                          <td className="py-3 pr-4">
                            <a className="font-medium text-ink hover:underline" href={`/sellers/${encodeURIComponent(s.external_id)}`}>
                              <span aria-hidden>{flag(s.country)}</span> {s.title ?? s.external_id}
                            </a>
                            <p className="font-mono text-xs text-muted">{s.external_id}</p>
                          </td>
                          <td className="py-3 pr-4">
                            <Badge tone={v.tone}>{v.label}</Badge>
                          </td>
                          <td className="py-3 pr-4">
                            <ModeToggle externalId={s.external_id} mode={s.collection_mode} back={back} />
                          </td>
                          <td className="py-3 pr-4 tabular">
                            <span className={s.fee_bps == null ? "whitespace-nowrap text-muted" : "font-medium text-ink"}>{feeLabel(s.fee_bps)}</span>
                          </td>
                          <td className="py-3 pr-4 text-muted">{s.last_reminder_at ? timeAgo(s.last_reminder_at, now) : "Never"}</td>
                          <td className="py-3">
                            <div className="flex items-center justify-end gap-3">
                              {s.whop_account_id && needsVerification(s) && (
                                <ReminderButton externalId={s.external_id} back={back} lastSentAt={s.last_reminder_at} now={now} />
                              )}
                              {s.whop_account_id && (
                                <a
                                  href={whopDashboardUrl(s.whop_account_id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="whitespace-nowrap text-xs font-medium text-accent-ink hover:underline"
                                >
                                  Open in Whop ↗
                                </a>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {list.total > 0 && (
              <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                <p className="text-muted">
                  <span className="tabular">
                    {first}–{last}
                  </span>{" "}
                  of <span className="tabular">{list.total}</span>
                </p>
                <div className="flex gap-2">
                  <PageLink href={list.page > 1 ? consoleHref({ q: list.q, filter: list.filter, page: list.page - 1 }) : null}>← Previous</PageLink>
                  <PageLink href={list.page < list.pages ? consoleHref({ q: list.q, filter: list.filter, page: list.page + 1 }) : null}>Next →</PageLink>
                </div>
              </div>
            )}
          </Card>

          <Card title="Recent orders" className="lg:col-span-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-subtle">
                  <tr>
                    <th className="py-2 font-medium">Item</th>
                    <th className="py-2 font-medium">Seller</th>
                    <th className="py-2 font-medium">Flow</th>
                    <th className="py-2 text-right font-medium">Price</th>
                    <th className="py-2 text-right font-medium">Ledgerly fee</th>
                    <th className="py-2 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="py-3">
                        <a className="hover:underline" href={`/orders/${o.id}`}>
                          {o.title}
                        </a>
                      </td>
                      <td className="py-3 text-muted">{o.seller_external_id}</td>
                      <td className="py-3 text-muted">{o.flow === "direct" ? "Direct charge" : "Charge + transfer"}</td>
                      <td className="py-3 text-right tabular">{money(o.amount, o.currency)}</td>
                      <td className="py-3 text-right tabular">{money(o.platform_fee, o.currency)}</td>
                      <td className="py-3 text-right">
                        <Badge tone={o.status === "paid" ? "good" : o.status === "failed" ? "bad" : "neutral"}>{o.status.replace("_", " ")}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </Page>
    </>
  );
}

function q(search: string) {
  return search ? `matching “${search}”, ` : "";
}

function PageLink({ href, children }: { href: string | null; children: ReactNode }) {
  const cls = "rounded-lg border border-line px-3 py-1.5 font-medium";
  return href ? (
    <Link href={href} className={`${cls} text-ink transition hover:bg-bg`}>
      {children}
    </Link>
  ) : (
    <span className={`${cls} cursor-not-allowed text-subtle`} aria-disabled="true">
      {children}
    </span>
  );
}
