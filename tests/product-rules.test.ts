import { describe, expect, it } from "vitest";
import { parsePrice, productSku, safeFileName } from "@/lib/product-rules";

const ID = "3f9a1c2e-7b4d-4c1a-9e2f-0a1b2c3d4e5f";
const SKU = /^[a-z0-9-]{3,80}$/; // what createCheckout accepts

describe("productSku", () => {
  it("slugs the title and appends the product id, so it's stable and unique", () => {
    expect(productSku("Golden Hour — Lightroom Presets (v2)", ID)).toBe("golden-hour-lightroom-presets-v2-3f9a1c2e");
  });

  it("is always a valid checkout SKU, even for odd titles", () => {
    for (const title of ["🎧🎧", "Ünïcödé Pàck", "x".repeat(200), "  --  ", "A"]) {
      const sku = productSku(title, ID);
      expect(sku).toMatch(SKU);
      expect(sku.endsWith("-3f9a1c2e")).toBe(true);
    }
    expect(productSku("🎧", ID)).toBe("product-3f9a1c2e");
  });
});

describe("parsePrice", () => {
  it("accepts whole dollars and up to two decimals", () => {
    expect(parsePrice("12")).toBe(12);
    expect(parsePrice("12.5")).toBe(12.5);
    expect(parsePrice(" $0012.99 ")).toBe(12.99);
    expect(parsePrice("1")).toBe(1);
    expect(parsePrice("10000.00")).toBe(10000);
  });

  it("rejects fractions of a cent, junk and out-of-range prices", () => {
    for (const bad of ["12.999", "abc", "", "-5", "1e3", "0.99", "10000.01", "12,50"]) {
      expect(() => parsePrice(bad), bad).toThrow();
    }
  });
});

describe("safeFileName", () => {
  it("keeps a readable name and extension, drops paths and unsafe characters", () => {
    expect(safeFileName("Golden Hour Presets.zip")).toBe("Golden-Hour-Presets.zip");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\pack (final).zip")).toBe("pack-final.zip");
    expect(safeFileName("...")).toBe("download");
    expect(safeFileName("a".repeat(300) + ".wav")).toHaveLength(100);
    expect(safeFileName("a".repeat(300) + ".wav").endsWith(".wav")).toBe(true);
  });
});
