import { redirect } from "next/navigation";
import { AuthShell, MarketHeader, Notice } from "@/components/market";
import { Page } from "@/components/ui";
import { authUser } from "@/lib/seller-accounts";
import { currentSeller } from "@/lib/seller-session";
import { supabaseAuthEnabled } from "@/lib/supabase/server";
import { AuthForm } from "./auth-form";
import { OAuthButtons } from "./oauth-buttons";

const ERRORS: Record<string, string> = {
  link: "That link has expired or was opened in a different browser. Log in to continue.",
  cancelled: "Sign-in was cancelled. Try again whenever you're ready.",
};

/** The sign up and log in pages. Signed-in sellers skip straight to where they belong. */
export async function AuthPage({ mode, error }: { mode: "signup" | "login"; error?: string }) {
  if (await currentSeller()) redirect("/sell/dashboard");
  if (await authUser()) redirect("/sell/onboard");
  const enabled = supabaseAuthEnabled();

  return (
    <>
      <MarketHeader />
      <Page>
        <div className="py-4 sm:py-10">
          <AuthShell
            title={mode === "signup" ? "Start selling on Ledgerly" : "Log in to your store"}
            subtitle={mode === "signup" ? "Create your seller account. It takes a minute." : "Welcome back."}
          >
            {!enabled ? (
              <Notice tone="warn">Seller sign-in isn&apos;t set up on this site yet.</Notice>
            ) : (
              <div className="space-y-5">
                {error && ERRORS[error] && <Notice tone="warn">{ERRORS[error]}</Notice>}
                <OAuthButtons />
                <div className="flex items-center gap-3 text-xs text-subtle">
                  <span className="h-px flex-1 bg-line" />
                  or with email
                  <span className="h-px flex-1 bg-line" />
                </div>
                <AuthForm mode={mode} />
              </div>
            )}
          </AuthShell>
        </div>
      </Page>
    </>
  );
}
