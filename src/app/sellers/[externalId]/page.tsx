import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { whop } from "@/lib/whop";

export const dynamic = "force-dynamic";

export default async function SellerPage({
  params,
  searchParams,
}: {
  params: Promise<{ externalId: string }>;
  searchParams: Promise<{ onboarding?: string }>;
}) {
  const { externalId } = await params;
  const { onboarding } = await searchParams;
  const [seller] = await sql()`select * from sellers where external_id = ${externalId}`;
  if (!seller?.whop_account_id) notFound();

  const account = await whop().accounts.retrieve({ id: seller.whop_account_id });

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      {onboarding === "done" && (
        <p className="rounded-lg bg-green-50 p-3 text-green-800">Thanks, onboarding submitted. Status below updates as Whop reviews it.</p>
      )}
      {onboarding === "refresh" && (
        <p className="rounded-lg bg-amber-50 p-3 text-amber-800">That onboarding link expired. Ask Ledgerly for a new one.</p>
      )}
      <header>
        <h1 className="text-2xl font-semibold">{account.title}</h1>
        <p className="text-neutral-500">
          {externalId} · {account.id} · {seller.collection_mode === "platform" ? "paid via Ledgerly transfers" : "direct charges"}
        </p>
      </header>
      <Section title="Verification" value={account.verification} />
      <Section title="Required actions" value={account.required_actions} />
      <Section title="Capabilities" value={account.capabilities} />
    </main>
  );
}

function Section({ title, value }: { title: string; value: unknown }) {
  return (
    <section>
      <h2 className="mb-2 font-medium">{title}</h2>
      <pre className="overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}
