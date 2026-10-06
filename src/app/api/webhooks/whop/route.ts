import { after } from "next/server";
import { unwrapWebhook, WebhookVerificationError } from "@whop/sdk/helpers";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { eventAccountId, type WhopEvent } from "@/lib/webhooks";
import { handlers } from "@/lib/webhook-handlers";
import { settlePlatformOrder } from "@/lib/checkout";

/**
 * Whop webhook consumer.
 *
 * Exactly-once effects: the event row (keyed on the webhook-id) and every ledger write the
 * handler makes commit in ONE transaction. A retry, a replay, or a redelivery after a crash
 * either finds a processed row and returns 200, or finds no committed work and does it.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const headers = Object.fromEntries(request.headers);

  let event: WhopEvent;
  try {
    event = unwrapWebhook<WhopEvent>(raw, { headers, key: env().WHOP_WEBHOOK_SECRET });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return Response.json({ error: "invalid signature" }, { status: 401 });
    }
    throw err;
  }

  const webhookId = headers["webhook-id"] ?? event.id;
  const accountId = eventAccountId(event);

  const outcome = await sql().begin(async (tx) => {
    await tx`
      insert into webhook_events (webhook_id, type, account_id, api_version_date, payload)
      values (${webhookId}, ${event.type}, ${accountId}, ${event.api_version_date ?? null}, ${tx.json(event as never)})
      on conflict (webhook_id) do nothing`;

    // Row lock serializes concurrent deliveries of the same message.
    const [row] = await tx`
      select processed_at from webhook_events where webhook_id = ${webhookId} for update`;
    if (row.processed_at) return "duplicate";

    const [seller] = accountId
      ? await tx`select external_id from sellers where whop_account_id = ${accountId}`
      : [];

    const handler = handlers[event.type];
    if (handler) {
      await handler({ tx, event, accountId, sellerExternalId: seller?.external_id ?? null });
    }

    await tx`update webhook_events set processed_at = now(), error = null where webhook_id = ${webhookId}`;
    return handler ? "processed" : "ignored";
  });

  // Platform-collected sale just got paid: pay the seller's share right away from Ledgerly's
  // balance. Runs after the 2xx so Whop never waits on (or retries because of) the transfer;
  // settlePlatformOrder is idempotent per order, and scripts/settle-orders.ts sweeps misses.
  if (outcome === "processed" && event.type === "payment.succeeded") {
    const [order] = await sql()`
      select id from orders where whop_payment_id = ${String(event.data.id)} and flow = 'platform' and status = 'paid'`;
    if (order) after(() => settlePlatformOrder(order.id).catch((e) => console.error("settle failed", order.id, e)));
  }

  return Response.json({ ok: true, webhook_id: webhookId, outcome });
}
