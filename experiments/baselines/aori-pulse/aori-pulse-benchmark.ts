import { inspect } from "node:util";
import {
  aoriPulseBenchmarkSuites,
  type BenchmarkSuite,
} from "../../../apps/server/test/helpers/aori-pulse-eval-fixtures.js";
import { runBenchmarkSuite } from "./benchmark-runner.js";
import type { BenchmarkRunRecord, BenchmarkScenarioSummary, BenchmarkSuiteSummary, PulseInputMode } from "@agent-thinking/contracts";

type ProviderMode = "configured" | "fake";

interface BenchmarkArgs {
  iterations: number;
  provider: ProviderMode;
  mode: PulseInputMode;
  scenarioNames: string[];
  suites: BenchmarkSuite[];
  json: boolean;
}

function parseArgs(argv: string[]): BenchmarkArgs {
  const args: BenchmarkArgs = {
    iterations: 1,
    provider: "configured",
    mode: "full",
    scenarioNames: [],
    suites: [],
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
    if (token === "--suite" && next) {
      if (next in aoriPulseBenchmarkSuites) args.suites.push(next as BenchmarkSuite);
      index += 1;
      continue;
    }
    if (token.startsWith("--suite=")) {
      const value = token.slice("--suite=".length);
      if (value in aoriPulseBenchmarkSuites) args.suites.push(value as BenchmarkSuite);
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

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runBenchmarkSuite({
    iterations: args.iterations,
    provider: args.provider,
    mode: args.mode,
    scenarioNames: args.scenarioNames,
    suites: args.suites,
  });
  const records = summary.records;
  const scenarioSummaries = summary.scenarioSummaries;
  const benchmarkSummaries = summary.benchmarkSuites;
  const providerLabel = summary.providerLabel;

  console.log(`AORI/Pulse benchmark`);
  console.log(`provider=${providerLabel} mode=${args.mode} iterations=${args.iterations} scenarios=${scenarioSummaries.length}`);
  console.log(`suites=${args.suites.length > 0 ? args.suites.join(",") : "all_except_beir"} languages=${[...new Set(records.map((record) => record.language))].join(",")}`);
  if (args.iterations < 2) console.log(`hint=use --iterations 2 or 3 if you want cache-hit behavior to stabilize`);
  for (const record of records) {
    console.log(
      `[${record.iteration}/${args.iterations}] ${record.scenario} ` +
      `strict=${record.strictPass ? "pass" : "fail"} structural=${record.structuralPass ? "pass" : "fail"} ` +
      `coverage=${formatPercent(record.answerCoverage)} citeR=${formatPercent(record.citationRecall)} ` +
      `faith=${formatPercent(record.ragasFaithfulness)} duration=${formatNumber(record.durationMs)}ms ` +
      `tokens=${record.totalTokens} cache=${formatPercent(record.promptCacheHitRate)} calls=${record.modelCalls}`,
    );
  }
  const overall = summary.overall;

  if (args.json) {
    console.log(JSON.stringify({
      provider: providerLabel,
      mode: args.mode,
      iterations: args.iterations,
      benchmarkSuites: benchmarkSummaries,
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
      `coverage=${formatPercent(summary.avgAnswerCoverage)} citeR=${formatPercent(summary.avgCitationRecall)} ` +
      `faith=${formatPercent(summary.avgRagasFaithfulness)} duration=${formatNumber(summary.avgDurationMs)}ms ` +
      `tokens=${formatNumber(summary.avgTotalTokens)} cache=${formatPercent(summary.avgPromptCacheHitRate)}`,
    );
    if (summary.latestAnswerMisses.length > 0) console.log(`  missed includes: ${summary.latestAnswerMisses.join(" | ")}`);
    if (summary.latestAnswerExcludesViolated.length > 0) console.log(`  violated excludes: ${summary.latestAnswerExcludesViolated.join(" | ")}`);
  }

  console.log(`\nBenchmark suites`);
  for (const summary of benchmarkSummaries) {
    console.log(
      `${summary.suite} (${summary.kind}): strict=${formatPercent(summary.strictPassRate)} ` +
      `coverage=${formatPercent(summary.avgAnswerCoverage)} citeR=${formatPercent(summary.avgCitationRecall)} ` +
      `ragas_faith=${formatPercent(summary.avgRagasFaithfulness)} ares_rel=${formatPercent(summary.avgAresAnswerRelevance)}`,
    );
  }

  console.log(`\nOverall`);
  console.log(inspect(overall, { colors: false, depth: null, compact: true }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
