/**
 * The seller-import CSV formats, without server dependencies so the operator console can build
 * files in the browser. Parsing and importing live in import-sellers.ts.
 */

/** The columns an import file needs (title and collection_mode may be empty). */
export const IMPORT_COLUMNS = ["external_id", "email", "country", "title", "collection_mode"] as const;

/** The most rows the console imports in one upload; bigger batches go through the CLI. */
export const MAX_CONSOLE_IMPORT_ROWS = 200;

export type ImportResult = {
  line: number;
  external_id: string;
  email?: string;
  status: "created" | "existing" | "would_create" | "would_skip" | "error";
  account_id?: string;
  onboarding_url?: string;
  expires_at?: string;
  error?: string;
};

/** The CLI's results file. Onboarding links are short-lived (about an hour). */
export const CLI_RESULT_COLUMNS = ["line", "external_id", "status", "account_id", "onboarding_url", "expires_at", "error"] as const;

export function toCsv(results: ImportResult[], cols: readonly (keyof ImportResult)[] = CLI_RESULT_COLUMNS) {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...results.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
