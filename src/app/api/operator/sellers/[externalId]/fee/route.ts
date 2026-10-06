import { backUrl, errorText, parseFeePercent, sameOrigin, setSellerFee } from "@/lib/operator";
import { currentOperator } from "@/lib/seller-session";

export const dynamic = "force-dynamic";

/** Operator "Ledgerly fee": a percentage (0–50, up to 2 decimals) or empty/"default". New checkouts only. */
export async function POST(req: Request, { params }: { params: Promise<{ externalId: string }> }) {
  const operator = await currentOperator();
  if (!operator || !sameOrigin(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const { externalId } = await params;
  const form = await req.formData().catch(() => new FormData());
  const fee = parseFeePercent(form.get("fee"));
  let notice: string;
  if (!fee.ok) {
    notice = "fee_invalid";
  } else {
    try {
      const r = await setSellerFee(externalId, fee.bps, operator.name);
      notice = `fee_${r.status}`;
    } catch (err) {
      console.error(`fee change for ${externalId} failed: ${errorText(err)}`);
      notice = "error";
    }
  }
  return Response.redirect(backUrl(req, form.get("back"), { notice, seller: externalId }), 303);
}
