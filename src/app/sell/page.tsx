import type { Metadata } from "next";
import Link from "next/link";
import { MarketHeader } from "@/components/market";
import { btnGhost, btnPrimary } from "@/components/styles";
import { Page } from "@/components/ui";
import { env } from "@/lib/env";
import { authUser } from "@/lib/seller-accounts";
import { currentSeller } from "@/lib/seller-session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sell on Ledgerly" };

const STEPS = [
  { title: "Open your store", body: "Sign up with email, Google or Whop, name your store and pick your country." },
  { title: "Verify with Whop", body: "Whop, our payments partner, checks your identity once. It takes a few minutes." },
  { title: "List and get paid", body: "Upload a file, set a price, and withdraw your earnings from your Seller Hub." },
];

export default async function SellPage() {
  const [seller, user] = await Promise.all([currentSeller(), authUser()]);
  const feePct = env().PLATFORM_FEE_BPS / 100;

  return (
    <>
      <MarketHeader />
      <Page>
        <section className="mx-auto max-w-2xl py-6 text-center sm:py-14">
          <p className="text-sm font-medium text-accent-ink">For creators</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Sell your presets, templates and sample packs</h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-muted">
            Ledgerly handles the storefront and delivery. Payments, identity checks and payouts run on Whop. You keep everything
            but a {feePct}% fee.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            {seller ? (
              <Link href="/sell/dashboard" className={btnPrimary}>
                Go to your dashboard
              </Link>
            ) : user ? (
              <Link href="/sell/onboard" className={btnPrimary}>
                Finish opening your store
              </Link>
            ) : (
              <>
                <Link href="/sell/signup" className={btnPrimary}>
                  Start selling
                </Link>
                <Link href="/sell/login" className={btnGhost}>
                  Log in
                </Link>
              </>
            )}
          </div>
        </section>

        <section className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title} className="rounded-2xl border border-line bg-surface p-5">
              <span className="grid size-8 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink">{i + 1}</span>
              <h2 className="mt-4 font-semibold">{s.title}</h2>
              <p className="mt-1.5 text-sm text-muted">{s.body}</p>
            </div>
          ))}
        </section>
      </Page>
    </>
  );
}
