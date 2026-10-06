import { errorResponse, requireAdmin } from "@/lib/admin-auth";
import { reconcileSeller } from "@/lib/reconcile";

export const dynamic = "force-dynamic";

/** GET /api/reconcile/:externalId → { ok, discrepancies[] } (409 when anything is off). */
export async function GET(req: Request, { params }: { params: Promise<{ externalId: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    const report = await reconcileSeller((await params).externalId);
    return Response.json(report, { status: report.ok ? 200 : 409 });
  } catch (err) {
    return errorResponse(err);
  }
}
