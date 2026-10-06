import { z } from "zod";
import { sql } from "@/lib/db";
import { MAX_CONSOLE_IMPORT_ROWS } from "@/lib/import-csv";
import { after } from "next/server";
import { importSellers, parseSellersCsv } from "@/lib/import-sellers";
import { errorText, sameOrigin, syncSellerVerification } from "@/lib/operator";
import { currentOperator } from "@/lib/seller-session";

export const dynamic = "force-dynamic";
// 200 rows at 3 at a time is about a minute of Whop calls; retries on 429/5xx can stretch it.
export const maxDuration = 300;

const Body = z.object({
  csv: z.string().max(1_000_000),
  dryRun: z.boolean(),
});

/**
 * Operator seller import (the console's /import page). A dry run reports what would happen and
 * creates nothing; a real run creates (or finds) each seller's Whop account. Safe to repeat:
 * every row is idempotent by external_id. No onboarding links are minted or returned. Each real
 * run is recorded in seller_imports (who, and the counts).
 */
export async function POST(req: Request) {
  const operator = await currentOperator();
  if (!operator || !sameOrigin(req)) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Send the CSV as text (up to 1 MB)." }, { status: 400 });

  let rows;
  try {
    rows = parseSellersCsv(body.data.csv);
  } catch (err) {
    return Response.json({ error: `${(err as Error).message}. The first line must be the header: external_id,email,country,title,collection_mode.` }, { status: 400 });
  }
  if (rows.length === 0) return Response.json({ error: "There are no sellers in that file, only a header." }, { status: 400 });
  if (rows.length > MAX_CONSOLE_IMPORT_ROWS) {
    return Response.json(
      { error: `That file has ${rows.length} sellers; the console takes up to ${MAX_CONSOLE_IMPORT_ROWS} at a time. For bigger batches use pnpm ledgerly import-sellers.` },
      { status: 413 },
    );
  }

  try {
    const results = await importSellers(rows, { dryRun: body.data.dryRun, links: false });
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (!body.data.dryRun) {
      await sql()`
        insert into seller_imports (imported_by, created, existing, errors)
        values (${operator.name}, ${counts.created ?? 0}, ${counts.existing ?? 0}, ${counts.error ?? 0})`;
      // Fill in the new sellers' verification status now (never-synced sellers go first),
      // so the console doesn't show "Not synced yet" until the hourly run.
      if (counts.created) {
        after(() => syncSellerVerification({ limit: counts.created, deadline: Date.now() + 60_000 }).catch((e) => console.error("post-import sync failed", e?.message)));
      }
    }
    return Response.json({
      results: results.map((r) => ({ line: r.line, external_id: r.external_id, email: r.email, status: r.status, account_id: r.account_id, error: r.error })),
      counts,
    });
  } catch (err) {
    console.error(`seller import failed: ${errorText(err)}`);
    return Response.json({ error: "The import stopped unexpectedly. It's safe to run the same file again." }, { status: 500 });
  }
}
