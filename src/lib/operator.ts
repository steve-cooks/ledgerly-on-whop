import type postgres from "postgres";
import { z } from "zod";
import { sql } from "./db";
import { env } from "./env";
import { whopErrorSummary } from "./errors";
import { whop } from "./whop";

/**
 * Operator actions Whop's dashboard can't do for us: a seller list that knows who still needs
 * verification (mirrored locally, so it never calls Whop per row), verification reminders, and
 * switching a seller's payment mode. Browsing, balances, payments and compliance stay in Whop.
 */

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

// ── Verification mirror ─────────────────────────────────────────────────────────────────────

/**
 * The fields we mirror from a Whop account object (a webhook payload or accounts.retrieve).
 * A field the object doesn't carry is null, so it never overwrites what we already know.
 */
export function verificationFields(account: Obj) {
  const v = account.verification as { individual?: { status?: string } | null; business?: { status?: string } | null } | null | undefined;
  const actions = account.required_actions as { status?: string }[] | null | undefined;
  return {
    title: str(account.title),
    status: str(account.status),
    verificationStatus: v === undefined ? null : (v?.individual?.status ?? v?.business?.status ?? "not_started"),
    outstandingActions: actions === undefined ? null : (actions ?? []).filter((a) => a?.status !== "completed").length,
  };
}

/** Store an account snapshot taken at `at`. An older snapshot never overwrites a newer one. */
export async function applyAccountSnapshot(db: postgres.Sql | postgres.TransactionSql, account: Obj, at: string) {
  const id = str(account.id);
  if (!id) return;
  const f = verificationFields(account);
  await db`
    update sellers set
      title = coalesce(${f.title}, title),
      whop_status = coalesce(${f.status}, whop_status),
      verification_status = coalesce(${f.verificationStatus}, verification_status),
      outstanding_actions = coalesce(${f.outstandingActions}::int, outstanding_actions),
      verification_synced_at = ${at}::timestamptz,
      updated_at = now()
    where whop_account_id = ${id}
      and (verification_synced_at is null or verification_synced_at <= ${at}::timestamptz)`;
}

/**
 * Backfill the mirror from Whop (accounts.retrieve per seller), least recently synced first.
 * Webhooks keep it current; this covers sellers imported before them and any missed event.
 */
export async function syncSellerVerification(opts: { externalId?: string; limit?: number; deadline?: number } = {}) {
  const db = sql();
  const sellers = opts.externalId
    ? await db`select external_id, whop_account_id from sellers where external_id = ${opts.externalId} and whop_account_id is not null`
    : await db`
        select external_id, whop_account_id from sellers where whop_account_id is not null
        order by verification_synced_at asc nulls first, external_id
        limit ${opts.limit ?? 1_000_000}`;
  let synced = 0;
  let attempted = 0;
  const errors: string[] = [];
  for (const s of sellers) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    attempted++;
    try {
      const at = new Date().toISOString();
      const account = await whop().accounts.retrieve({ id: s.whop_account_id });
      await applyAccountSnapshot(db, { ...(account as unknown as Obj), id: s.whop_account_id }, at);
      synced++;
    } catch (err) {
      errors.push(`${s.external_id}: ${errorText(err)}`);
    }
  }
  return { synced, errors, remaining: sellers.length - attempted };
}

/** "Needs verification": not approved by Whop, or Whop still lists something to do. */
export function needsVerification(s: { verification_status: string | null; outstanding_actions: number }) {
  return s.verification_status !== "approved" || s.outstanding_actions > 0;
}

type Tone = "good" | "warn" | "bad" | "neutral";

/** Plain-English verification state for the seller list. */
export function verificationLabel(s: {
  whop_account_id: string | null;
  whop_status: string | null;
  verification_status: string | null;
  outstanding_actions: number;
}): { label: string; tone: Tone } {
  if (!s.whop_account_id) return { label: "Not on Whop yet", tone: "neutral" };
  if (s.whop_status === "suspended") return { label: "Suspended", tone: "bad" };
  const v = s.verification_status;
  if (!v) return { label: "Not synced yet", tone: "neutral" };
  const open = s.outstanding_actions;
  if (v === "approved" || v === "verified") {
    return open > 0 ? { label: `${open} action${open === 1 ? "" : "s"} open`, tone: "warn" } : { label: "Verified", tone: "good" };
  }
  if (["submitted", "processing", "review", "manual_review", "pending"].includes(v)) return { label: "In review", tone: "neutral" };
  if (["declined", "canceled", "expired", "abandoned"].includes(v)) return { label: `Verification ${v}`, tone: "bad" };
  if (v === "not_started" || v === "created") return { label: "Not started", tone: "warn" };
  return { label: "Action needed", tone: "warn" };
}

// ── Seller list ─────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 25;
export const SellerFilter = z.enum(["needs_verification", "all"]).catch("needs_verification");
export type SellerFilter = z.infer<typeof SellerFilter>;

export type SellerRow = {
  external_id: string;
  email: string;
  country: string;
  title: string | null;
  whop_account_id: string | null;
  whop_status: string | null;
  collection_mode: "direct" | "platform";
  fee_bps: number | null;
  verification_status: string | null;
  outstanding_actions: number;
  last_reminder_at: Date | null;
};

/** One page of sellers for the console: search by external id, email or title. */
export async function listSellers(opts: { q?: string; filter?: string; page?: number | string }) {
  const db = sql();
  const q = (opts.q ?? "").trim().slice(0, 100);
  const filter = SellerFilter.parse(opts.filter);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const search = () => db`(${pattern}::text is null or s.external_id ilike ${pattern} or s.email ilike ${pattern} or s.title ilike ${pattern})`;
  // Keep in step with needsVerification().
  const needs = () => db`(s.verification_status is distinct from 'approved' or s.outstanding_actions > 0)`;

  const [counts] = await db`
    select count(*)::int as all_sellers, count(*) filter (where ${needs()})::int as needs_verification
    from sellers s where ${search()}`;
  const total: number = filter === "all" ? counts.all_sellers : counts.needs_verification;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(opts.page) || 1)));

  const rows = await db<SellerRow[]>`
    select s.external_id, s.email, s.country, s.title, s.whop_account_id, s.whop_status, s.collection_mode, s.fee_bps,
           s.verification_status, s.outstanding_actions, r.last_reminder_at
    from sellers s
    left join lateral (
      select max(sent_at) as last_reminder_at from seller_reminders where seller_external_id = s.external_id and ok
    ) r on true
    where ${search()} and (${filter === "all"}::boolean or ${needs()})
    order by s.created_at desc, s.external_id
    limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`;

  return { rows, q, filter, page, pages, total, counts: { all: counts.all_sellers as number, needsVerification: counts.needs_verification as number } };
}

// ── Reminders ───────────────────────────────────────────────────────────────────────────────

export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** How long a reminder stays on the seller's status page. */
export const REMINDER_VISIBLE_MS = 14 * 24 * 60 * 60 * 1000;

export type ReminderResult = { status: "sent" } | { status: "cooldown"; lastSentAt: Date; nextAt: Date } | { status: "not_found" };

/**
 * Ask a seller to finish verification. Reminders are in-app: the seller sees the latest one on
 * their status page (Whop doesn't let a company key notify connected accounts). At most one
 * per seller per 24h; every reminder is recorded in seller_reminders.
 */
export async function sendVerificationReminder(externalId: string, sentBy: string): Promise<ReminderResult> {
  return sql().begin(async (tx): Promise<ReminderResult> => {
    // Lock the seller so two operators clicking at once record one reminder.
    const [seller] = await tx`select external_id from sellers where external_id = ${externalId} for update`;
    if (!seller) return { status: "not_found" };
    const [last] = await tx`
      select sent_at from seller_reminders where seller_external_id = ${externalId} and ok order by sent_at desc limit 1`;
    if (last && Date.now() - last.sent_at.getTime() < REMINDER_COOLDOWN_MS) {
      return { status: "cooldown", lastSentAt: last.sent_at, nextAt: new Date(last.sent_at.getTime() + REMINDER_COOLDOWN_MS) };
    }
    await tx`insert into seller_reminders (seller_external_id, sent_by, ok) values (${externalId}, ${sentBy}, true)`;
    return { status: "sent" };
  });
}

/** A seller's latest reminder, or null. */
export async function lastReminder(externalId: string) {
  const [r] = await sql()`
    select sent_at, sent_by from seller_reminders
    where seller_external_id = ${externalId} and ok order by sent_at desc limit 1`;
  return (r ?? null) as { sent_at: Date; sent_by: string } | null;
}

// ── Payment mode ────────────────────────────────────────────────────────────────────────────

export const CollectionMode = z.enum(["direct", "platform"]);
export type CollectionMode = z.infer<typeof CollectionMode>;

export type ModeResult = { status: "changed"; from: CollectionMode; to: CollectionMode } | { status: "unchanged" } | { status: "not_found" };

/**
 * Switch how a seller's NEW checkouts collect money. Existing orders keep the flow they were
 * created with (orders.flow), so settlement and refunds of past sales are unaffected.
 */
export async function setCollectionMode(externalId: string, mode: CollectionMode, changedBy: string): Promise<ModeResult> {
  const to = CollectionMode.parse(mode);
  return sql().begin(async (tx): Promise<ModeResult> => {
    const [s] = await tx`select collection_mode from sellers where external_id = ${externalId} for update`;
    if (!s) return { status: "not_found" };
    if (s.collection_mode === to) return { status: "unchanged" };
    await tx`update sellers set collection_mode = ${to}, updated_at = now() where external_id = ${externalId}`;
    await tx`
      insert into seller_mode_changes (seller_external_id, from_mode, to_mode, changed_by)
      values (${externalId}, ${s.collection_mode}, ${to}, ${changedBy})`;
    return { status: "changed", from: s.collection_mode, to };
  });
}

// ── Ledgerly fee ────────────────────────────────────────────────────────────────────────────

/** The most an operator can set, in basis points (50%). Matches the sellers.fee_bps check. */
export const MAX_FEE_BPS = 5000;

/**
 * An operator's fee input: a percentage with up to 2 decimals between 0 and 50 ("10", "7.5%"),
 * or empty / "default" for the platform default (null). Parsed as text, so no float rounding.
 */
export function parseFeePercent(input: FormDataEntryValue | null): { ok: true; bps: number | null } | { ok: false } {
  const text = (typeof input === "string" ? input : "").trim().replace(/\s*%$/, "");
  if (text === "" || text.toLowerCase() === "default") return { ok: true, bps: null };
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return { ok: false };
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bps <= MAX_FEE_BPS ? { ok: true, bps } : { ok: false };
}

export type FeeResult = { status: "changed"; from: number | null; to: number | null } | { status: "unchanged" } | { status: "not_found" };

/**
 * Set a seller's Ledgerly fee (null = platform default). Applies to NEW checkouts only: each
 * order stores the fee it was created with, so settlement and refunds of past sales keep theirs.
 */
export async function setSellerFee(externalId: string, bps: number | null, changedBy: string): Promise<FeeResult> {
  if (bps !== null && (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS)) throw new Error(`fee must be 0–${MAX_FEE_BPS} bps`);
  return sql().begin(async (tx): Promise<FeeResult> => {
    const [s] = await tx`select fee_bps from sellers where external_id = ${externalId} for update`;
    if (!s) return { status: "not_found" };
    if (s.fee_bps === bps) return { status: "unchanged" };
    await tx`update sellers set fee_bps = ${bps}, updated_at = now() where external_id = ${externalId}`;
    await tx`
      insert into seller_fee_changes (seller_external_id, from_bps, to_bps, changed_by)
      values (${externalId}, ${s.fee_bps}, ${bps}, ${changedBy})`;
    return { status: "changed", from: s.fee_bps, to: bps };
  });
}

/** A seller's own fee setting: a number of bps, null for the platform default, undefined if unknown. */
/** A seller's display name for operator messages: their title, else their id. */
export async function sellerDisplayName(externalId: string) {
  const [s] = await sql()`select coalesce(title, external_id) as name from sellers where external_id = ${externalId}`;
  return (s?.name as string | undefined) ?? externalId;
}

export async function sellerFeeSetting(externalId: string) {
  const [s] = await sql()`select fee_bps from sellers where external_id = ${externalId}`;
  return s ? (s.fee_bps as number | null) : undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

/** A safe, short description of an error: Whop's own message when it's a Whop error. */
export function errorText(err: unknown) {
  const w = whopErrorSummary(err);
  if (w) return `Whop ${w.status}: ${w.message ?? w.type ?? "error"}`;
  return (err as Error)?.message ?? String(err);
}

/**
 * Where an operator form returns to: a same-site path from the form (default the console),
 * with the outcome in the query string.
 */
export function backUrl(req: Request, back: FormDataEntryValue | null, params: Record<string, string>) {
  const base = new URL(req.url);
  let target = new URL("/", base);
  if (typeof back === "string" && back.startsWith("/") && !back.startsWith("//")) {
    try {
      const u = new URL(back, base);
      if (u.origin === base.origin) target = u;
    } catch {
      // keep the console
    }
  }
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return target;
}

/** A browser form post from another site carries a different Origin: refuse it. */
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

/** Whop's dashboard: Ledgerly's connected accounts, or one of them. */
/** Whop's Developer page for Ledgerly's account (webhooks and their delivery logs). */
export function whopDeveloperUrl() {
  return `https://whop.com/dashboard/${env().WHOP_PLATFORM_ACCOUNT_ID}/developer/`;
}

export function whopDashboardUrl(accountId?: string | null) {
  return `https://whop.com/dashboard/${env().WHOP_PLATFORM_ACCOUNT_ID}/connected-companies/${accountId ?? ""}`;
}
