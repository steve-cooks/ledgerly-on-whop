# Runbook

What to do when something looks wrong. Every command here is safe to run more than once.

**Tools**: `pnpm ledgerly help` lists the CLI. The operator console (`/`) shows the last hourly ops run. Whop's side is in the Whop dashboard (Payments, Sub accounts, Developer → Webhooks) and the API.

---

## The hourly ops run says "Needs attention"

The run (`/api/cron/ops`) syncs payout states from Whop, reconciles every seller and settles owed seller shares. It alerts when anything is off.

1. Run it yourself to see detail: `pnpm ledgerly reconcile --fix`. It prints each seller's discrepancies; the exit code is 1 while anything is off.
2. Read each discrepancy:

| `problem` | Usually means | Do this |
| --- | --- | --- |
| `missing_locally` (payment) | A webhook hasn't been processed yet, or failed | Check webhook deliveries (below), then `pnpm ledgerly reprocess payment.succeeded` |
| `missing_locally` (transfer / payout) | Same, for `transfer.completed` / `payout.*` | `pnpm ledgerly reprocess transfer.completed` or `reconcile --fix` |
| `state_mismatch` (payout) | Whop didn't send a webhook for the final state (seen in production) | `pnpm ledgerly reconcile --fix` |
| `state_mismatch` (payment) | A refund or failure we haven't recorded | `pnpm ledgerly reprocess refund.created` |
| `amount_mismatch` | A bug or a manual change in Whop's dashboard | Investigate before fixing; `pnpm ledgerly trace <pay_id>` shows Whop's numbers |
| `missing_at_whop` | A local record Whop doesn't know | Check whether it was created against another environment (sandbox vs production) |
| `balance` | Ledger and Whop balance differ | Fix the item-level discrepancies first; the balance follows |

---

## Webhooks aren't arriving

1. Whop dashboard → Developer → Webhooks: check the endpoint and recent deliveries. Whop retries a failed delivery for about 3 days and **disables the webhook after 3 days of failures**; events from the disabled period are not resent.
2. Health check: `curl $APP_URL/api/health` should return `ok: true`.
3. A `401 invalid signature` from our endpoint means `WHOP_WEBHOOK_SECRET` on the host doesn't match the webhook. Copy the right secret, redeploy.
4. Re-enable a disabled webhook (`PATCH /webhooks/{id}` with `enabled: true`), then replay the gap with Whop's replay endpoint (`POST /webhooks/{id}/replay` with `sent_after`). Replays are safe: the consumer dedupes them.
5. Run `pnpm ledgerly reconcile --fix` to catch anything replay missed.

---

## A seller says their withdrawal is stuck

1. Find the payout in Whop (dashboard → Sub accounts → the seller → Payouts) or in our `payouts` table.
2. Read `status` / `status_detail`:
   - `in_review / risk_review`: Whop's automatic review. Every payout starts here and usually clears in seconds; a manual review can take longer.
   - `processing / awaiting_provider_acceptance` or `in_transit`: sent. Standard bank payouts take 1–5 business days (look at `estimated_arrival`).
   - `completed`: Whop has sent it; the bank may still take a few days.
   - `failed` / `reversed`: money returns to the seller's balance (our ledger records a reversal).
3. Check the basics: minimum payout is **$10**, the seller must have passed identity verification, and instant payouts are only available where Whop enabled them.
4. If it's past `estimated_arrival` and still `in_transit`, contact Whop support with the payout id (`wdrl_…`).

---

## A refund fails with `not_enough_balance`

On a direct charge the seller pays the refund from their **available** balance, and a recent sale is still pending.

1. Fund the seller: transfer the refund amount from Ledgerly (as in `examples/assessment/scripts/03c-fund-refund.ts`, using a key like `order:<id>:refund_funding`).
2. Retry the refund **with a new idempotency key**. Whop replays a failed request's error for 24 hours if you reuse the key.
3. Record the advance so it can be recovered from the seller's next sales (manual for now).

---

## A platform-collected seller wasn't paid

`pnpm ledgerly settle` pays every paid platform order whatever is still owed. It never pays twice: transfers are keyed per order and target amount. If a transfer fails, the usual causes are Ledgerly's available balance being too low (top up in the Whop dashboard), or Ledgerly's own account missing verification.

---

## A seller's onboarding link expired

`pnpm ledgerly onboarding-link <external_id>` (or `POST /api/sellers` again). It never creates a second account.

---

## Suspend a seller

`POST /accounts/{id}/suspend` with Ledgerly's API key (or Whop dashboard → Sub accounts). An `account.updated` webhook records the new status. There is no un-suspend endpoint; contact Whop.

---

## Rotate secrets

| Secret | How |
| --- | --- |
| `WHOP_API_KEY` | Dashboard → Developer → create a new key with the same permissions, update the host env, redeploy, then delete the old key |
| `WHOP_WEBHOOK_SECRET` | Recreate the webhook (`pnpm ledgerly webhook:create` after deleting the old one), update env, redeploy |
| `ADMIN_API_TOKEN`, `CRON_SECRET`, `SESSION_SECRET` | `openssl rand -hex 32`, update env (and Ledgerly's backend for the admin token), redeploy |
| Database password | Supabase → Settings → Database, then update `DATABASE_URL` |

Never paste secrets into chat, tickets or screenshots.

---

## Re-running webhook handlers

All handlers are idempotent, so after fixing a handler bug you can replay what's stored:

```bash
pnpm ledgerly reprocess payment.succeeded
pnpm ledgerly reconcile
```
