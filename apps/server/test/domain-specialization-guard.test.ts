import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const checkedFiles = [
  "packages/contracts/src/index.ts",
  "apps/server/src/services/models.ts",
  "apps/server/src/services/pulse-evidence-controller.ts",
  "apps/server/test/pulse-evidence-controller.test.ts",
];

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
    const contents = await Promise.all(checkedFiles.map((file) => readFile(file, "utf8")));
    const combined = contents.join("\n");
    for (const term of forbidden) expect(combined).not.toContain(term);
  });
});
