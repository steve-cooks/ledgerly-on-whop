import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { currentSeller } from "@/lib/seller-session";
import { PayoutPortal } from "./payout-portal";

export const dynamic = "force-dynamic";

export default async function PayoutsPage({ params }: { params: Promise<{ externalId: string }> }) {
  const { externalId } = await params;
  if ((await currentSeller()) !== externalId) {
    return <main className="mx-auto max-w-xl p-8">Please sign in to Ledgerly as this seller.</main>;
  }
  const [seller] = await sql()`select external_id, whop_account_id from sellers where external_id = ${externalId}`;
  if (!seller?.whop_account_id) notFound();

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-neutral-500">Ledgerly · Seller payouts</p>
          <h1 className="text-2xl font-semibold">Your earnings</h1>
        </div>
        <a
          className="text-sm text-blue-600 underline"
          href={`/api/sellers/${encodeURIComponent(externalId)}/payouts-portal`}
        >
          Open Whop-hosted payouts portal instead
        </a>
      </header>
      <PayoutPortal externalId={externalId} accountId={seller.whop_account_id} />
    </main>
  );
}
