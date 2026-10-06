import { sql } from "./db";
import { env } from "./env";
import { settlePlatformOrder } from "./checkout";
import { reconcileSeller, repairPayouts } from "./reconcile";

/**
 * The scheduled operations run: sync payout state from Whop, reconcile every seller, and pay
 * any platform-collected seller share still owed. Recorded in job_runs; alerts on problems.
 */
export async function runOpsJob() {
  const db = sql();
  const [run] = await db`insert into job_runs (job) values ('ops') returning id`;

  const sellers = (await db`select external_id from sellers where whop_account_id is not null order by external_id`).map(
    (r) => r.external_id as string,
  );
  const reconcile: { seller: string; ok: boolean; discrepancies: number; error?: string }[] = [];
  for (const s of sellers) {
    try {
      await repairPayouts(s);
      const r = await reconcileSeller(s);
      reconcile.push({ seller: s, ok: r.ok, discrepancies: r.discrepancies.length });
    } catch (err) {
      reconcile.push({ seller: s, ok: false, discrepancies: 0, error: (err as Error).message });
    }
  }

  const settled: { order: string; result: string }[] = [];
  for (const o of await db`select id from orders where flow = 'platform' and status = 'paid'`) {
    try {
      const r = await settlePlatformOrder(o.id);
      settled.push({ order: o.id, result: "skipped" in r ? String(r.skipped) : `sent ${r.sentNow}` });
    } catch (err) {
      settled.push({ order: o.id, result: `error: ${(err as Error).message}` });
    }
  }

  const ok = reconcile.every((r) => r.ok) && settled.every((s) => !s.result.startsWith("error"));
  const summary = { sellers: sellers.length, reconcile, settled };
  await db`update job_runs set finished_at = now(), ok = ${ok}, summary = ${db.json(summary)} where id = ${run.id}`;
  if (!ok) await alert(`Ledgerly ops run #${run.id} needs attention: ${JSON.stringify(summary)}`);
  return { run: run.id as number, ok, summary };
}

/** Post to a Slack-compatible incoming webhook if one is configured. */
async function alert(text: string) {
  const url = env().ALERT_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(
    () => {},
  );
}
