import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { sameOrigin } from "@/lib/operator";
import { buyProduct } from "@/lib/products";

export const dynamic = "force-dynamic";

const BUYER_COOKIE = "ledgerly_buyer";

/** "Buy" on a product page: open a Whop checkout for it and send the buyer there. */
export async function POST(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  // Another site's form can't start a purchase in this buyer's name.
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
  const form = await req.formData().catch(() => null);
  const nonce = String(form?.get("nonce") ?? "");

  // A private, per-browser buyer id: purchases are keyed to it.
  const jar = await cookies();
  let buyerId = jar.get(BUYER_COOKIE)?.value ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(buyerId)) {
    buyerId = randomBytes(18).toString("base64url");
    jar.set(BUYER_COOKIE, buyerId, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  }

  try {
    const target = await buyProduct(productId, nonce, buyerId);
    if (!target) return new Response("This product isn't for sale.", { status: 404 });
    return Response.redirect(new URL(target, req.url), 303);
  } catch (err) {
    console.error("checkout failed", productId, (err as Error).message);
    return Response.redirect(new URL(`/shop/${encodeURIComponent(productId)}?error=checkout`, req.url), 303);
  }
}
