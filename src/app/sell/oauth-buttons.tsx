"use client";

import { useState } from "react";
import { btnGhost } from "@/components/styles";
import { supabaseBrowser } from "@/lib/supabase/client";

// Google goes through Supabase Auth. Whop goes through our own server (/auth/whop/start): Whop
// requires an OIDC nonce that Supabase's custom providers don't send.
const PROVIDERS = [
  { id: "google", label: "Continue with Google", icon: <GoogleIcon /> },
  { id: "whop", label: "Continue with Whop", icon: <WhopIcon /> },
] as const;

/** Google / Whop sign-in; both end at the seller's dashboard (or opening their store). */
export function OAuthButtons() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(provider: (typeof PROVIDERS)[number]["id"]) {
    setBusy(provider);
    setError(null);
    if (provider === "whop") {
      // A full page load on purpose: the route handler redirects off-site to Whop.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/auth/whop/start");
      return;
    }
    try {
      const { error } = await supabaseBrowser().auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
    } catch (err) {
      setError((err as Error).message || "Couldn't start sign-in. Please try again.");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2.5">
      {PROVIDERS.map((p) => (
        <button key={p.id} type="button" onClick={() => go(p.id)} disabled={busy !== null} className={`${btnGhost} w-full`}>
          {p.icon}
          {busy === p.id ? "Redirecting…" : p.label}
        </button>
      ))}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}

function WhopIcon() {
  return (
    <span className="grid size-4 place-items-center rounded bg-[#ff6243] text-[9px] font-bold leading-none text-white" aria-hidden>
      W
    </span>
  );
}
