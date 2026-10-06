import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./env";

/**
 * DEMO sign-in, standing in for Ledgerly's real auth. Replace currentSeller()/isOperator() with
 * checks against Ledgerly's own session when integrating (see HANDOVER.md).
 *
 * A token is a signed {purpose, subject, expiry}. The subject is a seller's external id or
 * "operator". A sign-in link ("link", 24h) can only start a session; a session cookie
 * ("session", 8h) can only be used as a session. So a link can't be used as a cookie, and a
 * session can't be exchanged for a new one: every session ends 8h after its link was used.
 * Links are reusable until they expire (demo convenience). Disabled unless
 * DEMO_LOGIN_ENABLED=true and SESSION_SECRET is set.
 */
const COOKIE = "ledgerly_session";
export const OPERATOR = "operator";
const LINK_TTL_S = 60 * 60 * 24;
const SESSION_TTL_S = 60 * 60 * 8;

type Purpose = "link" | "session";

function secret() {
  const { DEMO_LOGIN_ENABLED, SESSION_SECRET } = env();
  if (DEMO_LOGIN_ENABLED !== "true" || !SESSION_SECRET) return null;
  return SESSION_SECRET;
}

function sign(payload: string, key: string) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signToken(subject: string, purpose: Purpose = "link") {
  const key = secret();
  if (!key) throw new Error("demo sign-in is disabled (set DEMO_LOGIN_ENABLED=true and SESSION_SECRET)");
  const ttl = purpose === "link" ? LINK_TTL_S : SESSION_TTL_S;
  const payload = Buffer.from(JSON.stringify({ p: purpose, s: subject, e: Math.floor(Date.now() / 1000) + ttl })).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

/** The token's subject if it's signed, unexpired and issued for `purpose`; else null. */
export function verifyToken(token: string, purpose: Purpose): string | null {
  const key = secret();
  const [payload, sig, extra] = token.split(".");
  if (!key || !payload || !sig || extra !== undefined) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, "base64url").toString()) as { p?: string; s?: string; e?: number };
    if (t.p !== purpose || typeof t.s !== "string" || typeof t.e !== "number" || t.e < Date.now() / 1000) return null;
    return t.s;
  } catch {
    return null;
  }
}

/** Exchange a sign-in link for a session cookie that ends 8h from now. */
export async function startSession(linkToken: string) {
  const subject = verifyToken(linkToken, "link");
  if (!subject) return null;
  (await cookies()).set(COOKIE, signToken(subject, "session"), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return subject;
}

async function subject() {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? verifyToken(token, "session") : null;
}

/** The signed-in seller's external id, or null (operators are not sellers). */
export async function currentSeller() {
  const s = await subject();
  return s && s !== OPERATOR ? s : null;
}

export async function isOperator() {
  return (await subject()) === OPERATOR;
}
