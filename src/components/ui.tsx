import Link from "next/link";
import type { ReactNode } from "react";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-ink">
      <span className="grid size-7 place-items-center rounded-lg bg-ink text-[13px] font-bold text-white">L</span>
      Ledgerly
    </Link>
  );
}

export function SiteHeader({ section, right }: { section?: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Logo />
          {section && (
            <>
              <span className="h-5 w-px bg-line" />
              <span className="text-sm text-muted">{section}</span>
            </>
          )}
        </div>
        {right}
      </div>
    </header>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>;
}

export function Card({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(15,26,23,0.04)] ${className}`}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="px-5 pb-5 pt-4 sm:px-6">{children}</div>
    </section>
  );
}

type Tone = "good" | "warn" | "bad" | "neutral";
const tones: Record<Tone, string> = {
  good: "bg-accent-soft text-accent-ink",
  warn: "bg-warn-soft text-warn",
  bad: "bg-danger-soft text-danger",
  neutral: "bg-bg text-muted ring-1 ring-line",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone]}`}>
      <span className="size-1.5 rounded-full bg-current opacity-80" />
      {children}
    </span>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft text-base font-semibold text-accent-ink">
      {initials}
    </span>
  );
}

export function flag(country: string) {
  return String.fromCodePoint(...[...country.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export const COUNTRY_NAMES: Record<string, string> = { US: "United States", DE: "Germany", BR: "Brazil" };

export function money(amount: number | string, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(Number(amount));
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium text-ink">{children}</span>
    </div>
  );
}
