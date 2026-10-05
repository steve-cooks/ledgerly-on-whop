// Prints a fresh onboarding link for an existing seller (idempotent: never creates twice).
//   pnpm tsx scripts/onboarding-link.ts seller_us_mira
import "./_setup";
import { onboardSeller } from "@/lib/onboarding";
import { sql } from "@/lib/db";
import { SELLERS } from "./sellers";

const seller = SELLERS.find((s) => s.externalId === process.argv[2]);
if (!seller) throw new Error(`unknown seller ${process.argv[2]}`);
onboardSeller(seller)
  .then((r) => console.log(`${r.externalId} ${r.accountId}\n${r.onboardingUrl}\nexpires ${r.expiresAt}`))
  .finally(() => sql().end());
