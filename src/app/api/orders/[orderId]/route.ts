import { errorResponse, requireAdmin } from "@/lib/admin-auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Order status for Ledgerly's backend: deliver the digital good when status is "paid".
 * Status is driven by Whop webhooks (paid, failed, refunded, partially_refunded).
 *
 *   GET /api/orders/:orderId
 */
export async function GET(req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    const { orderId } = await params;
    if (!/^[0-9a-f-]{36}$/.test(orderId)) return Response.json({ error: "not_found" }, { status: 404 });
    const [o] = await sql()`
      select id, seller_external_id, flow, title, amount, currency, platform_fee, status, refunded_amount,
             whop_payment_id, checkout_configuration_id, created_at, updated_at
      from orders where id = ${orderId}`;
    if (!o) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ ...o, deliverable: o.status === "paid" });
  } catch (err) {
    return errorResponse(err);
  }
}
