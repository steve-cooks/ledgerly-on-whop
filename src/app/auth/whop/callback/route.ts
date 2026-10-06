import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { claimImportedSeller, sellerForUser } from "@/lib/seller-accounts";
import { userFromCode } from "@/lib/whop-oauth";
import { startSellerSessionFromWhop } from "@/lib/whop-seller-signin";

export const dynamic = "force-dynamic";

/** Whop sends sellers back here. Check the state, learn who they are, start their session. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  const pending = jar.get("ledgerly_seller_oauth")?.value;
  jar.delete({ name: "ledgerly_seller_oauth", path: "/auth/whop" });

  let target: string;
  try {
    target = await signIn(params, pending);
  } catch (err) {
    console.error("seller whop sign-in failed", (err as Error).message);
    target = "/sell/login?error=whop";
  }
  redirect(target);
}

async function signIn(params: URLSearchParams, pending: string | undefined) {
  if (params.get("error")) return "/sell/login?error=cancelled";
  const { verifier, state } = pending ? (JSON.parse(pending) as { verifier: string; state: string }) : { verifier: "", state: "" };
  const code = params.get("code");
  if (!code || !state || params.get("state") !== state) return "/sell/login?error=link";

  const user = await userFromCode(code, verifier, "seller");
  const session = await startSellerSessionFromWhop(user);
  if ("error" in session) return "/sell/login?error=whop_email";
  const hasStore = (await sellerForUser(session.user.id)) || (await claimImportedSeller(session.user));
  return hasStore ? "/sell/dashboard" : "/sell/onboard";
}
