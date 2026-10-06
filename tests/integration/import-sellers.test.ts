import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, fakeWhop, seed } from "./helpers";

// Importing existing sellers from the operator console, and those sellers being recognised when
// they first sign in. The real routes and SQL; the operator session and Supabase Auth stubbed.
const session = vi.hoisted(() => ({ operator: null as { name: string } | null }));
vi.mock("@/lib/seller-session", () => ({
  currentOperator: async () => session.operator,
  isOperator: async () => Boolean(session.operator),
  currentSeller: async () => null,
}));
type User = { id: string; email?: string | null; email_confirmed_at?: string | null };
const supa = vi.hoisted(() => ({ user: null as User | null }));
vi.mock("@/lib/supabase/server", () => ({
  supabaseAuthEnabled: () => true,
  supabaseServer: async () => ({
    auth: {
      getClaims: async () => ({ data: supa.user ? { claims: { sub: supa.user.id, email: supa.user.email } } : null, error: null }),
      getUser: async () => ({ data: { user: supa.user }, error: null }),
      exchangeCodeForSession: async () => ({ data: { user: supa.user }, error: supa.user ? null : new Error("bad code") }),
    },
  }),
}));

beforeEach(() => {
  session.operator = { name: "Olivia Ops" };
  supa.user = null;
  fakeWhop.accounts.create.mockImplementation(async (body: { metadata: { external_id: string } }) => ({ id: `biz_${body.metadata.external_id}` }));
});

const HEADER = "external_id,email,country,title,collection_mode";

async function importCsv(csv: string, dryRun: boolean, headers: Record<string, string> = { origin: "https://ledgerly.test" }) {
  const { POST } = await import("@/app/api/operator/import/route");
  const res = await POST(
    new Request("https://ledgerly.test/api/operator/import", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ csv, dryRun }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const sellerCount = async () => (await (await db())`select count(*)::int as n from sellers`)[0].n as number;

describe("operator console: import sellers", () => {
  const csv = [
    HEADER,
    "seller_us,seller_us@example.com,US,Already Here,direct", // seeded and on Whop
    "seller_mira,mira@example.com,us,Mira Presets,",
    "seller_bad,not-an-email,US,Broken,direct",
    "seller_conflict,c@example.com,FR,Conflict,direct", // stored with country US
  ].join("\n");

  beforeEach(async () => {
    await seed();
    await (await db())`insert into sellers (external_id, email, country) values ('seller_conflict', 'c@example.com', 'US')`;
  });

  it("preview creates nothing and reports would_create, would_skip and errors", async () => {
    const before = await sellerCount();
    const r = await importCsv(csv, true);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { line: number; status: string }) => [x.line, x.status])).toEqual([
      [2, "would_skip"],
      [3, "would_create"],
      [4, "error"],
      [5, "error"],
    ]);
    expect(r.body.results[0]).toMatchObject({ external_id: "seller_us", account_id: "biz_seller_us" });
    expect(r.body.results[2]).toMatchObject({ external_id: "seller_bad", email: "not-an-email", error: expect.stringMatching(/email/) });
    expect(r.body.results[3].error).toBe("already exists with a different country");
    expect(r.body.counts).toEqual({ would_skip: 1, would_create: 1, error: 2 });
    expect(await sellerCount()).toBe(before);
    expect(await (await db())`select 1 from seller_imports`).toHaveLength(0);
    expect(fakeWhop.accounts.create).not.toHaveBeenCalled();
  });

  it("import creates accounts (no onboarding links) and reports existing on a re-run", async () => {
    const r = await importCsv(csv, false);
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual({ existing: 1, created: 1, error: 2 });
    expect(r.body.results[1]).toEqual({ line: 3, external_id: "seller_mira", email: "mira@example.com", status: "created", account_id: "biz_seller_mira" });
    expect(JSON.stringify(r.body)).not.toMatch(/onboarding_url|expires_at/);
    expect(fakeWhop.accounts.create).toHaveBeenCalledTimes(1);
    expect(fakeWhop.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: "mira@example.com", country: "US", title: "Mira Presets" }),
      { idempotencyKey: "ledgerly:seller:create:seller_mira" },
    );
    expect(fakeWhop.accountLinks.create).not.toHaveBeenCalled();
    const [mira] = await (await db())`select * from sellers where external_id = 'seller_mira'`;
    expect(mira).toMatchObject({ whop_account_id: "biz_seller_mira", title: "Mira Presets", collection_mode: "direct" });

    const again = await importCsv(csv, false);
    expect(again.body.counts).toEqual({ existing: 2, error: 2 });
    const runs = await (await db())`select imported_by, created, existing, errors from seller_imports order by id`;
    expect(runs).toEqual([
      { imported_by: "Olivia Ops", created: 1, existing: 1, errors: 2 },
      { imported_by: "Olivia Ops", created: 0, existing: 2, errors: 2 },
    ]);
    expect(fakeWhop.accounts.create).toHaveBeenCalledTimes(1);
  });

  it("refuses more than 200 rows and points to the CLI", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => `seller_${i},s${i}@example.com,US,,`);
    const r = await importCsv([HEADER, ...rows].join("\n"), false);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/up to 200.*pnpm ledgerly import-sellers/);
    expect(fakeWhop.accounts.create).not.toHaveBeenCalled();
  });

  it("refuses a file without the required header", async () => {
    const r = await importCsv("id,email\n1,a@example.com", true);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/external_id/);
  });

  it("is operator-only and refuses cross-site posts", async () => {
    session.operator = null;
    expect((await importCsv(csv, false)).status).toBe(403);
    session.operator = { name: "Olivia Ops" };
    expect((await importCsv(csv, false, { origin: "https://evil.test" })).status).toBe(403);
    expect(fakeWhop.accounts.create).not.toHaveBeenCalled();
  });
});

/** The redirect target of a next/navigation redirect() (it throws). */
const redirectTarget = (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string }) => e.digest?.split(";")[2] ?? Promise.reject(e));

describe("imported sellers are recognised when they sign in", () => {
  const verified = (email: string): User => ({ id: randomUUID(), email, email_confirmed_at: "2026-10-06T00:00:00Z" });

  async function imported(externalId: string, email: string, opts: { account?: string | null; title?: string } = {}) {
    await (await db())`
      insert into sellers (external_id, email, country, whop_account_id, title)
      values (${externalId}, ${email}, 'US', ${opts.account === undefined ? `biz_${externalId}` : opts.account}, ${opts.title ?? null})`;
  }
  async function callback() {
    const { GET } = await import("@/app/auth/callback/route");
    return redirectTarget(GET(new Request("https://ledgerly.test/auth/callback?code=c1")));
  }
  const links = async () => (await db())`select auth_user_id, seller_external_id, store_name from seller_users order by created_at`;

  it("links a verified user to the one imported seller with their email and sends them to the dashboard", async () => {
    await imported("seller_mira", "Mira@Example.com", { title: "Mira Presets" });
    supa.user = verified("mira@example.com");
    expect(await callback()).toBe("/sell/dashboard");
    expect(await links()).toEqual([{ auth_user_id: supa.user.id, seller_external_id: "seller_mira", store_name: "Mira Presets" }]);
    expect(fakeWhop.accounts.create).not.toHaveBeenCalled();
    // Signing in again finds the same store.
    expect(await callback()).toBe("/sell/dashboard");
    expect(await links()).toHaveLength(1);
  });

  it("names the store after the external id when the seller has no title", async () => {
    await imported("seller_kumo", "kumo@example.com");
    supa.user = verified("kumo@example.com");
    expect(await callback()).toBe("/sell/dashboard");
    expect((await links())[0].store_name).toBe("seller_kumo");
  });

  it("doesn't link an unverified email", async () => {
    await imported("seller_mira", "mira@example.com");
    supa.user = { ...verified("mira@example.com"), email_confirmed_at: null };
    expect(await callback()).toBe("/sell/onboard");
    expect(await links()).toEqual([]);
  });

  it("doesn't link when two sellers share the email", async () => {
    await imported("seller_a", "twin@example.com");
    await imported("seller_b", "twin@example.com");
    supa.user = verified("twin@example.com");
    expect(await callback()).toBe("/sell/onboard");
    expect(await links()).toEqual([]);
  });

  it("doesn't link a seller that isn't on Whop yet", async () => {
    await imported("seller_new", "new@example.com", { account: null });
    supa.user = verified("new@example.com");
    expect(await callback()).toBe("/sell/onboard");
    expect(await links()).toEqual([]);
  });

  it("never takes over a seller someone already claimed", async () => {
    await imported("seller_mira", "mira@example.com");
    const owner = verified("mira@example.com");
    supa.user = owner;
    expect(await callback()).toBe("/sell/dashboard");
    supa.user = verified("mira@example.com"); // a different Supabase user, same email
    expect(await callback()).toBe("/sell/onboard");
    expect(await links()).toEqual([expect.objectContaining({ auth_user_id: owner.id, seller_external_id: "seller_mira" })]);
  });

  it("concurrent sign-ins of the same user link once", async () => {
    await imported("seller_mira", "mira@example.com");
    const { claimImportedSeller } = await import("@/lib/seller-accounts");
    const user = verified("mira@example.com");
    const results = await Promise.all([claimImportedSeller(user), claimImportedSeller(user), claimImportedSeller(user)]);
    expect(results.filter(Boolean)).toEqual(["seller_mira"]);
    expect(await links()).toHaveLength(1);
  });

  it("/sell/onboard links an imported seller instead of offering a new store", async () => {
    await imported("seller_mira", "mira@example.com");
    supa.user = verified("mira@example.com");
    const { default: OnboardPage } = await import("@/app/sell/onboard/page");
    expect(await redirectTarget(OnboardPage())).toBe("/sell/dashboard");
    expect(await links()).toHaveLength(1);
  });
});
