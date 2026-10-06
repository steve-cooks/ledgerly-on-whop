import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { sellerForUser } from "@/lib/seller-accounts";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Supabase sends sellers back here after Google / Whop sign-in (?code=, PKCE) or from the
 * email confirmation link (?code=, or ?token_hash=&type= with a custom email template).
 * Sellers with a store go to their dashboard; new ones go on to open their store.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  if (p.get("error")) redirect("/sell/login?error=cancelled");

  const auth = (await supabaseServer()).auth;
  const code = p.get("code");
  const tokenHash = p.get("token_hash");
  const type = p.get("type") as EmailOtpType | null;
  const { data, error } = code
    ? await auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await auth.verifyOtp({ token_hash: tokenHash, type })
      : { data: { user: null }, error: new Error("missing code") };
  // Usually a link opened in a different browser than the one that started sign-in, or reused.
  if (error || !data.user) redirect("/sell/login?error=link");

  redirect((await sellerForUser(data.user.id)) ? "/sell/dashboard" : "/sell/onboard");
}
