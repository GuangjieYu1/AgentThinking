import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BenchmarkRunResult } from "@agent-thinking/contracts";
import { getConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { BenchmarkService } from "../src/services/benchmarks.js";

const temporaryDirectories: string[] = [];

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-benchmarks-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function benchmarkConfig(dataDir: string) {
  return getConfig({ dataDir, benchmarkDir: join(dataDir, "runtime", "benchmarks") });
}

function fixtureRun(benchmarkDir: string, runId = "2026-06-11-test"): BenchmarkRunResult {
  const runPath = join(benchmarkDir, `${runId}.json`);
  return {
    id: runId,
    path: runPath,
    createdAt: "2026-06-11T00:00:00.000Z",
    label: "AORI demand 回归",
    libraryId: "library-benchmark",
    methodology: {
      benchmarkTarget: "AORI pulse answering over a library that has already been indexed into aspect-oriented reflective facets.",
      benchmarkAssumption: "These scores evaluate retrieval and answering after AORI facet indexing is available for the target knowledge base.",
      caveat: "This report does not measure the weaker baseline of answering directly from raw source documents without AORI indexing; direct raw-document answering is expected to perform worse.",
    },
    providerMode: "configured",
    providerLabel: "deepseek:deepseek-v4-flash",
    mode: "full",
    iterations: 1,
    requestedSuites: ["ragas"],
    requestedScenarios: ["scenario-1"],
    benchmarkSuites: [{
      suite: "ragas",
      label: "RAGAS",
      kind: "scoring",
      runs: 1,
      strictPassRate: 1,
      structuralPassRate: 1,
      avgAnswerCoverage: 0.9,
      avgCitationRecall: 0.8,
      avgCitationPrecision: 0.7,
      avgGapPrecision: 1,
      avgRagasFaithfulness: 0.85,
      avgRagasAnswerRelevancy: 0.9,
      avgRagasContextPrecision: 0.7,
      avgRagasContextRecall: 0.8,
      avgAresAnswerFaithfulness: 0.88,
      avgAresAnswerRelevance: 0.89,
      avgAresContextRelevance: 0.75,
      avgDurationMs: 1234,
      avgTotalTokens: 456,
    }],
    scenarioSummaries: [{
      scenario: "scenario-1",
      runs: 1,
      strictPassRate: 1,
      structuralPassRate: 1,
      avgAnswerCoverage: 0.9,
      avgCitationRecall: 0.8,
      avgCitationPrecision: 0.7,
      avgGapPrecision: 1,
      avgRagasFaithfulness: 0.85,
      avgRagasAnswerRelevancy: 0.9,
      avgRagasContextPrecision: 0.7,
      avgRagasContextRecall: 0.8,
      avgAresAnswerFaithfulness: 0.88,
      avgAresAnswerRelevance: 0.89,
      avgAresContextRelevance: 0.75,
      avgDurationMs: 1234,
      avgWallClockMs: 1300,
      avgModelCalls: 3,
      avgPromptTokens: 111,
      avgCompletionTokens: 222,
      avgTotalTokens: 333,
      avgPromptCacheHitTokens: 10,
      avgPromptCacheMissTokens: 20,
      latestAnswerMisses: [],
      latestAnswerExcludesViolated: [],
    }],
    overall: {
      runs: 1,
      strictPassRate: 1,
      structuralPassRate: 1,
      avgAnswerCoverage: 0.9,
      avgCitationRecall: 0.8,
      avgCitationPrecision: 0.7,
      avgGapPrecision: 1,
      avgRagasFaithfulness: 0.85,
      avgRagasAnswerRelevancy: 0.9,
      avgRagasContextPrecision: 0.7,
      avgRagasContextRecall: 0.8,
      avgAresAnswerFaithfulness: 0.88,
      avgAresAnswerRelevance: 0.89,
      avgAresContextRelevance: 0.75,
      avgDurationMs: 1234,
      avgWallClockMs: 1300,
      avgTotalTokens: 333,
    },
    records: [{
      scenario: "scenario-1",
      suites: ["ragas"],
      language: "zh",
      iteration: 1,
      sourceItems: [{
        title: "SourceA payment",
        text: "source: SourceA; person: Alice; time: 2005; evidence: Alice paid Huang in 2005.",
      }],
      evidenceTrace: {
        citationChunkIds: ["chunk-1"],
        selectedChunkIds: ["chunk-1"],
        evidenceRecordChunkIds: ["chunk-1"],
        citations: [{
          chunkId: "chunk-1",
          treeNodeId: null,
          quote: "Alice paid Huang in 2005.",
          headingPath: "SourceA payment",
          pageNumber: null,
        }],
        evidenceRecords: [{
          recordName: "answer_record",
          evidenceChunkIds: ["chunk-1"],
          fields: [{
            fieldName: "answer",
            value: "关键点 A",
            chunkId: "chunk-1",
            evidenceChunkIds: ["chunk-1"],
            quote: "Alice paid Huang in 2005.",
          }],
        }],
      },
      question: "这个问题是否回答完整？",
      testsetAnswers: ["关键点 A"],
      expectedAnswerIncludes: ["关键点 A"],
      expectedAnswerExcludes: [],
      actualAnswer: "回答内容",
      actualSummary: "摘要内容",
      answerReview: {
        verdict: "partial",
        summary: "实际答案覆盖了核心判断，但没有把 benchmark 预期锚点写得足够显式。",
        expectedAnswerSummary: "预期答案应明确给出关键点 A，并说明对应原文依据。",
        actualAnswerSummary: "实际答案给出了一般性结论。",
        matchedExpected: [],
        missingExpected: ["关键点 A"],
        unexpectedAnswerPoints: [],
        differences: [{
          aspect: "关键点表达",
          expected: "关键点 A",
          actual: "回答内容",
          impact: "会导致 benchmark 覆盖率下降。",
        }],
        sourceComparisons: [{
          sourceTitle: "SourceA payment",
          sourceTextExcerpt: "source: SourceA; person: Alice; time: 2005; evidence: Alice paid Huang in 2005.",
          expectedRole: "included",
          actualRole: "not_mentioned",
          note: "原文支持的关键来源没有在实际答案中被显式点出。",
        }],
        improvementActions: ["把关键点 A 及其对应原文来源直接写进最终答案。"],
      },
      strictPass: true,
      structuralPass: true,
      answerCoverage: 0.9,
      answerMisses: [],
      answerExcludesViolated: [],
      citationRecall: 0.8,
      citationPrecision: 0.7,
      gapPrecision: 1,
      ragasFaithfulness: 0.85,
      ragasAnswerRelevancy: 0.9,
      ragasContextPrecision: 0.7,
      ragasContextRecall: 0.8,
      aresAnswerFaithfulness: 0.88,
      aresAnswerRelevance: 0.89,
      aresContextRelevance: 0.75,
      durationMs: 1234,
      wallClockMs: 1300,
      modelCalls: 3,
      promptTokens: 111,
      completionTokens: 222,
      totalTokens: 333,
      promptCacheHitTokens: 10,
      promptCacheMissTokens: 20,
    }],
  };
}

describe("BenchmarkService", () => {
  it("exports compact readable Chinese markdown", async () => {
    const dataDir = await temporaryDir();
    const config = benchmarkConfig(dataDir);
    const service = new BenchmarkService(config);
    const run = fixtureRun(config.benchmarkDir);

    await mkdir(config.benchmarkDir, { recursive: true });
    await writeFile(run.path, JSON.stringify(run, null, 2), "utf8");

    const markdown = await service.exportMarkdown(run.id);
    expect(markdown).toContain("# Benchmark 报告");
    expect(markdown).toContain("## 运行方式");
    expect(markdown).toContain("## 场景摘要");
    expect(markdown).toContain("| 场景 | 类型 | Strict | Coverage | 测试集答案 | AORI 回答 | 未命中 | 证据 Chunk |");
    expect(markdown).toContain("关联评测知识库：library-benchmark");
    expect(markdown).toContain("问题数：1（多跳 0）");
    expect(markdown).toContain("脉冲输入：仅 `question` 字段");
    expect(markdown).toContain("测试集中的 `evidence` / `question_id` / `source_url`");
    expect(markdown).toContain("25 个原始问题");
    expect(markdown).not.toContain("100 个公开语料派生问题");
    expect(markdown).not.toContain("`answer_value` / `evidence` / `question_id` / `source_url`");
    expect(markdown).not.toContain("## Methodology");
    expect(markdown).not.toContain("AORI pulse answering over a library");
    expect(markdown).not.toContain("#### 知识库原文");
  });

  it("deletes a benchmark knowledge base and removes the run library pointer", async () => {
    const dataDir = await temporaryDir();
    const db = new AgentDatabase(dataDir);
    const config = benchmarkConfig(dataDir);
    const service = new BenchmarkService(config, db);
    const library = db.createLibrary("Benchmark delete me");
    const run = { ...fixtureRun(config.benchmarkDir), libraryId: library.id };

    try {
      await mkdir(config.benchmarkDir, { recursive: true });
      await writeFile(run.path, JSON.stringify(run, null, 2), "utf8");

      const deleted = await service.deleteRunKnowledgeBase(run.id);
      expect(deleted.libraryId).toBe(library.id);
      expect(deleted.deleted).toBe(true);
      expect(db.getLibrary(library.id)).toBeUndefined();
      expect((await service.getRun(run.id))?.libraryId).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
