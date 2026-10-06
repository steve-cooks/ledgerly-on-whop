import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { startOperatorSession } from "@/lib/seller-session";
import { operatorRole, userFromCode } from "@/lib/whop-oauth";

export const dynamic = "force-dynamic";

/**
 * Whop sends the browser back here. Check the state, learn who signed in, and let them in only
 * if they're on Ledgerly's Whop team. Every failure lands on the console's sign-in page with a
 * reason it can explain.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  const pending = jar.get("ledgerly_oauth")?.value;
  jar.delete({ name: "ledgerly_oauth", path: "/api/auth/whop" });

  let outcome: string;
  try {
    outcome = await signIn(params, pending);
  } catch (err) {
    console.error("whop sign-in failed", (err as Error).message);
    outcome = "failed";
  }
  redirect(outcome === "ok" ? "/" : `/?signin=${outcome}`);
}

async function signIn(params: URLSearchParams, pending: string | undefined) {
  if (params.get("error")) return "cancelled";
  const { verifier, state } = pending ? (JSON.parse(pending) as { verifier: string; state: string }) : { verifier: "", state: "" };
  const code = params.get("code");
  if (!code || !state || params.get("state") !== state) return "expired";

  const user = await userFromCode(code, verifier);
  if (!(await operatorRole(user.id))) return "not_team";
  await startOperatorSession(user.name);
  return "ok";
}
