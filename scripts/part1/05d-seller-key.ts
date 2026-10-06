// Part 1 · Step 5d: a per-seller API key, created on Mira's connected account. Shows what it can
// and can't reach, and runs the real "create an account under a connected account" attempt.
//   pnpm tsx scripts/part1/05d-seller-key.ts
import "../_setup";
import { WhopClient } from "@whop/sdk";
import { capture, saveEvidence } from "../_evidence";

const MIRA = "biz_9ejVCcyqXnAYeV";
const VORLAGE = "biz_Vo8bzz6O0bWPcR";
const LEDGERLY = process.env.WHOP_PLATFORM_ACCOUNT_ID!;

async function main() {
  const seller = new WhopClient({ token: process.env.WHOP_SELLER_MIRA_API_KEY! });
  const summarize = (r: Awaited<ReturnType<typeof capture>>) =>
    r.ok ? { ok: true, id: (r.result as { id?: string }).id ?? "(list)" } : { ok: false, status: r.status, error: r.error };

  const out = {
    key: { owner_account: MIRA, scopes: ["company:basic:read", "company:balance:read", "payment:basic:read", "company:create_child"] },
    read_own_account: summarize(await capture(() => seller.accounts.retrieve({ id: MIRA }))),
    read_other_seller: summarize(await capture(() => seller.accounts.retrieve({ id: VORLAGE }))),
    read_platform: summarize(await capture(() => seller.accounts.retrieve({ id: LEDGERLY }))),
    list_own_payments: summarize(
      await capture(async () => (await seller.payments.list({ account_id: MIRA, first: 5 } as never)).data),
    ),
    create_checkout_without_scope: summarize(
      await capture(() => seller.checkoutConfigurations.create({ account_id: MIRA, plan: { initial_price: 5, plan_type: "one_time" } })),
    ),
    // The brief's step-1 question, asked properly: a connected account creating its own child.
    create_account_under_connected_account: summarize(
      await capture(() =>
        seller.accounts.create({
          email: "seller+ledgerly-grandchild@example.com",
          title: "Grandchild Seller",
          metadata: { external_id: "seller_grandchild_attempt" },
        }),
      ),
    ),
  };
  saveEvidence("05-webhooks/seller-scoped-key", out);
  console.log(JSON.stringify(out, null, 2));
}
main();
