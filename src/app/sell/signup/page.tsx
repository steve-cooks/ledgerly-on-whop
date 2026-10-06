import type { Metadata } from "next";
import { AuthPage } from "../auth-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign up to sell" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  return <AuthPage mode="signup" error={(await searchParams).error} />;
}
