import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWhop } from "./helpers";

// Operator "Sign in with Whop": the real callback route, with Whop's OAuth endpoints and
// team-member lookup stubbed, and an in-memory cookie jar.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined),
    set: (k: string, v: string) => jar.set(k, v),
    delete: (k: string | { name: string }) => jar.delete(typeof k === "string" ? k : k.name),
  }),
}));

const oauth = vi.fn();
beforeEach(() => {
  jar.clear();
  oauth.mockReset();
  oauth.mockImplementation(async (url: string) => {
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "at", refresh_token: "rt" });
    if (url.endsWith("/oauth/userinfo")) return Response.json({ sub: "user_ops", name: "Ops Person" });
    return new Response(null, { status: 200 }); // revoke
  });
  vi.stubGlobal("fetch", oauth);
});
afterEach(() => vi.unstubAllGlobals());

/** Run start → Whop → callback; returns where the callback redirected. */
async function signIn(opts: { state?: string } = {}) {
  const start = await import("@/app/api/auth/whop/start/route");
  const whopUrl = (await start.GET().catch((e: { digest: string }) => e.digest.split(";")[2])) as string;
  const state = new URL(whopUrl).searchParams.get("state")!;
  const cb = await import("@/app/api/auth/whop/callback/route");
  const req = new Request(`https://ledgerly.test/api/auth/whop/callback?code=c1&state=${opts.state ?? state}`);
  return cb.GET(req).catch((e: { digest: string }) => e.digest.split(";")[2]);
}

async function operator() {
  const { currentOperator } = await import("@/lib/seller-session");
  return currentOperator();
}

describe("Sign in with Whop (operators)", () => {
  it("sends the browser to Whop with PKCE, and lets a Ledgerly team member in", async () => {
    fakeWhop.teamMembers.list.mockResolvedValue({ data: [{ role: "admin", status: "joined" }] });
    expect(await signIn()).toBe("/");
    expect(await operator()).toEqual({ name: "Ops Person" });
    expect(fakeWhop.teamMembers.list).toHaveBeenCalledWith({ account_id: "biz_platform", user_id: "user_ops", status: "joined" });
    const tokenCall = JSON.parse(oauth.mock.calls.find(([u]) => u.endsWith("/oauth/token"))![1].body);
    expect(tokenCall).toMatchObject({ grant_type: "authorization_code", client_id: "app_test", client_secret: "secret_test", code_verifier: expect.any(String) });
    expect(oauth.mock.calls.some(([u]) => u.endsWith("/oauth/revoke"))).toBe(true); // no long-lived token kept
  });

  it("refuses a Whop user who isn't on Ledgerly's team (or has a role without access)", async () => {
    fakeWhop.teamMembers.list.mockResolvedValue({ data: [{ role: "advertiser", status: "joined" }] });
    expect(await signIn()).toBe("/?signin=not_team");
    expect(await operator()).toBeNull();
  });

  it("rejects a callback whose state doesn't match (forged or from another browser)", async () => {
    expect(await signIn({ state: "forged" })).toBe("/?signin=expired");
    expect(oauth).not.toHaveBeenCalled();
    expect(await operator()).toBeNull();
  });
});
