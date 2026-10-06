// Part 1 · Step 1: platform + connected accounts.
//   pnpm tsx examples/assessment/scripts/01-accounts.ts
import "../../../scripts/_setup";
import { WhopClient } from "@whop/sdk";
import { onboardSeller } from "@/lib/onboarding";
import { whop } from "@/lib/whop";
import { sql } from "@/lib/db";
import { capture, saveEvidence } from "./_evidence";
import { SELLERS } from "./sellers";

async function main() {
  const platformId = process.env.WHOP_PLATFORM_ACCOUNT_ID!;
  const platform = await whop().accounts.retrieve({ id: platformId });

  // 1. Three connected accounts through the idempotent onboarding path.
  const onboarded: Awaited<ReturnType<typeof onboardSeller>>[] = [];
  for (const s of SELLERS) onboarded.push(await onboardSeller(s));

  // 2. Same path again: must return the same accounts, created=false.
  const rerun: Awaited<ReturnType<typeof onboardSeller>>[] = [];
  for (const s of SELLERS) rerun.push(await onboardSeller(s));

  // 3. "Call create twice for the same seller": the DE seller already exists from step 1.
  //    Create it again with the same email + metadata.external_id, no idempotency key and no
  //    local lookup. Does Whop dedupe on its own?
  const de = SELLERS[1];
  const rawBody = {
    email: de.email,
    country: de.country,
    title: de.title,
    metadata: { external_id: de.externalId, collection_mode: de.collectionMode },
  };
  const rawSecond = await capture(() => whop().accounts.create(rawBody));

  // 4. Same create again reusing onboarding's Idempotency-Key (valid for 24h): should replay
  //    the original response, i.e. the same account id, without creating anything.
  const idemReplay = await capture(() =>
    whop().accounts.create(rawBody, { idempotencyKey: `ledgerly:seller:create:${de.externalId}` }),
  );

  // 5. Nested: act AS the US connected account and try to create an account under it.
  const us = onboarded[0];
  const childToken = await capture(() =>
    whop().accessTokens.create({ account_id: us.accountId, scoped_actions: ["company:create_child"] }),
  );
  const nested = childToken.ok
    ? await capture(() =>
        new WhopClient({ token: childToken.result.token }).accounts.create({
          email: "nested@seller.example",
          title: "Nested Seller",
          metadata: { external_id: "seller_nested_attempt" },
        }),
      )
    : null;
  // And with the platform key, naming a parent explicitly the way the brief's `parent_company_id` suggests.
  const nestedViaParam = await capture(() =>
    whop().accounts.create(
      { email: "nested@seller.example", title: "Nested Seller" },
      { additionalBodyParameters: { parent_company_id: us.accountId } },
    ),
  );

  const accounts = await Promise.all(onboarded.map((o) => whop().accounts.retrieve({ id: o.accountId })));

  const pick = (r: Awaited<ReturnType<typeof capture>>) =>
    r.ok ? { ok: true, id: (r.result as { id: string }).id } : r;

  const summary = {
    platform: { id: platform.id, title: platform.title },
    connected: onboarded.map(({ onboardingUrl, ...o }) => ({ ...o, onboardingUrl: onboardingUrl ? "<redacted link>" : null })),
    rerun_same_ids: rerun.every((r, i) => r.accountId === onboarded[i].accountId && !r.created),
    create_twice_same_seller: { original: onboarded[1].accountId, second_raw_create: pick(rawSecond) },
    create_twice_with_idempotency_key: { original: onboarded[1].accountId, replay: pick(idemReplay) },
    nested_with_child_token: childToken.ok ? (nested ? pick(nested) : null) : { token_error: childToken },
    nested_with_parent_company_id_param: pick(nestedViaParam),
  };

  saveEvidence("01-accounts/summary", summary);
  saveEvidence("01-accounts/platform", platform);
  accounts.forEach((a, i) => saveEvidence(`01-accounts/${SELLERS[i].externalId}`, a));
  saveEvidence("01-accounts/create-twice", { rawSecond, idemReplay });
  saveEvidence("01-accounts/nested", { childToken: childToken.ok ? "minted" : childToken, nested, nestedViaParam });

  console.log(JSON.stringify(summary, null, 2));
  await sql().end();
}

main().catch(async (e) => {
  console.error(e);
  await sql().end();
  process.exit(1);
});
