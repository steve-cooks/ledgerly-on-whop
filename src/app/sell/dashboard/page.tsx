import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MarketHeader, Notice } from "@/components/market";
import { btnGhost, btnPrimary } from "@/components/styles";
import { Badge, Card, Page, money } from "@/components/ui";
import { sql } from "@/lib/db";
import { sellerProducts } from "@/lib/products";
import { authUser } from "@/lib/seller-accounts";
import { getSellerOverview } from "@/lib/seller-overview";
import { currentSeller } from "@/lib/seller-session";
import { toggleProductAction } from "../actions";
import { AddProductForm } from "./add-product-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Seller dashboard" };

export default async function DashboardPage() {
  const seller = await currentSeller();
  if (!seller) redirect((await authUser()) ? "/sell/onboard" : "/sell/login");

  const [[row], products, overview] = await Promise.all([
    sql()`
      select coalesce(su.store_name, s.external_id) as store_name, s.whop_account_id
      from sellers s left join seller_users su on su.seller_external_id = s.external_id
      where s.external_id = ${seller}`,
    sellerProducts(seller),
    // Live status from Whop; the dashboard still works if Whop can't be reached.
    getSellerOverview(seller).catch((err) => {
      console.error("seller overview failed", (err as Error).message);
      return undefined;
    }),
  ]);
  if (!row) redirect("/sell/onboard");

  const id = encodeURIComponent(seller);
  const verified = overview ? overview.identity === "approved" && overview.requiredActions.length === 0 : false;
  const status = !row.whop_account_id
    ? { tone: "warn" as const, label: "Not started", note: "Verify your identity with Whop to start selling." }
    : overview === undefined
      ? { tone: "neutral" as const, label: "Unavailable", note: "We couldn't reach Whop just now. Refresh in a moment." }
      : verified
        ? { tone: "good" as const, label: "Verified", note: "You're all set to sell and get paid." }
        : { tone: "warn" as const, label: "Action needed", note: "You can sell now. Finish verifying your identity with Whop to withdraw your earnings." };

  return (
    <>
      <MarketHeader />
      <Page>
        <div className="mb-8 flex flex-col gap-1">
          <p className="text-sm text-muted">Seller dashboard</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{row.store_name}</h1>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="order-2 space-y-6 lg:order-1">
            <Card title="Your products" description={products.length ? `${products.length} listed` : undefined}>
              {products.length === 0 ? (
                <p className="text-sm text-muted">No products yet. Add your first one below.</p>
              ) : (
                <ul className="-my-1 divide-y divide-line">
                  {products.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                      <div className="min-w-0 flex-1">
                        <Link href={`/shop/${p.id}`} className="block truncate font-medium text-ink hover:underline">
                          {p.title}
                        </Link>
                        <p className="mt-0.5 text-sm text-muted">
                          <span className="tabular">{money(p.price)}</span> · {p.sales} {p.sales === 1 ? "sale" : "sales"}
                          {p.fileName && <span className="hidden sm:inline"> · {p.fileName}</span>}
                        </p>
                      </div>
                      <form action={toggleProductAction} className="flex items-center gap-3">
                        <input type="hidden" name="productId" value={p.id} />
                        <input type="hidden" name="active" value={String(!p.active)} />
                        <Badge tone={p.active ? "good" : "neutral"}>{p.active ? "On sale" : "Hidden"}</Badge>
                        <button className="text-sm font-medium text-accent-ink hover:underline">{p.active ? "Hide" : "Put on sale"}</button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Add a product" description="Buyers pay through Whop's secure checkout and download the file right after.">
              <AddProductForm />
            </Card>
          </div>

          <div className="order-1 space-y-6 lg:order-2">
            <Card title="Verification" action={<Badge tone={status.tone}>{status.label}</Badge>}>
              <p className="text-sm text-muted">{status.note}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {!verified && (
                  <a href={`/api/sellers/${id}/onboarding-link`} className={btnPrimary}>
                    Continue verification
                  </a>
                )}
                <Link href={`/sellers/${id}`} className={btnGhost}>
                  Account status
                </Link>
              </div>
            </Card>
            <Card title="Earnings and payouts" description="See your balance and withdraw to your bank in the Seller Hub.">
              <Link href={`/sellers/${id}/payouts`} className={`${btnGhost} w-full`}>
                Open Seller Hub
              </Link>
            </Card>
            {status.tone === "warn" && products.length > 0 && (
              <Notice tone="warn">Buyers can&apos;t pay you until you&apos;re verified.</Notice>
            )}
          </div>
        </div>
      </Page>
    </>
  );
}
