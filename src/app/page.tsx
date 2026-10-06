import { Badge, Card, COUNTRY_NAMES, Page, SiteHeader, flag, money } from "@/components/ui";
import { sql } from "@/lib/db";
import { currentOperator } from "@/lib/seller-session";

export const dynamic = "force-dynamic";

const SIGNIN_ERRORS: Record<string, string> = {
  not_team: "That Whop account isn't on Ledgerly's team. Ask an owner to add you in Whop (Settings → Team), then try again.",
  cancelled: "Sign-in was cancelled on Whop.",
  expired: "That sign-in expired or was opened in another browser. Please try again.",
  failed: "Whop couldn't complete the sign-in. Please try again.",
  unavailable: "Sign in with Whop isn't set up on this deployment yet.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ signin?: string }> }) {
  const operator = await currentOperator();
  if (!operator) {
    const { signin } = await searchParams;
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
  const [sellers, orders, events, runs] = await Promise.all([
    sql()`select * from sellers order by created_at`,
    sql()`select * from orders where whop_payment_id is not null order by created_at desc limit 8`,
    sql()`select count(*)::int as n, count(*) filter (where processed_at is not null)::int as processed from webhook_events`,
    sql()`select * from job_runs where job = 'ops' order by started_at desc limit 1`,
  ]);
  const lastRun = runs[0];

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
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Ledgerly on Whop</h1>
          <p className="mt-2 max-w-2xl text-muted">
            Creators sell digital goods on Ledgerly. Whop runs checkout, holds balances, and pays sellers out in 40 countries.
            Ledgerly takes 8% of every sale.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Sellers" description="Connected accounts under Ledgerly's platform account." className="lg:col-span-2">
            <ul className="divide-y divide-line">
              {sellers.map((s) => (
                <li key={s.external_id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <p className="font-medium">
                      {flag(s.country)} {s.external_id}
                    </p>
                    <p className="text-xs text-muted">
                      {COUNTRY_NAMES[s.country] ?? s.country} · <span className="font-mono">{s.whop_account_id}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone={s.collection_mode === "direct" ? "good" : "neutral"}>
                      {s.collection_mode === "direct" ? "Direct charges" : "Platform-collected"}
                    </Badge>
                    <a className="text-sm text-accent-ink hover:underline" href={`/sellers/${s.external_id}`}>
                      Status →
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <div className="space-y-6">
            <Card title="Webhooks" description="Signed and stored; each one applied once.">
              <p className="text-3xl font-semibold tabular">{events[0].processed}</p>
              <p className="text-sm text-muted">of {events[0].n} events processed</p>
            </Card>
            <Card title="Books vs Whop" description="Hourly: sync payouts, reconcile every seller, settle shares.">
              {lastRun ? (
                <div className="flex items-center justify-between gap-3">
                  <Badge tone={lastRun.ok ? "good" : "bad"}>{lastRun.ok ? "All sellers match" : "Needs attention"}</Badge>
                  <span className="text-xs text-muted">
                    Run #{lastRun.id} ·{" "}
                    {new Date(lastRun.started_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted">No run yet.</p>
              )}
            </Card>
          </div>

          <Card title="Recent orders" className="lg:col-span-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-subtle">
                  <tr>
                    <th className="py-2 font-medium">Item</th>
                    <th className="py-2 font-medium">Seller</th>
                    <th className="py-2 font-medium">Flow</th>
                    <th className="py-2 text-right font-medium">Price</th>
                    <th className="py-2 text-right font-medium">Ledgerly 8%</th>
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
