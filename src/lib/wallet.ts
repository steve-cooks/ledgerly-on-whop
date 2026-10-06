import { sql } from "./db";
import { whop } from "./whop";

/**
 * Exactly what the embedded wallet needs, nothing more. Omitting scoped_actions would make the
 * token inherit every permission of Ledgerly's API key, inside the seller's browser.
 */
export const WALLET_SCOPES = [
  "company:balance:read", // Balances + Activity
  "payout:withdrawal:read", // payout history in Activity
  "payout:withdraw_funds", // Withdraw
  "payout:destination:read", // list saved payout methods
  "payout:create_destination", // add a bank / wallet
] as const;

export const WALLET_TOKEN_TTL_MINUTES = 15;

export async function mintWalletToken(sellerExternalId: string) {
  const [seller] = await sql()`select whop_account_id from sellers where external_id = ${sellerExternalId}`;
  if (!seller?.whop_account_id) throw new Error("seller not onboarded");
  const expiresAt = new Date(Date.now() + WALLET_TOKEN_TTL_MINUTES * 60_000).toISOString();
  const res = await whop().accessTokens.create({
    account_id: seller.whop_account_id,
    scoped_actions: [...WALLET_SCOPES],
    expires_at: expiresAt,
  });
  return { accountId: seller.whop_account_id as string, token: res.token, expiresAt: res.expires_at ?? expiresAt };
}
