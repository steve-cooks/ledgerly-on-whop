import { beforeAll, describe, expect, it, vi } from "vitest";

// Demo sign-in tokens. env() is read lazily, so set it before the first call.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined), set: (k: string, v: string) => jar.set(k, v) }),
}));

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgres://x@localhost/x",
    WHOP_PLATFORM_ACCOUNT_ID: "biz_platform",
    DEMO_LOGIN_ENABLED: "true",
    SESSION_SECRET: "s".repeat(32),
  });
});

describe("demo sign-in tokens", async () => {
  const { signToken, verifyToken, startSession, currentSeller, isOperator } = await import("@/lib/seller-session");

  it("a link starts a session for its subject", async () => {
    expect(await startSession(signToken("seller_us"))).toBe("seller_us");
    expect(await currentSeller()).toBe("seller_us");
    expect(await isOperator()).toBe(false);
  });

  it("a link can't be used as a session, and a session can't start a new one", async () => {
    const link = signToken("seller_us");
    expect(verifyToken(link, "session")).toBeNull();
    const session = signToken("seller_us", "session");
    expect(verifyToken(session, "session")).toBe("seller_us");
    expect(await startSession(session)).toBeNull();
  });

  it("rejects tampered and expired tokens", () => {
    const [payload, sig] = signToken("seller_us").split(".");
    const forged = Buffer.from(JSON.stringify({ p: "link", s: "operator", e: 9e9 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, "link")).toBeNull();
    expect(verifyToken(`${payload}.${sig}x`, "link")).toBeNull();
    vi.useFakeTimers();
    const old = signToken("seller_us");
    vi.setSystemTime(Date.now() + 25 * 3600_000);
    expect(verifyToken(old, "link")).toBeNull();
    vi.useRealTimers();
  });
});
