import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BenchmarkCatalog,
  BenchmarkRunListEntry,
  BenchmarkRunRecord,
  BenchmarkRunResult,
  CreateBenchmarkRunInput,
} from "@agent-thinking/contracts";
import type { AppConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import {
  benchmarkScenarioCatalog,
  benchmarkSuiteCatalog,
  runBenchmarkSuite,
} from "./benchmark-runner.js";

const legacyEnglishBenchmarkMethodology = {
  benchmarkTarget: "AORI pulse answering over a library that has already been indexed into aspect-oriented reflective facets.",
  benchmarkAssumption: "These scores evaluate retrieval and answering after AORI facet indexing is available for the target knowledge base.",
  caveat: "This report does not measure the weaker baseline of answering directly from raw source documents without AORI indexing; direct raw-document answering is expected to perform worse.",
} as const;

const readableDefaultChineseBenchmarkMethodology: BenchmarkRunResult["methodology"] = {
  benchmarkTarget: "本基准测试使用公开 CMRC 2018 开发集小型公开语料，先对 contextExcerpt 去重并建立一个共享 AORI 知识库，测试时仅向 AORI 脉冲输入 question 字段。",
  benchmarkAssumption: "当前默认使用公开数据集中的 25 个原始问题，不做问题改写，也不拼接自造多跳问题；标准答案只用于评分和报告展示，不会输入给模型。",
  caveat: "本报告是本地回归评测，不是 CMRC 2018 全量开发集或隐藏测试集的官方分数，也不应直接与原始 leaderboard 对比。",
};

const reviewVerdictLabels = {
  aligned: "基本一致",
  partial: "部分一致",
  mismatch: "差异明显",
} as const;

function now(): string {
  return new Date().toISOString();
}

function compareNewestFirst(left: { createdAt: string }, right: { createdAt: string }): number {
  return right.createdAt.localeCompare(left.createdAt);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

function truncate(value: string | undefined, maxLength = 120): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized || "-";
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeReadableMethodology(methodology: BenchmarkRunResult["methodology"] | undefined): BenchmarkRunResult["methodology"] {
  if (!methodology) return { ...readableDefaultChineseBenchmarkMethodology };
  if (methodology.benchmarkTarget === legacyEnglishBenchmarkMethodology.benchmarkTarget) {
    return { ...readableDefaultChineseBenchmarkMethodology };
  }
  if (methodology.benchmarkTarget.includes("contextExcerpt")) {
    return { ...readableDefaultChineseBenchmarkMethodology };
  }
  return methodology;
}

function uniqueSourceTextCount(run: BenchmarkRunResult): number {
  return new Set(
    run.records
      .flatMap((record) => record.sourceItems ?? [])
      .map((source) => source.text.trim())
      .filter(Boolean),
  ).size;
}

function answerList(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(" / ") : "-";
}

function scenarioKind(record: BenchmarkRunRecord): string {
  return record.scenario.includes("multihop") ? "多跳" : "单跳";
}

function compactChunkIds(record: BenchmarkRunRecord): string {
  const ids = record.evidenceTrace?.selectedChunkIds ?? [];
  return ids.length > 0 ? ids.slice(0, 3).join(", ") + (ids.length > 3 ? "…" : "") : "-";
}

function pushFailureDetails(lines: string[], records: BenchmarkRunRecord[]): void {
  const failures = records.filter((record) => !record.strictPass).slice(0, 10);
  if (failures.length === 0) {
    lines.push("本轮没有严格失败的场景。");
    lines.push("");
    return;
  }

  lines.push(`以下仅列出前 ${failures.length} 个失败/不严格通过场景，完整字段请查看 JSON 导出。`);
  lines.push("");
  for (const record of failures) {
    lines.push(`### ${record.scenario}`);
    lines.push("");
    lines.push(`- 类型：${scenarioKind(record)}`);
    lines.push(`- 问题：${record.question}`);
    lines.push(`- 测试集答案：${answerList(record.testsetAnswers)}`);
    lines.push(`- AORI 回答：${truncate(record.actualAnswer, 220)}`);
    lines.push(`- 未命中：${record.answerMisses.length > 0 ? record.answerMisses.join(" / ") : "无"}`);
    lines.push(`- 证据 Chunk：${compactChunkIds(record)}`);
    if (record.answerReview) {
      lines.push(`- AI评审：${reviewVerdictLabels[record.answerReview.verdict]}；${truncate(record.answerReview.summary, 180)}`);
      const difference = record.answerReview.differences[0];
      if (difference) {
        lines.push(`- 主要差异：${difference.aspect}。预期：${truncate(difference.expected, 80)}；实际：${truncate(difference.actual, 80)}`);
      }
    }
    lines.push("");
  }
}

function renderBenchmarkMarkdown(run: BenchmarkRunResult): string {
  const methodology = normalizeReadableMethodology(run.methodology);
  const uniqueContextCount = uniqueSourceTextCount(run);
  const multiHopCount = run.records.filter((record) => record.scenario.includes("multihop")).length;
  const lines: string[] = [
    `# Benchmark 报告：${run.label ?? run.id}`,
    "",
    "## 概览",
    "",
    `- Run ID：\`${run.id}\``,
    `- 生成时间：${run.createdAt}`,
    `- Provider：${run.providerLabel}（${run.providerMode}）`,
    `- 脉冲模式：${run.mode}`,
    `- 迭代次数：${run.iterations}`,
    `- 关联评测知识库：${run.libraryId ?? "未记录"}`,
    `- 问题数：${run.records.length}（多跳 ${multiHopCount}）`,
    `- 去重原文数：${uniqueContextCount}`,
    "",
    "## 运行方式",
    "",
    methodology.benchmarkTarget,
    "",
    methodology.benchmarkAssumption,
    "",
    `说明：${methodology.caveat}`,
    "",
    "- 知识库构建：`contextExcerpt` 去重后一次性建成共享 AORI 知识库。",
    "- 脉冲输入：仅 `question` 字段。",
    "- 不输入给模型：测试集标准答案，以及测试集中的 `evidence` / `question_id` / `source_url` 等评分元数据。",
    "",
    "## 总分",
    "",
    `- 严格通过率：${percent(run.overall.strictPassRate)}`,
    `- 结构通过率：${percent(run.overall.structuralPassRate)}`,
    `- 回答覆盖率：${percent(run.overall.avgAnswerCoverage)}`,
    `- 引用召回率：${percent(run.overall.avgCitationRecall)}`,
    `- 引用精确率：${percent(run.overall.avgCitationPrecision)}`,
    `- RAGAS 忠实度：${percent(run.overall.avgRagasFaithfulness)}`,
    `- ARES 回答相关性：${percent(run.overall.avgAresAnswerRelevance)}`,
    `- 平均 Tokens：${Math.round(run.overall.avgTotalTokens)}`,
    "",
    "## 套件",
    "",
    "| Suite | 类型 | Runs | Strict | Coverage | Cite Recall | RAGAS Faith | ARES Rel | Avg Tokens |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const suite of run.benchmarkSuites) {
    lines.push(`| ${suite.label} | ${suite.kind} | ${suite.runs} | ${percent(suite.strictPassRate)} | ${percent(suite.avgAnswerCoverage)} | ${percent(suite.avgCitationRecall)} | ${percent(suite.avgRagasFaithfulness)} | ${percent(suite.avgAresAnswerRelevance)} | ${Math.round(suite.avgTotalTokens)} |`);
  }

  lines.push("");
  lines.push("## 场景摘要");
  lines.push("");
  lines.push("| 场景 | 类型 | Strict | Coverage | 测试集答案 | AORI 回答 | 未命中 | 证据 Chunk |");
  lines.push("| --- | --- | ---: | ---: | --- | --- | --- | --- |");
  for (const record of run.records) {
    lines.push(`| ${record.scenario} | ${scenarioKind(record)} | ${yesNo(record.strictPass)} | ${percent(record.answerCoverage)} | ${truncate(answerList(record.testsetAnswers), 80)} | ${truncate(record.actualAnswer, 100)} | ${truncate(record.answerMisses.join(" / ") || "无", 80)} | ${compactChunkIds(record)} |`);
  }

  lines.push("");
  lines.push("## 失败样例");
  lines.push("");
  pushFailureDetails(lines, run.records);
  lines.push("## 说明");
  lines.push("");
  lines.push("报告默认保持精简；如需逐字段、完整原文、完整 AI 评审和 citation 明细，请导出 JSON。");
  lines.push("");
  return lines.join("\n");
}

export class BenchmarkService {
  readonly rootDir: string;

  constructor(private readonly config: AppConfig, private readonly db?: AgentDatabase) {
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
      db: this.db,
      libraryName: `Benchmark ${id} public-cmrc2018-deduped`,
    });
    const result: BenchmarkRunResult = {
      id,
      path,
      createdAt,
      ...(input.label ? { label: input.label } : {}),
      ...(summary.libraryId ? { libraryId: summary.libraryId } : {}),
      methodology: { ...readableDefaultChineseBenchmarkMethodology },
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
        ...(run.libraryId ? { libraryId: run.libraryId } : {}),
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
    return renderBenchmarkMarkdown(run);
  }

  async deleteRunKnowledgeBase(id: string): Promise<{ libraryId: string; deleted: boolean }> {
    if (!this.db) throw new Error("当前服务未连接知识库数据库，无法删除 benchmark 知识库");
    const run = await this.getRun(id);
    if (!run) throw new Error("Benchmark 结果不存在");
    if (!run.libraryId) throw new Error("此 benchmark 记录未关联评测知识库");
    const libraryId = run.libraryId;
    const deleted = this.db.deleteLibrary(libraryId);
    await rm(join(this.config.filesDir, libraryId), { recursive: true, force: true });
    await rm(join(this.config.analysisDir, libraryId), { recursive: true, force: true });
    const { libraryId: _removedLibraryId, ...updated } = run;
    await writeFile(run.path, JSON.stringify(updated, null, 2), "utf8");
    return { libraryId, deleted };
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
