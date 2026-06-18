import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const checkedFiles = [
  "packages/contracts/src/index.ts",
  "apps/server/test/pulse-evidence-controller.test.ts",
];

async function serviceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob("apps/server/src/services/**/*.ts")) files.push(file);
  return files;
}

describe("domain specialization guard", () => {
  it("does not reintroduce forbidden domain-specific planner or fixture terms", async () => {
    const forbidden = [
      "legal_fact_breakdown",
      "bribery",
      "court_declared_total",
      "prosecution_declared_total",
      "returned_or_confiscated",
      "受贿",
      "行贿",
      "判决书",
    ];
    const contents = await Promise.all([...checkedFiles, ...await serviceFiles()].map((file) => readFile(file, "utf8")));
    const combined = contents.join("\n");
    for (const term of forbidden) expect(combined).not.toContain(term);
  });

  it("does not hardcode domain-specific benchmark routing phrases or fake closure heuristics", async () => {
    const forbidden = [
      "南航",
      "CSAIR",
      "受限货币资金",
      "解释第17号",
      "债务融资工具",
      "records.length > 0 ? \"success\" : \"empty\"",
      "records.length > 0 ? 'success' : 'empty'",
    ];
    const contents = await Promise.all((await serviceFiles()).map((file) => readFile(file, "utf8")));
    const combined = contents.join("\n");
    for (const term of forbidden) expect(combined).not.toContain(term);
  });
});
