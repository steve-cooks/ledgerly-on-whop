// Part 1 · Step 2: read the onboarded seller back and diff against the pre-onboarding snapshot.
//   pnpm tsx scripts/part1/02-onboarding-diff.ts seller_us_mira
import "../_setup";
import { readFileSync } from "node:fs";
import { whop } from "@/lib/whop";
import { saveEvidence } from "../_evidence";
import { SELLERS } from "../sellers";

const FIELDS = ["verification", "required_actions", "capabilities"] as const;

async function main() {
  const seller = SELLERS.find((s) => s.externalId === process.argv[2]) ?? SELLERS[0];
  const before = JSON.parse(readFileSync(`evidence/01-accounts/${seller.externalId}.json`, "utf8"));
  const accountId: string = before.id;
  const after = await whop().accounts.retrieve({ id: accountId });

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const f of FIELDS) {
    const b = before[f];
    const a = (after as Record<string, unknown>)[f];
    if (f === "capabilities") {
      for (const k of Object.keys(a as object)) {
        const bv = (b as Record<string, string>)[k];
        const av = (a as Record<string, string>)[k];
        if (bv !== av) changes[`capabilities.${k}`] = { before: bv, after: av };
      }
    } else if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes[f] = { before: b, after: a };
    }
  }

  saveEvidence(`02-onboarding/${seller.externalId}-after`, after);
  saveEvidence(`02-onboarding/${seller.externalId}-diff`, { accountId, changes });
  console.log(JSON.stringify(changes, null, 2));
}

main();
