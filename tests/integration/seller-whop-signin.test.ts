import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, fakeWhop } from "./helpers";

// Sellers' "Continue with Whop": the real routes, with Whop's OAuth endpoints and Supabase Auth stubbed.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined),
    set: (k: string, v: string) => jar.set(k, v),
    delete: (k: string | { name: string }) => jar.delete(typeof k === "string" ? k : k.name),
  }),
}));
const supa = vi.hoisted(() => ({
  createUser: vi.fn(),
  generateLink: vi.fn(),
  updateUserById: vi.fn(),
  verifyOtp: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: () => ({ auth: { admin: { createUser: supa.createUser, generateLink: supa.generateLink, updateUserById: supa.updateUserById } } }),
  supabaseServer: async () => ({ auth: { verifyOtp: supa.verifyOtp } }),
}));

let userinfo: Record<string, unknown>;
const oauth = vi.fn();
beforeEach(() => {
  jar.clear();
  Object.assign(process.env, { WHOP_SELLER_APP_ID: "app_seller", WHOP_SELLER_APP_KEY: "seller_secret" });
  userinfo = { sub: "user_seller", name: "Sam Seller", email: "sam@example.com", email_verified: true };
  oauth.mockImplementation(async (url: string) => {
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "at" });
    if (url.endsWith("/oauth/userinfo")) return Response.json(userinfo);
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", oauth);
  supa.createUser.mockResolvedValue({ data: {}, error: null });
  supa.generateLink.mockResolvedValue({ data: { properties: { hashed_token: "th_1" }, user: { id: "u_1", email_confirmed_at: "2026-10-01T00:00:00Z" } }, error: null });
  supa.updateUserById.mockResolvedValue({ data: {}, error: null });
  supa.verifyOtp.mockResolvedValue({ data: { user: { id: "11111111-1111-1111-1111-111111111111" } }, error: null });
});
afterEach(() => vi.unstubAllGlobals());

const digest = (p: Promise<unknown>) => p.catch((e: { digest: string }) => e.digest.split(";")[2]);

async function signIn(opts: { state?: string } = {}) {
  const start = await import("@/app/auth/whop/start/route");
  const whopUrl = new URL((await digest(start.GET())) as string);
  expect(whopUrl.searchParams.get("client_id")).toBe("app_seller");
  expect(whopUrl.searchParams.get("nonce")).toBeTruthy(); // Whop requires it with openid
  const cb = await import("@/app/auth/whop/callback/route");
  const state = opts.state ?? whopUrl.searchParams.get("state");
  return digest(cb.GET(new Request(`https://ledgerly.test/auth/whop/callback?code=c1&state=${state}`)));
}

describe("sellers: Continue with Whop", () => {
  it("a Whop user with a verified email gets a session and goes on to open a store", async () => {
    expect(await signIn()).toBe("/sell/onboard");
    expect(supa.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: "sam@example.com", email_confirm: true }));
    expect(supa.verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "th_1" });
    const token = JSON.parse(oauth.mock.calls.find(([u]) => u.endsWith("/oauth/token"))![1].body);
    expect(token).toMatchObject({ client_id: "app_seller", client_secret: "seller_secret" });
  });

  it("an existing confirmed user with that email signs in to the same account", async () => {
    supa.createUser.mockResolvedValue({ data: {}, error: new Error("A user with this email address has already been registered") });
    expect(await signIn()).toBe("/sell/onboard");
    expect(supa.verifyOtp).toHaveBeenCalled();
    expect(supa.updateUserById).not.toHaveBeenCalled();
  });

  it("an existing account that was never confirmed has its password wiped before it's handed over", async () => {
    supa.createUser.mockResolvedValue({ data: {}, error: new Error("A user with this email address has already been registered") });
    supa.generateLink.mockResolvedValue({ data: { properties: { hashed_token: "th_1" }, user: { id: "u_squat", email_confirmed_at: null } }, error: null });
    expect(await signIn()).toBe("/sell/onboard");
    expect(supa.updateUserById).toHaveBeenCalledWith("u_squat", { password: expect.any(String), email_confirm: true });
    expect(supa.updateUserById.mock.invocationCallOrder[0]).toBeLessThan(supa.verifyOtp.mock.invocationCallOrder[0]);
  });

  it("a seller Ledgerly imported with that email lands on their existing store", async () => {
    await (await db())`
      insert into sellers (external_id, email, country, whop_account_id, title)
      values ('seller_sam', 'sam@example.com', 'US', 'biz_sam', 'Sam Sounds')`;
    supa.verifyOtp.mockResolvedValue({
      data: { user: { id: "11111111-1111-1111-1111-111111111111", email: "sam@example.com", email_confirmed_at: "2026-10-01T00:00:00Z" } },
      error: null,
    });
    expect(await signIn()).toBe("/sell/dashboard");
    const links = await (await db())`select seller_external_id, store_name from seller_users`;
    expect(links).toEqual([{ seller_external_id: "seller_sam", store_name: "Sam Sounds" }]);
    expect(fakeWhop.accounts.create).not.toHaveBeenCalled();
  });

  it("refuses a Whop account without a verified email", async () => {
    userinfo.email_verified = false;
    expect(await signIn()).toBe("/sell/login?error=whop_email");
    expect(supa.createUser).not.toHaveBeenCalled();
  });

  it("rejects a callback whose state doesn't match", async () => {
    expect(await signIn({ state: "forged" })).toBe("/sell/login?error=link");
    expect(oauth).not.toHaveBeenCalled();
  });
});
