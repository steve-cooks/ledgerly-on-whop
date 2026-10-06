import { beforeEach, describe, expect, it } from "vitest";
import { db, deliver, fakeWhop, paymentEvent, seed } from "./helpers";
import { runOpsJob } from "@/lib/ops-job";
import { reconcileSeller } from "@/lib/reconcile";

beforeEach(() => {
  fakeWhop.payments.listFees.mockResolvedValue({ data: [{ origin: "payment_processing_fixed_fee", amount: { amount: "0.30" } }] });
  fakeWhop.transfers.create.mockResolvedValue({ id: "ctt_1", status: "succeeded" });
  fakeWhop.payments.list.mockResolvedValue([]);
  fakeWhop.transfers.list.mockResolvedValue([]);
  fakeWhop.payouts.list.mockResolvedValue([]);
  fakeWhop.accounts.retrieve.mockResolvedValue({ balances: [] });
});

describe("hourly ops job", () => {
  it("one event that always fails is reported, and every other stage still runs", async () => {
    const sql = await db();
    // A stored payment whose metadata isn't a valid order id: its handler fails every time.
    await sql`
      insert into webhook_events (webhook_id, type, payload, error, attempts)
      values ('msg_poison', 'payment.succeeded',
              ${sql.json({ type: "payment.succeeded", data: { id: "pay_x", metadata: { ledgerly_order_id: "not-a-uuid" } } })}, 'x', 1)`;
    // A platform order that still owes its seller.
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });

    const run = await runOpsJob();
    expect(run.ok).toBe(false);
    const problems = run.summary.problems as string[];
    expect(problems.some((p) => p.includes("msg_poison"))).toBe(true);
    expect(fakeWhop.transfers.create).toHaveBeenCalledTimes(1); // settlement still ran
    expect(run.summary.reconciled).toHaveLength(1); // so did reconciliation
    const [row] = await sql`select finished_at, ok from job_runs where id = ${run.run}`;
    expect(row.finished_at).not.toBeNull();
    expect((await sql`select status from seller_transfers where order_id = ${order.id}`)[0].status).toBe("completed");
  });

  it("a stage that throws is recorded, and the run still finishes", async () => {
    await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    fakeWhop.payments.list.mockRejectedValue(new Error("Whop is down"));
    const run = await runOpsJob();
    expect(run.summary.problems).toContain("reconcile failed: Whop is down");
    expect(fakeWhop.transfers.create).toHaveBeenCalledTimes(1);
    const sql = await db();
    expect((await sql`select finished_at from job_runs where id = ${run.run}`)[0].finished_at).not.toBeNull();
  });
});

describe("reconcileSeller", () => {
  it("is clean when Whop and the ledger agree, and names what differs when they don't", async () => {
    const { order, account } = await seed();
    await deliver(paymentEvent("payment.succeeded", order, "pay_1", account));
    const whopPayment = { id: "pay_1", status: "paid", substatus: "succeeded", currency: "usd", subtotal: { amount: "10.00" }, refunded_amount: { amount: "0" } };
    fakeWhop.payments.list.mockImplementation(async ({ account_id }: { account_id: string }) => (account_id === account ? [whopPayment] : []));
    fakeWhop.accounts.retrieve.mockResolvedValue({ balances: [{ symbol: "USD", balance: "8.48" }] });
    expect(await reconcileSeller("seller_us")).toMatchObject({ ok: true, discrepancies: [] });

    fakeWhop.payouts.list.mockResolvedValue([{ id: "wdrl_9", amount: "5.0", currency: "usd", status: "completed" }]);
    fakeWhop.accounts.retrieve.mockResolvedValue({ balances: [{ symbol: "USD", balance: "3.48" }] });
    const r = await reconcileSeller("seller_us");
    expect(r.discrepancies).toEqual([
      expect.objectContaining({ kind: "payout", id: "wdrl_9", problem: "missing_locally" }),
      expect.objectContaining({ kind: "balance", problem: "amount_mismatch" }),
    ]);
  });
});
