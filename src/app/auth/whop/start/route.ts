import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authorizationRequest, oauthConfigured } from "@/lib/whop-oauth";

export const dynamic = "force-dynamic";

/** Sellers' "Continue with Whop": remember the PKCE verifier and state, then go to Whop. */
export async function GET() {
  if (!oauthConfigured("seller")) redirect("/sell/login?error=unavailable");
  const { verifier, state, url } = authorizationRequest("seller");
  (await cookies()).set("ledgerly_seller_oauth", JSON.stringify({ verifier, state }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/auth/whop",
    maxAge: 600,
  });
  redirect(url);
}
