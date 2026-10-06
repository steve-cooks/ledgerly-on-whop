import { createHmac, randomUUID } from "node:crypto";
import { vi } from "vitest";

/**
 * Shared test doubles. Whop is replaced by `fakeWhop` (tests set the methods they need), and
 * next/server's after() runs its callback inline so the post-response settlement is awaited.
 */
export const fakeWhop: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {
  payments: { listFees: vi.fn(), list: vi.fn() },
  transfers: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() },
  payouts: { list: vi.fn() },
  checkoutConfigurations: { create: vi.fn() },
  accounts: { create: vi.fn(), retrieve: vi.fn() },
  accountLinks: { create: vi.fn() },
  teamMembers: { list: vi.fn() },
};

/** A Whop SDK error as the SDK throws it. */
export const whopError = (statusCode: number, message = "error") =>
  Object.assign(new Error(message), { statusCode, body: { error: { type: "invalid_request", message } } });
export const afterTasks: Promise<unknown>[] = [];

vi.mock("@/lib/whop", () => ({ whop: () => fakeWhop }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => afterTasks.push(fn()) }));

const SECRET = "ws_" + "a".repeat(64);

/** A webhook request signed exactly like Whop signs it (Standard Webhooks, literal-byte key). */
export function signedRequest(event: Record<string, unknown>, webhookId = `msg_${randomUUID()}`) {
  const body = JSON.stringify({ id: webhookId, timestamp: new Date().toISOString(), api_version: "v1", api_version_date: "2026-09-29", ...event });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${webhookId}.${ts}.${body}`).digest("base64");
  return new Request("https://ledgerly.test/api/webhooks/whop", {
    method: "POST",
    headers: { "webhook-id": webhookId, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}`, "content-type": "application/json" },
    body,
  });
}

export async function deliver(event: Record<string, unknown>, webhookId?: string) {
  const { POST } = await import("@/app/api/webhooks/whop/route");
  const res = await POST(signedRequest(event, webhookId));
  await Promise.all(afterTasks.splice(0));
  return { status: res.status, body: (await res.json()) as { outcome?: string; error?: string } };
}

export async function db() {
  const { sql } = await import("@/lib/db");
  return sql();
}

/** Seed a seller and an order in a given state. */
export async function seed(opts: { flow?: "direct" | "platform"; status?: string; amount?: number; paymentId?: string } = {}) {
  const sql = await db();
  const flow = opts.flow ?? "direct";
  const external = flow === "direct" ? "seller_us" : "seller_br";
  const account = flow === "direct" ? "biz_seller_us" : "biz_seller_br";
  await sql`
    insert into sellers (external_id, email, country, whop_account_id, collection_mode)
    values (${external}, ${`${external}@example.com`}, ${flow === "direct" ? "US" : "BR"}, ${account}, ${flow})
    on conflict do nothing`;
  const amount = opts.amount ?? 10;
  const [order] = await sql`
    insert into orders (seller_external_id, flow, title, amount, currency, platform_fee, status, whop_payment_id)
    values (${external}, ${flow}, 'Preset Pack', ${amount}, 'usd', ${Math.round(amount * 8) / 100}, ${opts.status ?? "pending"}, ${opts.paymentId ?? null})
    returning *`;
  return { order: order as { id: string } & Record<string, unknown>, external, account };
}

export function paymentEvent(type: string, order: { id: string }, paymentId: string, account: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    account_id: account,
    data: {
      id: paymentId,
      status: type === "payment.failed" ? "open" : "paid",
      metadata: { ledgerly_order_id: order.id },
      total: { amount: "10.00", currency: "usd" },
      amount_after_fees: { amount: "8.48", currency: "usd" },
      paid_at: new Date().toISOString(),
      ...extra,
    },
  };
}
