import { describe, expect, it } from "vitest";
import { parseCsv, parseSellersCsv, toCsv } from "@/lib/import-sellers";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
});

describe("parseSellersCsv", () => {
  const csv = [
    "external_id,email,country,title,collection_mode",
    "s1,a@example.com,us,Shop One,",
    "s2,not-an-email,US,Shop Two,direct",
    "s3,c@example.com,USA,Shop Three,direct",
    "s1,d@example.com,US,Dupe,direct",
    "s4,e@example.com,BR,Shop Four,platform",
  ].join("\n");

  it("validates every row up front and keeps line numbers", () => {
    const rows = parseSellersCsv(csv);
    expect(rows.map((r) => [r.line, r.input?.externalId ?? null, r.error ? "error" : "ok"])).toEqual([
      [2, "s1", "ok"],
      [3, null, "error"],
      [4, null, "error"],
      [5, null, "error"],
      [6, "s4", "ok"],
    ]);
    expect(rows[0].input).toMatchObject({ country: "US", collectionMode: "direct" }); // normalized + defaulted
    expect(rows[3].error).toMatch(/duplicate external_id s1/);
  });

  it("refuses a file without the required columns", () => {
    expect(() => parseSellersCsv("id,email\n1,a@b.co")).toThrow(/external_id/);
  });

  it("writes a results CSV that round-trips", () => {
    const out = toCsv([{ line: 2, external_id: "s1", status: "error", error: 'bad "email", sorry' }]);
    expect(parseCsv(out)[1]).toEqual(["2", "s1", "error", "", "", "", 'bad "email", sorry']);
  });
});
