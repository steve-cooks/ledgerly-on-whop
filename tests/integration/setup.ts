import "./helpers";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeEach, vi } from "vitest";

// Env must be in place before any app module reads it.
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set (run `pnpm test:integration`)");
Object.assign(process.env, {
  DATABASE_URL: url,
  WHOP_API_KEY: "apik_test",
  WHOP_PLATFORM_ACCOUNT_ID: "biz_platform",
  WHOP_WEBHOOK_SECRET: "ws_" + "a".repeat(64),
  APP_URL: "https://ledgerly.test",
});

// Fresh schema from the real migrations, once per file.
const admin = postgres(url, { max: 1, onnotice: () => {} });
await admin.unsafe("drop schema if exists public cascade; create schema public;");
const dir = join(process.cwd(), "supabase/migrations");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await admin.unsafe(readFileSync(join(dir, f), "utf8"));
}

beforeEach(async () => {
  await admin.unsafe(`truncate webhook_events, ledger_entries, payouts, refunds, disputes, seller_transfers, orders, sellers, job_runs restart identity cascade`);
  vi.clearAllMocks();
});

afterAll(async () => {
  await admin.end();
  const { sql } = await import("@/lib/db");
  await sql().end();
});
