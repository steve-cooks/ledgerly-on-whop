import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createCheckout } from "./checkout";
import { sql } from "./db";
import { BUCKET, MAX_FILE_BYTES, parsePrice, productSku, safeFileName } from "./product-rules";
import { supabaseAdmin } from "./supabase/server";

/**
 * The marketplace's catalog: what sellers list and buyers buy. Files live in the private
 * Supabase Storage bucket `deliverables`; buyers only ever get a short-lived signed URL, and only for
 * a paid order. Payment itself is Whop's checkout (createCheckout).
 */
const DOWNLOAD_TTL_S = 60;

const priceField = z.string().transform((v, ctx) => {
  try {
    return parsePrice(v);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: (err as Error).message });
    return z.NEVER;
  }
});

export const ProductInput = z.object({
  title: z.string().trim().min(2, "Title must be at least 2 characters").max(100, "Title can be at most 100 characters"),
  description: z.string().trim().max(2000, "Description can be at most 2,000 characters").default(""),
  price: priceField,
  fileName: z.string().min(1, "Choose a file"),
  fileSize: z.coerce.number().int().positive("Choose a file").max(MAX_FILE_BYTES, "Files can be at most 10 MB"),
});
export type ProductInput = z.input<typeof ProductInput>;

const filePath = (seller: string, productId: string, fileName: string) => `${seller}/${productId}/${safeFileName(fileName)}`;

/** Step 1 of adding a product: validate it and get a one-time upload URL for its file. */
export async function prepareProductUpload(sellerExternalId: string, raw: ProductInput) {
  ProductInput.parse(raw);
  const productId = randomUUID();
  const path = filePath(sellerExternalId, productId, raw.fileName);
  const { data, error } = await supabaseAdmin().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw new Error(`Couldn't start the upload: ${error.message}`);
  return { productId, path, token: data.token };
}

/** Step 2, after the browser uploaded the file: check it's there and list the product. */
export async function createProduct(sellerExternalId: string, productId: string, raw: ProductInput) {
  const input = ProductInput.parse(raw);
  if (!z.uuid().safeParse(productId).success) throw new Error("Invalid product");
  const path = filePath(sellerExternalId, productId, input.fileName);
  const storage = supabaseAdmin().storage.from(BUCKET);
  const { data: info, error } = await storage.info(path);
  if (error || !info) throw new Error("The file didn't finish uploading. Please try again.");
  if ((info.size ?? 0) > MAX_FILE_BYTES) {
    await storage.remove([path]);
    throw new Error("Files can be at most 10 MB");
  }
  const [product] = await sql()`
    insert into products (id, seller_external_id, title, description, price, sku, file_path, file_name)
    values (${productId}, ${sellerExternalId}, ${input.title}, ${input.description || null}, ${input.price},
            ${productSku(input.title, productId)}, ${path}, ${safeFileName(input.fileName)})
    on conflict (id) do nothing
    returning id`;
  return { productId: (product?.id as string) ?? productId };
}

export async function setProductActive(sellerExternalId: string, productId: string, active: boolean) {
  if (!z.uuid().safeParse(productId).success) return;
  await sql()`
    update products set active = ${active}, updated_at = now()
    where id = ${productId} and seller_external_id = ${sellerExternalId}`;
}

export type SellerProduct = { id: string; title: string; price: number; active: boolean; sales: number; fileName: string | null };

export async function sellerProducts(sellerExternalId: string): Promise<SellerProduct[]> {
  const rows = await sql()`
    select p.id, p.title, p.price, p.active, p.file_name,
           (select count(*) from orders o where o.product_id = p.id and o.status in ('paid', 'partially_refunded'))::int as sales
    from products p where p.seller_external_id = ${sellerExternalId}
    order by p.created_at desc`;
  return rows.map((r) => ({ id: r.id, title: r.title, price: Number(r.price), active: r.active, sales: r.sales, fileName: r.file_name }));
}

export type ShopProduct = { id: string; title: string; description: string | null; price: number; storeName: string; sellerExternalId: string };

/** Active products, with a file, from sellers who can take payments. */
export async function shopProducts(productId?: string): Promise<ShopProduct[]> {
  const db = sql();
  const rows = await db`
    select p.id, p.title, p.description, p.price, p.seller_external_id,
           coalesce(su.store_name, p.seller_external_id) as store_name
    from products p
    join sellers s on s.external_id = p.seller_external_id
    left join seller_users su on su.seller_external_id = p.seller_external_id
    where p.active and p.file_path is not null and s.whop_account_id is not null
      ${productId ? db`and p.id = ${productId}` : db``}
    order by p.created_at desc
    limit 120`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    price: Number(r.price),
    storeName: r.store_name,
    sellerExternalId: r.seller_external_id,
  }));
}

export async function shopProduct(productId: string) {
  if (!z.uuid().safeParse(productId).success) return null;
  return (await shopProducts(productId))[0] ?? null;
}

/**
 * Start a purchase: a Whop checkout for the product, with the order linked to it. The request
 * key comes from the product page, so a double-clicked "Buy" opens one order, not two.
 * Returns where to send the buyer.
 */
export async function buyProduct(productId: string, nonce: string, buyerId: string) {
  const product = await shopProduct(productId);
  if (!product) return null;
  const [{ sku }] = await sql()`select sku from products where id = ${product.id}`;
  const order = await createCheckout({
    sellerExternalId: product.sellerExternalId,
    title: product.title,
    sku,
    price: product.price,
    productId: product.id,
    // Bound to this browser's buyer id, so nobody else's browser can reuse the page's nonce
    // to reach this buyer's order.
    requestKey: /^[A-Za-z0-9-]{8,64}$/.test(nonce) && /^[A-Za-z0-9_-]{16,64}$/.test(buyerId) ? `shop:${product.id}:${buyerId}:${nonce}` : undefined,
  });
  const [{ status }] = await sql()`select status from orders where id = ${order.orderId}`;
  // The same key after the buyer already paid: show the order instead of a second checkout.
  return status === "pending" && order.purchaseUrl ? order.purchaseUrl : `/orders/${order.orderId}`;
}

/** Can this order's file be downloaded? Mirrors the API's `deliverable` (status = 'paid'). */
export async function orderDownload(orderId: string) {
  if (!z.uuid().safeParse(orderId).success) return null;
  const [o] = await sql()`
    select o.status, p.file_path, p.file_name
    from orders o join products p on p.id = o.product_id
    where o.id = ${orderId}`;
  if (!o?.file_path) return null;
  return { deliverable: o.status === "paid", path: o.file_path as string, fileName: o.file_name as string };
}

/** A short-lived signed link to a paid order's file, or null if it isn't downloadable. */
export async function downloadUrl(orderId: string) {
  const d = await orderDownload(orderId);
  if (!d?.deliverable) return null;
  const { data, error } = await supabaseAdmin()
    .storage.from(BUCKET)
    .createSignedUrl(d.path, DOWNLOAD_TTL_S, { download: d.fileName });
  if (error || !data) throw new Error(`couldn't sign the download: ${error?.message ?? "no url"}`);
  return data.signedUrl;
}
