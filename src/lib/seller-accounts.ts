import { randomInt } from "node:crypto";
import { z } from "zod";
import { sql } from "./db";
import { onboardSeller } from "./onboarding";
import { supabaseAuthEnabled, supabaseServer } from "./supabase/server";

/**
 * Sellers who sign in to the marketplace with Supabase Auth (email + password, Google, or
 * Whop). seller_users links a Supabase user to the Ledgerly seller they own.
 */
export type AuthUser = { id: string; email: string | null };

/** The Supabase user signed in on this request, or null (also when sign-in isn't configured). */
export async function authUser(): Promise<AuthUser | null> {
  if (!supabaseAuthEnabled()) return null;
  const { data } = await (await supabaseServer()).auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === "string" && claims.email ? claims.email : null };
}

export async function sellerForUser(authUserId: string) {
  const [row] = await sql()`
    select seller_external_id, store_name from seller_users where auth_user_id = ${authUserId}`;
  return row ? { externalId: row.seller_external_id as string, storeName: row.store_name as string } : null;
}

/** The signed-in Supabase user's seller external id, or null. */
export async function supabaseSeller() {
  const user = await authUser();
  return user ? ((await sellerForUser(user.id))?.externalId ?? null) : null;
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newSellerId() {
  return "seller_" + Array.from({ length: 10 }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join("");
}

export const StoreInput = z.object({
  storeName: z.string().trim().min(2, "Store name must be at least 2 characters").max(60, "Store name can be at most 60 characters"),
  country: z.string().regex(/^[A-Z]{2}$/, "Choose a country"),
});

/**
 * Open a store for a signed-in user and return the Whop onboarding link (identity
 * verification, hosted by Whop). Safe to repeat: the user's link to their seller is written
 * first, so a double submit or a retry after a Whop error reuses the same
 * seller (and onboardSeller's idempotency key reuses the same Whop account).
 */
export async function openStore(user: AuthUser, raw: z.input<typeof StoreInput>) {
  const input = StoreInput.parse(raw);
  if (!user.email) throw new Error("Your sign-in has no email address. Sign up with email instead.");
  const db = sql();
  const externalId = newSellerId();
  await db.begin(async (tx) => {
    // Serialise a user's concurrent submits: there's no row to lock yet.
    await tx`select pg_advisory_xact_lock(hashtext(${"seller_users:" + user.id}))`;
    const [linked] = await tx`select 1 from seller_users where auth_user_id = ${user.id}`;
    if (linked) return;
    await tx`
      insert into sellers (external_id, email, country, collection_mode)
      values (${externalId}, ${user.email}, ${input.country}, 'direct')`;
    await tx`
      insert into seller_users (auth_user_id, seller_external_id, store_name)
      values (${user.id}, ${externalId}, ${input.storeName})`;
  });
  const [row] = await db`
    select s.external_id, s.email, s.country, s.collection_mode, su.store_name
    from seller_users su join sellers s on s.external_id = su.seller_external_id
    where su.auth_user_id = ${user.id}`;
  const { onboardingUrl } = await onboardSeller({
    externalId: row.external_id,
    email: row.email,
    country: row.country,
    title: row.store_name,
    collectionMode: row.collection_mode,
  });
  return { externalId: row.external_id as string, onboardingUrl };
}
