import type { Metadata } from "next";
import { AuthPage } from "../auth-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Log in" };

export default async function LogInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  return <AuthPage mode="login" error={(await searchParams).error} />;
}
