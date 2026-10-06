import { createHash, randomBytes } from "node:crypto";
import { env } from "./env";
import { whop } from "./whop";

/**
 * "Sign in with Whop" for Ledgerly's operators: OAuth 2.1 authorization code + PKCE against
 * Whop's OAuth app, done entirely on the server. The app is a confidential client, so the code
 * exchange also sends WHOP_OAUTH_CLIENT_SECRET.
 *
 * Signing in with Whop proves who someone is; access comes from being on Ledgerly's Whop
 * team (Whop dashboard → Settings → Team) in one of OPERATOR_ROLES. Removing someone from the
 * team removes their access at their next sign-in (sessions last 8h).
 */
const OAUTH = "https://api.whop.com/oauth";
export const OPERATOR_ROLES = new Set(["owner", "admin", "manager", "support"]);

/**
 * Two Whop OAuth apps: "Ledgerly Console" for staff (console at /) and the seller-facing
 * "Ledgerly" app for sellers on the marketplace (/sell). Each has its own client and callback.
 */
export type WhopApp = "console" | "seller";

function app(which: WhopApp) {
  const e = env();
  return which === "console"
    ? { id: e.WHOP_OAUTH_CLIENT_ID, secret: e.WHOP_OAUTH_CLIENT_SECRET, callback: `${e.APP_URL}/api/auth/whop/callback` }
    : { id: e.WHOP_SELLER_APP_ID, secret: e.WHOP_SELLER_APP_KEY, callback: `${e.APP_URL}/auth/whop/callback` };
}

export function oauthConfigured(which: WhopApp = "console") {
  const a = app(which);
  return Boolean(a.id && a.secret && (which === "seller" || env().SESSION_SECRET));
}

export function redirectUri(which: WhopApp = "console") {
  return app(which).callback;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const client = (which: WhopApp) => ({ client_id: app(which).id, client_secret: app(which).secret });

/** A fresh PKCE verifier and state, and the Whop URL to send the browser to. */
export function authorizationRequest(which: WhopApp = "console") {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: app(which).id!,
    redirect_uri: redirectUri(which),
    scope: "openid profile email",
    state,
    nonce: b64url(randomBytes(16)),
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return { verifier, state, url: `${OAUTH}/authorize?${params}` };
}

export type WhopUser = { id: string; name: string; email: string | null; emailVerified: boolean };

/** Exchange the callback's code for the Whop user it belongs to. Tokens are not kept. */
export async function userFromCode(code: string, verifier: string, which: WhopApp = "console"): Promise<WhopUser> {
  const res = await fetch(`${OAUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(which),
      code_verifier: verifier,
      ...client(which),
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    throw new Error(`token exchange failed (${res.status} ${err.error ?? ""} ${err.error_description ?? ""})`.trim());
  }
  const tokens = (await res.json()) as { access_token: string; refresh_token?: string };

  const info = await fetch(`${OAUTH}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  if (!info.ok) throw new Error(`userinfo failed (${info.status})`);
  const u = (await info.json()) as { sub: string; name?: string; preferred_username?: string; email?: string; email_verified?: boolean };

  // We only needed their identity: revoke the refresh token so nothing long-lived is left.
  if (tokens.refresh_token) {
    await fetch(`${OAUTH}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tokens.refresh_token, ...client(which) }),
    }).catch(() => {});
  }
  return {
    id: u.sub,
    name: u.name || u.preferred_username || "Ledgerly operator",
    email: u.email ?? null,
    emailVerified: u.email_verified === true,
  };
}

/** The user's role on Ledgerly's Whop team if it grants console access, else null. */
export async function operatorRole(userId: string) {
  const page = await whop().teamMembers.list({ account_id: env().WHOP_PLATFORM_ACCOUNT_ID, user_id: userId, status: "joined" });
  const role = (page.data as { role?: string }[]).map((m) => m.role ?? "").find((r) => OPERATOR_ROLES.has(r));
  return role ?? null;
}
