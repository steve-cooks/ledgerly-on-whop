import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** JSON with email addresses replaced, so evidence can live in a public repo. */
export function redact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, null, 2).replace(EMAIL, (m) => {
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
