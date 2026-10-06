// Part 1 · Step 5a: one platform webhook that also receives connected-account events.
// Thin wrapper around the shared setup (also used by `pnpm ledgerly webhook:create`); writes the
// signing secret to .env.local without printing it and saves the config as evidence.
//   pnpm tsx examples/assessment/scripts/05a-create-webhook.ts
import "../../../scripts/_setup";
import { createPlatformWebhook, writeWebhookSecret } from "@/lib/webhook-setup";
import { saveEvidence } from "./_evidence";

async function main() {
  const { webhook_secret, ...rest } = await createPlatformWebhook();
  writeWebhookSecret(rest.id, webhook_secret ?? "");
  saveEvidence("05-webhooks/webhook", { ...rest, webhook_secret: webhook_secret ? "ws_<redacted>" : null });
  console.log(JSON.stringify({ ...rest, webhook_secret: "<written to .env.local>" }, null, 2));
}

main();
