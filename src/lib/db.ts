import postgres from "postgres";
import { env } from "./env";

declare global {
  var __ledgerlySql: postgres.Sql | undefined;
}

/**
 * One pool per server instance. `prepare: false` because DATABASE_URL points at
 * Supabase's transaction-mode pooler (port 6543), which doesn't support prepared statements.
 */
export function sql(): postgres.Sql {
  globalThis.__ledgerlySql ??= postgres(env().DATABASE_URL, { prepare: false, max: 5 });
  return globalThis.__ledgerlySql;
}
