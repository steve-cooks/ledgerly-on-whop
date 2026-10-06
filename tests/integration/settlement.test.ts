import { beforeEach, describe, expect, it } from "vitest";
import { db, deliver, fakeWhop, paymentEvent, seed, whopError } from "./helpers";
import { settlePlatformOrder } from "@/lib/checkout";
import { refreshPendingTransfers, transferToSeller } from "@/lib/transfers";
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

const transferEvent = (type: "transfer.completed" | "transfer.failed", id: string, extra: Record<string, unknown> = {}) => ({
  type,
  account_id: "biz_platform",
  data: { id, status: type === "transfer.completed" ? "succeeded" : "failed", ...extra },
});

async function state(orderId: string) {
  const sql = await db();
  const transfers = await sql`select idempotence_key, whop_transfer_id, status, last_error from seller_transfers where order_id = ${orderId} order by created_at`;
  const [{ n }] = await sql`select count(*)::int n from ledger_entries where kind = 'transfer_in'`;
  return { transfers, ledgerCredits: n as number };
}

describe("settlement of platform-collected orders", () => {
  it("pays the seller's share right after payment.succeeded, once, and books it", async () => {
    const { order } = await seed({ flow: "platform" });
    await deliver(paymentEvent("payment.succeeded", order, "pay_1", "biz_platform"));
    const sql = await db();
    const [o] = await sql`select seller_share from orders where id = ${order.id}`;
    expect(o.seller_share).toBe("8.45");
    expect(fakeWhop.transfers.create).toHaveBeenCalledTimes(1);
    expect(fakeWhop.transfers.create.mock.calls[0][0]).toMatchObject({ amount: 8.45, idempotence_key: `order:${order.id}:share` });
    expect((await state(order.id)).ledgerCredits).toBe(1);
    expect(await settlePlatformOrder(order.id)).toMatchObject({ skipped: "seller already paid" });
  });

  it("a transfer still processing blocks a second one", async () => {
    fakeWhop.transfers.create.mockResolvedValueOnce({ id: "ctt_slow", status: "processing" });
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await settlePlatformOrder(order.id);
    expect(await settlePlatformOrder(order.id)).toMatchObject({ skipped: "a transfer is still in flight" });
    expect(fakeWhop.transfers.create).toHaveBeenCalledTimes(1);
  });

  it("a transfer that failed at Whop blocks a replacement; when Whop retries it to success, the seller is paid once", async () => {
    fakeWhop.transfers.create.mockResolvedValueOnce({ id: "ctt_bad", status: "processing" });
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await settlePlatformOrder(order.id);
    await deliver(transferEvent("transfer.failed", "ctt_bad"));
    expect(await settlePlatformOrder(order.id)).toMatchObject({ blocked: expect.stringContaining("ctt_bad") });
    expect(fakeWhop.transfers.create).toHaveBeenCalledTimes(1);

    await deliver(transferEvent("transfer.completed", "ctt_bad"));
    expect((await state(order.id)).transfers.map((t) => t.status)).toEqual(["completed"]);
    expect((await state(order.id)).ledgerCredits).toBe(1);
    expect(await settlePlatformOrder(order.id)).toMatchObject({ skipped: "seller already paid" });
  });

  it("an operator can replace a transfer Whop confirmed dead, under a new key", async () => {
    fakeWhop.transfers.create.mockResolvedValueOnce({ id: "ctt_bad", status: "processing" });
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await settlePlatformOrder(order.id);
    await deliver(transferEvent("transfer.failed", "ctt_bad"));
    expect(await settlePlatformOrder(order.id, { replaceFailed: true })).toMatchObject({ sentNow: 8.45 });
    expect(fakeWhop.transfers.create.mock.calls[1][0].idempotence_key).toBe(`order:${order.id}:share:to-845:attempt-2`);
  });

  it("a request Whop refused outright (no transfer created) is retried automatically under a new key", async () => {
    fakeWhop.transfers.create.mockRejectedValueOnce(whopError(400, "not enough balance"));
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    expect(await settlePlatformOrder(order.id)).toMatchObject({ status: "failed", error: expect.stringContaining("not enough balance") });
    expect((await state(order.id)).transfers[0]).toMatchObject({ status: "failed", whop_transfer_id: null });

    expect(await settlePlatformOrder(order.id)).toMatchObject({ status: "completed", sentNow: 8.45 });
    expect(fakeWhop.transfers.create.mock.calls[1][0].idempotence_key).toBe(`order:${order.id}:share:to-845:attempt-2`);
  });

  it("a lost response is recovered under the same key, and the seller is paid once", async () => {
    fakeWhop.transfers.create.mockRejectedValueOnce(whopError(504, "gateway timeout"));
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await expect(settlePlatformOrder(order.id)).rejects.toThrow("gateway timeout");
    // The intent is recorded but unanswered: settlement must not send a second one.
    expect(await settlePlatformOrder(order.id)).toMatchObject({ skipped: "a transfer is still in flight" });

    // The ops job resends it under the same key; Whop returns the transfer it created.
    expect(await refreshPendingTransfers({ olderThanMinutes: 0 })).toMatchObject({ checked: 1, errors: [] });
    const keys = fakeWhop.transfers.create.mock.calls.map((c) => c[0].idempotence_key);
    expect(keys).toEqual([`order:${order.id}:share`, `order:${order.id}:share`]);
    expect((await state(order.id)).transfers.map((t) => t.status)).toEqual(["completed"]);
    expect((await state(order.id)).ledgerCredits).toBe(1);
    expect(await settlePlatformOrder(order.id)).toMatchObject({ skipped: "seller already paid" });
  });

  it("a completion webhook that lands before the create response is not undone by it", async () => {
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    fakeWhop.transfers.create.mockImplementationOnce(async (body: { idempotence_key: string }) => {
      await deliver(transferEvent("transfer.completed", "ctt_fast", { metadata: { ledgerly_transfer_key: body.idempotence_key } }));
      return { id: "ctt_fast", status: "processing" };
    });
    await settlePlatformOrder(order.id);
    expect((await state(order.id)).transfers.map((t) => t.status)).toEqual(["completed"]);
    expect((await state(order.id)).ledgerCredits).toBe(1);
  });

  it("a completion found by polling (no webhook) is booked to the ledger", async () => {
    fakeWhop.transfers.create.mockResolvedValueOnce({ id: "ctt_quiet", status: "processing" });
    fakeWhop.transfers.retrieve.mockResolvedValue({ id: "ctt_quiet", status: "succeeded" });
    const { order } = await seed({ flow: "platform", status: "paid", paymentId: "pay_1" });
    await settlePlatformOrder(order.id);
    expect(await refreshPendingTransfers({ olderThanMinutes: 0 })).toMatchObject({ changed: [{ status: "completed" }] });
    expect((await state(order.id)).ledgerCredits).toBe(1);
  });

  it("reusing a transfer key for a different amount is refused, and a retry sends the recorded intent", async () => {
    await seed({ flow: "platform" });
    const args = { sellerExternalId: "seller_br", amount: 8.23, currency: "usd", key: "k1", purpose: "order_share" as const };
    fakeWhop.transfers.create.mockRejectedValueOnce(whopError(504, "timeout"));
    await expect(transferToSeller(args)).rejects.toThrow("timeout");
    await expect(transferToSeller({ ...args, amount: 8.45 })).rejects.toBeInstanceOf(ConflictError);
    await transferToSeller(args);
    expect(fakeWhop.transfers.create.mock.calls.at(-1)?.[0]).toMatchObject({ amount: 8.23, idempotence_key: "k1" });
  });
});

describe("settlement respects refunds and disputes that arrived first", () => {
  it.each([
    ["refund", { type: "refund.created", data: { id: "rf_1", payment: { id: "pay_1" }, amount: 10, status: "succeeded" } }, "refunded"],
    ["dispute", { type: "dispute.created", data: { id: "dspt_1", payment: { id: "pay_1" }, status: "needs_response", amount: 10 } }, "disputed"],
  ])("a %s delivered before the payment stops the seller's share", async (_name, early, finalStatus) => {
    const { order } = await seed({ flow: "platform" });
    expect((await deliver({ ...early, account_id: "biz_platform" })).body.outcome).toBe("deferred");
    await deliver(paymentEvent("payment.succeeded", order, "pay_1", "biz_platform"));
    const sql = await db();
    expect((await sql`select status from orders where id = ${order.id}`)[0].status).toBe(finalStatus);
    expect(fakeWhop.transfers.create).not.toHaveBeenCalled();
  });
});

describe("idempotent checkout and onboarding", () => {
  const input = { sellerExternalId: "seller_us", title: "Preset Pack", sku: "preset-pack", price: 10, requestKey: "cart-42" };

  it("the same requestKey returns the same order and creates one Whop checkout; a different purchase is refused", async () => {
    const { createCheckout } = await import("@/lib/checkout");
    await seed();
    fakeWhop.checkoutConfigurations.create.mockResolvedValue({ id: "ch_1", purchase_url: "https://whop.com/checkout/ch_1/" });
    const a = await createCheckout(input);
    const b = await createCheckout(input);
    expect(b.orderId).toBe(a.orderId);
    expect(fakeWhop.checkoutConfigurations.create).toHaveBeenCalledTimes(1);
    await expect(createCheckout({ ...input, price: 12 })).rejects.toBeInstanceOf(ConflictError);
    await expect(createCheckout({ ...input, sku: "other-pack" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("concurrent requests with one requestKey share one order", async () => {
    const { createCheckout } = await import("@/lib/checkout");
    await seed();
    fakeWhop.checkoutConfigurations.create.mockResolvedValue({ id: "ch_1", purchase_url: "https://whop.com/checkout/ch_1/" });
    const results = await Promise.all(Array.from({ length: 5 }, () => createCheckout(input)));
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    const sql = await db();
    expect((await sql`select count(*)::int n from orders where request_key = 'cart-42'`)[0].n).toBe(1);
    // Every Whop call for it used the order's own idempotency key.
    expect(new Set(fakeWhop.checkoutConfigurations.create.mock.calls.map((c) => c[1].idempotencyKey)).size).toBe(1);
  });

  it("the second sale of a product reuses its Whop product by id (Whop refuses re-sending it inline)", async () => {
    const { createCheckout } = await import("@/lib/checkout");
    await seed();
    fakeWhop.checkoutConfigurations.create
      .mockResolvedValueOnce({ id: "ch_1", purchase_url: "u1", plan: { id: "plan_1" } })
      .mockResolvedValueOnce({ id: "ch_2", purchase_url: "u2", plan: { id: "plan_2" } });
    fakeWhop.plans.retrieve.mockResolvedValue({ product: { id: "prod_1" } });
    const sale = { sellerExternalId: "seller_us", title: "Preset Pack", sku: "preset-pack", price: 10 };
    await createCheckout(sale);
    await createCheckout(sale);
    const [first, second] = fakeWhop.checkoutConfigurations.create.mock.calls.map((c) => c[0].plan);
    expect(first.product).toMatchObject({ external_identifier: "ledgerly-preset-pack" });
    expect(first.product_id).toBeUndefined();
    expect(second).toMatchObject({ product_id: "prod_1", application_fee_amount: 0.8 });
    expect(second.product).toBeUndefined();
  });

  it("a product that already exists at Whop is found by its reference", async () => {
    const { createCheckout } = await import("@/lib/checkout");
    await seed();
    fakeWhop.products.list.mockResolvedValue([{ id: "prod_other", external_identifier: "ledgerly-other" }, { id: "prod_old", external_identifier: "ledgerly-preset-pack" }]);
    fakeWhop.checkoutConfigurations.create.mockResolvedValue({ id: "ch_1", purchase_url: "u1" });
    await createCheckout({ sellerExternalId: "seller_us", title: "Preset Pack", sku: "preset-pack", price: 10 });
    expect(fakeWhop.checkoutConfigurations.create.mock.calls[0][0].plan).toMatchObject({ product_id: "prod_old" });
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
    const seller = { externalId: "seller_x", email: "x@example.com", country: "US" };
    expect((await onboardSeller(seller)).created).toBe(true);
    expect((await onboardSeller(seller)).created).toBe(false);
    expect(fakeWhop.accounts.create).toHaveBeenCalledTimes(1);
    await expect(onboardSeller({ ...seller, collectionMode: "platform" })).rejects.toBeInstanceOf(ConflictError);
  });
});
