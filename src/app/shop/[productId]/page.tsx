import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketHeader, Notice, ProductArt } from "@/components/market";
import { btnAccent } from "@/components/styles";
import { Page, money } from "@/components/ui";
import { shopProduct } from "@/lib/products";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ productId: string }> }): Promise<Metadata> {
  const product = await shopProduct((await params).productId);
  return { title: product?.title ?? "Product" };
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const product = await shopProduct((await params).productId);
  if (!product) notFound();
  const { error } = await searchParams;

  return (
    <>
      <MarketHeader />
      <Page>
        <Link href="/shop" className="text-sm font-medium text-muted hover:text-ink">
          ← Back to shop
        </Link>
        <div className="mt-6 grid gap-8 md:grid-cols-2 md:gap-12">
          <ProductArt id={product.id} title={product.title} className="aspect-[4/3] rounded-2xl border border-line" />
          <div>
            <p className="text-sm text-muted">by {product.storeName}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{product.title}</h1>
            <p className="tabular mt-4 text-2xl font-semibold">{money(product.price)}</p>
            {product.description && <p className="mt-6 whitespace-pre-line text-muted">{product.description}</p>}
            {error && (
              <div className="mt-6">
                <Notice tone="bad">We couldn&apos;t start checkout just now. Please try again in a moment.</Notice>
              </div>
            )}
            <form action={`/shop/${product.id}/buy`} method="post" className="mt-8">
              {/* One purchase attempt per page view: a double click opens one order, not two. */}
              <input type="hidden" name="nonce" value={randomUUID()} />
              <button className={`${btnAccent} h-12 w-full text-base sm:w-auto sm:px-8`}>Buy for {money(product.price)}</button>
            </form>
            <ul className="mt-6 space-y-1.5 text-sm text-muted">
              <li>✓ Secure checkout by Whop. No account needed.</li>
              <li>✓ Download right after payment.</li>
            </ul>
          </div>
        </div>
      </Page>
    </>
  );
}
