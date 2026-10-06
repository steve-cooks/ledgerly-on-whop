import { timingSafeEqual } from "node:crypto";
import { env } from "./env";
import { ConflictError, whopErrorSummary } from "./errors";

/** Server-to-server auth for Ledgerly's own backend calling this service. */
export function requireAdmin(req: Request): Response | null {
  const expected = env().ADMIN_API_TOKEN;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected ?? "");
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * Error → response. Bad input 400, conflicting retry 409, Whop rejected the call 502 (only
 * Whop's type/code/message, never the raw body), anything else 500 without internals.
 */
export function errorResponse(err: unknown) {
  const e = err as { name?: string; issues?: unknown; message?: string };
  if (e?.name === "ZodError") return Response.json({ error: "invalid_request", issues: e.issues }, { status: 400 });
  if (err instanceof ConflictError) return Response.json({ error: "conflict", message: err.message }, { status: 409 });
  const whopError = whopErrorSummary(err);
  if (whopError) return Response.json({ error: "whop_error", whop: whopError }, { status: 502 });
  if (err instanceof Error && /not onboarded|unknown seller/.test(err.message)) {
    return Response.json({ error: "not_found", message: err.message }, { status: 404 });
  }
  console.error("internal error", err instanceof Error ? err.message : "unknown");
  return Response.json({ error: "internal_error" }, { status: 500 });
}
