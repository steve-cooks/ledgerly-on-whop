import { describe, expect, it } from "vitest";
import { db, deliver, fakeWhop, paymentEvent, seed } from "./helpers";
import { reprocessStored } from "@/lib/webhook-processor";

const refund = (id: string, amount: number, status = "succeeded", paymentId = "pay_1") => ({
  type: "refund.created",
  account_id: "biz_seller_us",
  data: { id, payment: { id: paymentId }, amount, status, created_at: new Date().toISOString() },
});

describe("refunds", () => {
  it("a refund that arrives before its payment is deferred, then applied once the payment is known", async () => {
    const { order, account } = await seed();
    expect((await deliver(refund("rf_early", 10))).body.outcome).toBe("deferred");
    await deliver(paymentEvent("payment.succeeded", order, "pay_1", account));
    await reprocessStored();
    const sql = await db();
    const [o] = await sql`select status, refunded_amount from orders where id = ${order.id}`;
    expect(o).toMatchObject({ status: "refunded", refunded_amount: "10.00" });
  });

  it("concurrent partial refunds add up correctly", async () => {
    const { order } = await seed({ status: "paid", paymentId: "pay_1" });
    await Promise.all([deliver(refund("rf_a", 5)), deliver(refund("rf_b", 5))]);
    const sql = await db();
    const [o] = await sql`select status, refunded_amount from orders where id = ${order.id}`;
    expect(o).toMatchObject({ status: "refunded", refunded_amount: "10.00" });
    expect((await sql`select count(*)::int n from ledger_entries where kind = 'refund'`)[0].n).toBe(2);
  });

  it("a pending refund moves no money until refund.updated says it succeeded, then books once", async () => {
    const { order } = await seed({ status: "paid", paymentId: "pay_1" });
    await deliver(refund("rf_1", 10, "pending"));
    const sql = await db();
    expect((await sql`select status from orders where id = ${order.id}`)[0].status).toBe("paid");
    const update = { ...refund("rf_1", 10, "succeeded"), type: "refund.updated" };
    await deliver(update);
    await deliver(update);
    expect((await sql`select refunded_amount from orders where id = ${order.id}`)[0].refunded_amount).toBe("10.00");
    expect((await sql`select count(*)::int n from ledger_entries where kind = 'refund'`)[0].n).toBe(1);
  });
});

describe("disputes", () => {
  const dispute = (status: string, at: string, type = "dispute.updated") => ({
    type,
    account_id: "biz_platform",
    timestamp: at,
    data: { id: "dspt_1", payment: { id: "pay_1" }, status, amount: 10 },
  });
  const orderStatus = async (id: string) => (await (await db())`select status from orders where id = ${id}`)[0].status;

  it("an open dispute holds the order; winning releases it", async () => {
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await deliver(dispute("needs_response", "2026-10-06T00:00:01Z", "dispute.created"));
    expect(await orderStatus(order.id)).toBe("disputed");

    const { settlePlatformOrder } = await import("@/lib/checkout");
    expect(await settlePlatformOrder(order.id)).toEqual({ skipped: "order is disputed" });

    await deliver(dispute("won", "2026-10-06T00:00:02Z"));
    expect(await orderStatus(order.id)).toBe("paid");
  });

  it("disputed, then refunded, then won: the order stays refunded and is never paid out", async () => {
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await deliver(dispute("needs_response", "2026-10-06T00:00:01Z", "dispute.created"));
    await deliver({ ...refund("rf_1", 10), account_id: "biz_platform" });
    expect(await orderStatus(order.id)).toBe("disputed");
    await deliver(dispute("won", "2026-10-06T00:00:03Z"));
    expect(await orderStatus(order.id)).toBe("refunded");
    const { settlePlatformOrder } = await import("@/lib/checkout");
    expect(await settlePlatformOrder(order.id)).toEqual({ skipped: "order is refunded" });
  });

  it("an older dispute event replayed after a win doesn't reopen the hold", async () => {
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    const open = dispute("needs_response", "2026-10-06T00:00:01Z", "dispute.created");
    await deliver(open, "msg_open");
    await deliver(dispute("won", "2026-10-06T00:00:02Z"));
    await deliver(open, "msg_open_replayed_under_new_id");
    expect(await orderStatus(order.id)).toBe("paid");
  });
});

describe("payouts", () => {
  const payout = (type: string, status: string, at: string, extra: Record<string, unknown> = {}) => ({
    type,
    account_id: "biz_seller_us",
    timestamp: at,
    data: { id: "wdrl_1", status, amount: "10.0", currency: "usd", created_at: "2026-10-06T00:00:00Z", ...extra },
  });

  it("an older event delivered late never rolls the payout back", async () => {
    await seed();
    await deliver(payout("payout.updated", "processing", "2026-10-06T00:00:10Z", { status_detail: "in_transit" }));
    await deliver(payout("payout.created", "in_review", "2026-10-06T00:00:01Z"));
    const sql = await db();
    expect((await sql`select status from payouts`)[0].status).toBe("processing");
    expect((await sql`select count(*)::int n from ledger_entries where kind = 'payout'`)[0].n).toBe(1);
  });

  const payoutLedger = async () =>
    Number((await (await db())`select coalesce(sum(amount), 0) total from ledger_entries where whop_object_id = 'wdrl_1'`)[0].total);

  it("'failed' alone credits nothing; the money is back once funds are returned, posted once", async () => {
    await seed();
    await deliver(payout("payout.updated", "failed", "2026-10-06T00:00:10Z", { failure: { funds_returned_at: null } }));
    expect(await payoutLedger()).toBe(-10);
    const returned = payout("payout.updated", "failed", "2026-10-06T00:00:20Z", { failure: { funds_returned_at: "2026-10-06T00:00:20Z" } });
    await deliver(returned);
    await deliver({ ...returned, timestamp: "2026-10-06T00:00:30Z" });
    expect(await payoutLedger()).toBe(0);
    const sql = await db();
    expect((await sql`select count(*)::int n from ledger_entries where kind = 'payout_reversal'`)[0].n).toBe(1);
  });

  it("a denied payout leaves no debit", async () => {
    await seed();
    await deliver(payout("payout.created", "in_review", "2026-10-06T00:00:01Z"));
    expect(await payoutLedger()).toBe(-10);
    await deliver(payout("payout.updated", "denied", "2026-10-06T00:00:02Z", { failure: { funds_returned_at: null } }));
    expect(await payoutLedger()).toBe(0);
  });

  it("a payout whose amount changes is booked at its new amount", async () => {
    await seed();
    await deliver(payout("payout.created", "in_review", "2026-10-06T00:00:01Z"));
    await deliver(payout("payout.updated", "processing", "2026-10-06T00:00:02Z", { amount: "9.0" }));
    expect(await payoutLedger()).toBe(-9);
  });

  it("legacy withdrawal.updated and payout.updated for the same payout post once", async () => {
    await seed();
    await deliver(payout("withdrawal.updated", "processing", "2026-10-06T00:00:05Z"));
    await deliver(payout("payout.updated", "processing", "2026-10-06T00:00:06Z"));
    const sql = await db();
    expect((await sql`select count(*)::int n from payouts`)[0].n).toBe(1);
    expect((await sql`select count(*)::int n from ledger_entries where kind = 'payout'`)[0].n).toBe(1);
  });
});

describe("payout repair (reconcile --fix)", () => {
  const remote = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "wdrl_1", status, status_detail: status, amount: "10.0", currency: "usd", created_at: "2026-10-06T00:00:00Z", ...extra,
  });
  const localStatus = async () => (await (await db())`select status from payouts where whop_payout_id = 'wdrl_1'`)[0]?.status;
  const age = async () => (await db())`update payouts set updated_at = now() - interval '1 minute'`;

  it("records a final state Whop never sent a webhook for, and books it once", async () => {
    const { repairPayouts } = await import("@/lib/reconcile");
    await seed();
    await deliver({ type: "payout.updated", account_id: "biz_seller_us", timestamp: "2026-10-06T00:00:01Z", data: remote("processing") });
    await age();
    fakeWhop.payouts.list.mockResolvedValue([remote("completed")]);
    expect(await repairPayouts("seller_us")).toBe(1);
    expect(await localStatus()).toBe("completed");
    await age();
    expect(await repairPayouts("seller_us")).toBe(0);
    expect((await (await db())`select count(*)::int n from ledger_entries where kind = 'payout'`)[0].n).toBe(1);
  });

  it("never moves a payout backwards", async () => {
    const { repairPayouts } = await import("@/lib/reconcile");
    await seed();
    await deliver({ type: "payout.updated", account_id: "biz_seller_us", timestamp: "2026-10-06T00:00:01Z", data: remote("completed") });
    await age();
    fakeWhop.payouts.list.mockResolvedValue([remote("processing")]);
    expect(await repairPayouts("seller_us")).toBe(0);
    expect(await localStatus()).toBe("completed");
  });

  it("a webhook that lands while repair is reading wins over the (older) read", async () => {
    const { repairPayouts } = await import("@/lib/reconcile");
    await seed();
    await deliver({ type: "payout.created", account_id: "biz_seller_us", timestamp: "2026-10-06T00:00:01Z", data: remote("in_review") });
    await age();
    fakeWhop.payouts.list.mockImplementation(async () => {
      await deliver({ type: "payout.updated", account_id: "biz_seller_us", timestamp: "2026-10-06T00:00:05Z", data: remote("denied") });
      return [remote("processing")]; // read before the webhook's change
    });
    expect(await repairPayouts("seller_us")).toBe(0);
    expect(await localStatus()).toBe("denied");
  });
});

describe("transfers", () => {
  it("transfer.completed from both participants credits the seller once", async () => {
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    const sql = await db();
    await sql`
      insert into seller_transfers (seller_external_id, order_id, amount, currency, idempotence_key, whop_transfer_id, status)
      values ('seller_br', ${order.id}, 8.45, 'usd', ${`order:${order.id}:share`}, 'ctt_1', 'pending')`;
    const done = (account: string) => ({ type: "transfer.completed", account_id: account, data: { id: "ctt_1", status: "succeeded" } });
    await deliver(done("biz_platform"));
    await deliver(done("biz_seller_br"));
    expect((await sql`select status from seller_transfers`)[0].status).toBe("completed");
    expect((await sql`select count(*)::int n from ledger_entries where kind = 'transfer_in'`)[0].n).toBe(1);
  });
});
