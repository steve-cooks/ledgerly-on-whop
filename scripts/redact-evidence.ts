// Re-apply redaction to every evidence file (run after tightening redact()).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./_evidence";

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
for (const f of walk("evidence").filter((f) => f.endsWith(".json"))) {
  writeFileSync(f, JSON.stringify(redact(JSON.parse(readFileSync(f, "utf8"))), null, 2) + "\n");
}
