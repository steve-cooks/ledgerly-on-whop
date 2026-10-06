import { describe, expect, it } from "vitest";
import { computeSellerShare, platformFee } from "@/lib/checkout";

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

describe("computeSellerShare (transfer flow, parity with direct charges)", () => {
  // Real fee lines from evidence/03-direct-charge/after-payment.json ($10 direct charge).
  const directFees = [
    { origin: "application_fee", amount: { amount: "0.80" } },
    { origin: "payment_processing_fixed_fee", amount: { amount: "0.30" } },
    { origin: "payment_processing_percentage_fee", amount: { amount: "0.27" } },
    { origin: "orchestration_percentage_fee", amount: { amount: "0.08" } },
    { origin: "stripe_radar_fee", amount: { amount: "0.07" } },
  ];
  // Real fee lines from evidence/03-transfer/after-payment.json ($10 + $0.83 tax, Ledgerly is MoR).
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
