import { afterEach, describe, expect, it } from "vitest";
import { cleanupEvalDatabases } from "./helpers/aori-pulse-eval-fixtures.js";
import { runBenchmarkSuite } from "../src/services/benchmark-runner.js";

afterEach(async () => {
  await cleanupEvalDatabases();
});

describe("runBenchmarkSuite", () => {
  it("records source items and answer review details for each scenario run", async () => {
    const result = await runBenchmarkSuite({
      iterations: 1,
      provider: "fake",
      mode: "full",
      scenarioNames: ["count-list"],
      suites: [],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sourceItems?.length).toBeGreaterThan(0);
    expect(result.records[0]?.answerReview).toBeTruthy();
    expect(result.records[0]?.answerReview?.sourceComparisons.length).toBeGreaterThan(0);
    expect(result.records[0]?.answerReview?.expectedAnswerSummary).toBeTruthy();
  });
});
