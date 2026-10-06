# Assessment proof run

The Whop Platforms FDE assessment's Part 1, run end to end in **production** with small real amounts. (The brief asked for the sandbox; Whop's sandbox doesn't support payouts or the embedded payout components, and Whop's team said to use production.) One script per step; each saves the real API responses to [`evidence/`](evidence) with personal data (names, emails, addresses, card digits) removed.

These scripts are tied to the demo sellers below. For day-to-day operations use `pnpm ledgerly` (see the main [README](../../README.md#operating-it)).

## Ids

| Item | Id |
| --- | --- |
| Ledgerly platform | `biz_3iFse5N7RWo86f` |
| Mira Presets (US, direct charges) | `biz_9ejVCcyqXnAYeV` |
| Vorlage Studio (DE, direct charges) | `biz_Vo8bzz6O0bWPcR` |
| Batida Samples (BR, platform-collected only) | `biz_oLmOUobBcpkXHb` |
| Leftover from the `parent_company_id` test, suspended | `biz_imW7SL959LNYDA` |
| Direct charge → refund | `pay_9pKP6wPzCIIGKf` → `rf_orWZqAstlPVIT77` (refund funded by `ctt_OO5NkD4qqOKBjp`) |
| Platform sale → seller share + true-up | `pay_uTqVCEQAnsGkcp` → `ctt_vVfORKght2JL9h` + `ctt_EIx63sdXPnpfwp` |
| **Same item** (Golden Hour Preset Pack) on Ledgerly's account → Batida's share | `pay_dyRnmqYVRjzFxt` → `ctt_7LOIGygo28FVM6` ($8.45, order `641c0fd2…`, request key `assessment-same-item-1`) |
| Live end-to-end after the final fixes ($1, deployed code) | `pay_ANVEYgeHhTvJdl` → `ctt_Xg6k3IhfXU8vIh` ($0.51 share, sent 3s after payment; two `transfer.completed`, one ledger entry; Batida reconciles 17.41 = 17.41) |
| Embedded-UI withdrawal | `wdrl_kjhEtb6Vfwcuy` ($10, $2.50 fee) |
| Declined payment (real `payment.failed`) | `pay_yJ5U8t8klXTRxK` |
| Webhook | `hook_mr4wbDzKhiXW5` |

## Steps

| Step | Script | Evidence |
| --- | --- | --- |
| 1 · Platform + connected accounts, create twice, nested attempt | [`01-accounts.ts`](scripts/01-accounts.ts) | [`01-accounts/`](evidence/01-accounts) |
| 2 · Onboarding: verification, required actions, capabilities before/after | [`02-onboarding-diff.ts`](scripts/02-onboarding-diff.ts) | [`02-onboarding/`](evidence/02-onboarding) |
| 3 · Direct charge with application fee | [`03a-direct-checkout.ts`](scripts/03a-direct-checkout.ts) | [`03-direct-charge/`](evidence/03-direct-charge) |
| 3 · Refund (refused, then funded by Ledgerly) | [`03b-refund.ts`](scripts/03b-refund.ts), [`03c-fund-refund.ts`](scripts/03c-fund-refund.ts) | same |
| 3 · Platform-collected sale + transfer | [`03d-platform-checkout.ts`](scripts/03d-platform-checkout.ts), [`settle-order.ts`](scripts/settle-order.ts) | [`03-transfer/`](evidence/03-transfer) |
| 3 · Same item as the direct charge, sold on Ledgerly's account | `pnpm ledgerly checkout …` + [`03e-same-item-transfer.ts`](scripts/03e-same-item-transfer.ts) | [`03-transfer/same-item.json`](evidence/03-transfer/same-item.json) |
| 4 · Withdrawal-rail markup (+$0.50 instant) | [`04a-withdrawal-markup.ts`](scripts/04a-withdrawal-markup.ts) | [`04-payouts/`](evidence/04-payouts) |
| 4 · Payout advance for the recorded withdrawal | [`04b-payout-advance.ts`](scripts/04b-payout-advance.ts) | same |
| 5 · Platform webhook (8 events, child accounts, pinned) | [`05a-create-webhook.ts`](scripts/05a-create-webhook.ts) | [`05-webhooks/webhook.json`](evidence/05-webhooks/webhook.json) |
| 5 · Test event, replay (same and regenerated id), suspend | [`05b-webhook-ops.ts`](scripts/05b-webhook-ops.ts) | [`05-webhooks/test-replay-suspend.json`](evidence/05-webhooks/test-replay-suspend.json) |
| 5 · Real declined payment | [`05c-decline-checkout.ts`](scripts/05c-decline-checkout.ts) | [`05-webhooks/payloads/payment.failed.json`](evidence/05-webhooks/payloads/payment.failed.json) |
| 5 · Per-seller API key: isolation + nested-account error | [`05d-seller-key.ts`](scripts/05d-seller-key.ts) | [`05-webhooks/seller-scoped-key.json`](evidence/05-webhooks/seller-scoped-key.json) |
| 5 · One payload per event type | [`export-webhook-evidence.ts`](scripts/export-webhook-evidence.ts) | [`05-webhooks/payloads/`](evidence/05-webhooks/payloads) |

The embedded payouts recording (Seller Hub withdrawal) is part of the submission video.

## Headline results

- **Create the same seller twice**: Whop returns the existing account. The brief's `parent_company_id` field is silently ignored.
- **Nested account**: a seller's own key gets `400 "A connected account cannot create its own connected accounts"`.
- **Onboarding**: `verification.individual` → `approved`; `verify_identity` cleared; `standard_payout`, `crypto_payout`, `transfer` → `active`. Card payments were already active before KYC.
- **Direct charge, $10**: seller nets $8.48 (−$0.72 Whop fees, −$0.80 Ledgerly); Ledgerly +$0.80. Refund first refused (`not_enough_balance`, funds pending); after Ledgerly transferred $10 it succeeded. The $0.80 application fee was not reversed.
- **Platform sale, $10 + $0.83 tax**: seller share $8.45 under the same fee policy as a direct charge (the first sale exposed a formula bug that subtracted tax: $7.40 + $1.05 true-up). The brief's "same item" was then sold again on Ledgerly's account with the hardened code: share computed, stored and transferred once ($8.45).
- **Webhooks**: 7 of 8 event types from real activity; `dispute.created` from Whop's test endpoint. Replays are deduplicated; payout state is forward-only; a missing completion webhook is repaired by reconciliation.
