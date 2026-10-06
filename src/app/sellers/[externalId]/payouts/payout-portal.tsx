"use client";

import { useEffect, useState } from "react";
import { loadWhop } from "@whop/elements";
import {
  ActivityElement,
  BalanceElement,
  Balances,
  Wallet,
  WhopElements,
  WithdrawElement,
} from "@whop/elements-react";

type Token = { token: string; expiresAt: string };

/** Fetches a short-lived, scoped token for this seller and refreshes it a minute before expiry. */
function useWalletToken(externalId: string) {
  const [token, setToken] = useState<Token | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const refresh = async () => {
      const res = await fetch(`/api/sellers/${encodeURIComponent(externalId)}/wallet-token`, { cache: "no-store" });
      if (!res.ok) return setError(`Could not load payouts (${res.status})`);
      const next: Token = await res.json();
      if (cancelled) return;
      setToken(next);
      const ms = new Date(next.expiresAt).getTime() - Date.now() - 60_000;
      timer = setTimeout(refresh, Math.max(ms, 10_000));
    };
    refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [externalId]);

  return { token, error };
}

export function PayoutPortal({ externalId, accountId }: { externalId: string; accountId: string }) {
  const { token, error } = useWalletToken(externalId);
  if (error) return <p className="text-red-600">{error}</p>;
  if (!token) return <p className="text-neutral-500">Loading your balance…</p>;

  return (
    <WhopElements elements={loadWhop()}>
      <Wallet accountId={accountId} accessToken={token.token} currency="usd">
        <section className="rounded-xl border p-4">
          <Balances>
            <BalanceElement />
          </Balances>
        </section>
        <section className="rounded-xl border p-4">
          <h2 className="mb-3 font-medium">Withdraw</h2>
          <WithdrawElement />
        </section>
        <section className="rounded-xl border p-4">
          <h2 className="mb-3 font-medium">Activity</h2>
          <ActivityElement />
        </section>
      </Wallet>
    </WhopElements>
  );
}
