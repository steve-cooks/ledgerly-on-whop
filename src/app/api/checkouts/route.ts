import { errorResponse, requireAdmin } from "@/lib/admin-auth";
import { createCheckout } from "@/lib/checkout";

/**
 * Create a checkout with Ledgerly's 8% computed and validated. Direct charge for 'direct'
 * sellers; platform-collected sale (paid out by transfer) for 'platform' sellers.
 *
 *   POST /api/checkouts  { sellerExternalId, title, sku, price, currency? }
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    return Response.json(await createCheckout(await req.json()), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
