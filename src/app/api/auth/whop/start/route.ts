import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authorizationRequest, oauthConfigured } from "@/lib/whop-oauth";

export const dynamic = "force-dynamic";

/** "Sign in with Whop": remember the PKCE verifier and state, then send the browser to Whop. */
export async function GET() {
  if (!oauthConfigured()) redirect("/?signin=unavailable");
  const { verifier, state, url } = authorizationRequest();
  (await cookies()).set("ledgerly_oauth", JSON.stringify({ verifier, state }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/auth/whop",
    maxAge: 600,
  });
  redirect(url);
}
