// Step 5 evidence: the webhook config plus one real (most recent) payload per subscribed event type.
//   pnpm tsx scripts/export-webhook-evidence.ts
import "./_setup";
import { sql } from "@/lib/db";
import { saveEvidence } from "./_evidence";

const TYPES = [
  "payment.succeeded", "payment.failed", "refund.created", "dispute.created",
  "transfer.completed", "payout.created", "payout.updated", "account.updated",
];

async function main() {
  const summary: Record<string, unknown> = {};
  for (const type of TYPES) {
    const [row] = await sql()`
      select webhook_id, payload, received_at from webhook_events
      where type = ${type} and payload->>'account_id' is not null
      order by received_at desc limit 1`;
    const [{ n }] = await sql()`select count(*)::int as n from webhook_events where type = ${type}`;
    summary[type] = row ? { deliveries: n, sample: row.webhook_id } : { deliveries: 0, sample: null };
    if (row) saveEvidence(`05-webhooks/payloads/${type}`, row.payload);
  }
  saveEvidence("05-webhooks/payloads/_summary", summary);
  console.log(JSON.stringify(summary, null, 2));
}
main().finally(() => sql().end());
