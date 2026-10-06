import { supabaseAdmin, supabaseServer } from "./supabase/server";
import type { WhopUser } from "./whop-oauth";

/**
 * "Continue with Whop" for sellers. Whop requires an OIDC nonce that Supabase's custom
 * providers don't send, so our server runs the Whop OAuth round trip itself (as it does for
 * staff) and then starts the seller's Supabase session:
 *  1. the Whop user must have a verified email;
 *  2. find or create the Supabase user with that email (confirmed, since Whop verified it);
 *  3. mint a one-time sign-in token for them and redeem it here, which sets the session cookies.
 * Returns the Supabase user id, or a reason the sign-in can't go ahead.
 */
export async function startSellerSessionFromWhop(user: WhopUser): Promise<{ userId: string } | { error: "no_email" }> {
  if (!user.email || !user.emailVerified) return { error: "no_email" };
  const admin = supabaseAdmin().auth.admin;

  const created = await admin.createUser({
    email: user.email,
    email_confirm: true,
    user_metadata: { name: user.name, whop_user_id: user.id },
  });
  // An existing user (email sign-up, Google, or an earlier Whop sign-in) is fine: same email.
  if (created.error && !/already|registered|exists/i.test(created.error.message)) throw created.error;

  const link = await admin.generateLink({ type: "magiclink", email: user.email });
  if (link.error) throw link.error;
  const { data, error } = await (await supabaseServer()).auth.verifyOtp({
    type: "magiclink",
    token_hash: link.data.properties.hashed_token,
  });
  if (error || !data.user) throw error ?? new Error("could not start the session");
  return { userId: data.user.id };
}
