import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("guard: no unbounded fallback", () => {
  it("keeps demand fallback bounded by model, token, source, and evidence budgets", async () => {
    const demandAnswer = await readFile("apps/server/src/services/aori-demand-answer.ts", "utf8");
    const pulse = await readFile("apps/server/src/services/pulse.ts", "utf8");

    expect(demandAnswer).toContain("defaultDemandFallbackBudget");
    for (const key of ["maxModelCalls", "maxTotalTokens", "maxSourceItems", "maxEvidenceRecords"]) {
      expect(demandAnswer).toContain(key);
    }
    expect(demandAnswer).toContain("fallbackBudget");
    expect(pulse).toContain("defaultDemandFallbackBudget");
  });
});
