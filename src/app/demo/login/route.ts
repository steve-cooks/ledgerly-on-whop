import { redirect } from "next/navigation";
import { OPERATOR, startSession } from "@/lib/seller-session";

/** Demo-only sign-in: /demo/login?t=<token from `pnpm ledgerly login-link`>. */
export async function GET(req: Request) {
  const subject = await startSession(new URL(req.url).searchParams.get("t") ?? "");
  if (!subject) return new Response("This sign-in link is invalid or has expired.", { status: 401 });
  redirect(subject === OPERATOR ? "/" : `/sellers/${encodeURIComponent(subject)}/payouts`);
}
