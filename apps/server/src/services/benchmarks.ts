import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BenchmarkCatalog,
  BenchmarkRunListEntry,
  BenchmarkRunResult,
  CreateBenchmarkRunInput,
} from "@agent-thinking/contracts";
import type { AppConfig } from "../config.js";
import {
  benchmarkScenarioCatalog,
  benchmarkSuiteCatalog,
  runBenchmarkSuite,
} from "./benchmark-runner.js";

function now(): string {
  return new Date().toISOString();
}

function compareNewestFirst(left: { createdAt: string }, right: { createdAt: string }): number {
  return right.createdAt.localeCompare(left.createdAt);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export class BenchmarkService {
  readonly rootDir: string;

  constructor(private readonly config: AppConfig) {
    this.rootDir = join(config.dataDir, "benchmarks");
  }

  catalog(): BenchmarkCatalog {
    return {
      suites: benchmarkSuiteCatalog(),
      scenarios: benchmarkScenarioCatalog(),
    };
  }

  async run(input: CreateBenchmarkRunInput): Promise<BenchmarkRunResult> {
    const createdAt = now();
    const id = `${createdAt.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const path = join(this.rootDir, `${id}.json`);
    const summary = await runBenchmarkSuite({
      iterations: input.iterations,
      provider: input.provider,
      mode: input.mode,
      scenarioNames: input.scenarioNames,
      suites: input.suites,
    });
    const result: BenchmarkRunResult = {
      id,
      path,
      createdAt,
      ...(input.label ? { label: input.label } : {}),
      methodology: {
        benchmarkTarget: "AORI pulse answering over a library that has already been indexed into aspect-oriented reflective facets.",
        benchmarkAssumption: "These scores evaluate retrieval and answering after AORI facet indexing is available for the target knowledge base.",
        caveat: "This report does not measure the weaker baseline of answering directly from raw source documents without AORI indexing; direct raw-document answering is expected to perform worse.",
      },
      providerMode: input.provider,
      providerLabel: summary.providerLabel,
      mode: input.mode,
      iterations: input.iterations,
      requestedSuites: input.suites,
      requestedScenarios: input.scenarioNames,
      benchmarkSuites: summary.benchmarkSuites,
      scenarioSummaries: summary.scenarioSummaries,
      overall: summary.overall,
      records: summary.records,
    };
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, JSON.stringify(result, null, 2), "utf8");
    await rename(tempPath, path);
    return result;
  }

  async listRuns(): Promise<BenchmarkRunListEntry[]> {
    const runs = await this.readAllRuns();
    return runs
      .sort(compareNewestFirst)
      .map((run) => ({
        id: run.id,
        path: run.path,
        createdAt: run.createdAt,
        ...(run.label ? { label: run.label } : {}),
        providerMode: run.providerMode,
        providerLabel: run.providerLabel,
        mode: run.mode,
        iterations: run.iterations,
        requestedSuites: run.requestedSuites,
        requestedScenarios: run.requestedScenarios,
        benchmarkSuites: run.benchmarkSuites.map((suite) => suite.suite),
        languages: [...new Set(run.records.map((record) => record.language))].sort(),
        overall: run.overall,
      }));
  }

  async getRun(id: string): Promise<BenchmarkRunResult | undefined> {
    const path = join(this.rootDir, `${basename(id)}.json`);
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as BenchmarkRunResult;
    } catch {
      return undefined;
    }
  }

  async exportJson(id: string): Promise<Buffer> {
    const run = await this.getRun(id);
    if (!run) throw new Error("Benchmark 结果不存在");
    return Buffer.from(JSON.stringify(run, null, 2), "utf8");
  }

  async exportMarkdown(id: string): Promise<string> {
    const run = await this.getRun(id);
    if (!run) throw new Error("Benchmark 结果不存在");
    const methodology = run.methodology ?? {
      benchmarkTarget: "AORI pulse answering over a library that has already been indexed into aspect-oriented reflective facets.",
      benchmarkAssumption: "These scores evaluate retrieval and answering after AORI facet indexing is available for the target knowledge base.",
      caveat: "This report does not measure the weaker baseline of answering directly from raw source documents without AORI indexing; direct raw-document answering is expected to perform worse.",
    };
    const lines = [
      `# Benchmark Report: ${run.label ?? run.id}`,
      "",
      `- Run ID: \`${run.id}\``,
      `- Created At: ${run.createdAt}`,
      `- Provider: ${run.providerLabel}`,
      `- Provider Mode: ${run.providerMode}`,
      `- Pulse Mode: ${run.mode}`,
      `- Iterations: ${run.iterations}`,
      run.requestedSuites.length > 0 ? `- Requested Suites: ${run.requestedSuites.join(", ")}` : `- Requested Suites: all supported suites except BEIR`,
      run.requestedScenarios.length > 0 ? `- Requested Scenarios: ${run.requestedScenarios.join(", ")}` : `- Requested Scenarios: all selected scenarios`,
      "",
      "## Methodology",
      "",
      methodology.benchmarkTarget,
      "",
      methodology.benchmarkAssumption,
      "",
      `Caveat: ${methodology.caveat}`,
      "",
      "## Overall",
      "",
      `- Strict Pass Rate: ${(run.overall.strictPassRate * 100).toFixed(1)}%`,
      `- Answer Coverage: ${(run.overall.avgAnswerCoverage * 100).toFixed(1)}%`,
      `- Citation Recall: ${(run.overall.avgCitationRecall * 100).toFixed(1)}%`,
      `- Citation Precision: ${(run.overall.avgCitationPrecision * 100).toFixed(1)}%`,
      `- RAGAS Faithfulness: ${(run.overall.avgRagasFaithfulness * 100).toFixed(1)}%`,
      `- ARES Answer Relevance: ${(run.overall.avgAresAnswerRelevance * 100).toFixed(1)}%`,
      `- Avg Duration: ${run.overall.avgDurationMs.toFixed(1)} ms/run`,
      `- Avg Tokens: ${Math.round(run.overall.avgTotalTokens)} tok/run`,
      "",
      "## Suite Summary",
      "",
    ];
    for (const suite of run.benchmarkSuites) {
      const suiteRecords = run.records.filter((record) => record.suites.includes(suite.suite));
      const suiteScenarios = run.scenarioSummaries.filter((scenario) =>
        suiteRecords.some((record) => record.scenario === scenario.scenario)
      );
      lines.push(`### ${suite.label}`);
      lines.push("");
      lines.push(`- Kind: ${suite.kind}`);
      lines.push(`- Strict Pass Rate: ${percent(suite.strictPassRate)}`);
      lines.push(`- Coverage: ${percent(suite.avgAnswerCoverage)}`);
      lines.push(`- Citation Recall: ${percent(suite.avgCitationRecall)}`);
      lines.push(`- RAGAS Faithfulness: ${percent(suite.avgRagasFaithfulness)}`);
      lines.push(`- ARES Relevance: ${percent(suite.avgAresAnswerRelevance)}`);
      lines.push(`- Avg Duration: ${suite.avgDurationMs.toFixed(1)} ms`);
      lines.push(`- Avg Tokens: ${Math.round(suite.avgTotalTokens)} tok`);
      lines.push("");
      lines.push("#### Included Scenarios");
      lines.push("");
      for (const scenario of suiteScenarios) {
        lines.push(`- ${scenario.scenario} · strict ${percent(scenario.strictPassRate)} · coverage ${percent(scenario.avgAnswerCoverage)} · ${Math.round(scenario.avgTotalTokens)} tok`);
      }
      lines.push("");
      lines.push("#### Suite Scenario Detail");
      lines.push("");
      for (const record of suiteRecords) {
        const scenario = suiteScenarios.find((item) => item.scenario === record.scenario);
        lines.push(`##### ${record.scenario}`);
        lines.push("");
        lines.push(`- Question: ${record.question ?? "(question not preserved in this older benchmark record)"}`);
        lines.push(`- Strict Pass: ${record.strictPass ? "yes" : "no"}`);
        lines.push(`- Coverage: ${percent(record.answerCoverage)}`);
        lines.push(`- Citation Recall: ${percent(record.citationRecall)}`);
        lines.push(`- Citation Precision: ${percent(record.citationPrecision)}`);
        lines.push(`- Duration: ${record.durationMs} ms`);
        lines.push(`- Total Tokens: ${record.totalTokens}`);
        if (scenario && scenario.latestAnswerMisses.length > 0) {
          lines.push(`- Missed Required Points: ${scenario.latestAnswerMisses.join(" | ")}`);
        } else {
          lines.push(`- Missed Required Points: (none)`);
        }
        lines.push("");
        lines.push("Actual Answer:");
        lines.push("");
        lines.push("```text");
        lines.push(record.actualAnswer ?? "(actual answer not preserved in this older benchmark record)");
        lines.push("```");
        lines.push("");
      }
      lines.push("");
    }
    lines.push("## Scenario Reports");
    lines.push("");
    for (const record of run.records) {
      lines.push(`### ${record.scenario}`);
      lines.push("");
      lines.push(`- Language: ${record.language}`);
      lines.push(`- Suites: ${record.suites.join(", ")}`);
      lines.push(`- Strict Pass: ${record.strictPass ? "yes" : "no"}`);
      lines.push(`- Structural Pass: ${record.structuralPass ? "yes" : "no"}`);
      lines.push(`- Coverage: ${(record.answerCoverage * 100).toFixed(1)}%`);
      lines.push(`- Citation Recall: ${(record.citationRecall * 100).toFixed(1)}%`);
      lines.push(`- Citation Precision: ${(record.citationPrecision * 100).toFixed(1)}%`);
      lines.push(`- Duration: ${record.durationMs} ms`);
      lines.push(`- Prompt Tokens: ${record.promptTokens}`);
      lines.push(`- Completion Tokens: ${record.completionTokens}`);
      lines.push(`- Total Tokens: ${record.totalTokens}`);
      lines.push(`- Model Calls: ${record.modelCalls}`);
      lines.push("");
      lines.push("#### Question");
      lines.push("");
      lines.push(record.question ?? "(question not preserved in this older benchmark record)");
      lines.push("");
      lines.push("#### Actual Answer");
      lines.push("");
      lines.push("```text");
      lines.push(record.actualAnswer ?? "(actual answer not preserved in this older benchmark record)");
      lines.push("```");
      lines.push("");
      lines.push("#### Actual Summary");
      lines.push("");
      lines.push("```text");
      lines.push(record.actualSummary ?? "(actual summary not preserved in this older benchmark record)");
      lines.push("```");
      lines.push("");
      lines.push("#### Expected Answer Should Include");
      lines.push("");
      if ((record.expectedAnswerIncludes ?? []).length > 0) {
        for (const item of record.expectedAnswerIncludes) lines.push(`- ${item}`);
      } else {
        lines.push("- (expected include list not preserved in this older benchmark record)");
      }
      lines.push("");
      lines.push("#### Expected Answer Should Exclude");
      lines.push("");
      if ((record.expectedAnswerExcludes ?? []).length > 0) {
        for (const item of record.expectedAnswerExcludes ?? []) lines.push(`- ${item}`);
      } else {
        lines.push("- (none)");
      }
      lines.push("");
      lines.push("#### Missed Required Points");
      lines.push("");
      if (record.answerMisses.length > 0) {
        for (const item of record.answerMisses) lines.push(`- ${item}`);
      } else {
        lines.push("- (none)");
      }
      lines.push("");
      lines.push("#### Violated Exclusions");
      lines.push("");
      if (record.answerExcludesViolated.length > 0) {
        for (const item of record.answerExcludesViolated) lines.push(`- ${item}`);
      } else {
        lines.push("- (none)");
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  private async readAllRuns(): Promise<BenchmarkRunResult[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
      const loaded = await Promise.all(files.map(async (entry) => {
        try {
          const raw = await readFile(join(this.rootDir, entry.name), "utf8");
          return JSON.parse(raw) as BenchmarkRunResult;
        } catch {
          return undefined;
        }
      }));
      return loaded.filter((entry): entry is BenchmarkRunResult => Boolean(entry));
    } catch {
      return [];
    }
  }
}
