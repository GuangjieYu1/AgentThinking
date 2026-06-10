import { inspect } from "node:util";
import { getConfig } from "../src/config.js";
import { createModelProvider } from "../src/services/models.js";
import type { ModelProvider } from "../src/services/models.js";
import {
  aoriPulseEvalScenarios,
  assessEvalScenario,
  cleanupEvalDatabases,
  EvalModelProvider,
  runEvalScenario,
  type EvalScenario,
} from "./helpers/aori-pulse-eval-fixtures.js";

type ProviderMode = "configured" | "fake";

interface BenchmarkArgs {
  iterations: number;
  provider: ProviderMode;
  mode: "full" | "progressive";
  scenarioNames: string[];
  json: boolean;
}

interface BenchmarkRunRecord {
  scenario: string;
  iteration: number;
  strictPass: boolean;
  structuralPass: boolean;
  answerCoverage: number;
  answerMisses: string[];
  answerExcludesViolated: string[];
  durationMs: number;
  wallClockMs: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  promptCacheHitRate?: number | undefined;
}

function parseArgs(argv: string[]): BenchmarkArgs {
  const args: BenchmarkArgs = {
    iterations: 1,
    provider: "configured",
    mode: "full",
    scenarioNames: [],
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const next = argv[index + 1];
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--iterations" && next) {
      args.iterations = Math.max(1, Number(next) || 1);
      index += 1;
      continue;
    }
    if (token.startsWith("--iterations=")) {
      args.iterations = Math.max(1, Number(token.slice("--iterations=".length)) || 1);
      continue;
    }
    if (token === "--provider" && (next === "configured" || next === "fake")) {
      args.provider = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--provider=")) {
      const value = token.slice("--provider=".length);
      if (value === "configured" || value === "fake") args.provider = value;
      continue;
    }
    if (token === "--mode" && (next === "full" || next === "progressive")) {
      args.mode = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--mode=")) {
      const value = token.slice("--mode=".length);
      if (value === "full" || value === "progressive") args.mode = value;
      continue;
    }
    if (token === "--scenario" && next) {
      args.scenarioNames.push(next);
      index += 1;
      continue;
    }
    if (token.startsWith("--scenario=")) {
      args.scenarioNames.push(token.slice("--scenario=".length));
      continue;
    }
  }

  return args;
}

function formatNumber(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function scenarioFilter(names: string[], scenarios: EvalScenario[]): EvalScenario[] {
  if (names.length === 0) return scenarios;
  const wanted = new Set(names);
  return scenarios.filter((scenario) => wanted.has(scenario.name));
}

async function verifyConfiguredModel(model: ModelProvider): Promise<void> {
  if (!model.configured) throw new Error("Configured benchmark requested, but the model provider is not configured from .env.");
  const tester = (model as { test?: () => Promise<unknown> }).test;
  if (typeof tester === "function") await tester.call(model);
}

function summarize(records: BenchmarkRunRecord[]) {
  const byScenario = new Map<string, BenchmarkRunRecord[]>();
  for (const record of records) {
    const group = byScenario.get(record.scenario) ?? [];
    group.push(record);
    byScenario.set(record.scenario, group);
  }
  return [...byScenario.entries()].map(([scenario, runs]) => {
    const average = (pick: (record: BenchmarkRunRecord) => number) => runs.reduce((sum, record) => sum + pick(record), 0) / runs.length;
    const averageOptional = (pick: (record: BenchmarkRunRecord) => number | undefined) => {
      const values = runs.map(pick).filter((value): value is number => value !== undefined && Number.isFinite(value));
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
    };
    return {
      scenario,
      runs: runs.length,
      strictPassRate: average((record) => record.strictPass ? 1 : 0),
      structuralPassRate: average((record) => record.structuralPass ? 1 : 0),
      avgAnswerCoverage: average((record) => record.answerCoverage),
      avgDurationMs: average((record) => record.durationMs),
      avgWallClockMs: average((record) => record.wallClockMs),
      avgModelCalls: average((record) => record.modelCalls),
      avgPromptTokens: average((record) => record.promptTokens),
      avgCompletionTokens: average((record) => record.completionTokens),
      avgTotalTokens: average((record) => record.totalTokens),
      avgPromptCacheHitTokens: average((record) => record.promptCacheHitTokens),
      avgPromptCacheMissTokens: average((record) => record.promptCacheMissTokens),
      avgPromptCacheHitRate: averageOptional((record) => record.promptCacheHitRate),
      latestAnswerMisses: runs.at(-1)?.answerMisses ?? [],
      latestAnswerExcludesViolated: runs.at(-1)?.answerExcludesViolated ?? [],
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = scenarioFilter(args.scenarioNames, aoriPulseEvalScenarios);
  if (scenarios.length === 0) throw new Error("No benchmark scenarios selected.");

  const config = getConfig();
  const model = args.provider === "fake" ? new EvalModelProvider() : createModelProvider(config);
  if (args.provider === "configured") await verifyConfiguredModel(model);

  const records: BenchmarkRunRecord[] = [];
  const providerLabel = args.provider === "fake"
    ? "fake-eval"
    : `${config.provider}:${config.chatModel ?? model.name}`;

  console.log(`AORI/Pulse benchmark`);
  console.log(`provider=${providerLabel} mode=${args.mode} iterations=${args.iterations} scenarios=${scenarios.length}`);
  if (args.iterations < 2) console.log(`hint=use --iterations 2 or 3 if you want cache-hit behavior to stabilize`);

  try {
    for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
      for (const scenario of scenarios) {
        const wallStartedAt = Date.now();
        const { db, pulse, events } = await runEvalScenario(scenario, { model, mode: args.mode });
        const wallClockMs = Date.now() - wallStartedAt;
        const assessment = assessEvalScenario(scenario, pulse, events);
        const metrics = pulse.pulse.metrics;
        const record: BenchmarkRunRecord = {
          scenario: scenario.name,
          iteration,
          strictPass: assessment.strictPass,
          structuralPass: assessment.structuralPass,
          answerCoverage: scenario.expected.answerIncludes.length > 0
            ? assessment.answerIncludesMatched.length / scenario.expected.answerIncludes.length
            : 1,
          answerMisses: assessment.answerIncludesMissed,
          answerExcludesViolated: assessment.answerExcludesViolated,
          durationMs: metrics?.durationMs ?? 0,
          wallClockMs,
          modelCalls: metrics?.modelCalls ?? 0,
          promptTokens: metrics?.promptTokens ?? 0,
          completionTokens: metrics?.completionTokens ?? 0,
          totalTokens: metrics?.totalTokens ?? 0,
          promptCacheHitTokens: metrics?.promptCacheHitTokens ?? 0,
          promptCacheMissTokens: metrics?.promptCacheMissTokens ?? 0,
          promptCacheHitRate: metrics?.promptCacheHitRate,
        };
        records.push(record);
        console.log(
          `[${iteration}/${args.iterations}] ${scenario.name} ` +
          `strict=${record.strictPass ? "pass" : "fail"} structural=${record.structuralPass ? "pass" : "fail"} ` +
          `coverage=${formatPercent(record.answerCoverage)} duration=${formatNumber(record.durationMs)}ms ` +
          `tokens=${record.totalTokens} cache=${formatPercent(record.promptCacheHitRate)} calls=${record.modelCalls}`,
        );
        db.close();
      }
    }
  } finally {
    await cleanupEvalDatabases();
  }

  const scenarioSummaries = summarize(records);
  const overall = {
    runs: records.length,
    strictPassRate: records.reduce((sum, record) => sum + (record.strictPass ? 1 : 0), 0) / Math.max(1, records.length),
    structuralPassRate: records.reduce((sum, record) => sum + (record.structuralPass ? 1 : 0), 0) / Math.max(1, records.length),
    avgAnswerCoverage: records.reduce((sum, record) => sum + record.answerCoverage, 0) / Math.max(1, records.length),
    avgDurationMs: records.reduce((sum, record) => sum + record.durationMs, 0) / Math.max(1, records.length),
    avgWallClockMs: records.reduce((sum, record) => sum + record.wallClockMs, 0) / Math.max(1, records.length),
    avgTotalTokens: records.reduce((sum, record) => sum + record.totalTokens, 0) / Math.max(1, records.length),
    avgPromptCacheHitRate: (() => {
      const values = records.map((record) => record.promptCacheHitRate).filter((value): value is number => value !== undefined);
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
    })(),
  };

  if (args.json) {
    console.log(JSON.stringify({
      provider: providerLabel,
      mode: args.mode,
      iterations: args.iterations,
      scenarioSummaries,
      overall,
      records,
    }, null, 2));
    return;
  }

  console.log(`\nScenario summary`);
  for (const summary of scenarioSummaries) {
    console.log(
      `${summary.scenario}: strict=${formatPercent(summary.strictPassRate)} structural=${formatPercent(summary.structuralPassRate)} ` +
      `coverage=${formatPercent(summary.avgAnswerCoverage)} duration=${formatNumber(summary.avgDurationMs)}ms ` +
      `tokens=${formatNumber(summary.avgTotalTokens)} cache=${formatPercent(summary.avgPromptCacheHitRate)}`,
    );
    if (summary.latestAnswerMisses.length > 0) console.log(`  missed includes: ${summary.latestAnswerMisses.join(" | ")}`);
    if (summary.latestAnswerExcludesViolated.length > 0) console.log(`  violated excludes: ${summary.latestAnswerExcludesViolated.join(" | ")}`);
  }

  console.log(`\nOverall`);
  console.log(inspect(overall, { colors: false, depth: null, compact: true }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
