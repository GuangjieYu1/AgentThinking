import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function productionFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob("apps/server/src/services/**/*.ts")) files.push(file);
  for await (const file of glob("packages/**/*.ts")) files.push(file);
  return files;
}

describe("guard: no production specific parser", () => {
  it("does not keep document/company-specific parsers in production paths", async () => {
    const forbidden = [
      "extractRealText",
      "extractCsair",
      "extractSouthAir",
      "parseSpecificReport",
      "SpecificReport",
      "specificReport",
      "中国南方航空",
      "南航集团",
      "南航年报",
      "24南航集",
      "22南航集",
    ];
    const offenders: string[] = [];

    for (const file of await productionFiles()) {
      const text = await readFile(file, "utf8");
      for (const term of forbidden) {
        if (text.includes(term)) offenders.push(`${file}: contains ${term}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
