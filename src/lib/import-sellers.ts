import { sql } from "./db";
import { onboardSeller, SellerInput } from "./onboarding";

/**
 * Bulk migration of Ledgerly's existing sellers onto Whop.
 *
 * Input CSV columns: external_id, email, country, title (optional), collection_mode (optional:
 * direct | platform). Every row goes through onboardSeller, which is idempotent, so a crashed
 * or interrupted import is resumed by running the same file again.
 */

export type ImportRow = { line: number; input?: SellerInput; error?: string };
export type ImportResult = {
  line: number;
  external_id: string;
  status: "created" | "existing" | "would_create" | "would_skip" | "error";
  account_id?: string;
  onboarding_url?: string;
  expires_at?: string;
  error?: string;
};

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
  if (field !== "" || row.length) endRow();
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

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
    const parsed = SellerInput.safeParse({
      externalId: get("external_id"),
      email: get("email"),
      country: get("country"),
      title: get("title"),
      collectionMode: get("collection_mode"),
    });
    if (!parsed.success) {
      return { line, error: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") };
    }
    if (seen.has(parsed.data.externalId)) return { line, error: `duplicate external_id ${parsed.data.externalId}` };
    seen.add(parsed.data.externalId);
    return { line, input: parsed.data };
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

export async function importSellers(
  rows: ImportRow[],
  opts: { dryRun?: boolean; concurrency?: number; onResult?: (r: ImportResult) => void } = {},
) {
  const results: ImportResult[] = [];
  const emit = (r: ImportResult) => {
    results.push(r);
    opts.onResult?.(r);
  };
  const existing = new Set(
    (await sql()`select external_id from sellers where whop_account_id is not null`).map((r) => r.external_id as string),
  );

  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const external_id = row.input?.externalId ?? "";
      if (!row.input) {
        emit({ line: row.line, external_id, status: "error", error: row.error });
        continue;
      }
      if (opts.dryRun) {
        emit({ line: row.line, external_id, status: existing.has(external_id) ? "would_skip" : "would_create" });
        continue;
      }
      try {
        const r = await withRetry(() => onboardSeller(row.input!));
        emit({
          line: row.line,
          external_id,
          status: r.created ? "created" : "existing",
          account_id: r.accountId,
          onboarding_url: r.onboardingUrl,
          expires_at: r.expiresAt ?? undefined,
        });
      } catch (err) {
        const e = err as { body?: unknown; message?: string };
        emit({ line: row.line, external_id, status: "error", error: JSON.stringify(e.body ?? e.message) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker));
  return results.sort((a, b) => a.line - b.line);
}

export function toCsv(results: ImportResult[]) {
  const cols = ["line", "external_id", "status", "account_id", "onboarding_url", "expires_at", "error"] as const;
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...results.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
