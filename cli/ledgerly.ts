// Ledgerly operations CLI.  Run `pnpm ledgerly help`.
import "../scripts/_setup";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sql } from "@/lib/db";
import { whop } from "@/lib/whop";
import { onboardSeller, freshOnboardingLink } from "@/lib/onboarding";
import { createCheckout, settlePlatformOrder } from "@/lib/checkout";
import { fetchPlatformPayments, reconcileSeller, repairPayouts } from "@/lib/reconcile";
import { importSellers, parseSellersCsv, toCsv } from "@/lib/import-sellers";
import { reprocessStored } from "@/lib/webhook-processor";
import { refreshPendingTransfers } from "@/lib/transfers";
import { runOpsJob } from "@/lib/ops-job";
import { createPlatformWebhook, syncPlatformWebhook, writeWebhookSecret } from "@/lib/webhook-setup";
import { whopErrorSummary } from "@/lib/errors";
import { OPERATOR, signToken } from "@/lib/seller-session";

const HELP = `
ledgerly <command> [options]

Sellers
  onboard --external-id ID --email E --country CC [--title T] [--mode direct|platform]
                                  Create or fetch a seller's Whop account; print an onboarding link
  onboarding-link ID              Fresh onboarding link for an existing seller
  import-sellers FILE.csv [--dry-run] [--out results.csv] [--concurrency 3]
                                  Bulk-migrate sellers (columns: external_id,email,country,title,collection_mode).
                                  Idempotent: re-run the same file to resume.
  login-link ID|--operator        Demo-only sign-in link (24h): a seller's Seller Hub, or the operator console

Money
  checkout --seller ID --title T --sku SKU --price 10 [--request-key K]
                                  Checkout with Ledgerly's 8%; flow follows the seller's policy
  settle [ORDER_ID]               Pay sellers for platform-collected orders (all paid orders if omitted)
  settle ORDER_ID --replace-failed
                                  Send a new transfer after one failed AT WHOP. Only once Whop has confirmed
                                  the failed one is final: Whop can retry a failed transfer to success.
  transfers:refresh               Ask Whop about transfers still pending (or failed in the last 14 days);
                                  resend requests that never got an answer, under the same key
  trace PAY_ID                    A payment's fee lines and both accounts' balances

Books
  reconcile [ID] [--fix]          Diff Whop vs the local ledger for one seller or all; exit 1 on any discrepancy.
                                  --fix first syncs payout state from Whop.

Checks
  ops                             Run the hourly ops job now (replay, transfers, settle, reconcile) and print its summary
  smoke                           Live checks against APP_URL that move no money: health, auth refusals,
                                  a signed Whop test event, a replayed delivery, order + reconcile APIs

Webhooks
  webhook:create                  Create the platform webhook (all sellers' events, pinned version);
                                  writes the signing secret to .env.local without printing it
  webhook:sync [HOOK_ID]          Update an existing webhook's events and version pin to match the code
  reprocess [EVENT_TYPE]          Retry deferred/failed events; with a type, re-apply every stored event of it
                                  (handlers are idempotent). Can't recover events never delivered: see RUNBOOK.
`;

const [command, ...rest] = process.argv.slice(2);
const { values: opt, positionals: args } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    "external-id": { type: "string" },
    email: { type: "string" },
    country: { type: "string" },
    title: { type: "string" },
    mode: { type: "string" },
    seller: { type: "string" },
    "replace-failed": { type: "boolean" },
    sku: { type: "string" },
    price: { type: "string" },
    "request-key": { type: "string" },
    out: { type: "string" },
    concurrency: { type: "string" },
    "dry-run": { type: "boolean" },
    fix: { type: "boolean" },
    operator: { type: "boolean" },
  },
});
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const commands: Record<string, () => Promise<unknown>> = {
  async onboard() {
    print(
      await onboardSeller({
        externalId: opt["external-id"]!,
        email: opt.email!,
        country: opt.country!,
        title: opt.title,
        collectionMode: (opt.mode as "direct" | "platform") ?? "direct",
      }),
    );
  },

  async "onboarding-link"() {
    print(await freshOnboardingLink(args[0]));
  },

  async "import-sellers"() {
    const rows = parseSellersCsv(readFileSync(args[0], "utf8"));
    const invalid = rows.filter((r) => r.error);
    console.error(`${rows.length} rows, ${invalid.length} invalid${opt["dry-run"] ? " (dry run: nothing is created)" : ""}`);
    const results = await importSellers(rows, {
      dryRun: opt["dry-run"],
      concurrency: Number(opt.concurrency ?? 3),
      onResult: (r) => console.error(`line ${r.line}\t${r.status}\t${r.external_id}${r.error ? `\t${r.error}` : ""}`),
    });
    const out = opt.out ?? args[0].replace(/\.csv$/i, "") + ".results.csv";
    writeFileSync(out, toCsv(results));
    const count = (s: string) => results.filter((r) => r.status === s).length;
    print({
      results_file: out,
      created: count("created"),
      existing: count("existing"),
      would_create: count("would_create"),
      would_skip: count("would_skip"),
      errors: count("error"),
    });
    if (count("error")) process.exitCode = 1;
  },

  async "login-link"() {
    const subject = opt.operator ? OPERATOR : args[0];
    if (!subject) throw new Error("pass a seller external id or --operator");
    console.log(`${process.env.APP_URL}/demo/login?t=${encodeURIComponent(signToken(subject))}`);
  },

  async checkout() {
    print(
      await createCheckout({
        sellerExternalId: opt.seller!,
        title: opt.title!,
        sku: opt.sku!,
        price: Number(opt.price),
        currency: "usd",
        requestKey: opt["request-key"],
      }),
    );
  },

  async settle() {
    const ids = args[0]
      ? [args[0]]
      : (await sql()`select id from orders where flow = 'platform' and status = 'paid'`).map((o) => o.id as string);
    if (opt["replace-failed"] && !args[0]) throw new Error("--replace-failed needs an ORDER_ID");
    for (const id of ids) print({ order: id, ...(await settlePlatformOrder(id, { replaceFailed: opt["replace-failed"] })) });
  },

  async "transfers:refresh"() {
    const r = await refreshPendingTransfers({ olderThanMinutes: 0 });
    print(r);
    if (r.errors.length) process.exitCode = 1;
  },

  async ops() {
    const r = await runOpsJob();
    print(r);
    if (!r.ok) process.exitCode = 1;
  },

  async trace() {
    const id = args[0];
    const payment = (await whop().payments.retrieve({ id })) as unknown as Record<string, unknown>;
    const fees = await whop().payments.listFees({ id });
    const balances: Record<string, unknown> = {};
    for (const acct of [payment.account_id as string, process.env.WHOP_PLATFORM_ACCOUNT_ID!]) {
      balances[acct] = (await whop().accounts.retrieve({ id: acct })).balances;
    }
    print({
      payment: { id, account: payment.account_id, status: payment.status, substatus: payment.substatus, total: payment.total, amount_after_fees: payment.amount_after_fees },
      fees: fees.data.map((f) => ({ origin: f.origin, amount: f.amount.amount })),
      balances,
    });
  },

  async reconcile() {
    const sellers = args[0]
      ? [args[0]]
      : (await sql()`select external_id from sellers where whop_account_id is not null order by external_id`).map((r) => r.external_id as string);
    let ok = true;
    const platformPayments = await fetchPlatformPayments();
    for (const s of sellers) {
      if (opt.fix) await repairPayouts(s);
      const r = await reconcileSeller(s, { platformPayments });
      ok &&= r.ok;
      print(r);
    }
    if (!ok) process.exitCode = 1;
  },

  async "webhook:create"() {
    const hook = await createPlatformWebhook();
    writeWebhookSecret(hook.id, hook.webhook_secret ?? "");
    print({ id: hook.id, url: hook.url, events: hook.events, secret: "written to .env.local; add it to your host's env too" });
  },

  async "webhook:sync"() {
    const id = args[0] ?? process.env.WHOP_WEBHOOK_ID;
    if (!id) throw new Error("pass the webhook id (hook_...) or set WHOP_WEBHOOK_ID");
    const hook = await syncPlatformWebhook(id);
    print({ id: hook.id, events: hook.events, api_version_date: hook.api_version_date });
  },

  async smoke() {
    const base = process.env.APP_URL!;
    const admin = { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` };
    const results: [string, boolean, string][] = [];
    const check = async (name: string, fn: () => Promise<[boolean, string]>) => {
      try {
        results.push([name, ...(await fn())]);
      } catch (err) {
        results.push([name, false, (err as Error).message]);
      }
    };
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers, redirect: "manual" });

    await check("health", async () => {
      const r = await get("/api/health");
      return [r.ok, `${r.status}`];
    });
    await check("admin API refuses without a token", async () => {
      const r = await get("/api/reconcile/x");
      return [r.status === 401, `${r.status}`];
    });
    await check("cron refuses without its secret", async () => {
      const r = await get("/api/cron/ops");
      return [r.status === 401, `${r.status}`];
    });
    await check("webhook refuses an unsigned body", async () => {
      const r = await fetch(`${base}/api/webhooks/whop`, { method: "POST", body: "{}" });
      return [r.status === 401, `${r.status}`];
    });
    await check("operator console requires sign-in", async () => {
      const html = await (await get("/")).text();
      return [html.includes("Operator sign-in required"), "gate shown"];
    });
    await check("expired or forged sign-in link is refused", async () => {
      const r = await get("/demo/login?t=operator.1.forged");
      return [r.status === 401, `${r.status}`];
    });
    await check("Whop test event is verified and recorded", async () => {
      const r = await whop().webhooks.test({ id: process.env.WHOP_WEBHOOK_ID!, event: "account.updated" });
      const outcome = JSON.parse(String(r.body ?? "{}")).outcome;
      return [r.status === 200 && ["processed", "ignored"].includes(outcome), `${r.status} ${outcome}`];
    });
    await check("replayed delivery is recognised as a duplicate", async () => {
      for await (const d of await whop().webhooks.listDeliveries({ id: process.env.WHOP_WEBHOOK_ID!, first: 20 })) {
        if (!d.success || d.replayed_from) continue;
        const r = await whop().webhooks.replayDelivery({ id: process.env.WHOP_WEBHOOK_ID!, delivery_id: d.id });
        const outcome = JSON.parse(String(r.body ?? "{}")).outcome;
        return [outcome === "duplicate", `${d.event} → ${outcome}`];
      }
      return [false, "no delivery to replay"];
    });
    await check("order API answers", async () => {
      const [o] = await sql()`select id from orders order by created_at desc limit 1`;
      const r = await get(`/api/orders/${o.id}`, admin);
      return [r.ok, `${r.status}`];
    });
    await check("reconcile API: every seller matches Whop", async () => {
      const sellers = await sql()`select external_id from sellers where whop_account_id is not null`;
      const reports = await Promise.all(sellers.map(async (s) => (await get(`/api/reconcile/${s.external_id}`, admin)).status));
      return [reports.every((s) => s === 200), reports.join(",")];
    });

    for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
    if (results.some(([, ok]) => !ok)) process.exitCode = 1;
  },

  async reprocess() {
    // `reprocess` alone retries deferred/failed events; `reprocess TYPE` re-applies every stored
    // event of that type (handlers are idempotent).
    const r = await reprocessStored({ type: args[0] });
    print(r);
    if (r.failed.length) process.exitCode = 1;
  },
};

async function main() {
  const run = commands[command ?? ""];
  if (!run) {
    console.log(HELP);
    process.exitCode = command && command !== "help" ? 1 : 0;
    return;
  }
  await run();
}

main()
  .catch((err) => {
    const e = err as { message?: string; issues?: unknown };
    console.error("error:", e.issues ?? whopErrorSummary(err) ?? e.message);
    process.exitCode = 1;
  })
  .finally(() => sql().end());
