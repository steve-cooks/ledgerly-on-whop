import { signOut } from "@/lib/seller-session";
import { supabaseAuthEnabled, supabaseServer } from "@/lib/supabase/server";

/** Marketplace sign out (a POST from the header, so other sites can't trigger it). */
export async function POST(req: Request) {
  if (supabaseAuthEnabled()) await (await supabaseServer()).auth.signOut();
  await signOut();
  return Response.redirect(new URL("/shop", req.url), 303);
}
