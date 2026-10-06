import { buyProduct } from "@/lib/products";

export const dynamic = "force-dynamic";

/** "Buy" on a product page: open a Whop checkout for it and send the buyer there. */
export async function POST(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  const form = await req.formData().catch(() => null);
  const nonce = String(form?.get("nonce") ?? "");
  try {
    const target = await buyProduct(productId, nonce);
    if (!target) return new Response("This product isn't for sale.", { status: 404 });
    return Response.redirect(new URL(target, req.url), 303);
  } catch (err) {
    console.error("checkout failed", productId, (err as Error).message);
    return Response.redirect(new URL(`/shop/${encodeURIComponent(productId)}?error=checkout`, req.url), 303);
  }
}
