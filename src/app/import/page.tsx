import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Page, SiteHeader } from "@/components/ui";
import { MAX_CONSOLE_IMPORT_ROWS } from "@/lib/import-csv";
import { whopDashboardUrl } from "@/lib/operator";
import { currentOperator } from "@/lib/seller-session";
import { ImportSellers } from "./import-sellers";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Import sellers" };

/** Operator console: bring Ledgerly's existing sellers onto Whop from a CSV. */
export default async function ImportPage() {
  if (!(await currentOperator())) redirect("/");
  return (
    <>
      <SiteHeader
        section="Operator console"
        right={
          <Link href="/" className="text-sm font-medium text-muted transition hover:text-ink">
            ← <span className="hidden sm:inline">Back to </span>sellers
          </Link>
        }
      />
      <Page>
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Import sellers</h1>
          <p className="mt-2 max-w-2xl text-muted">
            Each seller gets a Whop account under Ledgerly. When they sign in to Ledgerly with this email, their store is waiting and they verify with
            Whop.
          </p>
        </div>
        <ImportSellers whopBase={whopDashboardUrl()} maxRows={MAX_CONSOLE_IMPORT_ROWS} />
      </Page>
    </>
  );
}
