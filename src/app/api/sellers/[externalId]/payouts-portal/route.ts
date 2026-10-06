import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { currentSeller } from "@/lib/seller-session";
import { whop } from "@/lib/whop";

export const dynamic = "force-dynamic";

/** Hosted alternative to the embedded components: send the seller to Whop's payouts portal. */
export async function GET(_req: Request, { params }: { params: Promise<{ externalId: string }> }) {
  const { externalId } = await params;
  if ((await currentSeller()) !== externalId) return Response.json({ error: "forbidden" }, { status: 403 });
  const [seller] = await sql()`select whop_account_id from sellers where external_id = ${externalId}`;
  const back = `${env().APP_URL}/sellers/${encodeURIComponent(externalId)}/payouts`;
  const link = await whop().accountLinks.create({
    account_id: seller.whop_account_id,
    use_case: "payouts_portal",
    return_url: back,
    refresh_url: `${back}?portal=expired`,
  });
  redirect(link.url);
}
