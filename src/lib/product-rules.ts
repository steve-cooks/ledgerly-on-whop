// Pure product rules, shared by the server and the browser (no database or secrets here).

export const BUCKET = "deliverables";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A stable checkout SKU: the title as a slug plus the product's id, e.g. "lut-pack-3f9a1c2e". */
export function productSku(title: string, productId: string) {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "product"}-${productId.replace(/-/g, "").slice(0, 8)}`;
}

/** "12", "12.5" or "12.50" → 12.5. Whole cents only, $1 to $10,000 (Whop's minimum, our ceiling). */
export function parsePrice(input: string) {
  const s = input.trim().replace(/^\$/, "");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) throw new Error("Enter a price like 12 or 12.99");
  const cents = Math.round(Number(s) * 100);
  if (cents < 100 || cents > 1_000_000) throw new Error("Price must be between $1 and $10,000");
  return cents / 100;
}

/** A storage-safe file name that still reads like the original. */
export function safeFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+\./g, ".")
    .replace(/^[-.]+/, "");
  return clean.slice(-100) || "download";
}
