import { after } from "next/server";
import { unwrapWebhook, WebhookVerificationError } from "@whop/sdk/helpers";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { settlePlatformOrder } from "@/lib/checkout";
import { processEvent } from "@/lib/webhook-processor";
import type { WhopEvent } from "@/lib/webhooks";

/**
 * Whop webhook consumer: verify the Standard Webhooks signature on the raw body, then hand the
 * event to processEvent (inbox + handler in one transaction, exactly-once effects).
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const headers = Object.fromEntries(request.headers);

  let event: WhopEvent;
  try {
    event = unwrapWebhook<WhopEvent>(raw, { headers, key: env().WHOP_WEBHOOK_SECRET });
  } catch (err) {
    if (err instanceof WebhookVerificationError) return Response.json({ error: "invalid signature" }, { status: 401 });
    throw err;
  }

  const webhookId = headers["webhook-id"] ?? event.id;
  const outcome = await processEvent(webhookId, event);

  // A platform-collected sale just got paid: pay the seller's share now, from Ledgerly's
  // balance. This runs after the 2xx so Whop never waits on (or retries because of) the
  // transfer. settlePlatformOrder is idempotent, and the hourly ops job retries anything missed.
  if (outcome === "processed" && event.type === "payment.succeeded") {
    const [order] = await sql()`
      select id from orders where whop_payment_id = ${String(event.data.id)} and flow = 'platform' and status = 'paid'`;
    if (order) after(() => settlePlatformOrder(order.id).catch((e) => console.error("settle failed", order.id, e?.message)));
  }

  return Response.json({ ok: true, webhook_id: webhookId, outcome });
}
