import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, fakeWhop, seed } from "./helpers";

// Per-seller Ledgerly fee: the real operator route, checkout and settlement, with the session stubbed.
const session = vi.hoisted(() => ({ operator: null as { name: string } | null }));
vi.mock("@/lib/seller-session", () => ({
  currentOperator: async () => session.operator,
  isOperator: async () => Boolean(session.operator),
  currentSeller: async () => null,
}));

async function setFee(externalId: string, fee: string, headers: Record<string, string> = {}) {
  const route = await import("@/app/api/operator/sellers/[externalId]/fee/route");
  const body = new FormData();
  body.set("fee", fee);
  body.set("back", `/sellers/${externalId}`);
  const req = new Request(`https://ledgerly.test/api/operator/sellers/${externalId}/fee`, { method: "POST", body, headers });
  const res = await route.POST(req, { params: Promise.resolve({ externalId }) });
  return { status: res.status, location: res.headers.get("location") };
}

let calls = 0;
async function checkout(sellerExternalId: string, price = 10) {
  const { createCheckout } = await import("@/lib/checkout");
  const c = await createCheckout({ sellerExternalId, title: "Pack", sku: `pack-${++calls}`, price });
  const plan = fakeWhop.checkoutConfigurations.create.mock.lastCall![0].plan;
  const [o] = await (await db())`select platform_fee from orders where id = ${c.orderId}`;
  return { c, plan, storedFee: o.platform_fee as string };
}

beforeEach(() => {
  session.operator = { name: "Ops Person" };
  fakeWhop.checkoutConfigurations.create.mockImplementation(async () => ({ id: `ch_${calls}`, purchase_url: "https://whop.com/checkout/x/" }));
  fakeWhop.products.list.mockResolvedValue([]);
  fakeWhop.plans.retrieve.mockResolvedValue({});
});

describe("platform default", () => {
  it("a freshly onboarded seller and an existing seller without a rate both pay 8%", async () => {
    const { onboardSeller } = await import("@/lib/onboarding");
    fakeWhop.accounts.create.mockResolvedValue({ id: "biz_new" });
    fakeWhop.accountLinks.create.mockResolvedValue({ url: "https://whop.com/verify", expires_at: null });
    await onboardSeller({ externalId: "seller_new", email: "new@example.com", country: "US" });
    await seed(); // seller_us, inserted without fee_bps
    const sql = await db();
    expect(await sql`select external_id, fee_bps from sellers order by external_id`).toEqual([
      { external_id: "seller_new", fee_bps: null },
      { external_id: "seller_us", fee_bps: null },
    ]);

    for (const seller of ["seller_new", "seller_us"]) {
      const { c, plan, storedFee } = await checkout(seller);
      expect(c.fee).toBe(0.8);
      expect(plan.application_fee_amount).toBe(0.8);
      expect(storedFee).toBe("0.80");
    }
  });
});

describe("operator sets a seller's fee", () => {
  it("10% → the next direct checkout sends a $1.00 application fee; old orders keep theirs", async () => {
    const { order } = await seed();
    const r = await setFee("seller_us", "10");
    expect(r).toEqual({ status: 303, location: "https://ledgerly.test/sellers/seller_us?notice=fee_changed&seller=seller_us" });

    const { plan, storedFee } = await checkout("seller_us");
    expect(plan.application_fee_amount).toBe(1);
    expect(storedFee).toBe("1.00");

    const sql = await db();
    expect((await sql`select platform_fee from orders where id = ${order.id}`)[0].platform_fee).toBe("0.80");
    expect(await sql`select seller_external_id, from_bps, to_bps, changed_by from seller_fee_changes`).toEqual([
      { seller_external_id: "seller_us", from_bps: null, to_bps: 1000, changed_by: "Ops Person" },
    ]);

    // Same rate again changes nothing.
    expect((await setFee("seller_us", "10%")).location).toContain("notice=fee_unchanged");
    expect((await sql`select count(*)::int as n from seller_fee_changes`)[0].n).toBe(1);
  });

  it("0% → no application fee and a zero fee on the order", async () => {
    await seed();
    expect((await setFee("seller_us", "0")).location).toContain("notice=fee_changed");
    const { c, plan, storedFee } = await checkout("seller_us");
    expect(plan).not.toHaveProperty("application_fee_amount");
    expect(c.fee).toBe(0);
    expect(storedFee).toBe("0.00");
  });

  it("reset to default → back to 8% and fee_bps null", async () => {
    await seed();
    await setFee("seller_us", "12.5");
    expect((await checkout("seller_us")).plan.application_fee_amount).toBe(1.25);

    expect((await setFee("seller_us", "default")).location).toContain("notice=fee_changed");
    const sql = await db();
    expect((await sql`select fee_bps from sellers where external_id = 'seller_us'`)[0].fee_bps).toBeNull();
    expect((await checkout("seller_us")).plan.application_fee_amount).toBe(0.8);

    // Empty input also means default.
    await setFee("seller_us", "5");
    await setFee("seller_us", "");
    expect((await sql`select fee_bps from sellers where external_id = 'seller_us'`)[0].fee_bps).toBeNull();
    expect((await sql`select to_bps from seller_fee_changes order by id`).map((r) => r.to_bps)).toEqual([1250, null, 500, null]);
  });

  it("refuses bad input with a clear notice and changes nothing", async () => {
    await seed();
    for (const bad of ["60", "abc", "50.5", "-3"]) {
      expect((await setFee("seller_us", bad)).location).toBe("https://ledgerly.test/sellers/seller_us?notice=fee_invalid&seller=seller_us");
    }
    const sql = await db();
    expect((await sql`select fee_bps from sellers`)[0].fee_bps).toBeNull();
    expect((await sql`select count(*)::int as n from seller_fee_changes`)[0].n).toBe(0);
  });

  it("reports an unknown seller", async () => {
    expect((await setFee("nobody", "10")).location).toContain("notice=fee_not_found");
  });

  it("refuses non-operators and cross-site posts", async () => {
    await seed();
    session.operator = null;
    expect((await setFee("seller_us", "10")).status).toBe(403);
    session.operator = { name: "Ops" };
    expect((await setFee("seller_us", "10", { origin: "https://evil.example" })).status).toBe(403);
    expect((await (await db())`select fee_bps from sellers`)[0].fee_bps).toBeNull();
  });
});

describe("platform-collected seller at 10%", () => {
  it("transfers the share computed with the 10% fee", async () => {
    await seed({ flow: "platform" });
    await setFee("seller_br", "10");
    const { c, plan, storedFee } = await checkout("seller_br");
    expect(plan).not.toHaveProperty("application_fee_amount");
    expect(storedFee).toBe("1.00");

    const sql = await db();
    await sql`update orders set status = 'paid', whop_payment_id = 'pay_10pct' where id = ${c.orderId}`;
    fakeWhop.payments.listFees.mockResolvedValue({
      data: [
        { origin: "sales_tax_remittance", amount: { amount: "0.83" } },
        { origin: "payment_processing_fixed_fee", amount: { amount: "0.30" } },
        { origin: "payment_processing_percentage_fee", amount: { amount: "0.29" } },
        { origin: "stripe_sales_tax_fee", amount: { amount: "0.22" } },
        { origin: "orchestration_percentage_fee", amount: { amount: "0.09" } },
        { origin: "stripe_radar_fee", amount: { amount: "0.07" } },
      ],
    });
    fakeWhop.transfers.create.mockResolvedValue({ id: "ctt_10pct", status: "succeeded" });
    const { settlePlatformOrder } = await import("@/lib/checkout");
    const r = await settlePlatformOrder(c.orderId);
    // $10 − $0.75 Whop fees − $1.00 Ledgerly (10%) = $8.25 (8% would have been $8.45).
    expect(r).toMatchObject({ share: 8.25 });
    expect(fakeWhop.transfers.create.mock.calls[0][0]).toMatchObject({ amount: 8.25 });
  });
});
