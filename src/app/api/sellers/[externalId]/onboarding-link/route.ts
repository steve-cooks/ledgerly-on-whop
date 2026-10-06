import { redirect } from "next/navigation";
import { freshOnboardingLink } from "@/lib/onboarding";
import { currentSeller } from "@/lib/seller-session";

export const dynamic = "force-dynamic";

/** A signed-in seller's "continue verification" button: mint a fresh Whop onboarding link and go. */
export async function GET(_req: Request, { params }: { params: Promise<{ externalId: string }> }) {
  const { externalId } = await params;
  if ((await currentSeller()) !== externalId) return Response.json({ error: "forbidden" }, { status: 403 });
  const { onboardingUrl } = await freshOnboardingLink(externalId);
  redirect(onboardingUrl);
}
