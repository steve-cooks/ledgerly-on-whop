import type { Metadata } from "next";
import Link from "next/link";
import { MarketHeader, ProductArt } from "@/components/market";
import { Page, money } from "@/components/ui";
import { shopProducts } from "@/lib/products";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shop" };

export default async function ShopPage() {
  const products = await shopProducts();
  return (
    <>
      <MarketHeader />
      <Page>
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Shop</h1>
          <p className="mt-2 text-muted">Presets, templates and sample packs from independent creators. Instant download.</p>
        </div>
        {products.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-surface px-6 py-16 text-center">
            <p className="font-medium">Nothing for sale yet</p>
            <p className="mt-1 text-sm text-muted">
              Are you a creator?{" "}
              <Link href="/sell" className="font-medium text-accent-ink hover:underline">
                Be the first to sell on Ledgerly
              </Link>
              .
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/shop/${p.id}`}
                  className="group block overflow-hidden rounded-2xl border border-line bg-surface transition-shadow hover:shadow-[0_4px_16px_rgba(15,26,23,0.08)]"
                >
                  <ProductArt id={p.id} title={p.title} className="aspect-[4/3]" />
                  <div className="flex items-start justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink group-hover:underline">{p.title}</p>
                      <p className="mt-0.5 truncate text-sm text-muted">{p.storeName}</p>
                    </div>
                    <p className="tabular shrink-0 font-semibold">{money(p.price)}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Page>
    </>
  );
}
