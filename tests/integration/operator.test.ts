import { describe, expect, it, vi } from "vitest";
import { db, deliver, fakeWhop, seed, whopError } from "./helpers";

// Operator console actions: the real routes and SQL, with the session stubbed.
const session = vi.hoisted(() => ({ operator: null as { name: string } | null }));
vi.mock("@/lib/seller-session", () => ({
  currentOperator: async () => session.operator,
  isOperator: async () => Boolean(session.operator),
  currentSeller: async () => null,
}));

async function post(action: "reminder" | "mode", externalId: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const route =
    action === "reminder"
      ? await import("@/app/api/operator/sellers/[externalId]/reminder/route")
      : await import("@/app/api/operator/sellers/[externalId]/mode/route");
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const req = new Request(`https://ledgerly.test/api/operator/sellers/${externalId}/${action}`, { method: "POST", body, headers });
  const res = await route.POST(req, { params: Promise.resolve({ externalId }) });
  return { status: res.status, location: res.headers.get("location") };
}

const accountEvent = (data: Record<string, unknown>, timestamp = new Date().toISOString()) => ({
  type: "account.updated",
  timestamp,
  account_id: "biz_seller_us",
  data: { id: "biz_seller_us", status: "active", ...data },
});

describe("verification mirror", () => {
  it("account.updated stores title, verification status and open required actions", async () => {
    await seed();
    const r = await deliver(
      accountEvent({
        title: "Mira Presets",
        verification: { individual: { status: "submitted" }, business: null },
        required_actions: [
          { action: "verify_identity", status: "required" },
          { action: "accept_payout_terms", status: "pending" },
          { action: "update_payout_profile", status: "completed" },
        ],
      }),
    );
    expect(r.status).toBe(200);
    const [s] = await (await db())`select * from sellers where external_id = 'seller_us'`;
    expect(s).toMatchObject({ title: "Mira Presets", whop_status: "active", verification_status: "submitted", outstanding_actions: 2 });
  });

  it("treats a missing verification as not started, and never lets an older event overwrite a newer one", async () => {
    await seed();
    await deliver(accountEvent({ verification: { individual: null, business: null }, required_actions: [] }, "2026-10-06T10:00:00Z"));
    let [s] = await (await db())`select * from sellers where external_id = 'seller_us'`;
    expect(s).toMatchObject({ verification_status: "not_started", outstanding_actions: 0 });

    await deliver(accountEvent({ verification: { individual: null, business: { status: "approved" } }, required_actions: [] }, "2026-10-06T12:00:00Z"));
    await deliver(accountEvent({ verification: { individual: { status: "started" } }, required_actions: [{ status: "required" }] }, "2026-10-06T11:00:00Z"));
    [s] = await (await db())`select * from sellers where external_id = 'seller_us'`;
    expect(s).toMatchObject({ verification_status: "approved", outstanding_actions: 0 });
  });

  it("sellers:sync backfills from accounts.retrieve and reports failures per seller", async () => {
    await seed();
    await seed({ flow: "platform" });
    fakeWhop.accounts.retrieve.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "biz_seller_br") throw whopError(500, "upstream");
      return { id, title: "Mira", status: "active", verification: { individual: { status: "approved" } }, required_actions: [] };
    });
    const { syncSellerVerification } = await import("@/lib/operator");
    const r = await syncSellerVerification();
    expect(r.synced).toBe(1);
    expect(r.errors).toEqual(["seller_br: Whop 500: upstream"]);
    const rows = await (await db())`select external_id, verification_status, title from sellers order by external_id`;
    expect(rows).toEqual([
      { external_id: "seller_br", verification_status: null, title: null },
      { external_id: "seller_us", verification_status: "approved", title: "Mira" },
    ]);
  });
});

describe("seller list", () => {
  it("filters to sellers needing verification, searches id/email/title, and pages by 25", async () => {
    const sql = await db();
    await sql`
      insert into sellers (external_id, email, country, whop_account_id, title, verification_status, outstanding_actions, created_at)
      select 'seller_' || lpad(i::text, 3, '0'), 'seller' || i || '@example.com', 'US', 'biz_' || i,
             case when i = 7 then 'Lucky Presets' else 'Shop ' || i end,
             case when i % 2 = 0 then 'approved' else 'not_started' end,
             case when i = 4 then 1 else 0 end,
             now() - (i || ' minutes')::interval
      from generate_series(1, 60) i`;
    const { listSellers } = await import("@/lib/operator");

    // Odd ones aren't approved (30) and seller_004 is approved with an open action: 31.
    const p1 = await listSellers({});
    expect(p1).toMatchObject({ filter: "needs_verification", total: 31, pages: 2, page: 1, counts: { all: 60, needsVerification: 31 } });
    expect(p1.rows).toHaveLength(25);
    expect(p1.rows[0].external_id).toBe("seller_001"); // newest first
    const p2 = await listSellers({ page: "2" });
    expect(p2.rows).toHaveLength(6);
    expect(p2.rows.map((r) => r.external_id)).not.toContain(p1.rows[0].external_id);
    expect((await listSellers({ page: "99" })).page).toBe(2); // clamped

    expect((await listSellers({ filter: "all" })).total).toBe(60);
    expect((await listSellers({ filter: "bogus" })).filter).toBe("needs_verification");
    expect((await listSellers({ q: "lucky" })).rows.map((r) => r.external_id)).toEqual(["seller_007"]);
    expect((await listSellers({ q: "seller42@example", filter: "all" })).rows.map((r) => r.external_id)).toEqual(["seller_042"]);
    expect((await listSellers({ q: "seller_05", filter: "all" })).total).toBe(10);
    expect((await listSellers({ q: "%" })).total).toBe(0); // wildcards are literal
  });

  it("shows when each seller was last reminded", async () => {
    await seed();
    session.operator = { name: "Ops" };
    await post("reminder", "seller_us");
    const { listSellers } = await import("@/lib/operator");
    const [row] = (await listSellers({})).rows;
    expect(row.last_reminder_at).toBeInstanceOf(Date);
  });
});

describe("Send reminder", () => {
  it("records the reminder, then refuses another within 24h", async () => {
    await seed();
    session.operator = { name: "Ops Person" };
    const first = await post("reminder", "seller_us", { back: "/?filter=all&page=2" });
    expect(first.status).toBe(303);
    expect(first.location).toBe("https://ledgerly.test/?filter=all&page=2&notice=reminder_sent&seller=seller_us");

    const second = await post("reminder", "seller_us", { back: "/sellers/seller_us" });
    expect(second.location).toBe("https://ledgerly.test/sellers/seller_us?notice=reminder_cooldown&seller=seller_us");

    const sql = await db();
    expect(await sql`select seller_external_id, sent_by, ok from seller_reminders`).toEqual([
      { seller_external_id: "seller_us", sent_by: "Ops Person", ok: true },
    ]);

    // A day later it can be sent again.
    await sql`update seller_reminders set sent_at = now() - interval '25 hours'`;
    expect((await post("reminder", "seller_us")).location).toContain("notice=reminder_sent");
    expect((await sql`select count(*)::int as n from seller_reminders`)[0].n).toBe(2);
  });

  it("never redirects off-site, and reports an unknown seller", async () => {
    session.operator = { name: "Ops" };
    const r = await post("reminder", "nobody", { back: "//evil.example/x" });
    expect(r.location).toBe("https://ledgerly.test/?notice=reminder_not_found&seller=nobody");
  });
});

describe("payment mode", () => {
  it("switches the mode, records who did it, and only new checkouts use it", async () => {
    const { order } = await seed(); // seller_us on direct, with an existing direct order
    session.operator = { name: "Ops Person" };
    const r = await post("mode", "seller_us", { mode: "platform", back: "/" });
    expect(r.location).toBe("https://ledgerly.test/?notice=mode_platform&seller=seller_us");

    const sql = await db();
    expect((await sql`select collection_mode from sellers where external_id = 'seller_us'`)[0].collection_mode).toBe("platform");
    expect(await sql`select seller_external_id, from_mode, to_mode, changed_by from seller_mode_changes`).toEqual([
      { seller_external_id: "seller_us", from_mode: "direct", to_mode: "platform", changed_by: "Ops Person" },
    ]);
    expect((await sql`select flow from orders where id = ${order.id}`)[0].flow).toBe("direct");

    fakeWhop.checkoutConfigurations.create.mockResolvedValue({ id: "ch_new", purchase_url: "https://whop.com/checkout/ch_new/" });
    const { createCheckout } = await import("@/lib/checkout");
    const c = await createCheckout({ sellerExternalId: "seller_us", title: "Pack", sku: "pack", price: 10, currency: "usd" });
    expect(c.flow).toBe("platform");
    expect(fakeWhop.checkoutConfigurations.create).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: "biz_platform", plan: expect.not.objectContaining({ application_fee_amount: expect.anything() }) }),
      expect.anything(),
    );

    // Choosing the current mode changes nothing.
    expect((await post("mode", "seller_us", { mode: "platform" })).location).toContain("notice=mode_unchanged");
    expect((await sql`select count(*)::int as n from seller_mode_changes`)[0].n).toBe(1);
  });

  it("rejects an unknown mode", async () => {
    await seed();
    session.operator = { name: "Ops" };
    expect((await post("mode", "seller_us", { mode: "free" })).status).toBe(400);
  });
});

describe("operator-only", () => {
  it("refuses anyone who isn't a signed-in operator, and cross-site posts", async () => {
    await seed();
    session.operator = null;
    expect((await post("reminder", "seller_us")).status).toBe(403);
    expect((await post("mode", "seller_us", { mode: "platform" })).status).toBe(403);

    session.operator = { name: "Ops" };
    expect((await post("mode", "seller_us", { mode: "platform" }, { origin: "https://evil.example" })).status).toBe(403);

    const sql = await db();
    expect((await sql`select count(*)::int as n from seller_reminders`)[0].n).toBe(0);
    expect((await sql`select collection_mode from sellers`)[0].collection_mode).toBe("direct");
  });
});
