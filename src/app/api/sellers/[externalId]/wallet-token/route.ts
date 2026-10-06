import { currentSeller } from "@/lib/seller-session";
import { mintWalletToken } from "@/lib/wallet";

export const dynamic = "force-dynamic";

/** A short-lived token for the signed-in seller's own account only. */
export async function GET(_req: Request, { params }: { params: Promise<{ externalId: string }> }) {
  const { externalId } = await params;
  if ((await currentSeller()) !== externalId) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json(await mintWalletToken(externalId), { headers: { "cache-control": "no-store" } });
}
