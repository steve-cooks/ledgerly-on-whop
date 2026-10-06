import { notFound } from "next/navigation";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(orderId)) notFound();
  const [order] = await sql()`select * from orders where id = ${orderId}`;
  if (!order) notFound();
  return (
    <main className="mx-auto max-w-xl space-y-3 p-8">
      <h1 className="text-2xl font-semibold">Thanks for your order</h1>
      <p>
        {order.title} · {Number(order.amount).toFixed(2)} {order.currency.toUpperCase()}
      </p>
      <p className="text-neutral-500">
        Status: <b>{order.status}</b> (updated by Whop webhooks)
      </p>
    </main>
  );
}
