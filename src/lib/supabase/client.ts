import { createBrowserClient } from "@supabase/ssr";

/** Supabase in the browser (OAuth redirects, direct file uploads). Session lives in cookies. */
export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Seller sign-in isn't set up yet.");
  return createBrowserClient(url, key);
}
