import { describe, expect, it, vi } from "vitest";
import { computeSellerShare, platformFee, sellerFeeBps } from "@/lib/checkout";
import { parseFeePercent } from "@/lib/operator";

// Minimal env for the platform default (PLATFORM_FEE_BPS unset → 800).
vi.stubEnv("WHOP_PLATFORM_ACCOUNT_ID", "biz_test");
vi.stubEnv("DATABASE_URL", "postgres://localhost/unused");

describe("platformFee (Ledgerly's 8%)", () => {
  it("is exact in cents", () => {
    expect(platformFee(10, 800)).toEqual({ price: 10, fee: 0.8, sellerGross: 9.2 });
    expect(platformFee(25, 800)).toEqual({ price: 25, fee: 2, sellerGross: 23 }); // the brief's example
    expect(platformFee(0.1 + 0.2, 800).fee).toBe(0.02); // no float drift: 0.30000000000000004
  });

  it("rounds half-cents to the nearest cent", () => {
    expect(platformFee(9.99, 800).fee).toBe(0.8); // 79.92c -> 80c
    expect(platformFee(1.06, 800).fee).toBe(0.08); // 8.48c -> 8c
  });

  it("rejects prices with more than 2 decimals", () => {
    expect(() => platformFee(10.005, 800)).toThrow(/2 decimals/);
  });

  it("rejects a fee that rounds to zero or eats the whole price", () => {
    expect(() => platformFee(0.05, 800)).toThrow(/rounds to zero/);
    expect(() => platformFee(1, 10_000)).toThrow(/less than the price/);
  });
});

describe("per-seller fee", () => {
  it("defaults to the platform's 8% when the seller has no rate", () => {
    expect(sellerFeeBps({ fee_bps: null })).toBe(800);
    expect(sellerFeeBps({})).toBe(800);
    expect(platformFee(10)).toEqual({ price: 10, fee: 0.8, sellerGross: 9.2 });
  });

  it("uses the seller's own rate, 0% included", () => {
    expect(sellerFeeBps({ fee_bps: 1000 })).toBe(1000);
    expect(sellerFeeBps({ fee_bps: 0 })).toBe(0);
    expect(platformFee(10, 1000)).toEqual({ price: 10, fee: 1, sellerGross: 9 });
    expect(platformFee(0.05, 0)).toEqual({ price: 0.05, fee: 0, sellerGross: 0.05 });
    expect(platformFee(10, 5000)).toEqual({ price: 10, fee: 5, sellerGross: 5 });
  });

  it("rounds custom rates to the nearest cent", () => {
    expect(platformFee(9.99, 750).fee).toBe(0.75); // 74.925c -> 75c
    expect(platformFee(1.01, 1250).fee).toBe(0.13); // 12.625c -> 13c
    expect(platformFee(3.33, 333).fee).toBe(0.11); // 11.0889c -> 11c
  });

  it("still refuses a non-zero rate that rounds to nothing, and a fractional bps", () => {
    expect(() => platformFee(1, 1)).toThrow(/rounds to zero/);
    expect(() => platformFee(10, 7.5)).toThrow(/basis points/);
  });
});

describe("parseFeePercent (operator input)", () => {
  it("reads percentages with up to 2 decimals as basis points, without float drift", () => {
    expect(parseFeePercent("10")).toEqual({ ok: true, bps: 1000 });
    expect(parseFeePercent(" 7.5% ")).toEqual({ ok: true, bps: 750 });
    expect(parseFeePercent("8.25")).toEqual({ ok: true, bps: 825 });
    expect(parseFeePercent("0.29")).toEqual({ ok: true, bps: 29 });
    expect(parseFeePercent("0")).toEqual({ ok: true, bps: 0 });
    expect(parseFeePercent("50")).toEqual({ ok: true, bps: 5000 });
  });

  it("treats empty or 'default' as the platform default", () => {
    expect(parseFeePercent("")).toEqual({ ok: true, bps: null });
    expect(parseFeePercent(null)).toEqual({ ok: true, bps: null });
    expect(parseFeePercent("Default")).toEqual({ ok: true, bps: null });
  });

  it("refuses anything else", () => {
    for (const bad of ["60", "50.01", "abc", "-1", "8.255", "1e1", "100", ".5", "8,5"]) {
      expect(parseFeePercent(bad)).toEqual({ ok: false });
    }
  });
});

describe("computeSellerShare (transfer flow, parity with direct charges)", () => {
  // Real fee lines from examples/assessment/evidence/03-direct-charge/after-payment.json ($10 direct charge).
  const directFees = [
    { origin: "application_fee", amount: { amount: "0.80" } },
    { origin: "payment_processing_fixed_fee", amount: { amount: "0.30" } },
    { origin: "payment_processing_percentage_fee", amount: { amount: "0.27" } },
    { origin: "orchestration_percentage_fee", amount: { amount: "0.08" } },
    { origin: "stripe_radar_fee", amount: { amount: "0.07" } },
  ];
  // Real fee lines from examples/assessment/evidence/03-transfer/after-payment.json ($10 + $0.83 tax, Ledgerly is MoR).
  const platformFees = [
    { origin: "sales_tax_remittance", amount: { amount: "0.83" } },
    { origin: "payment_processing_fixed_fee", amount: { amount: "0.30" } },
    { origin: "payment_processing_percentage_fee", amount: { amount: "0.29" } },
    { origin: "stripe_sales_tax_fee", amount: { amount: "0.22" } },
    { origin: "orchestration_percentage_fee", amount: { amount: "0.09" } },
    { origin: "stripe_radar_fee", amount: { amount: "0.07" } },
  ];

  it("matches what a direct-charge seller nets ($8.48 on $10)", () => {
    expect(computeSellerShare(directFees, 10, 0.8)).toEqual({ share: 8.48, sellerFees: 0.72 });
  });

  it("excludes sales tax and the tax-service fee (the bug that underpaid Batida)", () => {
    expect(computeSellerShare(platformFees, 10, 0.8)).toEqual({ share: 8.45, sellerFees: 0.75 });
  });
});
