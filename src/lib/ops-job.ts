import { sql } from "./db";
import { env } from "./env";
import { settlePlatformOrder } from "./checkout";
import { syncSellerVerification } from "./operator";
import { fetchPlatformPayments, reconcileSeller, repairPayouts } from "./reconcile";
import { refreshPendingTransfers } from "./transfers";
import { reprocessStored } from "./webhook-processor";

// Stop starting new work well before the route's 300s ceiling; the next run resumes.
const TIME_BUDGET_MS = 240_000;
// The verification mirror is a convenience: a small slice per run leaves reconcile the budget.
const VERIFICATION_SYNC_LIMIT = 100;
const VERIFICATION_SYNC_MS = 30_000;

/**
 * The scheduled operations run, in order of what costs least and matters most:
 *  1. retry webhook events that were deferred or failed;
 *  2. settle transfers webhooks haven't (poll Whop; resend unanswered requests, same key);
 *  3. settle platform orders that still owe the seller something;
 *  4. refresh the verification mirror for the least recently synced sellers (bounded; webhooks
 *     keep it current, this backfills and covers missed events);
 *  5. sync payouts and reconcile sellers, resuming after the last seller the previous run
 *     reached, until the time budget runs out.
 * Every stage, and every item inside one, is isolated: a failure is recorded and the run moves
 * on. The run is always recorded in job_runs and alerts when anything is off, when it ran out
 * of time, or when the previous run never finished.
 */
export async function runOpsJob() {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const outOfTime = () => Date.now() > deadline;
  const db = sql();

  const [previous] = await db`select * from job_runs where job = 'ops' order by started_at desc limit 1`;
  const [run] = await db`insert into job_runs (job) values ('ops') returning id`;
  const problems: string[] = [];
  const summary: Record<string, unknown> = { problems };
  if (previous && !previous.finished_at) problems.push(`run #${previous.id} never finished`);

  async function stage<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (outOfTime()) {
      problems.push(`${name}: skipped, out of time`);
      return undefined;
    }
    try {
      return await fn();
    } catch (err) {
      problems.push(`${name} failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  try {
    const events = await stage("replay events", () => reprocessStored({ deadline }));
    if (events) {
      summary.events = events;
      if (events.outcomes.deferred) problems.push(`${events.outcomes.deferred} webhook events still deferred`);
      for (const f of events.failed) problems.push(`event ${f.webhook_id} (${f.type}) fails: ${f.error}`);
      if (events.remaining) problems.push(`${events.remaining} stored events not retried yet; next run continues`);
    }

    const transfers = await stage("refresh transfers", () => refreshPendingTransfers({ deadline }));
    if (transfers) {
      summary.transfers = transfers;
      problems.push(...transfers.errors.map((e) => `transfer ${e}`));
    }

    await stage("settle orders", async () => {
      // Only orders that may still owe the seller: no share computed yet, or confirmed
      // transfers short of it.
      const outstanding = await db`
        select o.id from orders o
        where o.flow = 'platform' and o.status = 'paid'
          and (o.seller_share is null or o.seller_share > coalesce((
            select sum(t.amount) from seller_transfers t
            where t.order_id = o.id and t.purpose = 'order_share' and t.status = 'completed'), 0))
        order by o.created_at`;
      const settled: { order: string; result: unknown }[] = [];
      summary.settled = settled;
      for (const o of outstanding) {
        if (outOfTime()) break;
        try {
          const result = await settlePlatformOrder(o.id);
          settled.push({ order: o.id, result });
          if ("blocked" in result) problems.push(`settle ${o.id}: ${result.blocked}`);
          if ("status" in result && result.status === "failed") problems.push(`settle ${o.id}: Whop refused the transfer: ${result.error}`);
        } catch (err) {
          problems.push(`settle ${o.id}: ${(err as Error).message}`);
        }
      }
    });

    const verification = await stage("sync seller verification", () =>
      syncSellerVerification({ limit: VERIFICATION_SYNC_LIMIT, deadline: Math.min(deadline, Date.now() + VERIFICATION_SYNC_MS) }),
    );
    if (verification) {
      summary.verification = { synced: verification.synced, errors: verification.errors.length };
      if (verification.errors.length) problems.push(`verification sync: ${verification.errors.length} sellers failed (first: ${verification.errors[0]})`);
    }

    await stage("reconcile", async () => {
      // Sellers in a stable order, continuing after where the last run stopped.
      const cursor: string = previous?.summary?.reconcile_cursor ?? "";
      const sellers = (
        await db`select external_id from sellers where whop_account_id is not null order by external_id`
      ).map((r) => r.external_id as string);
      const ordered = [...sellers.filter((s) => s > cursor), ...sellers.filter((s) => s <= cursor)];
      const platformPayments = await fetchPlatformPayments();
      const reconciled: { seller: string; ok: boolean; discrepancies: number }[] = [];
      summary.sellers = sellers.length;
      summary.reconciled = reconciled;
      let lastSeller = cursor;
      for (const s of ordered) {
        if (outOfTime()) break;
        try {
          await repairPayouts(s);
          const r = await reconcileSeller(s, { platformPayments });
          reconciled.push({ seller: s, ok: r.ok, discrepancies: r.discrepancies.length });
          if (!r.ok) problems.push(`${s}: ${r.discrepancies.length} discrepancies`);
        } catch (err) {
          problems.push(`reconcile ${s}: ${(err as Error).message}`);
        }
        lastSeller = s;
      }
      const complete = reconciled.length === sellers.length;
      if (!complete) problems.push(`out of time after ${reconciled.length}/${sellers.length} sellers; next run resumes`);
      summary.reconcile_cursor = complete ? "" : lastSeller;
    });
  } catch (err) {
    problems.push(`ops run crashed: ${(err as Error).message}`);
  } finally {
    const ok = problems.length === 0;
    await db`update job_runs set finished_at = now(), ok = ${ok}, summary = ${db.json(JSON.parse(JSON.stringify(summary)))} where id = ${run.id}`.catch(
      (e) => console.error("could not record ops run", e?.message),
    );
    if (!ok) await alert(`Ledgerly ops run #${run.id} needs attention:\n- ${problems.join("\n- ")}`);
  }
  return { run: run.id as number, ok: problems.length === 0, summary };
}

/** Post to a Slack-compatible incoming webhook if one is configured; a failed alert is logged. */
async function alert(text: string) {
  const url = env().ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) console.error(`alert webhook answered ${res.status}`);
  } catch (err) {
    console.error("alert webhook unreachable", (err as Error).message);
  }
}
