import { timingSafeEqual } from "node:crypto";
import { env } from "./env";

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

/** Turns thrown validation / Whop errors into a clean JSON response. */
export function errorResponse(err: unknown) {
  const e = err as { name?: string; issues?: unknown; statusCode?: number; body?: unknown; message?: string };
  if (e?.name === "ZodError") return Response.json({ error: "invalid_request", issues: e.issues }, { status: 400 });
  if (e?.statusCode) return Response.json({ error: "whop_error", whop: e.body }, { status: 502 });
  return Response.json({ error: e?.message ?? "internal_error" }, { status: 400 });
}
