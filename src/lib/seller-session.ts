import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./env";

/**
 * DEMO sign-in, standing in for Ledgerly's real auth. Replace currentSeller()/isOperator() with
 * checks against Ledgerly's own session when integrating (see HANDOVER.md).
 *
 * A token names a subject (a seller's external id, or "operator") and an expiry, signed with
 * SESSION_SECRET. Sign-in links and the session cookie are both such tokens, so a copied link
 * stops working when it expires. Disabled unless DEMO_LOGIN_ENABLED=true and a secret is set.
 */
const COOKIE = "ledgerly_session";
export const OPERATOR = "operator";
const LINK_TTL_S = 60 * 60 * 24; // a sign-in link is valid for 24h
const SESSION_TTL_S = 60 * 60 * 8; // a session lasts 8h

function secret() {
  const { DEMO_LOGIN_ENABLED, SESSION_SECRET } = env();
  if (DEMO_LOGIN_ENABLED !== "true" || !SESSION_SECRET) return null;
  return SESSION_SECRET;
}

function sign(payload: string, key: string) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signToken(subject: string, ttlSeconds = LINK_TTL_S) {
  const key = secret();
  if (!key) throw new Error("demo sign-in is disabled (set DEMO_LOGIN_ENABLED=true and SESSION_SECRET)");
  const payload = `${subject}.${Math.floor(Date.now() / 1000) + ttlSeconds}`;
  return `${payload}.${sign(payload, key)}`;
}

/** The token's subject if the signature is valid and it hasn't expired, else null. */
export function verifyToken(token: string): string | null {
  const key = secret();
  const parts = token.split(".");
  if (!key || parts.length < 3) return null;
  const sig = parts.pop()!;
  const exp = Number(parts.pop());
  const subject = parts.join(".");
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(`${subject}.${exp}`, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  return subject;
}

/** Exchange a sign-in link token for a fresh short session cookie. */
export async function startSession(linkToken: string) {
  const subject = verifyToken(linkToken);
  if (!subject) return null;
  (await cookies()).set(COOKIE, signToken(subject, SESSION_TTL_S), {
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
  return token ? verifyToken(token) : null;
}

/** The signed-in seller's external id, or null (operators are not sellers). */
export async function currentSeller() {
  const s = await subject();
  return s && s !== OPERATOR ? s : null;
}

export async function isOperator() {
  return (await subject()) === OPERATOR;
}
