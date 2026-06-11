import type {
  BenchmarkOverallSummary,
  BenchmarkProviderMode,
  BenchmarkRunRecord,
  BenchmarkScenarioSummary,
  BenchmarkSuite,
  BenchmarkSuiteCatalogEntry,
  BenchmarkSuiteSummary,
  PulseInputMode,
} from "@agent-thinking/contracts";
import { getConfig } from "../config.js";
import { createModelProvider } from "./models.js";
import type { BenchmarkAnswerReviewInput, ModelProvider } from "./models.js";
import {
  aoriPulseBenchmarkSuites,
  aoriPulseEvalScenarios,
  assessEvalScenario,
  cleanupEvalDatabases,
  EvalModelProvider,
  runEvalScenario,
  type EvalScenario,
} from "../../test/helpers/aori-pulse-eval-fixtures.js";

export interface BenchmarkRunnerArgs {
  iterations: number;
  provider: BenchmarkProviderMode;
  mode: PulseInputMode;
  scenarioNames: string[];
  suites: BenchmarkSuite[];
}

export interface BenchmarkRunnerOutput {
  providerLabel: string;
  scenarioSummaries: BenchmarkScenarioSummary[];
  benchmarkSuites: BenchmarkSuiteSummary[];
  overall: BenchmarkOverallSummary;
  records: BenchmarkRunRecord[];
}

export function benchmarkSuiteCatalog(): BenchmarkSuiteCatalogEntry[] {
  return Object.entries(aoriPulseBenchmarkSuites).map(([suite, value]) => ({
    suite: suite as BenchmarkSuite,
    label: value.label,
    kind: value.kind,
    focus: value.focus,
  }));
}

export function benchmarkScenarioCatalog(): Array<{
  name: string;
  benchmarkSuites: BenchmarkSuite[];
  language: "en" | "zh";
  question: string;
}> {
  return aoriPulseEvalScenarios.map((scenario) => ({
    name: scenario.name,
    benchmarkSuites: scenario.benchmarkSuites,
    language: scenario.language,
    question: scenario.question,
  }));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scenarioFilter(names: string[], scenarios: EvalScenario[]): EvalScenario[] {
  if (names.length === 0) return scenarios;
  const wanted = new Set(names);
  return scenarios.filter((scenario) => wanted.has(scenario.name));
}

function suiteFilter(suites: BenchmarkSuite[], scenarios: EvalScenario[]): EvalScenario[] {
  if (suites.length === 0) return scenarios;
  const wanted = new Set(suites);
  return scenarios.filter((scenario) => scenario.benchmarkSuites.some((suite) => wanted.has(suite)));
}

function summarize(records: BenchmarkRunRecord[]): BenchmarkScenarioSummary[] {
  const byScenario = new Map<string, BenchmarkRunRecord[]>();
  for (const record of records) {
    const group = byScenario.get(record.scenario) ?? [];
    group.push(record);
    byScenario.set(record.scenario, group);
  }
  return [...byScenario.entries()].map(([scenario, runs]) => {
    const avg = (pick: (record: BenchmarkRunRecord) => number) => runs.reduce((sum, record) => sum + pick(record), 0) / runs.length;
    const avgOptional = (pick: (record: BenchmarkRunRecord) => number | undefined) => {
      const values = runs.map(pick).filter((value): value is number => value !== undefined && Number.isFinite(value));
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
    };
    return {
      scenario,
      runs: runs.length,
      strictPassRate: avg((record) => record.strictPass ? 1 : 0),
      structuralPassRate: avg((record) => record.structuralPass ? 1 : 0),
      avgAnswerCoverage: avg((record) => record.answerCoverage),
      avgCitationRecall: avg((record) => record.citationRecall),
      avgCitationPrecision: avg((record) => record.citationPrecision),
      avgGapPrecision: avg((record) => record.gapPrecision),
      avgRagasFaithfulness: avg((record) => record.ragasFaithfulness),
      avgRagasAnswerRelevancy: avg((record) => record.ragasAnswerRelevancy),
      avgRagasContextPrecision: avg((record) => record.ragasContextPrecision),
      avgRagasContextRecall: avg((record) => record.ragasContextRecall),
      avgAresAnswerFaithfulness: avg((record) => record.aresAnswerFaithfulness),
      avgAresAnswerRelevance: avg((record) => record.aresAnswerRelevance),
      avgAresContextRelevance: avg((record) => record.aresContextRelevance),
      avgDurationMs: avg((record) => record.durationMs),
      avgWallClockMs: avg((record) => record.wallClockMs),
      avgModelCalls: avg((record) => record.modelCalls),
      avgPromptTokens: avg((record) => record.promptTokens),
      avgCompletionTokens: avg((record) => record.completionTokens),
      avgTotalTokens: avg((record) => record.totalTokens),
      avgPromptCacheHitTokens: avg((record) => record.promptCacheHitTokens),
      avgPromptCacheMissTokens: avg((record) => record.promptCacheMissTokens),
      avgPromptCacheHitRate: avgOptional((record) => record.promptCacheHitRate),
      latestAnswerMisses: runs.at(-1)?.answerMisses ?? [],
      latestAnswerExcludesViolated: runs.at(-1)?.answerExcludesViolated ?? [],
    };
  });
}

function suiteSummaries(records: BenchmarkRunRecord[]): BenchmarkSuiteSummary[] {
  const bySuite = new Map<BenchmarkSuite, BenchmarkRunRecord[]>();
  for (const record of records) {
    for (const suite of record.suites) {
      const group = bySuite.get(suite) ?? [];
      group.push(record);
      bySuite.set(suite, group);
    }
  }
  return [...bySuite.entries()].map(([suite, runs]) => ({
    suite,
    label: aoriPulseBenchmarkSuites[suite].label,
    kind: aoriPulseBenchmarkSuites[suite].kind,
    runs: runs.length,
    strictPassRate: average(runs.map((record) => record.strictPass ? 1 : 0)),
    structuralPassRate: average(runs.map((record) => record.structuralPass ? 1 : 0)),
    avgAnswerCoverage: average(runs.map((record) => record.answerCoverage)),
    avgCitationRecall: average(runs.map((record) => record.citationRecall)),
    avgCitationPrecision: average(runs.map((record) => record.citationPrecision)),
    avgGapPrecision: average(runs.map((record) => record.gapPrecision)),
    avgRagasFaithfulness: average(runs.map((record) => record.ragasFaithfulness)),
    avgRagasAnswerRelevancy: average(runs.map((record) => record.ragasAnswerRelevancy)),
    avgRagasContextPrecision: average(runs.map((record) => record.ragasContextPrecision)),
    avgRagasContextRecall: average(runs.map((record) => record.ragasContextRecall)),
    avgAresAnswerFaithfulness: average(runs.map((record) => record.aresAnswerFaithfulness)),
    avgAresAnswerRelevance: average(runs.map((record) => record.aresAnswerRelevance)),
    avgAresContextRelevance: average(runs.map((record) => record.aresContextRelevance)),
    avgDurationMs: average(runs.map((record) => record.durationMs)),
    avgTotalTokens: average(runs.map((record) => record.totalTokens)),
  }));
}

function scoreRecord(scenario: EvalScenario, assessment: ReturnType<typeof assessEvalScenario>, pulse: Awaited<ReturnType<typeof runEvalScenario>>["pulse"]) {
  const selectedChunkCount = pulse.evidencePack?.chunkEvidencePack?.selectedChunks.length ?? 0;
  const citationsCount = pulse.evidencePack?.citations.length ?? 0;
  const gapsCount = pulse.evidencePack?.gaps.length ?? 0;
  const expectedGapCount = scenario.expected.gapCount ?? 0;
  const answerCoverage = scenario.expected.answerIncludes.length > 0
    ? assessment.answerIncludesMatched.length / scenario.expected.answerIncludes.length
    : 1;
  const citationRecall = scenario.expected.selectedChunkCount > 0
    ? Math.min(1, selectedChunkCount / scenario.expected.selectedChunkCount)
    : 1;
  const citationPrecision = citationsCount > 0
    ? Math.min(1, scenario.expected.selectedChunkCount / citationsCount)
    : 0;
  const gapPrecision = expectedGapCount === 0
    ? (gapsCount === 0 ? 1 : 0)
    : Math.max(0, 1 - Math.abs(gapsCount - expectedGapCount) / expectedGapCount);
  const ragasFaithfulness = average([
    assessment.structuralPass ? 1 : 0,
    citationPrecision,
    assessment.answerExcludesViolated.length === 0 ? 1 : 0,
  ]);
  const ragasAnswerRelevancy = answerCoverage;
  const ragasContextPrecision = citationPrecision;
  const ragasContextRecall = citationRecall;
  const aresAnswerFaithfulness = average([
    ragasFaithfulness,
    assessment.checks.mustCiteSourceChunks ? 1 : 0,
  ]);
  const aresAnswerRelevance = average([
    answerCoverage,
    assessment.strictPass ? 1 : 0,
  ]);
  const aresContextRelevance = average([
    citationPrecision,
    citationRecall,
    gapPrecision,
  ]);
  return {
    answerCoverage,
    citationRecall,
    citationPrecision,
    gapPrecision,
    ragasFaithfulness,
    ragasAnswerRelevancy,
    ragasContextPrecision,
    ragasContextRecall,
    aresAnswerFaithfulness,
    aresAnswerRelevance,
    aresContextRelevance,
  };
}

async function verifyConfiguredModel(model: ModelProvider): Promise<void> {
  if (!model.configured) throw new Error("Configured benchmark requested, but the model provider is not configured from .env.");
  const tester = (model as { test?: () => Promise<unknown> }).test;
  if (typeof tester === "function") await tester.call(model);
}

export async function runBenchmarkSuite(input: BenchmarkRunnerArgs): Promise<BenchmarkRunnerOutput> {
  const scenarios = suiteFilter(input.suites, scenarioFilter(input.scenarioNames, aoriPulseEvalScenarios));
  if (scenarios.length === 0) throw new Error("No benchmark scenarios selected.");

  const config = getConfig();
  const model = input.provider === "fake" ? new EvalModelProvider() : createModelProvider(config);
  if (input.provider === "configured") await verifyConfiguredModel(model);

  const providerLabel = input.provider === "fake"
    ? "fake-eval"
    : `${config.provider}:${config.chatModel ?? model.name}`;
  const records: BenchmarkRunRecord[] = [];

  try {
    for (let iteration = 1; iteration <= input.iterations; iteration += 1) {
      for (const scenario of scenarios) {
        const wallStartedAt = Date.now();
        const { db, pulse, events } = await runEvalScenario(scenario, { model, mode: input.mode });
        const wallClockMs = Date.now() - wallStartedAt;
        const assessment = assessEvalScenario(scenario, pulse, events);
        const metrics = pulse.pulse.metrics;
        const scores = scoreRecord(scenario, assessment, pulse);
        const reviewInput: BenchmarkAnswerReviewInput = {
          question: scenario.question,
          sourceItems: scenario.items.map((item) => ({
            title: item.title,
            text: item.text,
            ...(item.summary ? { summary: item.summary } : {}),
          })),
          expectedAnswerIncludes: scenario.expected.answerIncludes,
          expectedAnswerExcludes: scenario.expected.answerExcludes ?? [],
          actualAnswer: pulse.pulse.answer,
          actualSummary: pulse.pulse.summary,
          answerMisses: assessment.answerIncludesMissed,
          answerExcludesViolated: assessment.answerExcludesViolated,
        };
        const answerReview = await model.reviewBenchmarkAnswer(reviewInput);
        records.push({
          scenario: scenario.name,
          suites: scenario.benchmarkSuites,
          language: scenario.language,
          iteration,
          question: scenario.question,
          sourceItems: reviewInput.sourceItems,
          expectedAnswerIncludes: scenario.expected.answerIncludes,
          expectedAnswerExcludes: scenario.expected.answerExcludes ?? [],
          actualAnswer: pulse.pulse.answer,
          actualSummary: pulse.pulse.summary,
          answerReview,
          strictPass: assessment.strictPass,
          structuralPass: assessment.structuralPass,
          answerCoverage: scores.answerCoverage,
          answerMisses: assessment.answerIncludesMissed,
          answerExcludesViolated: assessment.answerExcludesViolated,
          citationRecall: scores.citationRecall,
          citationPrecision: scores.citationPrecision,
          gapPrecision: scores.gapPrecision,
          ragasFaithfulness: scores.ragasFaithfulness,
          ragasAnswerRelevancy: scores.ragasAnswerRelevancy,
          ragasContextPrecision: scores.ragasContextPrecision,
          ragasContextRecall: scores.ragasContextRecall,
          aresAnswerFaithfulness: scores.aresAnswerFaithfulness,
          aresAnswerRelevance: scores.aresAnswerRelevance,
          aresContextRelevance: scores.aresContextRelevance,
          durationMs: metrics?.durationMs ?? 0,
          wallClockMs,
          modelCalls: metrics?.modelCalls ?? 0,
          promptTokens: metrics?.promptTokens ?? 0,
          completionTokens: metrics?.completionTokens ?? 0,
          totalTokens: metrics?.totalTokens ?? 0,
          promptCacheHitTokens: metrics?.promptCacheHitTokens ?? 0,
          promptCacheMissTokens: metrics?.promptCacheMissTokens ?? 0,
          promptCacheHitRate: metrics?.promptCacheHitRate,
        });
        db.close();
      }
    }
  } finally {
    await cleanupEvalDatabases();
  }

  const scenarioSummaries = summarize(records);
  const benchmarkSuites = suiteSummaries(records);
  const overall: BenchmarkOverallSummary = {
    runs: records.length,
    strictPassRate: records.reduce((sum, record) => sum + (record.strictPass ? 1 : 0), 0) / Math.max(1, records.length),
    structuralPassRate: records.reduce((sum, record) => sum + (record.structuralPass ? 1 : 0), 0) / Math.max(1, records.length),
    avgAnswerCoverage: records.reduce((sum, record) => sum + record.answerCoverage, 0) / Math.max(1, records.length),
    avgCitationRecall: records.reduce((sum, record) => sum + record.citationRecall, 0) / Math.max(1, records.length),
    avgCitationPrecision: records.reduce((sum, record) => sum + record.citationPrecision, 0) / Math.max(1, records.length),
    avgGapPrecision: records.reduce((sum, record) => sum + record.gapPrecision, 0) / Math.max(1, records.length),
    avgRagasFaithfulness: records.reduce((sum, record) => sum + record.ragasFaithfulness, 0) / Math.max(1, records.length),
    avgRagasAnswerRelevancy: records.reduce((sum, record) => sum + record.ragasAnswerRelevancy, 0) / Math.max(1, records.length),
    avgRagasContextPrecision: records.reduce((sum, record) => sum + record.ragasContextPrecision, 0) / Math.max(1, records.length),
    avgRagasContextRecall: records.reduce((sum, record) => sum + record.ragasContextRecall, 0) / Math.max(1, records.length),
    avgAresAnswerFaithfulness: records.reduce((sum, record) => sum + record.aresAnswerFaithfulness, 0) / Math.max(1, records.length),
    avgAresAnswerRelevance: records.reduce((sum, record) => sum + record.aresAnswerRelevance, 0) / Math.max(1, records.length),
    avgAresContextRelevance: records.reduce((sum, record) => sum + record.aresContextRelevance, 0) / Math.max(1, records.length),
    avgDurationMs: records.reduce((sum, record) => sum + record.durationMs, 0) / Math.max(1, records.length),
    avgWallClockMs: records.reduce((sum, record) => sum + record.wallClockMs, 0) / Math.max(1, records.length),
    avgTotalTokens: records.reduce((sum, record) => sum + record.totalTokens, 0) / Math.max(1, records.length),
    avgPromptCacheHitRate: (() => {
      const values = records.map((record) => record.promptCacheHitRate).filter((value): value is number => value !== undefined);
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
    })(),
  };

  return {
    providerLabel,
    scenarioSummaries,
    benchmarkSuites,
    overall,
    records,
  };
}
