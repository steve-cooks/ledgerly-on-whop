import Link from "next/link";
import type { ReactNode } from "react";
import { authUser } from "@/lib/seller-accounts";
import { currentSeller } from "@/lib/seller-session";
import { Logo } from "./ui";

/** The marketplace's header: Shop, selling, and the signed-in seller's account. */
export async function MarketHeader() {
  const [user, seller] = await Promise.all([authUser().catch(() => null), currentSeller().catch(() => null)]);
  const sellHref = seller ? "/sell/dashboard" : user ? "/sell/onboard" : "/sell";
  const sellLabel = seller ? "Dashboard" : user ? "Open your store" : (
    <>
      Sell<span className="hidden sm:inline"> on Ledgerly</span>
    </>
  );

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-5">
          <Logo href="/shop" />
          <nav className="flex items-center gap-4 text-sm">
            <NavLink href="/shop">Shop</NavLink>
            <NavLink href={sellHref}>{sellLabel}</NavLink>
          </nav>
        </div>
        {user || seller ? (
          <form action="/auth/signout" method="post">
            <button className="text-sm font-medium text-muted hover:text-ink">Sign out</button>
          </form>
        ) : (
          <Link href="/sell/login" className="text-sm font-medium text-muted hover:text-ink">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-muted hover:text-ink">
      {children}
    </Link>
  );
}

/** A centred card for sign-in style pages. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
      <div className="mt-6 rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(15,26,23,0.04)] sm:p-6">{children}</div>
    </div>
  );
}

export function Notice({ tone = "good", children }: { tone?: "good" | "warn" | "bad"; children: ReactNode }) {
  const cls = { good: "bg-accent-soft text-accent-ink", warn: "bg-warn-soft text-warn", bad: "bg-danger-soft text-danger" }[tone];
  return (
    <p role={tone === "bad" ? "alert" : "status"} className={`rounded-xl px-4 py-3 text-sm ${cls}`}>
      {children}
    </p>
  );
}

/** A deterministic soft colour block standing in for product artwork. */
export function ProductArt({ id, title, className = "" }: { id: string; title: string; className?: string }) {
  const hues = [158, 172, 190, 140, 32, 210, 260, 340];
  const hue = hues[parseInt(id.replace(/-/g, "").slice(0, 2), 16) % hues.length];
  return (
    <div
      className={`grid place-items-center overflow-hidden ${className}`}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 92%), hsl(${hue} 45% 82%))` }}
      aria-hidden
    >
      <span className="px-4 text-center text-lg font-semibold tracking-tight" style={{ color: `hsl(${hue} 45% 28%)` }}>
        {title.split(/\s+/).slice(0, 3).join(" ")}
      </span>
    </div>
  );
}
