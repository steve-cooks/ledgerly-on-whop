// Part 1 · Step 5a: one platform webhook that also receives connected-account events.
// Writes the signing secret to .env.local (never prints it).
//   pnpm tsx examples/assessment/scripts/05a-create-webhook.ts
import "../../../scripts/_setup";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { whop } from "@/lib/whop";
import { saveEvidence } from "./_evidence";

const EVENTS = [
  "payment.succeeded",
  "payment.failed",
  "refund.created",
  "dispute.created",
  "transfer.completed",
  "payout.created",
  "payout.updated",
  "account.updated",
] as const;

async function main() {
  const url = `${process.env.APP_URL}/api/webhooks/whop`;
  const existing = await whop().webhooks.list({ account_id: process.env.WHOP_PLATFORM_ACCOUNT_ID! });
  for await (const w of existing) {
    if (w.url === url) throw new Error(`webhook already exists: ${w.id}`);
  }

  const hook = await whop().webhooks.create(
    {
      url,
      resource_id: process.env.WHOP_PLATFORM_ACCOUNT_ID!,
      events: [...EVENTS],
      child_resource_events: true,
      // Pin the payload shape so it can't change under us (and so the envelope carries account_id).
      api_version_date: "2026-09-29",
    },
    { idempotencyKey: "ledgerly:webhook:create:v1" },
  );

  const { webhook_secret, ...rest } = hook;
  const env = readFileSync(".env.local", "utf8").split("\n").filter((l) => !l.startsWith("WHOP_WEBHOOK_SECRET="));
  writeFileSync(".env.local", env.join("\n").trimEnd() + "\n");
  appendFileSync(".env.local", `WHOP_WEBHOOK_SECRET=${webhook_secret}\nWHOP_WEBHOOK_ID=${rest.id}\n`);

  saveEvidence("05-webhooks/webhook", { ...rest, webhook_secret: webhook_secret ? "ws_<redacted>" : null });
  console.log(JSON.stringify({ ...rest, webhook_secret: "<written to .env.local>" }, null, 2));
}

main();
