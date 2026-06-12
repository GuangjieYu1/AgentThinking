import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupEvalDatabases } from "./helpers/aori-pulse-eval-fixtures.js";
import { AgentDatabase } from "../src/db.js";
import { benchmarkScenarioCatalog, benchmarkSuiteCatalog, runBenchmarkSuite } from "../src/services/benchmark-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await cleanupEvalDatabases();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runBenchmarkSuite", () => {
  it("exposes the 100-question public eval catalog including multi-hop scenarios", () => {
    expect(benchmarkScenarioCatalog()).toHaveLength(100);
    expect(benchmarkScenarioCatalog().some((entry) => entry.name.includes("multihop"))).toBe(true);
    expect(benchmarkSuiteCatalog().map((entry) => entry.suite)).toEqual(["crud_rag", "ragas", "ares", "ragbench"]);
  });

  it("records source items, answer review details, and the eval library id for each scenario run", async () => {
    const result = await runBenchmarkSuite({
      iterations: 1,
      provider: "fake",
      mode: "full",
      scenarioNames: ["cmrc2018-dev-29-query-0"],
      suites: [],
    });

    expect(result.libraryId).toBeTruthy();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sourceItems?.length).toBeGreaterThan(0);
    expect(result.records[0]?.evidenceTrace?.citationChunkIds.length).toBeGreaterThan(0);
    expect(result.records[0]?.evidenceTrace?.selectedChunkIds.length).toBeGreaterThan(0);
    expect(result.records[0]?.evidenceTrace?.evidenceRecordChunkIds.length).toBeGreaterThan(0);
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
      const result = await runBenchmarkSuite({
        iterations: 1,
        provider: "fake",
        mode: "full",
        scenarioNames: ["cmrc2018-dev-29-query-0"],
        suites: [],
        db,
        libraryName: "Benchmark persistence test",
      });

      expect(result.libraryId).toBeTruthy();
      const library = db.listLibraries().find((item) => item.name === "Benchmark persistence test");
      expect(library).toBeTruthy();
      expect(library ? db.listDocuments(library.id) : []).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
