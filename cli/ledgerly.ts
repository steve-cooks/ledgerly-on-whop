// Ledgerly operations CLI.  Run `pnpm ledgerly help`.
import "../scripts/_setup";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sql } from "@/lib/db";
import { whop } from "@/lib/whop";
import { onboardSeller, freshOnboardingLink } from "@/lib/onboarding";
import { createCheckout, settlePlatformOrder } from "@/lib/checkout";
import { reconcileSeller, repairPayouts } from "@/lib/reconcile";
import { importSellers, parseSellersCsv, toCsv } from "@/lib/import-sellers";
import { handlers } from "@/lib/webhook-handlers";
import { eventAccountId, type WhopEvent } from "@/lib/webhooks";
import { signedLoginToken } from "@/lib/seller-session";

const HELP = `
ledgerly <command> [options]

Sellers
  onboard --external-id ID --email E --country CC [--title T] [--mode direct|platform]
                                  Create or fetch a seller's Whop account; print an onboarding link
  onboarding-link ID              Fresh onboarding link for an existing seller
  import-sellers FILE.csv [--dry-run] [--out results.csv] [--concurrency 3]
                                  Bulk-migrate sellers (columns: external_id,email,country,title,collection_mode).
                                  Idempotent: re-run the same file to resume.
  login-link ID                   Demo-only Seller Hub sign-in link

Money
  checkout --seller ID --title T --sku SKU --price 10 [--currency usd]
                                  Checkout with Ledgerly's 8%; flow follows the seller's policy
  settle [ORDER_ID]               Pay sellers for platform-collected orders (all paid orders if omitted)
  trace PAY_ID                    A payment's fee lines and both accounts' balances

Books
  reconcile [ID] [--fix]          Diff Whop vs the local ledger for one seller or all; exit 1 on any discrepancy.
                                  --fix first syncs payout state from Whop.

Webhooks
  webhook:create                  Create the platform webhook (8 events, child accounts, pinned version);
                                  writes the signing secret to .env.local without printing it
  reprocess EVENT_TYPE            Re-run handlers over stored events (all handlers are idempotent)
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
    currency: { type: "string" },
    out: { type: "string" },
    concurrency: { type: "string" },
    "dry-run": { type: "boolean" },
    fix: { type: "boolean" },
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
    console.log(`${process.env.APP_URL}/demo/login?t=${encodeURIComponent(signedLoginToken(args[0]))}`);
  },

  async checkout() {
    print(
      await createCheckout({
        sellerExternalId: opt.seller!,
        title: opt.title!,
        sku: opt.sku!,
        price: Number(opt.price),
        currency: (opt.currency as "usd" | "eur" | "brl") ?? "usd",
      }),
    );
  },

  async settle() {
    const ids = args[0]
      ? [args[0]]
      : (await sql()`select id from orders where flow = 'platform' and status = 'paid'`).map((o) => o.id as string);
    for (const id of ids) print({ order: id, ...(await settlePlatformOrder(id)), transfer: undefined });
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
    for (const s of sellers) {
      if (opt.fix) await repairPayouts(s);
      const r = await reconcileSeller(s);
      ok &&= r.ok;
      print(r);
    }
    if (!ok) process.exitCode = 1;
  },

  async "webhook:create"() {
    const platform = process.env.WHOP_PLATFORM_ACCOUNT_ID!;
    const url = `${process.env.APP_URL}/api/webhooks/whop`;
    for await (const w of await whop().webhooks.list({ account_id: platform })) {
      if (w.url === url) throw new Error(`a webhook for ${url} already exists: ${w.id}`);
    }
    const hook = await whop().webhooks.create({
      url,
      resource_id: platform,
      child_resource_events: true,
      api_version_date: "2026-09-29",
      events: ["payment.succeeded", "payment.failed", "refund.created", "dispute.created", "transfer.completed", "payout.created", "payout.updated", "account.updated"],
    });
    const env = readFileSync(".env.local", "utf8").split("\n").filter((l) => !/^WHOP_WEBHOOK_(SECRET|ID)=/.test(l));
    writeFileSync(".env.local", env.join("\n").trimEnd() + "\n");
    appendFileSync(".env.local", `WHOP_WEBHOOK_SECRET=${hook.webhook_secret}\nWHOP_WEBHOOK_ID=${hook.id}\n`);
    print({ id: hook.id, url: hook.url, events: hook.events, secret: "written to .env.local; add it to your host's env too" });
  },

  async reprocess() {
    const type = args[0];
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
    }
    print({ reprocessed: rows.length, type });
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
    const e = err as { body?: unknown; message?: string; issues?: unknown };
    console.error("error:", e.issues ?? e.body ?? e.message);
    process.exitCode = 1;
  })
  .finally(() => sql().end());
