import { z } from "zod";
import { sql } from "./db";
import { env } from "./env";
import { ConflictError } from "./errors";
import { whop } from "./whop";

export const SellerInput = z.object({
  externalId: z.string().min(1).max(100),
  email: z.string().email(),
  country: z.string().length(2).transform((c) => c.toUpperCase()),
  title: z.string().min(1).max(100).optional(),
  collectionMode: z.enum(["direct", "platform"]).default("direct"),
});
export type SellerInput = z.input<typeof SellerInput>;

/**
 * Create-or-fetch a seller's connected account, then mint a fresh onboarding link.
 *
 * Safe to call any number of times for the same externalId:
 *  1. Our sellers row is the durable source of truth (external_id -> biz_...).
 *  2. Whop's Idempotency-Key covers the gap between Whop creating the account and us
 *     saving its id (crash, timeout, two concurrent requests). Whop keeps keys for 24h,
 *     which is why (1) exists.
 *  3. metadata.external_id on the account lets an operator match accounts to sellers
 *     from the Whop side.
 */
export async function onboardSeller(raw: SellerInput) {
  const input = SellerInput.parse(raw);
  const db = sql();

  await db`
    insert into sellers (external_id, email, country, collection_mode)
    values (${input.externalId}, ${input.email}, ${input.country}, ${input.collectionMode})
    on conflict (external_id) do nothing`;
  const [seller] = await db`select * from sellers where external_id = ${input.externalId}`;
  // A retry must describe the same seller. Changing email, country or payment policy is a
  // deliberate operation, not something a retry should silently do (or silently ignore).
  const conflicts = (
    [
      ["email", seller.email, input.email],
      ["country", seller.country, input.country],
      ["collectionMode", seller.collection_mode, input.collectionMode],
    ] as const
  ).filter(([, stored, given]) => String(stored).toLowerCase() !== String(given).toLowerCase());
  if (conflicts.length) {
    throw new ConflictError(
      `seller ${input.externalId} already exists with a different ${conflicts.map(([k]) => k).join(", ")}`,
    );
  }

  let accountId: string = seller.whop_account_id;
  let created = false;

  if (!accountId) {
    const account = await whop().accounts.create(
      {
        email: input.email,
        country: input.country,
        title: input.title,
        metadata: { external_id: input.externalId, collection_mode: input.collectionMode },
      },
      { idempotencyKey: `ledgerly:seller:create:${input.externalId}` },
    );
    accountId = account.id;
    created = true;
    await db`
      update sellers set whop_account_id = ${accountId}, updated_at = now()
      where external_id = ${input.externalId} and whop_account_id is null`;
  }

  const link = await whop().accountLinks.create({
    account_id: accountId,
    use_case: "account_onboarding",
    return_url: `${env().APP_URL}/sellers/${encodeURIComponent(input.externalId)}?onboarding=done`,
    refresh_url: `${env().APP_URL}/sellers/${encodeURIComponent(input.externalId)}?onboarding=refresh`,
  });

  return { externalId: input.externalId, accountId, created, onboardingUrl: link.url, expiresAt: link.expires_at };
}

/** A fresh onboarding link for a seller we've already onboarded (never creates an account). */
export async function freshOnboardingLink(externalId: string) {
  const [seller] = await sql()`select * from sellers where external_id = ${externalId}`;
  if (!seller) throw new Error(`unknown seller ${externalId}`);
  return onboardSeller({
    externalId: seller.external_id,
    email: seller.email,
    country: seller.country,
    collectionMode: seller.collection_mode,
  });
}
