import { CollectionMode, backUrl, errorText, sameOrigin, setCollectionMode } from "@/lib/operator";
import { currentOperator } from "@/lib/seller-session";

export const dynamic = "force-dynamic";

/** Operator payment-mode switch (direct ↔ platform). Applies to the seller's new checkouts only. */
export async function POST(req: Request, { params }: { params: Promise<{ externalId: string }> }) {
  const operator = await currentOperator();
  if (!operator || !sameOrigin(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const { externalId } = await params;
  const form = await req.formData().catch(() => new FormData());
  const mode = CollectionMode.safeParse(form.get("mode"));
  if (!mode.success) return Response.json({ error: "mode must be direct or platform" }, { status: 400 });
  let notice: string;
  try {
    const r = await setCollectionMode(externalId, mode.data, operator.name);
    notice = r.status === "changed" ? `mode_${r.to}` : `mode_${r.status}`;
  } catch (err) {
    console.error(`mode change for ${externalId} failed: ${errorText(err)}`);
    notice = "error";
  }
  return Response.redirect(backUrl(req, form.get("back"), { notice, seller: externalId }), 303);
}
