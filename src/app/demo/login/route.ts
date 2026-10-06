import { redirect } from "next/navigation";
import { startSellerSession } from "@/lib/seller-session";

/** Demo-only sign-in: /demo/login?t=<signed token from scripts/seller-login-link.ts> */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const seller = await startSellerSession(token);
  if (!seller) return new Response("invalid login link", { status: 401 });
  redirect(`/sellers/${encodeURIComponent(seller)}/payouts`);
}
