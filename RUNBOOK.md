# Runbook

What to do when something looks wrong. Every command here is safe to run more than once.

**Tools**

| Tool | Use it to |
| --- | --- |
| `pnpm ledgerly reconcile [ID]` | **Diagnose.** Diff Whop against our records; exit code 1 while anything is off. Changes nothing. |
| `pnpm ledgerly reconcile --fix` | Pull **payout** state from Whop first (webhooks can miss a payout's final state), then diagnose. |
| `pnpm ledgerly settle [ORDER_ID]` | **Pay sellers** what platform-collected orders still owe them. |
| `pnpm ledgerly transfers:refresh` | Ask Whop about transfers still **pending** (or failed in the last 14 days); resend requests that never got an answer, under the same key. |
| `pnpm ledgerly ops` | Run the whole hourly ops job now and print its summary. |
| `pnpm ledgerly reprocess` | Retry **stored** events that were deferred or failed. |
| `pnpm ledgerly reprocess EVENT_TYPE` | Re-apply every stored event of a type (after fixing a handler). |
| Whop's webhook replay | Re-send events **we never stored** (endpoint down, webhook disabled). See "Webhooks aren't arriving". |
| `pnpm ledgerly trace PAY_ID` | Whop's fee lines and balances for one payment. |
| `pnpm ledgerly smoke` | Live checks of the deployment that move no money. |

The operator console (`/`, operator sign-in) shows the last hourly ops run. Whop's side is in the Whop dashboard (Payments, Sub accounts, Developer → Webhooks).

---

## The hourly ops run says "Needs attention"

Each run (`/api/cron/ops`) retries deferred and failed webhook events, settles transfers webhooks haven't, settles orders that still owe a seller, then syncs payouts and reconciles sellers. One failing event or stage doesn't stop the others. The alert lists what was wrong:

- `event msg_… (type) fails: …`: that stored event's handler throws every time. Fix the cause (often bad data in the payload or a bug), then `pnpm ledgerly reprocess`.
- `settle <order>: transfer ctt_… failed at Whop and may still succeed`: see "A platform-collected seller wasn't paid".
- `<stage> failed: …`: that whole stage errored (often Whop or the database unreachable). The next run retries it.

1. Run `pnpm ledgerly reconcile --fix` to see each seller's discrepancies.
2. Act on each one:

| `kind` / `problem` | Usually means | Do this |
| --- | --- | --- |
| payment `missing_locally` | We never stored the payment event | Check deliveries (below); replay from Whop if needed |
| payment `state_mismatch` | Usually a refund we haven't applied (Whop shows it refunded) | `pnpm ledgerly reprocess` (deferred events), else replay `refund.*` events from Whop |
| transfer `state_mismatch` | Transfer completed or failed without a webhook | `pnpm ledgerly transfers:refresh` (the hourly run does the same) |
| payout `state_mismatch` | Whop skipped the payout's final webhook (seen in production) | `pnpm ledgerly reconcile --fix` |
| obligation `unsettled` / `underpaid` | A platform-collected seller hasn't been paid in full | `pnpm ledgerly settle <order>`; if it says "in flight", wait for the transfer |
| obligation `overpaid` | More was sent than owed | Don't send less to "fix" it. Record the difference and recover it from the seller's next sale |
| `amount_mismatch` | A bug, or a manual change in Whop's dashboard | Investigate before changing anything; `pnpm ledgerly trace <pay_id>` shows Whop's numbers |
| `missing_at_whop` | A local record Whop doesn't know | Usually created against another environment (sandbox vs production) |
| balance `amount_mismatch` | Ledger and Whop balance differ | Fix the item-level problems first. Open disputes also show here: Whop debits the disputed amount and fee, which we don't post |

3. "Run #N never finished" means the previous run hit the time limit or crashed. Check Vercel's function logs for `/api/cron/ops`. "Out of time after N/M sellers" is normal for a large seller base: the next run continues from where this one stopped.

---

## Webhooks aren't arriving

1. Whop dashboard → Developer → Webhooks: check the endpoint and recent deliveries. Whop retries a failed delivery for about 3 days and **disables the webhook after 3 days of failures**; events from the disabled period are not resent.
2. `curl $APP_URL/api/health` should return `ok: true`, or run `pnpm ledgerly smoke`.
3. Our endpoint answering `401 invalid signature` means `WHOP_WEBHOOK_SECRET` on the host doesn't match the webhook. Copy the right secret, redeploy.
4. Our endpoint answering `500`: the event is in `webhook_events` with `error` and `attempts` set. Fix the cause; Whop's retry (or `pnpm ledgerly reprocess`) applies it.
5. Re-enable a disabled webhook (`PATCH /webhooks/{id}` with `enabled: true`), then replay the gap with Whop's replay endpoint (`POST /webhooks/{id}/replay` with `sent_after`). Replays are safe: the consumer dedupes them.
6. Run `pnpm ledgerly reconcile --fix` to catch anything replay missed.

**Deferred events** (`outcome: deferred`, `error` starting `deferred:`) are events about something we don't know yet, such as a refund that arrived before its payment. The hourly run retries them; after 72 hours they're closed as `unmatched` (usually a refund or dispute on a payment that was never a Ledgerly order).

---

## A seller says their withdrawal is stuck

1. Find the payout in Whop (dashboard → Sub accounts → the seller → Payouts) or in our `payouts` table.
2. Read `status` / `status_detail`:
   - `in_review / risk_review`: Whop's automatic review. Every payout starts here and usually clears in seconds; a manual review can take longer.
   - `processing / awaiting_provider_acceptance` or `in_transit`: sent. Standard bank payouts take 1–5 business days (look at `estimated_arrival`).
   - `completed`: Whop has sent it; the bank may still take a few days.
   - `failed` / `reversed`: our ledger credits the seller back only once Whop reports the funds returned (`failure.funds_returned_at`) or the payout is `reversed`.
   - `denied` / `canceled`: nothing was paid out; our ledger removes the debit.
3. Check the basics: minimum payout is **$10**, the seller must have passed identity verification, and instant payouts are only available where Whop enabled them.
4. If it's past `estimated_arrival` and still `in_transit`, contact Whop support with the payout id (`wdrl_…`).

---

## A refund fails with `not_enough_balance`

On a direct charge the seller pays the refund from their **available** balance, and a recent sale is still pending.

1. Fund the seller with a transfer from Ledgerly (as in `examples/assessment/scripts/03c-fund-refund.ts`, key `order:<id>:refund_funding`).
2. Retry the refund. That first attempt got a **definite** "no" from Whop, so retry it under a **new** idempotency key: Whop replays a failed request's response for 24 hours if you reuse the key. If an attempt's outcome is **unknown** (timeout, no response), don't change the key: first check the payment's `refunded_amount`, then retry with the same key.
3. Record the advance so it can be recovered from the seller's next sales (manual for now).

---

## A platform-collected seller wasn't paid

`pnpm ledgerly settle <order>` pays what the order still owes. What it may answer:

- **"a transfer is still in flight"**: the last transfer is pending. If it's older than a few minutes, run `pnpm ledgerly transfers:refresh`: it asks Whop, or, if the request never got an answer, resends it under the **same** key (Whop returns the original transfer if it made one, so this can't pay twice).
- **Whop refused the transfer** (`status: failed` with an `error`, e.g. not enough balance): no transfer was created. Fix the cause (top up Ledgerly's balance in the Whop dashboard, or finish Ledgerly's own verification); the next settle sends a new attempt under a new key.
- **"transfer ctt_… failed at Whop and may still succeed"**: Whop created the transfer and it failed. Whop can retry a failed transfer to success under the same id, so settle won't send a replacement on its own. The hourly run keeps checking it for two weeks. If Whop confirms it's final, run `pnpm ledgerly settle <order> --replace-failed`. If the old one completes anyway, reconciliation reports the order `overpaid`.
- **"N webhook event(s) for this payment can't be applied yet"**: a refund or dispute for this payment is waiting in the inbox. `pnpm ledgerly reprocess`, then settle again.

It never sends a second transfer while one may still succeed, and never sends a different amount under a key already used.

---

## An order is "disputed"

Whop opened a chargeback. The order is held: `GET /api/orders/:id` returns `deliverable: false`, and a platform-collected seller's share isn't paid. Respond in the Whop dashboard (Payments → Disputes). If the dispute is won (`dispute.updated` → `won`), the hold is released: the order goes back to `paid` and settles normally, unless it was refunded meanwhile (then it stays `refunded`). A lost dispute keeps the order held.

---

## A seller's onboarding link expired

`pnpm ledgerly onboarding-link <external_id>` (or `POST /api/sellers` again with the same details). It never creates a second account.

---

## Suspend a seller

`POST /accounts/{id}/suspend` with Ledgerly's API key (or Whop dashboard → Sub accounts). An `account.updated` webhook records the new status. There is no un-suspend endpoint; contact Whop.

---

## Rotate secrets

| Secret | How |
| --- | --- |
| `WHOP_API_KEY` | Dashboard → Developer → create a new key with the same permissions, update the host env, redeploy, then delete the old key |
| `WHOP_WEBHOOK_SECRET` | Recreate the webhook (`pnpm ledgerly webhook:create` after deleting the old one), update env, redeploy |
| `ADMIN_API_TOKEN`, `CRON_SECRET`, `SESSION_SECRET` | `openssl rand -hex 32`, update env (and Ledgerly's backend for the admin token), redeploy. Rotating `SESSION_SECRET` signs everyone out |
| Database password | Supabase → Settings → Database, then update `DATABASE_URL` |

Never paste secrets into chat, tickets or screenshots.
