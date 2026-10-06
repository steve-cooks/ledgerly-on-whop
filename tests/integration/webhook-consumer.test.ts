import { describe, expect, it } from "vitest";
import { db, deliver, paymentEvent, seed, signedRequest } from "./helpers";
import { handlers } from "@/lib/webhook-handlers";

describe("webhook consumer: exactly-once", () => {
  it("rejects a forged signature and stores nothing", async () => {
    const { POST } = await import("@/app/api/webhooks/whop/route");
    const req = signedRequest({ type: "payment.succeeded", data: {} });
    const forged = new Request(req.url, { method: "POST", headers: req.headers, body: (await req.text()).replace("payment", "paymen") });
    expect((await POST(forged)).status).toBe(401);
    const sql = await db();
    expect((await sql`select count(*)::int n from webhook_events`)[0].n).toBe(0);
  });

  it("applies an event once; the same message again is a duplicate", async () => {
    const { order, account } = await seed();
    const ev = paymentEvent("payment.succeeded", order, "pay_1", account);
    expect((await deliver(ev, "msg_same")).body.outcome).toBe("processed");
    expect((await deliver(ev, "msg_same")).body.outcome).toBe("duplicate");
    const sql = await db();
    const [o] = await sql`select status from orders where id = ${order.id}`;
    expect(o.status).toBe("paid");
    const entries = await sql`select kind, amount from ledger_entries order by kind`;
    expect(entries.map((e) => [e.kind, Number(e.amount)])).toEqual([
      ["platform_fee", -0.8],
      ["processing_fee", -0.72],
      ["sale", 10],
    ]);
  });

  it("a near-duplicate under a new webhook id changes nothing", async () => {
    const { order, account } = await seed();
    const ev = paymentEvent("payment.succeeded", order, "pay_1", account);
    await deliver(ev, "msg_a");
    expect((await deliver(ev, "msg_b")).body.outcome).toBe("processed");
    const sql = await db();
    expect((await sql`select count(*)::int n from ledger_entries`)[0].n).toBe(3);
  });

  it("concurrent deliveries of one message apply it exactly once", async () => {
    const { order, account } = await seed();
    const ev = paymentEvent("payment.succeeded", order, "pay_1", account);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => deliver(ev, "msg_race")));
    expect(outcomes.filter((o) => o.body.outcome === "processed")).toHaveLength(1);
    expect(outcomes.filter((o) => o.body.outcome === "duplicate")).toHaveLength(5);
    const sql = await db();
    expect((await sql`select count(*)::int n from ledger_entries`)[0].n).toBe(3);
  });

  it("a handler crash rolls back, records why, answers 500, and the retry succeeds", async () => {
    const { account } = await seed();
    const original = handlers["account.updated"];
    handlers["account.updated"] = async () => {
      throw new Error("boom");
    };
    const ev = { type: "account.updated", account_id: account, data: { id: account, status: "active" } };
    await expect(deliver(ev, "msg_crash")).rejects.toThrow("boom");
    const sql = await db();
    const [row] = await sql`select processed_at, error, attempts from webhook_events where webhook_id = 'msg_crash'`;
    expect(row).toMatchObject({ processed_at: null, error: "boom", attempts: 1 });

    handlers["account.updated"] = original;
    expect((await deliver(ev, "msg_crash")).body.outcome).toBe("processed");
  });

  it("routes events by account_id, or by company_id on older payload versions", async () => {
    const { external } = await seed();
    const sql = await db();
    await deliver({ type: "account.updated", company_id: "biz_seller_us", data: { id: "biz_seller_us", status: "suspended" } });
    const [s] = await sql`select whop_status from sellers where external_id = ${external}`;
    expect(s.whop_status).toBe("suspended");
  });
});

describe("payment ordering", () => {
  it("payment.failed never overwrites a success, in either order", async () => {
    const { order, account } = await seed();
    await deliver(paymentEvent("payment.succeeded", order, "pay_1", account));
    await deliver(paymentEvent("payment.failed", order, "pay_1", account));
    const sql = await db();
    expect((await sql`select status from orders where id = ${order.id}`)[0].status).toBe("paid");
  });

  it("a retried card that succeeds after a failure ends paid", async () => {
    const { order, account } = await seed();
    await deliver(paymentEvent("payment.failed", order, "pay_1", account));
    await deliver(paymentEvent("payment.succeeded", order, "pay_1", account));
    const sql = await db();
    expect((await sql`select status from orders where id = ${order.id}`)[0].status).toBe("paid");
  });

  it("a late payment.succeeded can't un-refund an order", async () => {
    const { order, account } = await seed({ status: "paid", paymentId: "pay_1" });
    await deliver({ type: "refund.created", account_id: account, data: { id: "rf_1", payment: { id: "pay_1" }, amount: 10, status: "succeeded" } });
    await deliver(paymentEvent("payment.succeeded", order, "pay_1", account));
    const sql = await db();
    expect((await sql`select status from orders where id = ${order.id}`)[0].status).toBe("refunded");
  });
});
