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
  trace PAY_ID                    A payment's fee lines and both accounts' balances

Books
  reconcile [ID] [--fix]          Diff Whop vs the local ledger for one seller or all; exit 1 on any discrepancy.
                                  --fix first syncs payout state from Whop.

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
    for (const id of ids) print({ order: id, ...(await settlePlatformOrder(id)) });
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

  async reprocess() {
    // `reprocess` alone retries deferred/failed events; `reprocess TYPE` re-applies every stored
    // event of that type (handlers are idempotent).
    print(await reprocessStored({ type: args[0] }));
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
