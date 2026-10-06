import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell, MarketHeader } from "@/components/market";
import { COUNTRY_NAMES, Page } from "@/components/ui";
import { authUser, sellerForUser } from "@/lib/seller-accounts";
import { OpenStoreForm } from "./open-store-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Open your store" };

export default async function OnboardPage() {
  const user = await authUser();
  if (!user) redirect("/sell/login");
  if (await sellerForUser(user.id)) redirect("/sell/dashboard");

  return (
    <>
      <MarketHeader />
      <Page>
        <div className="py-4 sm:py-10">
          <AuthShell
            title="Open your store"
            subtitle="Next, Whop (our payments partner) will verify your identity so you can get paid."
          >
            <OpenStoreForm countries={COUNTRY_NAMES} email={user.email} />
          </AuthShell>
        </div>
      </Page>
    </>
  );
}
