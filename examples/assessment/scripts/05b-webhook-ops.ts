// Part 1 · Step 5b: fire a test event, replay a real delivery (same id and regenerated id),
// and suspend a connected account.
//   pnpm tsx examples/assessment/scripts/05b-webhook-ops.ts
import "../../../scripts/_setup";
import { whop } from "@/lib/whop";
import { sql } from "@/lib/db";
import { capture, saveEvidence } from "./_evidence";

const NESTED_LEFTOVER = "biz_imW7SL959LNYDA"; // created by the parent_company_id experiment in step 1

async function snapshot() {
  const [counts] = await sql()`
    select (select count(*) from webhook_events)::int as events,
           (select count(*) from ledger_entries)::int as ledger_entries,
           (select count(*) from payouts)::int as payouts`;
  return counts;
}

async function main() {
  const hookId = process.env.WHOP_WEBHOOK_ID!;

  // 1. Test endpoint: dispute.created has no real occurrence (a real one means a chargeback).
  const test = await capture(() => whop().webhooks.test({ id: hookId, event: "dispute.created" }));

  // 2. Replay one real delivery: the payout.created we received.
  const deliveries = [];
  for await (const d of await whop().webhooks.listDeliveries({ id: hookId, first: 100 })) deliveries.push(d);
  const target = deliveries.find((d) => d.event === "payout.created" && d.success && !d.replayed_from);
  if (!target) throw new Error("no payout.created delivery to replay");

  const before = await snapshot();
  // Same webhook-id: our inbox must answer "duplicate" and change nothing.
  const sameId = await capture(() => whop().webhooks.replayDelivery({ id: hookId, delivery_id: target.id }));
  const afterSame = await snapshot();
  // New webhook-id: the event is recorded, but business effects key on the payout id, so the
  // payout row and ledger stay as they were.
  const newId = await capture(() =>
    whop().webhooks.replayDelivery({ id: hookId, delivery_id: target.id, regenerate_id: true }),
  );
  const afterNew = await snapshot();

  // 3. Suspend the leftover connected account.
  const suspended = await capture(() => whop().accounts.suspend({ id: NESTED_LEFTOVER }));

  const out = {
    test_event: test,
    replayed_delivery: { id: target.id, event: target.event, sent_at: target.sent_at },
    replay_same_id: { response: sameId, counts_before: before, counts_after: afterSame },
    replay_regenerated_id: { response: newId, counts_after: afterNew },
    suspend: suspended.ok
      ? { ok: true, id: suspended.result.id, status: (suspended.result as { status?: string }).status }
      : suspended,
  };
  saveEvidence("05-webhooks/test-replay-suspend", out);
  console.log(JSON.stringify(out, null, 2));
}

main().finally(() => sql().end());
