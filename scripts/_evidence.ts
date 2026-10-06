import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Personal fields that can appear in Whop payloads (buyer, payout recipient, KYC).
const PERSONAL_KEYS = new Set([
  "payer_name", "name", "username", "first_name", "last_name", "middle_name", "date_of_birth",
  "phone", "customer_phone", "line1", "line2", "postal_code", "billing_address", "shipping_address",
  "profile_picture", "statement_descriptor", "nickname", "trace_code",
]);

/** JSON with emails and personal fields replaced, so evidence can live in a public repo. */
export function redact<T>(value: T): T {
  const scrubbed = JSON.stringify(value, (k, v) => (PERSONAL_KEYS.has(k) && v != null ? "<redacted>" : v), 2);
  return JSON.parse(
    scrubbed.replace(EMAIL, (m) => {
      const tag = m.match(/\+([^@]+)@/)?.[1];
      return tag ? `seller+${tag}@example.com` : "owner@example.com";
    }),
  );
}

export function saveEvidence(name: string, value: unknown) {
  const path = join("evidence", `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(redact(value), null, 2) + "\n");
  return path;
}

/** Run a Whop call and capture either the result or the error body, for evidence. */
export async function capture<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, result: await fn() };
  } catch (err) {
    const e = err as { statusCode?: number; body?: unknown; message?: string };
    return { ok: false as const, status: e.statusCode, error: e.body ?? e.message };
  }
}
