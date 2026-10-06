import { errorResponse, requireAdmin } from "@/lib/admin-auth";
import { onboardSeller } from "@/lib/onboarding";

/**
 * Create-or-fetch a seller's connected account and return a fresh onboarding link.
 * Safe to retry: the same externalId always maps to the same Whop account.
 *
 *   POST /api/sellers  { externalId, email, country, title?, collectionMode? }
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    const result = await onboardSeller(await req.json());
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
