import { beforeEach, describe, expect, it } from "vitest";
import { db, deliver, fakeWhop, paymentEvent, seed } from "./helpers";
import { settlePlatformOrder } from "@/lib/checkout";
import { transferToSeller } from "@/lib/transfers";
import { ConflictError } from "@/lib/errors";

// Real fee lines from the production run (platform sale with sales tax).
const FEES = [
  { origin: "sales_tax_remittance", amount: { amount: "0.83" } },
  { origin: "payment_processing_fixed_fee", amount: { amount: "0.30" } },
  { origin: "payment_processing_percentage_fee", amount: { amount: "0.29" } },
  { origin: "stripe_sales_tax_fee", amount: { amount: "0.22" } },
  { origin: "orchestration_percentage_fee", amount: { amount: "0.09" } },
  { origin: "stripe_radar_fee", amount: { amount: "0.07" } },
];

let transferCalls = 0;
beforeEach(() => {
  transferCalls = 0;
  fakeWhop.payments.listFees.mockResolvedValue({ data: FEES });
  fakeWhop.transfers.create.mockImplementation(async () => ({ id: `ctt_${++transferCalls}`, status: "succeeded" }));
});

describe("settlement of platform-collected orders", () => {
  it("pays the seller's share right after payment.succeeded, once", async () => {
    const { order } = await seed({ flow: "platform" });
    await deliver(paymentEvent("payment.succeeded", order, "pay_1", "biz_platform"));
    const sql = await db();
    const [o] = await sql`select seller_share from orders where id = ${order.id}`;
    expect(o.seller_share).toBe("8.45");
    expect(fakeWhop.transfers.create).toHaveBeenCalledTimes(1);
    expect(fakeWhop.transfers.create.mock.calls[0][0]).toMatchObject({ amount: 8.45, idempotence_key: `order:${order.id}:share` });
    expect(await settlePlatformOrder(order.id)).toMatchObject({ skipped: "seller already paid" });
  });

  it("a transfer still processing blocks a second one", async () => {
    fakeWhop.transfers.create.mockResolvedValueOnce({ id: "ctt_slow", status: "processing" });
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await settlePlatformOrder(order.id);
    expect(await settlePlatformOrder(order.id)).toMatchObject({ skipped: "a transfer is still in flight" });
    expect(fakeWhop.transfers.create).toHaveBeenCalledTimes(1);
  });

  it("after a confirmed failure, the next attempt uses a new key; a failed id never counts as paid", async () => {
    fakeWhop.transfers.create.mockResolvedValueOnce({ id: "ctt_bad", status: "processing" });
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await settlePlatformOrder(order.id);
    await deliver({ type: "transfer.failed", account_id: "biz_platform", data: { id: "ctt_bad", status: "failed" } });
    const result = await settlePlatformOrder(order.id);
    expect(result).toMatchObject({ sentNow: 8.45 });
    expect(fakeWhop.transfers.create.mock.calls[1][0].idempotence_key).toBe(`order:${order.id}:share:to-845:attempt-2`);
  });

  it("reusing a transfer key for a different amount is refused, and a retry sends the recorded intent", async () => {
    await seed({ flow: "platform" });
    const args = { sellerExternalId: "seller_br", amount: 8.23, currency: "usd", key: "k1", purpose: "order_share" as const };
    fakeWhop.transfers.create.mockRejectedValueOnce(Object.assign(new Error("timeout"), { statusCode: 504 }));
    await expect(transferToSeller(args)).rejects.toThrow("timeout");
    await expect(transferToSeller({ ...args, amount: 8.45 })).rejects.toBeInstanceOf(ConflictError);
    await transferToSeller(args);
    expect(fakeWhop.transfers.create.mock.calls.at(-1)?.[0]).toMatchObject({ amount: 8.23, idempotence_key: "k1" });
  });
});

describe("idempotent checkout and onboarding", () => {
  it("the same requestKey returns the same order and creates one Whop checkout", async () => {
    const { createCheckout } = await import("@/lib/checkout");
    await seed();
    fakeWhop.checkoutConfigurations.create.mockResolvedValue({ id: "ch_1", purchase_url: "https://whop.com/checkout/ch_1/" });
    const input = { sellerExternalId: "seller_us", title: "Preset Pack", sku: "preset-pack", price: 10, requestKey: "cart-42" };
    const a = await createCheckout(input);
    const b = await createCheckout(input);
    expect(b.orderId).toBe(a.orderId);
    expect(fakeWhop.checkoutConfigurations.create).toHaveBeenCalledTimes(1);
    await expect(createCheckout({ ...input, price: 12 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("a direct checkout carries the 8% application fee; a platform seller's never does", async () => {
    const { createCheckout } = await import("@/lib/checkout");
    await seed();
    await seed({ flow: "platform" });
    fakeWhop.checkoutConfigurations.create
      .mockResolvedValueOnce({ id: "ch_direct", purchase_url: "u1" })
      .mockResolvedValueOnce({ id: "ch_platform", purchase_url: "u2" });
    await createCheckout({ sellerExternalId: "seller_us", title: "A", sku: "aaa", price: 10 });
    await createCheckout({ sellerExternalId: "seller_br", title: "B", sku: "bbb", price: 10 });
    const [direct, platform] = fakeWhop.checkoutConfigurations.create.mock.calls.map((c) => c[0]);
    expect(direct).toMatchObject({ account_id: "biz_seller_us", plan: { application_fee_amount: 0.8 } });
    expect(platform.account_id).toBe("biz_platform");
    expect(platform.plan.application_fee_amount).toBeUndefined();
  });

  it("onboarding retries return the same account; a conflicting retry is refused", async () => {
    const { onboardSeller } = await import("@/lib/onboarding");
    fakeWhop.accounts.create.mockResolvedValue({ id: "biz_new" });
    fakeWhop.accountLinks.create.mockResolvedValue({ url: "https://whop.com/verify", expires_at: null });
    const input = { externalId: "seller_x", email: "x@example.com", country: "US" };
    expect((await onboardSeller(input)).created).toBe(true);
    expect((await onboardSeller(input)).created).toBe(false);
    expect(fakeWhop.accounts.create).toHaveBeenCalledTimes(1);
    await expect(onboardSeller({ ...input, collectionMode: "platform" })).rejects.toBeInstanceOf(ConflictError);
  });
});
