import { sql } from "./db";
import { DeferredEvent } from "./errors";
import { handlers } from "./webhook-handlers";
import { eventAccountId, type WhopEvent } from "./webhooks";

export type Outcome = "processed" | "ignored" | "duplicate" | "deferred";

// Deferred events are retried by the ops job; after this long they're closed as unmatched
// (e.g. a refund for a payment that was never a Ledgerly order).
const GIVE_UP_AFTER_HOURS = 72;

/**
 * Record a verified event in the inbox and apply it exactly once.
 *
 * The inbox row (keyed on the webhook id) and every effect of the handler commit in ONE
 * transaction. A retry, replay or redelivery after a crash either finds the row processed and
 * does nothing, or finds no committed work and does it. Concurrent deliveries of one message
 * serialize on the row lock. `force` re-applies an already processed event (handlers are
 * idempotent), for replays after a handler fix.
 */
export async function processEvent(webhookId: string, event: WhopEvent, opts: { force?: boolean } = {}): Promise<Outcome> {
  const accountId = eventAccountId(event);
  try {
    return await sql().begin(async (tx) => {
      await tx`
        insert into webhook_events (webhook_id, type, account_id, api_version_date, payload)
        values (${webhookId}, ${event.type}, ${accountId}, ${event.api_version_date ?? null}, ${tx.json(event as never)})
        on conflict (webhook_id) do nothing`;
      const [row] = await tx`select processed_at, received_at from webhook_events where webhook_id = ${webhookId} for update`;
      if (row.processed_at && !opts.force) return "duplicate";

      const handler = handlers[event.type];
      if (handler) {
        const [seller] = accountId ? await tx`select external_id from sellers where whop_account_id = ${accountId}` : [];
        try {
          await tx.savepoint((sp) => handler({ tx: sp, event, accountId, sellerExternalId: seller?.external_id ?? null }));
        } catch (err) {
          if (!(err instanceof DeferredEvent)) throw err;
          const expired = Date.now() - new Date(row.received_at).getTime() > GIVE_UP_AFTER_HOURS * 3_600_000;
          await tx`
            update webhook_events set attempts = attempts + 1, error = ${`${expired ? "unmatched" : "deferred"}: ${err.message}`},
              processed_at = ${expired ? new Date() : null}
            where webhook_id = ${webhookId}`;
          return "deferred";
        }
      }
      await tx`update webhook_events set processed_at = now(), error = null, attempts = attempts + 1 where webhook_id = ${webhookId}`;
      return handler ? "processed" : "ignored";
    });
  } catch (err) {
    // The transaction rolled back; keep a durable record of why (the message, truncated), then rethrow so
    // the caller answers 5xx and Whop retries.
    const message = err instanceof Error ? err.message.slice(0, 500) : "unknown error";
    await sql()`
      insert into webhook_events (webhook_id, type, account_id, api_version_date, payload, error, attempts)
      values (${webhookId}, ${event.type}, ${accountId}, ${event.api_version_date ?? null}, ${sql().json(event as never)}, ${message}, 1)
      on conflict (webhook_id) do update set error = excluded.error, attempts = webhook_events.attempts + 1`.catch(() => {});
    throw err;
  }
}

/**
 * Re-run stored events: deferred/failed ones (default) or every event of one type. Each event
 * is isolated: one that keeps failing is reported, and the rest still run.
 */
export async function reprocessStored(opts: { type?: string; force?: boolean; deadline?: number; limit?: number } = {}) {
  // Unprocessed events least-tried first, so ones that keep failing don't starve the rest.
  const rows = opts.type
    ? await sql()`select webhook_id, type, payload from webhook_events where type = ${opts.type} order by received_at`
    : await sql()`select webhook_id, type, payload from webhook_events where processed_at is null
                  order by attempts, received_at limit ${opts.limit ?? 500}`;
  const outcomes: Record<string, number> = {};
  const failed: { webhook_id: string; type: string; error: string }[] = [];
  let attempted = 0;
  for (const r of rows) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    attempted++;
    try {
      const outcome = await processEvent(r.webhook_id, r.payload as WhopEvent, { force: opts.force ?? Boolean(opts.type) });
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    } catch (err) {
      failed.push({ webhook_id: r.webhook_id, type: r.type, error: (err as Error).message.slice(0, 200) });
    }
  }
  return { events: attempted, remaining: rows.length - attempted, outcomes, failed };
}

/**
 * Apply stored events about one payment that couldn't be applied yet (a refund or dispute
 * delivered before the payment). Settlement calls this first so it never pays a seller past a
 * hold that is already sitting in the inbox. Returns how many are still unapplied.
 */
export async function applyDeferredForPayment(paymentId: string) {
  const rows = await sql()`
    select webhook_id, payload from webhook_events
    where processed_at is null
      and (payload->'data'->>'payment_id' = ${paymentId} or payload->'data'->'payment'->>'id' = ${paymentId})
    order by received_at`;
  let unapplied = 0;
  for (const r of rows) {
    try {
      if ((await processEvent(r.webhook_id, r.payload as WhopEvent)) === "deferred") unapplied++;
    } catch {
      unapplied++;
    }
  }
  return unapplied;
}
