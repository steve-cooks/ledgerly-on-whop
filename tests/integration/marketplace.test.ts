import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { db, fakeWhop, seed } from "./helpers";

// Supabase is stubbed at the module boundary: who's signed in (getClaims) and Storage.
const supa = vi.hoisted(() => ({
  claims: null as { sub: string; email?: string } | null,
  createSignedUrl: undefined as unknown as Mock,
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseAuthEnabled: () => true,
  supabaseServer: async () => ({ auth: { getClaims: async () => ({ data: supa.claims ? { claims: supa.claims } : null, error: null }) } }),
  supabaseAdmin: () => ({ storage: { from: () => ({ createSignedUrl: supa.createSignedUrl }) } }),
}));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined),
    set: (k: string, v: string) => jar.set(k, v),
    delete: (k: string) => jar.delete(k),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

beforeEach(() => {
  jar.clear();
  supa.claims = null;
  supa.createSignedUrl = vi.fn(async (path: string) => ({ data: { signedUrl: `https://storage.test/sign/${path}?token=t` }, error: null }));
});

/** A product listed by the seeded direct seller (seller_us). */
async function product(opts: { active?: boolean; price?: number } = {}) {
  const sql = await db();
  const id = randomUUID();
  await sql`
    insert into products (id, seller_external_id, title, price, sku, file_path, file_name, active)
    values (${id}, 'seller_us', 'Golden Hour Presets', ${opts.price ?? 10}, ${`golden-hour-presets-${id.slice(0, 8)}`},
            ${`seller_us/${id}/presets.zip`}, 'presets.zip', ${opts.active ?? true})`;
  return id;
}

/** The redirect target of a next/navigation redirect() (it throws). */
const redirectTarget = (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string }) => e.digest?.split(";")[2] ?? Promise.reject(e));

describe("buying a product", () => {
  const buy = async (productId: string, nonce = randomUUID(), origin?: string) => {
    const { POST } = await import("@/app/shop/[productId]/buy/route");
    const body = new FormData();
    body.set("nonce", nonce);
    const headers = origin ? { origin } : undefined;
    return POST(new Request(`https://ledgerly.test/shop/${productId}/buy`, { method: "POST", body, headers }), { params: Promise.resolve({ productId }) });
  };

  it("another browser can't reach a buyer's order by reusing their page's nonce", async () => {
    await seed();
    await (await db())`delete from orders`;
    const id = await product();
    fakeWhop.checkoutConfigurations.create
      .mockResolvedValueOnce({ id: "ch_victim", purchase_url: "https://whop.com/checkout/ch_victim" })
      .mockResolvedValueOnce({ id: "ch_other", purchase_url: "https://whop.com/checkout/ch_other" });
    const nonce = randomUUID();
    await buy(id, nonce); // the buyer's browser
    await (await db())`update orders set status = 'paid'`;
    jar.clear(); // a different browser, same nonce
    const res = await buy(id, nonce);
    expect(res.headers.get("location")).toBe("https://whop.com/checkout/ch_other");
    expect(await (await db())`select id from orders`).toHaveLength(2);
  });

  it("refuses a Buy submitted from another site", async () => {
    await seed();
    const res = await buy(await product(), randomUUID(), "https://evil.test");
    expect(res.status).toBe(403);
    expect(fakeWhop.checkoutConfigurations.create).not.toHaveBeenCalled();
  });

  it("creates an order linked to the product and sends the buyer to Whop's checkout", async () => {
    await seed(); // seller_us, onboarded, direct
    await (await db())`delete from orders`;
    const id = await product({ price: 10 });
    fakeWhop.checkoutConfigurations.create.mockResolvedValue({ id: "ch_1", purchase_url: "https://whop.com/checkout/ch_1" });

    const res = await buy(id);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://whop.com/checkout/ch_1");
    const [order] = await (await db())`select * from orders`;
    expect(order).toMatchObject({ product_id: id, sku: `golden-hour-presets-${id.slice(0, 8)}`, status: "pending", flow: "direct" });
    expect(Number(order.amount)).toBe(10);
    expect(Number(order.platform_fee)).toBe(0.8);
    expect(fakeWhop.checkoutConfigurations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "biz_seller_us",
        plan: expect.objectContaining({ initial_price: 10, application_fee_amount: 0.8 }),
        redirect_url: `https://ledgerly.test/orders/${order.id}`,
      }),
      { idempotencyKey: `ledgerly:checkout:${order.id}` },
    );
  });

  it("a double-clicked Buy opens one order and one checkout", async () => {
    await seed();
    await (await db())`delete from orders`;
    const id = await product();
    fakeWhop.checkoutConfigurations.create.mockResolvedValue({ id: "ch_1", purchase_url: "https://whop.com/checkout/ch_1" });
    const nonce = randomUUID();
    const [a, b] = [await buy(id, nonce), await buy(id, nonce)];
    expect(a.headers.get("location")).toBe(b.headers.get("location"));
    expect(await (await db())`select id from orders`).toHaveLength(1);
    expect(fakeWhop.checkoutConfigurations.create).toHaveBeenCalledTimes(1);
  });

  it("won't sell a hidden product", async () => {
    await seed();
    const res = await buy(await product({ active: false }));
    expect(res.status).toBe(404);
    expect(fakeWhop.checkoutConfigurations.create).not.toHaveBeenCalled();
  });

  it("sends the buyer back to the product page if Whop fails", async () => {
    await seed();
    const id = await product();
    fakeWhop.checkoutConfigurations.create.mockRejectedValue(new Error("whop down"));
    const res = await buy(id);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://ledgerly.test/shop/${id}?error=checkout`);
  });
});

describe("downloading a purchase", () => {
  const download = async (orderId: string) => {
    const { GET } = await import("@/app/orders/[orderId]/download/route");
    return GET(new Request(`https://ledgerly.test/orders/${orderId}/download`), { params: Promise.resolve({ orderId }) });
  };
  const orderFor = async (status: string) => {
    const { order } = await seed({ status });
    const id = await product();
    await (await db())`update orders set product_id = ${id} where id = ${order.id}`;
    return { orderId: order.id, productId: id };
  };

  it("serves a short-lived signed link for a paid order", async () => {
    const { orderId, productId } = await orderFor("paid");
    const res = await download(orderId);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://storage.test/sign/seller_us/${productId}/presets.zip?token=t`);
    expect(supa.createSignedUrl).toHaveBeenCalledWith(`seller_us/${productId}/presets.zip`, 60, { download: "presets.zip" });
  });

  it.each(["pending", "failed", "refunded", "partially_refunded", "disputed"])("refuses a %s order", async (status) => {
    const { orderId } = await orderFor(status);
    expect((await download(orderId)).status).toBe(403);
    expect(supa.createSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses an order with no product, and nonsense ids", async () => {
    const { order } = await seed({ status: "paid" });
    expect((await download(order.id)).status).toBe(403);
    expect((await download("not-a-uuid")).status).toBe(403);
    expect(supa.createSignedUrl).not.toHaveBeenCalled();
  });
});

describe("opening a store (seller onboarding)", () => {
  const USER = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
  const openStore = async () => {
    const { openStoreAction } = await import("@/app/sell/actions");
    const form = new FormData();
    form.set("storeName", "Golden Hour Studio");
    form.set("country", "US");
    return redirectTarget(openStoreAction(null, form));
  };

  it("creates the seller, links it to the signed-in user, and sends them to Whop", async () => {
    supa.claims = { sub: USER, email: "maya@example.com" };
    fakeWhop.accounts.create.mockResolvedValue({ id: "biz_new" });
    fakeWhop.accountLinks.create.mockResolvedValue({ url: "https://whop.com/onboarding/abc", expires_at: null });

    expect(await openStore()).toBe("https://whop.com/onboarding/abc");
    const sql = await db();
    const [link] = await sql`select * from seller_users where auth_user_id = ${USER}`;
    expect(link.store_name).toBe("Golden Hour Studio");
    expect(link.seller_external_id).toMatch(/^seller_[a-z0-9]{10}$/);
    const [seller] = await sql`select * from sellers where external_id = ${link.seller_external_id}`;
    expect(seller).toMatchObject({ email: "maya@example.com", country: "US", collection_mode: "direct", whop_account_id: "biz_new" });
    expect(fakeWhop.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: "maya@example.com", country: "US", title: "Golden Hour Studio" }),
      { idempotencyKey: `ledgerly:seller:create:${link.seller_external_id}` },
    );
    expect(fakeWhop.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: "biz_new", return_url: `https://ledgerly.test/sellers/${link.seller_external_id}?onboarding=done` }),
    );
  });

  it("submitting twice keeps one seller and one Whop account", async () => {
    supa.claims = { sub: USER, email: "maya@example.com" };
    fakeWhop.accounts.create.mockResolvedValue({ id: "biz_new" });
    fakeWhop.accountLinks.create.mockResolvedValue({ url: "https://whop.com/onboarding/abc", expires_at: null });
    await openStore();
    await openStore();
    expect(await (await db())`select * from sellers`).toHaveLength(1);
    expect(fakeWhop.accounts.create).toHaveBeenCalledTimes(1);
    expect(fakeWhop.accountLinks.create).toHaveBeenCalledTimes(2);
  });

  it("a retry after Whop failed reuses the same seller", async () => {
    supa.claims = { sub: USER, email: "maya@example.com" };
    fakeWhop.accounts.create.mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ id: "biz_new" });
    fakeWhop.accountLinks.create.mockResolvedValue({ url: "https://whop.com/onboarding/abc", expires_at: null });
    const { openStoreAction } = await import("@/app/sell/actions");
    const form = new FormData();
    form.set("storeName", "Golden Hour Studio");
    form.set("country", "US");
    expect(await openStoreAction(null, form)).toEqual({ error: expect.stringContaining("couldn't set up your store") });
    expect(await openStore()).toBe("https://whop.com/onboarding/abc");
    const sellers = await (await db())`select * from sellers`;
    expect(sellers).toHaveLength(1);
    const keys = fakeWhop.accounts.create.mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("sends a signed-out visitor to log in", async () => {
    expect(await openStore()).toBe("/sell/login");
    expect(fakeWhop.accounts.create).not.toHaveBeenCalled();
  });
});

describe("currentSeller with a Supabase session", () => {
  const USER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const currentSeller = async () => (await import("@/lib/seller-session")).currentSeller();

  it("maps the signed-in Supabase user to their seller", async () => {
    await seed();
    await (await db())`insert into seller_users (auth_user_id, seller_external_id, store_name) values (${USER}, 'seller_us', 'US Store')`;
    supa.claims = { sub: USER, email: "seller_us@example.com" };
    expect(await currentSeller()).toBe("seller_us");
  });

  it("is null for a signed-in user without a store, and for nobody", async () => {
    supa.claims = { sub: USER };
    expect(await currentSeller()).toBeNull();
    supa.claims = null;
    expect(await currentSeller()).toBeNull();
  });

  it("a staff (operator) session doesn't hide the seller's own session", async () => {
    await seed();
    await (await db())`insert into seller_users (auth_user_id, seller_external_id, store_name) values (${USER}, 'seller_us', 'US Store')`;
    supa.claims = { sub: USER };
    const session = await import("@/lib/seller-session");
    await session.startOperatorSession("Ops");
    expect(await currentSeller()).toBe("seller_us");
    expect(await session.isOperator()).toBe(true);
  });
});
