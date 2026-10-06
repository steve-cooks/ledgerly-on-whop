import { backUrl, errorText, sameOrigin, sendVerificationReminder } from "@/lib/operator";
import { currentOperator } from "@/lib/seller-session";

export const dynamic = "force-dynamic";

/** Operator "Send reminder": the seller sees it on their Ledgerly status page. */
export async function POST(req: Request, { params }: { params: Promise<{ externalId: string }> }) {
  const operator = await currentOperator();
  if (!operator || !sameOrigin(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const { externalId } = await params;
  const form = await req.formData().catch(() => new FormData());
  let notice: string;
  try {
    const r = await sendVerificationReminder(externalId, operator.name);
    notice = `reminder_${r.status}`;
  } catch (err) {
    console.error(`reminder for ${externalId} failed: ${errorText(err)}`);
    notice = "error";
  }
  return Response.redirect(backUrl(req, form.get("back"), { notice, seller: externalId }), 303);
}
