import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./env";

// Stand-in for Ledgerly's real seller login: a signed cookie naming one seller.
const COOKIE = "ledgerly_seller";

const sign = (value: string) => createHmac("sha256", env().SESSION_SECRET).update(value).digest("base64url");

export function signedLoginToken(sellerExternalId: string) {
  return `${sellerExternalId}.${sign(sellerExternalId)}`;
}

export function verifyLoginToken(token: string): string | null {
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const seller = token.slice(0, i);
  const a = Buffer.from(token.slice(i + 1));
  const b = Buffer.from(sign(seller));
  return a.length === b.length && timingSafeEqual(a, b) ? seller : null;
}

export async function startSellerSession(token: string) {
  const seller = verifyLoginToken(token);
  if (!seller) return null;
  (await cookies()).set(COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 8 });
  return seller;
}

/** The signed-in seller's external id, or null. */
export async function currentSeller() {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? verifyLoginToken(token) : null;
}
