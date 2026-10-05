// Ad-hoc read-only query helper: pnpm tsx scripts/sql.ts "select ..."
import "./_setup";
import { sql } from "@/lib/db";
sql()
  .unsafe(process.argv[2])
  .then((rows) => console.log(JSON.stringify(rows, null, 2)))
  .finally(() => sql().end());
