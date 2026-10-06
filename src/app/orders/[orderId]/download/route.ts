import { downloadUrl } from "@/lib/products";

export const dynamic = "force-dynamic";

/** A paid order's file: re-checks the order is paid, then redirects to a 60-second signed link. */
export async function GET(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  try {
    const url = await downloadUrl(orderId);
    if (!url) return new Response("This order has no download available.", { status: 403 });
    return new Response(null, { status: 303, headers: { location: url, "cache-control": "no-store" } });
  } catch (err) {
    console.error("download failed", orderId, (err as Error).message);
    return new Response("The download isn't available right now. Please try again.", { status: 503 });
  }
}
