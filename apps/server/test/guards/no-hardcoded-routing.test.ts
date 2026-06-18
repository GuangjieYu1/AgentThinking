import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function productionFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob("apps/server/src/services/**/*.ts")) files.push(file);
  for await (const file of glob("packages/**/*.ts")) files.push(file);
  return files;
}

describe("guard: no hardcoded routing", () => {
  it("keeps production routing generic instead of binding concrete question terms to fixed plans", async () => {
    const files = await productionFiles();
    const offenders: string[] = [];
    const forbiddenTerms = [
      "fixedPlan",
      "specificReport",
      "受限货币资金",
      "解释第17号",
      "南航",
      "CSAIR",
    ];
    const forbiddenRoutingPattern = /(question|normalized|normalizedQuestion)\.includes\(\s*["'`][^"'`]*(南航|受限货币资金|解释第17号|债务融资工具|具体业务词)[^"'`]*["'`]\s*\)/;

    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const term of forbiddenTerms) {
        if (text.includes(term)) offenders.push(`${file}: contains ${term}`);
      }
      if (forbiddenRoutingPattern.test(text)) offenders.push(`${file}: routes on concrete business wording`);
    }

    expect(offenders).toEqual([]);
  });
});
