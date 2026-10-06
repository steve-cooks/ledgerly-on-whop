"use client";

import { useState } from "react";
import { btnGhost, btnPrimary } from "@/components/styles";
import { Badge, Card } from "@/components/ui";
import { IMPORT_COLUMNS, toCsv, type ImportResult } from "@/lib/import-csv";

type Row = Pick<ImportResult, "line" | "external_id" | "email" | "status" | "account_id" | "error">;
type Outcome = { results: Row[]; counts: Partial<Record<Row["status"], number>> };

const STATUS: Record<Row["status"], { label: string; tone: "good" | "neutral" | "bad" }> = {
  would_create: { label: "Will create", tone: "good" },
  would_skip: { label: "Already on Whop", tone: "neutral" },
  created: { label: "Created", tone: "good" },
  existing: { label: "Already on Whop", tone: "neutral" },
  error: { label: "Error", tone: "bad" },
};

const MAX_BYTES = 1_000_000;
const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_COLUMNS.join(",") + "\n")}`;
const RESULT_COLUMNS = ["line", "external_id", "email", "status", "account_id", "error"] as const;

async function send(csv: string, dryRun: boolean): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch("/api/operator/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv, dryRun }),
    });
  } catch {
    throw new Error("Couldn't reach Ledgerly. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as (Outcome & { error?: string }) | null;
  if (res.status === 403) throw new Error("Your operator session ended. Sign in again from the console.");
  if (!res.ok || !body?.results) {
    throw new Error(
      body?.error ??
        (dryRun
          ? "The preview didn't finish. Please try again."
          : "The import didn't finish. It's safe to run the same file again: sellers already created show as already on Whop."),
    );
  }
  return body;
}

/** Upload or paste a CSV → preview (dry run) → import → per-row results. */
export function ImportSellers({ whopBase, maxRows }: { whopBase: string; maxRows: number }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Outcome | null>(null);
  const [done, setDone] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function edit(text: string, name: string | null = null) {
    setCsv(text);
    setFileName(name);
    setPreview(null);
    setError(null);
  }

  async function chooseFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // choosing the same file again still fires
    if (!file) return;
    if (file.size > MAX_BYTES) return setError("That file is over 1 MB. For bigger batches use pnpm ledgerly import-sellers.");
    edit(await file.text(), file.name);
  }

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "preview" : "import");
    setError(null);
    try {
      const outcome = await send(csv, dryRun);
      if (dryRun) setPreview(outcome);
      else setDone(outcome);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    edit("");
    setDone(null);
  }

  function download() {
    const blob = new Blob([toCsv(done!.results as ImportResult[], RESULT_COLUMNS)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ledgerly-import-results-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }

  const errorBox = error && (
    <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
      {error}
    </p>
  );

  if (done) {
    const n = (s: Row["status"]) => done.counts[s] ?? 0;
    return (
      <Card
        title="Import finished"
        description={`${n("created")} created · ${n("existing")} already on Whop · ${n("error")} with errors`}
        action={
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={download} className={btnGhost}>
              Download results
            </button>
            <button type="button" onClick={reset} className={btnPrimary}>
              Import another file
            </button>
          </div>
        }
      >
        <p className="mb-4 text-sm text-muted">
          Next: each seller signs in to Ledgerly with the email above, finds their store waiting and continues verification with Whop from
          their dashboard.
        </p>
        {n("error") > 0 && (
          <p className="mb-4 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">
            Rows with errors weren&apos;t imported. Fix them and import the file again: sellers already created are skipped.
          </p>
        )}
        <ResultsTable rows={done.results} whopBase={whopBase} />
      </Card>
    );
  }

  const willCreate = preview?.counts.would_create ?? 0;
  return (
    <div className="space-y-6">
      <Card
        title="Sellers to import"
        description={`A CSV with external_id, email and country, plus optional title and collection_mode (direct or platform). Up to ${maxRows} sellers per upload.`}
        action={
          <a href={TEMPLATE_HREF} download="ledgerly-sellers-template.csv" className="shrink-0 whitespace-nowrap text-sm font-medium text-accent-ink hover:underline">
            Download template
          </a>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className={`${btnGhost} cursor-pointer focus-within:ring-2 focus-within:ring-accent/30`}>
              Choose CSV file
              <input type="file" accept=".csv,text/csv" onChange={chooseFile} className="sr-only" />
            </label>
            <span className="text-sm text-muted">{fileName ? <span className="font-medium text-ink">{fileName}</span> : "or paste the rows below"}</span>
          </div>
          <textarea
            value={csv}
            onChange={(e) => edit(e.target.value)}
            rows={8}
            spellCheck={false}
            aria-label="Sellers CSV"
            placeholder={`${IMPORT_COLUMNS.join(",")}\nseller_123,mira@example.com,US,Mira Presets,direct`}
            className="block w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed text-ink outline-none placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          {!preview && errorBox}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-subtle">
              Bigger batches: <code className="font-mono">pnpm ledgerly import-sellers</code>
            </p>
            <button type="button" onClick={() => run(true)} disabled={!csv.trim() || busy !== null} className={btnPrimary}>
              {busy === "preview" ? "Checking…" : "Preview"}
            </button>
          </div>
        </div>
      </Card>

      {preview && (
        <Card
          title="Preview"
          description={`Nothing has been created yet. ${willCreate} new · ${preview.counts.would_skip ?? 0} already on Whop · ${preview.counts.error ?? 0} with errors`}
        >
          <ResultsTable rows={preview.results} whopBase={whopBase} />
          <div className="mt-5 space-y-3 border-t border-line pt-5">
            {errorBox}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {willCreate === 0
                  ? "Nothing new to import."
                  : (preview.counts.error ?? 0) > 0
                    ? "Rows with errors are left out. You can fix them and import the file again later."
                    : "Safe to run again: sellers already on Whop are skipped."}
              </p>
              <button type="button" onClick={() => run(false)} disabled={willCreate === 0 || busy !== null} className={btnPrimary}>
                {busy === "import" ? "Importing… keep this tab open" : `Import ${willCreate} ${willCreate === 1 ? "seller" : "sellers"}`}
              </button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function ResultsTable({ rows, whopBase }: { rows: Row[]; whopBase: string }) {
  return (
    <div className="max-h-[32rem] overflow-auto rounded-xl border border-line">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-subtle shadow-[0_1px_0_var(--line)]">
          <tr>
            <th className="px-3 py-2 font-medium">Line</th>
            <th className="px-3 py-2 font-medium">Seller</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Whop account</th>
            <th className="px-3 py-2 text-right font-medium">
              <span className="sr-only">Links</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const s = STATUS[r.status];
            return (
              <tr key={r.line} className="align-top">
                <td className="px-3 py-2.5 tabular text-muted">{r.line}</td>
                <td className="px-3 py-2.5">
                  <p className="font-mono text-xs text-ink">{r.external_id || "—"}</p>
                  {r.email && <p className="text-xs text-muted">{r.email}</p>}
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone={s.tone}>{s.label}</Badge>
                  {r.error && <p className="mt-1 max-w-sm text-xs text-danger">{r.error}</p>}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-muted">{r.account_id ?? "—"}</td>
                <td className="px-3 py-2.5 text-right">
                  {r.account_id && (
                    <a
                      href={whopBase + encodeURIComponent(r.account_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="whitespace-nowrap text-xs font-medium text-accent-ink hover:underline"
                    >
                      Open in Whop ↗
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
