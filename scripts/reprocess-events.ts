// Re-run handlers over stored webhook events (handlers are idempotent). Useful after adding a
// handler for an event type that was previously only recorded.
//   pnpm tsx scripts/reprocess-events.ts transfer.completed
import "./_setup";
import { sql } from "@/lib/db";
import { handlers } from "@/lib/webhook-handlers";
import { eventAccountId, type WhopEvent } from "@/lib/webhooks";

async function main() {
  const type = process.argv[2];
  const handler = handlers[type];
  if (!handler) throw new Error(`no handler for ${type}`);
  const rows = await sql()`select webhook_id, payload from webhook_events where type = ${type} order by received_at`;
  for (const r of rows) {
    await sql().begin(async (tx) => {
      const event = r.payload as WhopEvent;
      const accountId = eventAccountId(event);
      const [seller] = accountId ? await tx`select external_id from sellers where whop_account_id = ${accountId}` : [];
      await handler({ tx, event, accountId, sellerExternalId: seller?.external_id ?? null });
      await tx`update webhook_events set processed_at = now() where webhook_id = ${r.webhook_id}`;
    });
    console.log("reprocessed", r.webhook_id);
  }
}
main().finally(() => sql().end());
