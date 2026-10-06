import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unwrapWebhook, WebhookVerificationError } from "@whop/sdk/helpers";
import { eventAccountId, type WhopEvent } from "@/lib/webhooks";

const SECRET = "ws_" + "a".repeat(64);

/** Sign like Whop does: HMAC-SHA256 over "id.timestamp.body", keyed with the secret's literal bytes. */
function sign(body: string, id = "msg_test", ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` };
}

describe("signature verification", () => {
  const body = JSON.stringify({ id: "msg_test", type: "payment.succeeded", data: { id: "pay_1" } });

  it("accepts a correctly signed payload", () => {
    const event = unwrapWebhook<WhopEvent>(body, { headers: sign(body), key: SECRET });
    expect(event.type).toBe("payment.succeeded");
  });

  it("rejects a tampered body", () => {
    expect(() => unwrapWebhook(body.replace("pay_1", "pay_2"), { headers: sign(body), key: SECRET })).toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const old = Math.floor(Date.now() / 1000) - 60 * 60;
    expect(() => unwrapWebhook(body, { headers: sign(body, "msg_test", old), key: SECRET })).toThrow(
      WebhookVerificationError,
    );
  });

  it("refuses to run without a secret", () => {
    expect(() => unwrapWebhook(body, { headers: sign(body), key: undefined })).toThrow(/without a key/);
  });
});

describe("eventAccountId routes events across API versions", () => {
  const base = { id: "msg_1", type: "payout.updated", timestamp: "2026-10-06T00:00:00Z", data: {} };

  it("reads account_id (payloads pinned to 2026-08-14 or later)", () => {
    expect(eventAccountId({ ...base, account_id: "biz_new" })).toBe("biz_new");
  });

  it("falls back to company_id (older or unpinned payloads, Part 3's crash)", () => {
    expect(eventAccountId({ ...base, company_id: "biz_seller_de" })).toBe("biz_seller_de");
  });

  it("falls back to the object itself (Whop's test sends carry neither)", () => {
    expect(eventAccountId({ ...base, data: { account_id: "biz_obj" } })).toBe("biz_obj");
    expect(eventAccountId({ ...base, data: { account: { id: "biz_nested" } } })).toBe("biz_nested");
    expect(eventAccountId(base)).toBeNull();
  });
});

describe("payoutDebit: what a payout has taken from the seller's balance", async () => {
  const { payoutDebit } = await import("@/lib/webhook-handlers");
  it("is the amount while the payout is on its way or paid", () => {
    for (const status of ["requested", "in_review", "processing", "completed", "failed"]) {
      expect(payoutDebit({ status, amount: 10 })).toBe(10);
    }
  });
  it("is zero once denied, canceled, reversed, or the funds came back", () => {
    for (const status of ["denied", "canceled", "reversed"]) expect(payoutDebit({ status, amount: 10 })).toBe(0);
    expect(payoutDebit({ status: "failed", amount: 10, fundsReturnedAt: "2026-10-06T00:00:00Z" })).toBe(0);
  });
});
