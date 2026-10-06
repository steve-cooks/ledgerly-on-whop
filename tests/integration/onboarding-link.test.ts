import { describe, expect, it, vi } from "vitest";
import { fakeWhop, seed } from "./helpers";

const session = vi.hoisted(() => ({ seller: null as string | null }));
vi.mock("@/lib/seller-session", () => ({ currentSeller: async () => session.seller }));

const call = async () => {
  const { GET } = await import("@/app/api/sellers/[externalId]/onboarding-link/route");
  return GET(new Request("https://ledgerly.test"), { params: Promise.resolve({ externalId: "seller_us" }) });
};

describe("seller's 'get a new link' button", () => {
  it("sends the signed-in seller to a fresh Whop onboarding link, without creating an account", async () => {
    await seed();
    session.seller = "seller_us";
    fakeWhop.accountLinks.create.mockResolvedValue({ url: "https://whop.com/onboarding/fresh", expires_at: null });
    // next/navigation's redirect() throws a redirect signal carrying the target.
    await expect(call()).rejects.toMatchObject({ digest: expect.stringContaining("https://whop.com/onboarding/fresh") });
    expect(fakeWhop.accountLinks.create).toHaveBeenCalledWith(expect.objectContaining({ account_id: "biz_seller_us", use_case: "account_onboarding" }));
    expect(fakeWhop.accounts.create).not.toHaveBeenCalled();
  });

  it("refuses anyone who isn't that seller", async () => {
    await seed();
    session.seller = "someone_else";
    expect((await call()).status).toBe(403);
    expect(fakeWhop.accountLinks.create).not.toHaveBeenCalled();
  });
});
