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

const reviewVerdictLabels = {
  aligned: "基本一致",
  partial: "部分一致",
  mismatch: "差异明显",
} as const;

const reviewRoleLabels = {
  included: "纳入",
  excluded: "排除",
  uncertain: "不确定",
  background: "背景",
  not_mentioned: "未提及",
} as const;

const legacyEnglishBenchmarkMethodology = {
  benchmarkTarget: "AORI pulse answering over a library that has already been indexed into aspect-oriented reflective facets.",
  benchmarkAssumption: "These scores evaluate retrieval and answering after AORI facet indexing is available for the target knowledge base.",
  caveat: "This report does not measure the weaker baseline of answering directly from raw source documents without AORI indexing; direct raw-document answering is expected to perform worse.",
} as const;

const defaultChineseBenchmarkMethodology: BenchmarkRunResult["methodology"] = {
  benchmarkTarget: "本基准测试面向已经完成 AORI 切面反思式索引的知识库，评估其脉冲问答能力。",
  benchmarkAssumption: "这些分数衡量的是目标知识库在具备 AORI 切面索引之后的检索与回答表现。",
  caveat: "本报告不衡量直接基于原始文档、未经过 AORI 索引时的弱基线回答能力；通常该原始文档直答路径的表现会更差。",
};

function normalizeMethodology(methodology: BenchmarkRunResult["methodology"] | undefined): BenchmarkRunResult["methodology"] {
  if (!methodology) return { ...defaultChineseBenchmarkMethodology };
  return {
    benchmarkTarget: methodology.benchmarkTarget === legacyEnglishBenchmarkMethodology.benchmarkTarget
      ? defaultChineseBenchmarkMethodology.benchmarkTarget
      : methodology.benchmarkTarget,
    benchmarkAssumption: methodology.benchmarkAssumption === legacyEnglishBenchmarkMethodology.benchmarkAssumption
      ? defaultChineseBenchmarkMethodology.benchmarkAssumption
      : methodology.benchmarkAssumption,
    caveat: methodology.caveat === legacyEnglishBenchmarkMethodology.caveat
      ? defaultChineseBenchmarkMethodology.caveat
      : methodology.caveat,
  };
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
      methodology: { ...defaultChineseBenchmarkMethodology },
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
    const methodology = normalizeMethodology(run.methodology);
    const lines = [
      `# Benchmark 报告：${run.label ?? run.id}`,
      "",
      `- Run ID：\`${run.id}\``,
      `- 生成时间：${run.createdAt}`,
      `- Provider：${run.providerLabel}`,
      `- Provider 模式：${run.providerMode}`,
      `- 脉冲模式：${run.mode}`,
      `- 迭代次数：${run.iterations}`,
      run.requestedSuites.length > 0 ? `- 指定套件：${run.requestedSuites.join(", ")}` : "- 指定套件：全部受支持套件（不含 BEIR）",
      run.requestedScenarios.length > 0 ? `- 指定场景：${run.requestedScenarios.join(", ")}` : "- 指定场景：当前选中的全部场景",
      "",
      "## 评测方法",
      "",
      methodology.benchmarkTarget,
      "",
      methodology.benchmarkAssumption,
      "",
      `说明：${methodology.caveat}`,
      "",
      "## 总览",
      "",
      `- 严格通过率：${(run.overall.strictPassRate * 100).toFixed(1)}%`,
      `- 回答覆盖率：${(run.overall.avgAnswerCoverage * 100).toFixed(1)}%`,
      `- 引用召回率：${(run.overall.avgCitationRecall * 100).toFixed(1)}%`,
      `- 引用精确率：${(run.overall.avgCitationPrecision * 100).toFixed(1)}%`,
      `- RAGAS 忠实度：${(run.overall.avgRagasFaithfulness * 100).toFixed(1)}%`,
      `- ARES 回答相关性：${(run.overall.avgAresAnswerRelevance * 100).toFixed(1)}%`,
      `- 平均耗时：${run.overall.avgDurationMs.toFixed(1)} ms/次`,
      `- 平均 Tokens：${Math.round(run.overall.avgTotalTokens)} tok/次`,
      "",
      "## 套件汇总",
      "",
    ];
    for (const suite of run.benchmarkSuites) {
      const suiteRecords = run.records.filter((record) => record.suites.includes(suite.suite));
      const suiteScenarios = run.scenarioSummaries.filter((scenario) =>
        suiteRecords.some((record) => record.scenario === scenario.scenario)
      );
      lines.push(`### ${suite.label}`);
      lines.push("");
      lines.push(`- 类型：${suite.kind}`);
      lines.push(`- 严格通过率：${percent(suite.strictPassRate)}`);
      lines.push(`- 覆盖率：${percent(suite.avgAnswerCoverage)}`);
      lines.push(`- 引用召回率：${percent(suite.avgCitationRecall)}`);
      lines.push(`- RAGAS 忠实度：${percent(suite.avgRagasFaithfulness)}`);
      lines.push(`- ARES 相关性：${percent(suite.avgAresAnswerRelevance)}`);
      lines.push(`- 平均耗时：${suite.avgDurationMs.toFixed(1)} ms`);
      lines.push(`- 平均 Tokens：${Math.round(suite.avgTotalTokens)} tok`);
      lines.push("");
      lines.push("#### 覆盖场景");
      lines.push("");
      for (const scenario of suiteScenarios) {
        lines.push(`- ${scenario.scenario} · 严格通过 ${percent(scenario.strictPassRate)} · 覆盖率 ${percent(scenario.avgAnswerCoverage)} · ${Math.round(scenario.avgTotalTokens)} tok`);
      }
      lines.push("");
      lines.push("#### 套件内场景详情");
      lines.push("");
      for (const record of suiteRecords) {
        const scenario = suiteScenarios.find((item) => item.scenario === record.scenario);
        lines.push(`##### ${record.scenario}`);
        lines.push("");
        lines.push(`- 问题：${record.question ?? "（旧版 benchmark 记录未保留原问题）"}`);
        lines.push(`- 严格通过：${record.strictPass ? "是" : "否"}`);
        lines.push(`- 覆盖率：${percent(record.answerCoverage)}`);
        lines.push(`- 引用召回率：${percent(record.citationRecall)}`);
        lines.push(`- 引用精确率：${percent(record.citationPrecision)}`);
        lines.push(`- 耗时：${record.durationMs} ms`);
        lines.push(`- 总 Tokens：${record.totalTokens}`);
        if (scenario && scenario.latestAnswerMisses.length > 0) {
          lines.push(`- 未命中的必答点：${scenario.latestAnswerMisses.join(" | ")}`);
        } else {
          lines.push("- 未命中的必答点：无");
        }
        lines.push("");
        lines.push("模型回答：");
        lines.push("");
        lines.push("```text");
        lines.push(record.actualAnswer ?? "（旧版 benchmark 记录未保留模型回答）");
        lines.push("```");
        lines.push("");
        lines.push("原文与评审：");
        lines.push("");
        if ((record.sourceItems?.length ?? 0) > 0) {
          for (const source of record.sourceItems ?? []) {
            lines.push(`- 原文 ${source.title}：${source.text}`);
          }
        } else {
          lines.push("- （此旧版 benchmark 记录未保留原文片段）");
        }
        if (record.answerReview) {
          lines.push("");
          lines.push(`- AI评审结论：${reviewVerdictLabels[record.answerReview.verdict]}`);
          lines.push(`- AI评审摘要：${record.answerReview.summary}`);
        } else {
          lines.push("");
          lines.push("- AI评审：此旧版 benchmark 记录未保留结构化评审结果。");
        }
        lines.push("");
      }
      lines.push("");
    }
    lines.push("## 场景报告");
    lines.push("");
    for (const record of run.records) {
      lines.push(`### ${record.scenario}`);
      lines.push("");
      lines.push(`- 语言：${record.language}`);
      lines.push(`- 所属套件：${record.suites.join(", ")}`);
      lines.push(`- 严格通过：${record.strictPass ? "是" : "否"}`);
      lines.push(`- 结构通过：${record.structuralPass ? "是" : "否"}`);
      lines.push(`- 覆盖率：${(record.answerCoverage * 100).toFixed(1)}%`);
      lines.push(`- 引用召回率：${(record.citationRecall * 100).toFixed(1)}%`);
      lines.push(`- 引用精确率：${(record.citationPrecision * 100).toFixed(1)}%`);
      lines.push(`- 耗时：${record.durationMs} ms`);
      lines.push(`- Prompt Tokens：${record.promptTokens}`);
      lines.push(`- Completion Tokens：${record.completionTokens}`);
      lines.push(`- Total Tokens：${record.totalTokens}`);
      lines.push(`- 模型调用次数：${record.modelCalls}`);
      lines.push("");
      lines.push("#### 问题");
      lines.push("");
      lines.push(record.question ?? "（旧版 benchmark 记录未保留原问题）");
      lines.push("");
      lines.push("#### 模型回答");
      lines.push("");
      lines.push("```text");
      lines.push(record.actualAnswer ?? "（旧版 benchmark 记录未保留模型回答）");
      lines.push("```");
      lines.push("");
      lines.push("#### 回答摘要");
      lines.push("");
      lines.push("```text");
      lines.push(record.actualSummary ?? "（旧版 benchmark 记录未保留回答摘要）");
      lines.push("```");
      lines.push("");
      lines.push("#### 原文证据");
      lines.push("");
      if ((record.sourceItems?.length ?? 0) > 0) {
        for (const source of record.sourceItems ?? []) {
          lines.push(`- **${source.title}**`);
          lines.push(`  ${source.text}`);
        }
      } else {
        lines.push("- （此旧版 benchmark 记录未保留原文片段）");
      }
      lines.push("");
      lines.push("#### 期望答案应包含");
      lines.push("");
      if ((record.expectedAnswerIncludes ?? []).length > 0) {
        for (const item of record.expectedAnswerIncludes) lines.push(`- ${item}`);
      } else {
        lines.push("- （旧版 benchmark 记录未保留必含清单）");
      }
      lines.push("");
      lines.push("#### 期望答案不应包含");
      lines.push("");
      if ((record.expectedAnswerExcludes ?? []).length > 0) {
        for (const item of record.expectedAnswerExcludes ?? []) lines.push(`- ${item}`);
      } else {
        lines.push("- 无");
      }
      lines.push("");
      lines.push("#### AI评审");
      lines.push("");
      if (record.answerReview) {
        lines.push(`- 结论：${reviewVerdictLabels[record.answerReview.verdict]}`);
        lines.push(`- 摘要：${record.answerReview.summary}`);
        lines.push(`- 预期答案概括：${record.answerReview.expectedAnswerSummary}`);
        lines.push(`- 实际答案概括：${record.answerReview.actualAnswerSummary}`);
        lines.push("");
        lines.push("#### AI评审 - 差异点");
        lines.push("");
        if (record.answerReview.differences.length > 0) {
          for (const difference of record.answerReview.differences) {
            lines.push(`- ${difference.aspect}`);
            lines.push(`  - 预期：${difference.expected}`);
            lines.push(`  - 实际：${difference.actual}`);
            lines.push(`  - 影响：${difference.impact}`);
          }
        } else {
          lines.push("- 无明显结构化差异。");
        }
        lines.push("");
        lines.push("#### AI评审 - 原文 / 预期 / 实际对应");
        lines.push("");
        if (record.answerReview.sourceComparisons.length > 0) {
          for (const comparison of record.answerReview.sourceComparisons) {
            lines.push(`- ${comparison.sourceTitle}｜预期=${reviewRoleLabels[comparison.expectedRole]}｜实际=${reviewRoleLabels[comparison.actualRole]}`);
            lines.push(`  - 原文：${comparison.sourceTextExcerpt}`);
            lines.push(`  - 说明：${comparison.note}`);
          }
        } else {
          lines.push("- 未生成原文级比较。");
        }
        lines.push("");
        lines.push("#### AI评审 - 改进建议");
        lines.push("");
        if (record.answerReview.improvementActions.length > 0) {
          for (const action of record.answerReview.improvementActions) lines.push(`- ${action}`);
        } else {
          lines.push("- 无。");
        }
      } else {
        lines.push("- （此旧版 benchmark 记录未保留结构化 AI 评审结果）");
      }
      lines.push("");
      lines.push("#### 未命中的关键点");
      lines.push("");
      if (record.answerMisses.length > 0) {
        for (const item of record.answerMisses) lines.push(`- ${item}`);
      } else {
        lines.push("- 无");
      }
      lines.push("");
      lines.push("#### 违反排除项");
      lines.push("");
      if (record.answerExcludesViolated.length > 0) {
        for (const item of record.answerExcludesViolated) lines.push(`- ${item}`);
      } else {
        lines.push("- 无");
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
