"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { loadWhop } from "@whop/elements";
import { ActivityElement, Balances, BreakdownElement, Wallet, WhopElements, WithdrawElement } from "@whop/elements-react";

type Token = { token: string; expiresAt: string };

// Match Whop's embedded elements to Ledgerly's light, jade-accented UI.
const APPEARANCE = { theme: { appearance: "light", accentColor: "jade", grayColor: "sage" } } as const;

/** Fetches a short-lived, scoped token for this seller and refreshes it a minute before expiry. */
function useWalletToken(externalId: string) {
  const [token, setToken] = useState<Token | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const refresh = async () => {
      const res = await fetch(`/api/sellers/${encodeURIComponent(externalId)}/wallet-token`, { cache: "no-store" });
      if (!res.ok) return setError(`We couldn't load your payouts (${res.status}). Try refreshing.`);
      const next: Token = await res.json();
      if (cancelled) return;
      setToken(next);
      timer = setTimeout(refresh, Math.max(new Date(next.expiresAt).getTime() - Date.now() - 60_000, 10_000));
    };
    refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [externalId]);
  return { token, error };
}

const Ready = createContext(false);

export function WalletProvider({ externalId, accountId, children }: { externalId: string; accountId: string; children: ReactNode }) {
  const { token, error } = useWalletToken(externalId);
  if (error) return <p className="mt-8 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p>;
  if (!token) return <Ready.Provider value={false}>{children}</Ready.Provider>;
  return (
    <WhopElements elements={loadWhop()} appearance={APPEARANCE}>
      <Wallet accountId={accountId} accessToken={token.token} currency="usd">
        <Ready.Provider value={true}>{children}</Ready.Provider>
      </Wallet>
    </WhopElements>
  );
}

function Skeleton({ h }: { h: string }) {
  return <div className={`${h} animate-pulse rounded-xl bg-bg`} />;
}

export function PayoutBalance() {
  return useContext(Ready) ? (
    <Balances>
      <BreakdownElement />
    </Balances>
  ) : (
    <Skeleton h="h-40" />
  );
}

export function PayoutWithdraw() {
  return useContext(Ready) ? <WithdrawElement /> : <Skeleton h="h-64" />;
}

export function PayoutActivity() {
  return useContext(Ready) ? <ActivityElement /> : <Skeleton h="h-72" />;
}
