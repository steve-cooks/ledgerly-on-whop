import { Badge, Card, COUNTRY_NAMES, Page, SiteHeader, flag, money } from "@/components/ui";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [sellers, orders, events] = await Promise.all([
    sql()`select * from sellers order by created_at`,
    sql()`select * from orders where whop_payment_id is not null order by created_at desc limit 8`,
    sql()`select count(*)::int as n, count(*) filter (where processed_at is not null)::int as processed from webhook_events`,
  ]);

  return (
    <>
      <SiteHeader section="Operator console" />
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

          <Card title="Webhooks" description="Signed, stored once, processed exactly once.">
            <p className="text-3xl font-semibold tabular">{events[0].processed}</p>
            <p className="text-sm text-muted">of {events[0].n} events processed</p>
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
