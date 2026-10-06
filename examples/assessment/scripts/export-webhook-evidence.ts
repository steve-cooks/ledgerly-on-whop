// Step 5 evidence: the webhook config plus one real (most recent) payload per subscribed event type.
//   pnpm tsx examples/assessment/scripts/export-webhook-evidence.ts
import "../../../scripts/_setup";
import { sql } from "@/lib/db";
import { saveEvidence } from "./_evidence";

const TYPES = [
  "payment.succeeded", "payment.failed", "refund.created", "dispute.created",
  "transfer.completed", "payout.created", "payout.updated", "account.updated",
];

async function main() {
  const summary: Record<string, unknown> = {};
  for (const type of TYPES) {
    // Prefer a real delivery (real ones carry account_id; Whop's test sends don't).
    const [row] = await sql()`
      select webhook_id, payload, received_at, (payload->>'account_id' is null) as is_test from webhook_events
      where type = ${type}
      order by (payload->>'account_id' is null), received_at desc limit 1`;
    const [{ n }] = await sql()`select count(*)::int as n from webhook_events where type = ${type}`;
    summary[type] = row
      ? { deliveries: n, sample: row.webhook_id, source: row.is_test ? "whop test endpoint (sample data)" : "real event" }
      : { deliveries: 0, sample: null };
    if (row) saveEvidence(`05-webhooks/payloads/${type}${row.is_test ? ".TEST-SAMPLE" : ""}`, row.payload);
  }
  saveEvidence("05-webhooks/payloads/_summary", summary);
  console.log(JSON.stringify(summary, null, 2));
}
main().finally(() => sql().end());
