import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aoriPulseEvalScenarios, cleanupEvalDatabases } from "../../../apps/server/test/helpers/aori-pulse-eval-fixtures.js";
import { AgentDatabase } from "../../../apps/server/src/db.js";
import { benchmarkScenarioCatalog, benchmarkSuiteCatalog, runBenchmarkSuite } from "./benchmark-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await cleanupEvalDatabases();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runBenchmarkSuite", () => {
  it("exposes the 25-question public eval catalog using original dataset questions", () => {
    expect(benchmarkScenarioCatalog()).toHaveLength(25);
    expect(benchmarkScenarioCatalog().some((entry) => entry.name.includes("multihop"))).toBe(false);
    expect(benchmarkSuiteCatalog().map((entry) => entry.suite)).toEqual(["crud_rag", "ragas", "ares"]);
  });

  it("records source items, answer review details, and the eval library id for each scenario run", async () => {
    const scenarioName = aoriPulseEvalScenarios[0]?.name;
    expect(scenarioName).toBeTruthy();
    const result = await runBenchmarkSuite({
      iterations: 1,
      provider: "fake",
      mode: "full",
      scenarioNames: [scenarioName!],
      suites: [],
    });

    expect(result.libraryId).toBeTruthy();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sourceItems?.length).toBeGreaterThan(0);
    expect(result.records[0]?.evidenceTrace?.citationChunkIds.length).toBeGreaterThan(0);
    expect(result.records[0]?.evidenceTrace?.selectedChunkIds.length).toBeGreaterThan(0);
    expect(result.records[0]?.evidenceTrace?.evidenceRecordChunkIds.length).toBeGreaterThan(0);
    expect(result.records[0]?.evidenceTrace?.semanticTrace?.fallbackReason).toBeTruthy();
    expect(result.records[0]?.testsetAnswers?.length).toBeGreaterThan(0);
    expect(result.records[0]?.answerReview).toBeTruthy();
    expect(result.records[0]?.answerReview?.sourceComparisons.length).toBeGreaterThan(0);
    expect(result.records[0]?.answerReview?.expectedAnswerSummary).toBeTruthy();
  });

  it("persists the benchmark eval knowledge base when a database is provided", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agent-thinking-benchmark-db-"));
    temporaryDirectories.push(dataDir);
    const db = new AgentDatabase(dataDir);

    try {
      const scenarioName = aoriPulseEvalScenarios[0]?.name;
      expect(scenarioName).toBeTruthy();
      const result = await runBenchmarkSuite({
        iterations: 1,
        provider: "fake",
        mode: "full",
        scenarioNames: [scenarioName!],
        suites: [],
        db,
        libraryName: "Benchmark persistence test",
      });

      expect(result.libraryId).toBeTruthy();
      const library = db.listLibraries().find((item) => item.name === "Benchmark persistence test");
      expect(library).toBeTruthy();
      expect(library ? db.listDocuments(library.id).length : 0).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
