/** A request that conflicts with what was already recorded under the same key (HTTP 409). */
export class ConflictError extends Error {
  readonly status = 409;
}

/**
 * Thrown by a webhook handler when the event refers to something we don't know yet (e.g. a
 * refund delivered before its payment). The event stays unprocessed and the ops job retries it.
 */
export class DeferredEvent extends Error {}

/** Whop SDK errors carry the HTTP status and body; keep only what's safe to show or log. */
export function whopErrorSummary(err: unknown) {
  const e = err as { statusCode?: number; body?: { error?: { type?: string; message?: string; code?: string } } };
  if (!e?.statusCode) return null;
  const { type, message, code } = e.body?.error ?? {};
  return { status: e.statusCode, type, code, message };
}
