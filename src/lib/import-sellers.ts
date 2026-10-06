import { sql } from "./db";
import { whopErrorSummary } from "./errors";
import type { ImportResult } from "./import-csv";
import { ensureSellerAccount, onboardSeller, SellerInput, sellerConflicts } from "./onboarding";

export { toCsv, type ImportResult } from "./import-csv";

/**
 * Bulk migration of Ledgerly's existing sellers onto Whop.
 *
 * Input CSV columns: external_id, email, country, title (optional), collection_mode (optional:
 * direct | platform). Every row goes through onboardSeller, which is idempotent, so a crashed
 * or interrupted import is resumed by running the same file again. Used by the CLI
 * (`pnpm ledgerly import-sellers`) and the operator console (/import).
 */

/** A parsed row. externalId and email are the raw cells, kept for reporting invalid rows. */
export type ImportRow = { line: number; input?: SellerInput; error?: string; externalId?: string; email?: string };

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines in quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  if (quoted) throw new Error("CSV has an unclosed quote");
  if (field !== "" || row.length) endRow();
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** SellerInput field → CSV column, for error messages. */
const COLUMN: Record<string, string> = { externalId: "external_id", email: "email", country: "country", title: "title", collectionMode: "collection_mode" };

/** Parse and validate every row up front, so a bad file fails before any account is created. */
export function parseSellersCsv(text: string): ImportRow[] {
  const [header, ...body] = parseCsv(text);
  const cols = (header ?? []).map((h) => h.trim().toLowerCase());
  for (const required of ["external_id", "email", "country"]) {
    if (!cols.includes(required)) throw new Error(`CSV is missing the "${required}" column`);
  }
  const seen = new Set<string>();
  return body.map((cells, i) => {
    const line = i + 2;
    const get = (name: string) => cells[cols.indexOf(name)]?.trim() || undefined;
    const raw = { line, externalId: get("external_id"), email: get("email") };
    const parsed = SellerInput.safeParse({
      externalId: get("external_id"),
      email: get("email"),
      country: get("country"),
      title: get("title"),
      collectionMode: get("collection_mode"),
    });
    if (!parsed.success) {
      return { ...raw, error: parsed.error.issues.map((x) => `${COLUMN[String(x.path[0])] ?? x.path.join(".")} ${x.message}`).join("; ") };
    }
    if (seen.has(parsed.data.externalId)) return { ...raw, error: `duplicate external_id ${parsed.data.externalId}` };
    seen.add(parsed.data.externalId);
    return { ...raw, input: parsed.data };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry Whop rate limits and server errors with backoff; anything else fails the row. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 0;
      if (i >= attempts || !(status === 429 || status >= 500)) throw err;
      await sleep(Math.min(30_000, 500 * 2 ** i));
    }
  }
}

/**
 * Import parsed rows. A dry run calls nothing and reports would_create / would_skip, or an error
 * for a row that conflicts with the seller already stored under its external_id.
 * `links: false` skips minting onboarding links (they expire in about an hour; the seller's
 * status page mints a fresh one when they continue verification).
 */
export async function importSellers(
  rows: ImportRow[],
  opts: { dryRun?: boolean; concurrency?: number; links?: boolean; onResult?: (r: ImportResult) => void } = {},
) {
  const results: ImportResult[] = [];
  const emit = (r: ImportResult) => {
    results.push(r);
    opts.onResult?.(r);
  };
  const ids = rows.flatMap((r) => (r.input ? [r.input.externalId] : []));
  const existing = new Map(
    (
      await sql()`
        select external_id, email, country, collection_mode, whop_account_id
        from sellers where external_id = any(${ids}::text[])`
    ).map((r) => [r.external_id as string, r as unknown as { email: string; country: string; collection_mode: string; whop_account_id: string | null }]),
  );

  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const base = { line: row.line, external_id: row.input?.externalId ?? row.externalId ?? "", email: row.input?.email ?? row.email };
      if (!row.input) {
        emit({ ...base, status: "error", error: row.error });
        continue;
      }
      if (opts.dryRun) {
        const stored = existing.get(row.input.externalId);
        const conflicts = stored ? sellerConflicts(stored, SellerInput.parse(row.input)) : [];
        if (conflicts.length) emit({ ...base, status: "error", error: `already exists with a different ${conflicts.join(", ")}` });
        else emit({ ...base, status: stored?.whop_account_id ? "would_skip" : "would_create", account_id: stored?.whop_account_id ?? undefined });
        continue;
      }
      try {
        const input = row.input;
        if (opts.links === false) {
          const r = await withRetry(() => ensureSellerAccount(input));
          emit({ ...base, status: r.created ? "created" : "existing", account_id: r.accountId });
        } else {
          const r = await withRetry(() => onboardSeller(input));
          emit({
            ...base,
            status: r.created ? "created" : "existing",
            account_id: r.accountId,
            onboarding_url: r.onboardingUrl,
            expires_at: r.expiresAt ?? undefined,
          });
        }
      } catch (err) {
        // Only Whop's status, code and message: the full response body can echo personal data.
        const summary = whopErrorSummary(err);
        const error = summary ? `${summary.status} ${summary.code ?? summary.type ?? ""} ${summary.message ?? ""}`.replace(/\s+/g, " ").trim() : (err as Error).message;
        emit({ ...base, status: "error", error: error.slice(0, 300) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker));
  return results.sort((a, b) => a.line - b.line);
}
