import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EvidencePack, PulseResponse } from "@agent-thinking/contracts";
import { getConfig } from "../../apps/server/src/config.js";
import { AgentDatabase } from "../../apps/server/src/db.js";
import { createModelProvider } from "../../apps/server/src/services/models.js";
import { PulseEngine } from "../../apps/server/src/services/pulse.js";
import { VectorStore } from "../../apps/server/src/services/vector-store.js";

const libraryName = "南航年报测试-txt清洁版";
const iterations = 2;
const mode = "progressive" as const;
const reportCitationLimit = 8;
const reportEvidenceRowLimit = 12;
const reportHitLimit = 10;

const questions = [
  "存续债券余额合计是多少亿元？请列出计算过程。",
  "报告期内存续含到期债务融资工具募集资金总额合计是多少亿元？",
  "“存续债券余额”和“募集资金总额”有什么区别？为什么不能混算？",
  "报告期内是否存在募集资金用途变更？",
  "执行《企业会计准则解释第17号》对其他流动负债、应付债券分别有什么影响？",
  "请验证解释第17号导致的负债重分类是否闭合。",
  "会计差错更正一共涉及哪些调整事项？",
  "受限资产包括哪些类别？合计金额是多少？",
  "受限货币资金由哪些项目构成？分项是否加总闭合？",
  "公司对飞行学员贷款提供了什么担保？担保总额、已发放贷款、实际履责金额分别是多少？",
  "报告中有哪些事项明确写明“不涉及”？",
  "如果用户问“南航集团报告期内债务融资工具是否存在违约”，这份报告能支持什么结论？不能支持什么结论？",
];

interface RunRecord {
  questionIndex: number;
  iteration: number;
  question: string;
  pulseId?: string;
  answer?: string;
  summary?: string;
  error?: string;
  durationMs: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  hits: Array<{ type: string; id: string; label: string; score: number }>;
  citations: Array<{ heading?: string; pageNumber?: number | null; chunkId?: string }>;
  evidenceRows: Array<{
    rowId: string;
    type: string;
    role: string;
    usage: string;
    chunkId: string;
    claim: string;
  }>;
  gaps: Array<{ type: string; description: string; severity?: string }>;
  pipeline?: string | undefined;
  answerMode?: string | undefined;
}

function applyGlobalModelSettings(config: ReturnType<typeof getConfig>, db: AgentDatabase): void {
  if (!process.env.AI_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    const dbApiKey = db.getGlobalSetting("deepseekApiKey");
    if (dbApiKey) config.aiApiKey = dbApiKey;
  }
  if (!process.env.AI_BASE_URL) {
    const dbBaseUrl = db.getGlobalSetting("aiBaseUrl");
    if (dbBaseUrl) config.aiBaseUrl = dbBaseUrl;
  }
  if (!process.env.AI_CHAT_MODEL) {
    const dbChatModel = db.getGlobalSetting("aiChatModel");
    if (dbChatModel) config.chatModel = dbChatModel;
  }
}

function compact(value: string | undefined | null, max = 420): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function escapeTableCell(value: string | number | undefined | null): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function metric(response: PulseResponse | undefined, key: "durationMs" | "modelCalls" | "promptTokens" | "completionTokens" | "totalTokens" | "promptCacheHitTokens" | "promptCacheMissTokens"): number {
  return Number(response?.pulse.metrics?.[key] ?? 0);
}

function evidenceRows(pack: EvidencePack | undefined): RunRecord["evidenceRows"] {
  return (pack?.evidenceRows ?? []).slice(0, reportEvidenceRowLimit).map((row) => ({
    rowId: row.rowId,
    type: row.evidenceType,
    role: row.role ?? "-",
    usage: row.usage ?? "-",
    chunkId: row.evidenceChunkId,
    claim: row.claimText,
  }));
}

function citations(pack: EvidencePack | undefined): RunRecord["citations"] {
  return (pack?.citations ?? []).slice(0, reportCitationLimit).map((citation) => ({
    heading: Array.isArray(citation.headingPath) ? citation.headingPath.join(" / ") : citation.headingPath ?? "",
    pageNumber: citation.pageNumber,
    chunkId: citation.chunkId,
  }));
}

function gaps(pack: EvidencePack | undefined): RunRecord["gaps"] {
  return (pack?.gaps ?? []).map((gap) => ({
    type: gap.type,
    description: gap.description,
    severity: gap.severity,
  }));
}

function recordFromResponse(questionIndex: number, iteration: number, question: string, response: PulseResponse, durationMs: number): RunRecord {
  return {
    questionIndex,
    iteration,
    question,
    pulseId: response.pulse.id,
    answer: response.pulse.answer,
    summary: response.pulse.summary,
    durationMs,
    modelCalls: metric(response, "modelCalls"),
    promptTokens: metric(response, "promptTokens"),
    completionTokens: metric(response, "completionTokens"),
    totalTokens: metric(response, "totalTokens"),
    promptCacheHitTokens: metric(response, "promptCacheHitTokens"),
    promptCacheMissTokens: metric(response, "promptCacheMissTokens"),
    hits: response.hits.slice(0, reportHitLimit).map((hit) => ({
      type: hit.targetType,
      id: hit.targetId,
      label: hit.label,
      score: hit.score,
    })),
    citations: citations(response.evidencePack),
    evidenceRows: evidenceRows(response.evidencePack),
    gaps: gaps(response.evidencePack),
    pipeline: response.evidencePack?.pipeline?.packBuilder,
    answerMode: response.evidencePack?.answerMode,
  };
}

function recordFromError(questionIndex: number, iteration: number, question: string, error: unknown, durationMs: number): RunRecord {
  return {
    questionIndex,
    iteration,
    question,
    error: error instanceof Error ? error.message : String(error),
    durationMs,
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    hits: [],
    citations: [],
    evidenceRows: [],
    gaps: [],
  };
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderMarkdown(input: {
  libraryId: string;
  libraryName: string;
  provider: string;
  model: string;
  createdAt: string;
  records: RunRecord[];
}): string {
  const successRecords = input.records.filter((record) => !record.error);
  const totalTokens = successRecords.reduce((sum, record) => sum + record.totalTokens, 0);
  const totalDuration = successRecords.reduce((sum, record) => sum + record.durationMs, 0);
  const lines: string[] = [
    "# 南航年报 Golden Case Test",
    "",
    "## 测试设置",
    "",
    `- 知识库：${input.libraryName}`,
    `- Library ID：${input.libraryId}`,
    `- 执行模式：${mode}`,
    `- 每题执行次数：${iterations}`,
    `- Provider：${input.provider}`,
    `- Model：${input.model}`,
    `- 生成时间：${input.createdAt}`,
    "- 说明：本次小 golden set 只提供问题，没有提供人工标准答案；报告记录 AORI Progressive 的原始回答、证据与消耗，供后续人工判分或补充 gold answer。",
    "- 说明：当前项目默认 AORI 答案模式会优先使用已导入知识库的 AORI 切面索引；因此本报告测的是“基于 AORI 索引后的脉冲问答”，不是不索引直接回答的 baseline。",
    "- 说明：为提升可读性，本报告省略引用原文 quote 与 hit excerpt；如需回查原文，请通过 chunk id / row id 定位 evidence pack 或知识库片段。",
    "",
    "## 总览",
    "",
    `- 总问题数：${questions.length}`,
    `- 总执行次数：${input.records.length}`,
    `- 成功次数：${successRecords.length}`,
    `- 失败次数：${input.records.length - successRecords.length}`,
    `- 总耗时：${(totalDuration / 1000).toFixed(1)}s`,
    `- 平均耗时：${average(successRecords.map((record) => record.durationMs)).toFixed(1)}ms / run`,
    `- 总 token：${totalTokens}`,
    `- 平均 token：${average(successRecords.map((record) => record.totalTokens)).toFixed(1)} / run`,
    "",
    "## 问题级汇总",
    "",
    "| # | 问题 | 成功 | 平均耗时 | 平均 Token | 平均模型调用 |",
    "|---|---|---:|---:|---:|---:|",
  ];

  for (let index = 1; index <= questions.length; index += 1) {
    const records = input.records.filter((record) => record.questionIndex === index);
    const successes = records.filter((record) => !record.error);
    lines.push([
      index,
      escapeTableCell(questions[index - 1]),
      `${successes.length}/${records.length}`,
      `${average(successes.map((record) => record.durationMs)).toFixed(1)}ms`,
      average(successes.map((record) => record.totalTokens)).toFixed(1),
      average(successes.map((record) => record.modelCalls)).toFixed(1),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push("", "## 逐题明细", "");

  for (let index = 1; index <= questions.length; index += 1) {
    const records = input.records.filter((record) => record.questionIndex === index);
    lines.push(`### ${index}. ${questions[index - 1]}`, "", "> 人工标准答案：待补充。", "");
    for (const record of records) {
      lines.push(
        `#### Run ${record.iteration}`,
        "",
        `- Pulse ID：${record.pulseId ?? "-"}`,
        `- Pipeline：${record.pipeline ?? "-"} / Answer Mode：${record.answerMode ?? "-"}`,
        `- 耗时：${record.durationMs}ms`,
        `- Token：prompt ${record.promptTokens} / completion ${record.completionTokens} / total ${record.totalTokens}`,
        `- 模型调用：${record.modelCalls}`,
      );
      if (record.promptCacheHitTokens || record.promptCacheMissTokens) {
        lines.push(`- Prompt cache：hit ${record.promptCacheHitTokens} / miss ${record.promptCacheMissTokens}`);
      }
      if (record.error) {
        lines.push("", `**错误：** ${record.error}`, "");
        continue;
      }
      lines.push("", "**模型回答**", "", record.answer ?? "", "", `**摘要**：${record.summary ?? "-"}`, "");

      if (record.gaps.length > 0) {
        lines.push("**Gaps**", "");
        for (const gap of record.gaps) lines.push(`- ${gap.type}${gap.severity ? ` / ${gap.severity}` : ""}：${gap.description}`);
        lines.push("");
      }

      if (record.citations.length > 0) {
        lines.push("**Citations**", "", "| Chunk | Heading | Page |", "|---|---|---:|");
        for (const citation of record.citations) {
          lines.push(`| ${escapeTableCell(citation.chunkId)} | ${escapeTableCell(citation.heading)} | ${escapeTableCell(citation.pageNumber)} |`);
        }
        lines.push("");
      }

      if (record.evidenceRows.length > 0) {
        lines.push("**Evidence Rows**", "", "| Row | Type | Role | Usage | Chunk | Claim |", "|---|---|---|---|---|---|");
        for (const row of record.evidenceRows) {
          lines.push(`| ${escapeTableCell(row.rowId)} | ${escapeTableCell(row.type)} | ${escapeTableCell(row.role)} | ${escapeTableCell(row.usage)} | ${escapeTableCell(row.chunkId)} | ${escapeTableCell(compact(row.claim, 220))} |`);
        }
        lines.push("");
      }

      if (record.hits.length > 0) {
        lines.push("**Pulse Hits**", "", "| Type | ID | Label | Score |", "|---|---|---|---:|");
        for (const hit of record.hits) {
          lines.push(`| ${escapeTableCell(hit.type)} | ${escapeTableCell(hit.id)} | ${escapeTableCell(hit.label)} | ${hit.score.toFixed(3)} |`);
        }
        lines.push("");
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const config = getConfig();
  const db = new AgentDatabase(config.dataDir);
  applyGlobalModelSettings(config, db);

  const library = db.listLibraries().find((entry) => entry.name === libraryName);
  if (!library) throw new Error(`找不到知识库：${libraryName}`);

  const vectors = new VectorStore(db);
  const model = createModelProvider(config);
  const engine = new PulseEngine(db, vectors, model, { aoriAnswerMode: config.aoriAnswerMode });
  const records: RunRecord[] = [];
  const createdAt = new Date().toISOString();

  try {
    for (const [questionOffset, question] of questions.entries()) {
      const questionIndex = questionOffset + 1;
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        const startedAt = Date.now();
        console.log(`[${questionIndex}/${questions.length}] run ${iteration}/${iterations}: ${question}`);
        try {
          const response = await engine.create(library.id, question, mode);
          records.push(recordFromResponse(questionIndex, iteration, question, response, Date.now() - startedAt));
        } catch (error) {
          records.push(recordFromError(questionIndex, iteration, question, error, Date.now() - startedAt));
          console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const report = renderMarkdown({
      libraryId: library.id,
      libraryName: library.name,
      provider: config.provider,
      model: config.chatModel ?? "-",
      createdAt,
      records,
    });
    const reportsDir = resolve(import.meta.dirname, "../reports");
    await mkdir(reportsDir, { recursive: true });
    const stamp = createdAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const outputPath = join(reportsDir, `csair-golden-progressive-${stamp}.md`);
    await writeFile(outputPath, report, "utf8");
    console.log(`Report written: ${outputPath}`);
  } finally {
    db.close();
  }
}

await main();
