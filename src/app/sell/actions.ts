"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/lib/env";
import { createProduct, prepareProductUpload, setProductActive, type ProductInput } from "@/lib/products";
import { authUser, openStore, sellerForUser } from "@/lib/seller-accounts";
import { currentSeller } from "@/lib/seller-session";
import { supabaseServer } from "@/lib/supabase/server";

export type FormState = { error?: string; checkEmail?: string } | null;

const Credentials = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters").max(72, "Password can be at most 72 characters"),
});

const firstIssue = (err: z.ZodError) => err.issues[0]?.message ?? "Check the form and try again";

function friendly(message: string) {
  if (/invalid login credentials/i.test(message)) return "That email and password don't match.";
  if (/email not confirmed/i.test(message)) return "Confirm your email first: check your inbox for the link we sent.";
  if (/already registered|already exists/i.test(message)) return "There's already an account with that email. Log in instead.";
  if (/rate limit/i.test(message)) return "Too many attempts. Wait a minute and try again.";
  return message;
}

export async function signUpAction(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = Credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { data, error } = await (await supabaseServer()).auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${env().APP_URL}/auth/callback` },
  });
  if (error) return { error: friendly(error.message) };
  // Email confirmation is on: no session until they click the link.
  if (!data.session) return { checkEmail: parsed.data.email };
  redirect("/sell/onboard");
}

export async function logInAction(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = Credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { data, error } = await (await supabaseServer()).auth.signInWithPassword(parsed.data);
  if (error) return { error: friendly(error.message) };
  redirect((await sellerForUser(data.user.id)) ? "/sell/dashboard" : "/sell/onboard");
}

/** Open the signed-in user's store and send them to Whop to verify their identity. */
export async function openStoreAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await authUser();
  if (!user) redirect("/sell/login");
  let url: string;
  try {
    ({ onboardingUrl: url } = await openStore(user, { storeName: String(form.get("storeName") ?? ""), country: String(form.get("country") ?? "") }));
  } catch (err) {
    if (err instanceof z.ZodError) return { error: firstIssue(err) };
    console.error("open store failed", (err as Error).message);
    return { error: "We couldn't set up your store just now. Please try again." };
  }
  redirect(url);
}

async function requireSeller() {
  const seller = await currentSeller();
  if (!seller) throw new Error("Your session ended. Sign in again.");
  return seller;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof z.ZodError ? firstIssue(err) : (err as Error).message };
  }
}

/** Adding a product, step 1: validate and get a one-time upload URL for the file. */
export async function prepareProductAction(input: ProductInput) {
  return attempt(async () => prepareProductUpload(await requireSeller(), input));
}

/** Step 2, once the browser has uploaded the file: list the product. */
export async function createProductAction(productId: string, input: ProductInput) {
  const result = await attempt(async () => createProduct(await requireSeller(), productId, input));
  if (result.ok) revalidatePath("/sell/dashboard");
  return result;
}

export async function toggleProductAction(form: FormData) {
  const seller = await requireSeller();
  await setProductActive(seller, String(form.get("productId")), form.get("active") === "true");
  revalidatePath("/sell/dashboard");
}
