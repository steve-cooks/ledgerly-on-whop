import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Card, Page, Row, SiteHeader, money } from "@/components/ui";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Order" };

const STATUS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "neutral"; note: string }> = {
  pending: { label: "Processing", tone: "warn", note: "We're confirming your payment. This page updates automatically." },
  paid: { label: "Paid", tone: "good", note: "Payment confirmed. Thanks for your order." },
  failed: { label: "Payment failed", tone: "bad", note: "This payment didn't go through. Please try again." },
  refunded: { label: "Refunded", tone: "neutral", note: "This order was refunded in full." },
  partially_refunded: { label: "Partially refunded", tone: "neutral", note: "Part of this order was refunded." },
  disputed: { label: "Disputed", tone: "bad", note: "This payment is under dispute." },
};

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(orderId)) notFound();
  const [order] = await sql()`
    select o.*, s.country, s.collection_mode from orders o join sellers s on s.external_id = o.seller_external_id
    where o.id = ${orderId}`;
  if (!order) notFound();
  const st = STATUS[order.status] ?? STATUS.pending;

  return (
    <>
      <SiteHeader section="Checkout" />
      <Page>
        <div className="mx-auto max-w-lg">
          {order.status === "pending" && <meta httpEquiv="refresh" content="3" />}
          <div className="mb-6 text-center">
            <div className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-accent-soft text-2xl text-accent-ink">
              {order.status === "paid" ? "✓" : order.status === "failed" ? "!" : "↺"}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {order.status === "paid" ? "Payment confirmed" : st.label}
            </h1>
            <p className="mt-2 text-sm text-muted">{st.note}</p>
          </div>
          <Card>
            <div className="flex items-center justify-between pb-3">
              <p className="font-medium">{order.title}</p>
              <Badge tone={st.tone}>{st.label}</Badge>
            </div>
            <div className="divide-y divide-line border-t border-line">
              <Row label="Price">{money(order.amount, order.currency)}</Row>
              {Number(order.refunded_amount) > 0 && <Row label="Refunded">−{money(order.refunded_amount, order.currency)}</Row>}
              <Row label="Order">
                <span className="font-mono text-xs">{order.id.slice(0, 8)}</span>
              </Row>
              <Row label="Paid with">Whop secure checkout</Row>
            </div>
          </Card>
          <p className="mt-6 text-center text-xs text-subtle">Status is updated by Whop webhooks.</p>
        </div>
      </Page>
    </>
  );
}
