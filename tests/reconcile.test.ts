import { describe, expect, it } from "vitest";
import { diffRecords, paymentState } from "@/lib/reconcile";

describe("diffRecords", () => {
  const whop = [
    { id: "pay_ok", amount: 10, state: "paid" },
    { id: "pay_missing", amount: 5, state: "paid" },
    { id: "pay_amount", amount: 10, state: "paid" },
    { id: "pay_state", amount: 10, state: "refunded / refunded 10.00" },
  ];
  const local = [
    { id: "pay_ok", amount: 10.0, state: "paid" },
    { id: "pay_amount", amount: 9.99, state: "paid" },
    { id: "pay_state", amount: 10, state: "refunded / refunded 20.00" }, // the double-refund bug
    { id: "pay_ghost", amount: 3, state: "paid" },
  ];

  it("finds every kind of discrepancy, two-way", () => {
    const out = diffRecords("payment", whop, local).map((d) => [d.id, d.problem]);
    expect(out).toEqual([
      ["pay_missing", "missing_locally"],
      ["pay_amount", "amount_mismatch"],
      ["pay_state", "state_mismatch"],
      ["pay_ghost", "missing_at_whop"],
    ]);
  });

  it("is clean when both sides agree (compared in cents)", () => {
    expect(diffRecords("transfer", [{ id: "t", amount: 7.4, state: "completed" }], [{ id: "t", amount: 7.40000001, state: "completed" }])).toEqual([]);
  });
});

describe("paymentState maps Whop's status/substatus pair", () => {
  it("reads refunds and failures from substatus, not status", () => {
    expect(paymentState({ status: "paid", substatus: "refunded" })).toBe("refunded"); // real refund
    expect(paymentState({ status: "open", substatus: "failed" })).toBe("failed"); // real declined card
    expect(paymentState({ status: "paid", substatus: "succeeded" })).toBe("paid");
  });
});
