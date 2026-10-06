import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "./env";
import { whop } from "./whop";

/**
 * The events Ledgerly's webhook subscribes to: the eight from the integration brief, plus the
 * lifecycle events that let refunds, disputes and transfers reach a final state.
 */
export const WEBHOOK_EVENTS = [
  "payment.succeeded",
  "payment.failed",
  "refund.created",
  "refund.updated",
  "dispute.created",
  "dispute.updated",
  "transfer.completed",
  "transfer.failed",
  "payout.created",
  "payout.updated",
  "account.updated",
] as const;

// Pinned so payload shapes can't change under the consumer (and so envelopes carry account_id).
export const WEBHOOK_API_VERSION = "2026-09-29";

/** One webhook on Ledgerly's platform account that also receives every seller's events. */
export async function createPlatformWebhook() {
  const platform = env().WHOP_PLATFORM_ACCOUNT_ID;
  const url = `${env().APP_URL}/api/webhooks/whop`;
  for await (const w of await whop().webhooks.list({ account_id: platform })) {
    if (w.url === url) throw new Error(`a webhook for ${url} already exists: ${w.id} (use syncPlatformWebhook)`);
  }
  return whop().webhooks.create(
    {
      url,
      resource_id: platform,
      events: [...WEBHOOK_EVENTS],
      child_resource_events: true,
      api_version_date: WEBHOOK_API_VERSION,
    },
    { idempotencyKey: `ledgerly:webhook:create:${url}` },
  );
}

/** Bring an existing webhook's events and version pin in line with the code. */
export async function syncPlatformWebhook(id: string) {
  return whop().webhooks.update({ id, events: [...WEBHOOK_EVENTS], api_version_date: WEBHOOK_API_VERSION });
}

/** Store the signing secret locally without ever printing it. */
export function writeWebhookSecret(id: string, secret: string, file = ".env.local") {
  const kept = readFileSync(file, "utf8").split("\n").filter((l) => !/^WHOP_WEBHOOK_(SECRET|ID)=/.test(l));
  writeFileSync(file, kept.join("\n").trimEnd() + "\n");
  appendFileSync(file, `WHOP_WEBHOOK_SECRET=${secret}\nWHOP_WEBHOOK_ID=${id}\n`);
}
