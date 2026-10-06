import { signOut } from "@/lib/seller-session";

/** Sign out of this site (a POST from the header's form, so other sites can't trigger it). */
export async function POST(req: Request) {
  await signOut();
  return Response.redirect(new URL("/", req.url), 303);
}
