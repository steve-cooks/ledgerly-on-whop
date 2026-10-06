import { sql } from "./db";
import { env } from "./env";
import { settlePlatformOrder } from "./checkout";
import { fetchPlatformPayments, reconcileSeller, repairPayouts } from "./reconcile";
import { refreshPendingTransfers } from "./transfers";
import { reprocessStored } from "./webhook-processor";

// Stop starting new work well before the route's 300s ceiling; the next run resumes.
const TIME_BUDGET_MS = 240_000;

/**
 * The scheduled operations run, in order of what costs least and matters most:
 *  1. retry webhook events that were deferred or failed;
 *  2. ask Whop about transfers still in flight;
 *  3. settle platform orders that still owe the seller something;
 *  4. sync payouts and reconcile sellers, resuming after the last seller the previous run
 *     reached, until the time budget runs out.
 * Recorded in job_runs; alerts when anything is off, when this run ran out of time, or when
 * the previous run never finished.
 */
export async function runOpsJob() {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;
  const db = sql();

  const [previous] = await db`select * from job_runs where job = 'ops' order by started_at desc limit 1`;
  const [run] = await db`insert into job_runs (job) values ('ops') returning id`;
  const problems: string[] = [];
  if (previous && !previous.finished_at) problems.push(`run #${previous.id} never finished`);

  const events = await reprocessStored();
  if (events.outcomes.deferred) problems.push(`${events.outcomes.deferred} webhook events still deferred`);

  const transfersChecked = await refreshPendingTransfers();

  // Only orders that may still owe the seller: no share computed yet, or confirmed transfers
  // short of it.
  const outstanding = await db`
    select o.id from orders o
    where o.flow = 'platform' and o.status = 'paid'
      and (o.seller_share is null or o.seller_share > coalesce((
        select sum(t.amount) from seller_transfers t
        where t.order_id = o.id and t.purpose = 'order_share' and t.status = 'completed'), 0))
    order by o.created_at`;
  const settled: { order: string; result: unknown }[] = [];
  for (const o of outstanding) {
    if (outOfTime()) break;
    try {
      settled.push({ order: o.id, result: await settlePlatformOrder(o.id) });
    } catch (err) {
      problems.push(`settle ${o.id}: ${(err as Error).message}`);
    }
  }

  // Reconcile sellers in a stable order, continuing after where the last run stopped.
  const cursor: string = previous?.summary?.reconcile_cursor ?? "";
  const sellers = (
    await db`select external_id from sellers where whop_account_id is not null order by external_id`
  ).map((r) => r.external_id as string);
  const ordered = [...sellers.filter((s) => s > cursor), ...sellers.filter((s) => s <= cursor)];
  const platformPayments = await fetchPlatformPayments();
  const reconciled: { seller: string; ok: boolean; discrepancies: number }[] = [];
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

  const ok = problems.length === 0;
  const summary = {
    events,
    transfers_checked: transfersChecked,
    settled,
    sellers: sellers.length,
    reconciled,
    reconcile_cursor: complete ? "" : lastSeller,
    problems,
  };
  await db`update job_runs set finished_at = now(), ok = ${ok}, summary = ${db.json(JSON.parse(JSON.stringify(summary)))} where id = ${run.id}`;
  if (!ok) await alert(`Ledgerly ops run #${run.id} needs attention:\n- ${problems.join("\n- ")}`);
  return { run: run.id as number, ok, summary };
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
