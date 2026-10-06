import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./env";
import { supabaseSeller } from "./seller-accounts";

/**
 * Sessions for the pages this service hosts.
 *
 *  - Operators (Ledgerly staff) sign in with Whop: /api/auth/whop/start. Only members of
 *    Ledgerly's Whop team get in (see whop-oauth.ts).
 *  - Sellers sign in on the marketplace (/sell/login, Supabase Auth; see seller-accounts.ts).
 *    DEMO sign-in links (`pnpm ledgerly login-link`) also work, for sellers and operators alike,
 *    and take precedence over a Supabase session.
 *
 * A token is a signed {purpose, subject, expiry, name?}. The subject is a seller's external id
 * or "operator". A sign-in link ("link", 24h) can only start a session; a session cookie
 * ("session", 8h) can only be used as a session, so it can't be renewed. Sessions need
 * SESSION_SECRET; demo links additionally need DEMO_LOGIN_ENABLED=true.
 */
const COOKIE = "ledgerly_session";
export const OPERATOR = "operator";
const LINK_TTL_S = 60 * 60 * 24;
const SESSION_TTL_S = 60 * 60 * 8;

type Purpose = "link" | "session";
type Claims = { p: Purpose; s: string; e: number; n?: string };

function sessionKey() {
  return env().SESSION_SECRET ?? null;
}

function demoLinksEnabled() {
  return env().DEMO_LOGIN_ENABLED === "true" && Boolean(sessionKey());
}

function sign(payload: string, key: string) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function issue(claims: Omit<Claims, "e">, ttlSeconds: number) {
  const key = sessionKey();
  if (!key) throw new Error("sessions are disabled (set SESSION_SECRET)");
  const payload = Buffer.from(JSON.stringify({ ...claims, e: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

function read(token: string, purpose: Purpose): Claims | null {
  const key = sessionKey();
  const [payload, sig, extra] = token.split(".");
  if (!key || !payload || !sig || extra !== undefined) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<Claims>;
    if (t.p !== purpose || typeof t.s !== "string" || typeof t.e !== "number" || t.e < Date.now() / 1000) return null;
    return t as Claims;
  } catch {
    return null;
  }
}

/** A demo sign-in link token (24h) for a seller's external id or "operator". */
export function signToken(subject: string) {
  if (!demoLinksEnabled()) throw new Error("demo sign-in is disabled (set DEMO_LOGIN_ENABLED=true and SESSION_SECRET)");
  return issue({ p: "link", s: subject }, LINK_TTL_S);
}

/** The subject of a valid token for `purpose`, else null. */
export function verifyToken(token: string, purpose: Purpose): string | null {
  if (purpose === "link" && !demoLinksEnabled()) return null;
  return read(token, purpose)?.s ?? null;
}

async function setSession(claims: Omit<Claims, "e" | "p">) {
  (await cookies()).set(COOKIE, issue({ p: "session", ...claims }, SESSION_TTL_S), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
}

/** Exchange a demo sign-in link for a session cookie that ends 8h from now. */
export async function startSession(linkToken: string) {
  const subject = verifyToken(linkToken, "link");
  if (!subject) return null;
  await setSession({ s: subject });
  return subject;
}

/** Start an 8h operator session for a Ledgerly team member who signed in with Whop. */
export async function startOperatorSession(name: string) {
  await setSession({ s: OPERATOR, n: name.slice(0, 80) });
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
}

async function session() {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? read(token, "session") : null;
}

/** The signed-in seller's external id, or null (operators are not sellers). */
export async function currentSeller() {
  const s = await session();
  if (s) return s.s !== OPERATOR ? s.s : null;
  return supabaseSeller();
}

export async function isOperator() {
  return (await session())?.s === OPERATOR;
}

/** The signed-in operator's display name, or null. */
export async function currentOperator() {
  const s = await session();
  return s?.s === OPERATOR ? { name: s.n ?? "Ledgerly operator" } : null;
}
