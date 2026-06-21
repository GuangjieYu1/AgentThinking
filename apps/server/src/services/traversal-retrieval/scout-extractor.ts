import type {
  Chunk,
  TableHarvestPlan,
  TraversalCompletenessType,
  TraversalScoutDeclaration,
  TraversalScoutResult,
} from "@agent-thinking/contracts";
import { TableRoleAdapter, type TableRoleClassification } from "./table-role-adapter.js";
import { byOrdinal } from "./utils.js";
import { normalizeText, termOverlap, uniqueStrings } from "./utils.js";

export interface ScoutExtractorInput {
  question: string;
  chunks: Chunk[];
  completenessType: TraversalCompletenessType;
  maxRounds?: number;
}

interface NumericMention {
  value: number;
  unit?: string | undefined;
  metric: string;
  bindingColumn?: string | undefined;
  sourceChunkId: string;
  text: string;
  score: number;
}

interface ClassifiedChunk {
  chunk: Chunk;
  classification: TableRoleClassification;
}

const numericPattern = /([-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[-+]?\d+(?:\.\d+)?)(\s*(?:亿元|万元|千元|元|亿|万|%))?/g;
const metricPattern = /([\p{Script=Han}A-Za-z0-9（）()]{2,24}?)(?:为|是|达|合计|总计|小计|:|：)?\s*[-+]?\d/u;
const unitPattern = /(?:单位[:：]?\s*)?(亿元|万元|千元|元|亿|万|%)/;

function parseNumber(raw: string): number | undefined {
  const normalized = raw.replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeUnit(unit: string | undefined): string | undefined {
  const value = unit?.trim();
  return value || undefined;
}

function metricFromText(text: string, question: string, headingPath?: string | null | undefined): string {
  const normalized = normalizeText(text);
  const metricMatch = normalized.match(metricPattern)?.[1]?.trim();
  // 排除合计/总计/小计等汇总关键字作为 metric
  const summaryKeywords = /^(合计|总计|小计|汇总|total|subtotal|summary)$/i;
  if (metricMatch && metricMatch.length <= 24 && !summaryKeywords.test(metricMatch)) return metricMatch;
  // 优先使用 headingPath 作为 metric，因为它更语义化
  if (headingPath) return headingPath;
  const questionTerms = uniqueStrings(question.match(/[\p{Script=Han}A-Za-z0-9]{2,}/gu) ?? []);
  return questionTerms.slice(0, 2).join("/") || "数值指标";
}

function bindingColumnFromText(text: string): string | undefined {
  const normalized = normalizeText(text);
  if (/金额|余额|总额|规模|数量|比例|占比/.test(normalized)) {
    return normalized.match(/(?:金额|余额|总额|规模|数量|比例|占比)/)?.[0];
  }
  return undefined;
}

function confidenceFromScore(score: number): "low" | "medium" | "high" {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function numericMentions(question: string, chunks: Chunk[]): NumericMention[] {
  const mentions: NumericMention[] = [];
  for (const chunk of chunks) {
    const text = normalizeText(chunk.text);
    for (const match of text.matchAll(numericPattern)) {
      const value = parseNumber(match[1] ?? "");
      if (value === undefined) continue;
      const before = text.slice(Math.max(0, match.index - 36), match.index).trim();
      const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 24).trim();
      const context = `${before} ${match[0]} ${after}`.trim();
      const metric = metricFromText(`${before} ${after}`, question, chunk.headingPath);
      const unit = normalizeUnit(match[2]) ?? normalizeUnit(text.match(unitPattern)?.[1]);
      const metricScore = termOverlap(question, `${metric} ${context}`);
      const summaryBoost = /合计|总计|总额|总数|总规模|总募集|总收入/.test(context) ? 0.22 : 0;
      const unitBoost = unit ? 0.08 : 0;
      mentions.push({
        value,
        ...(unit ? { unit } : {}),
        metric,
        ...(bindingColumnFromText(context) ? { bindingColumn: bindingColumnFromText(context) } : {}),
        sourceChunkId: chunk.id,
        text: context,
        score: Math.min(1, metricScore + summaryBoost + unitBoost),
      });
    }
  }
  return mentions.sort((left, right) => right.score - left.score || Math.abs(right.value) - Math.abs(left.value));
}

function mentionForChunk(mentions: NumericMention[], chunkId: string): NumericMention | undefined {
  return mentions.find((mention) => mention.sourceChunkId === chunkId);
}

function sameHeadingPath(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizeText(left) === normalizeText(right);
}

function planConfidence(input: {
  headerChunkId?: string | undefined;
  dataStartChunkId?: string | undefined;
  finalSummaryChunkId?: string | undefined;
  dataRowCount: number;
  subtotalCount: number;
  finalMentionScore?: number | undefined;
}): number {
  let score = 0;
  if (input.headerChunkId) score += 0.2;
  if (input.dataStartChunkId) score += 0.25;
  if (input.finalSummaryChunkId) score += 0.3;
  score += Math.min(0.1, input.dataRowCount * 0.03);
  if (input.subtotalCount > 0) score += 0.1;
  score += Math.min(0.15, Math.max(0, input.finalMentionScore ?? 0) * 0.15);
  return Math.min(1, Number(score.toFixed(4)));
}

function buildTableHarvestPlan(input: {
  question: string;
  chunks: Chunk[];
  mentions: NumericMention[];
  declared: NumericMention | undefined;
}): TableHarvestPlan | undefined {
  const roleAdapter = new TableRoleAdapter();
  const classified = input.chunks
    .map((chunk): ClassifiedChunk => ({ chunk, classification: roleAdapter.classify(chunk) }))
    .sort((left, right) => byOrdinal(left.chunk, right.chunk));
  const summaryChunks = classified.filter((entry) => entry.classification.role === "summary");
  const finalSummary = summaryChunks.find((entry) =>
    (entry.classification.indicator === "total" || entry.classification.indicator === "final_total") &&
    mentionForChunk(input.mentions, entry.chunk.id)
  );
  const finalMention = finalSummary ? mentionForChunk(input.mentions, finalSummary.chunk.id) : input.declared;
  if (!finalSummary || !finalMention) return undefined;

  const headingPath = finalSummary?.chunk.headingPath ?? input.chunks.find((chunk) => chunk.id === finalMention.sourceChunkId)?.headingPath ?? null;
  if (!headingPath) return undefined;
  const sameSection = classified.filter((entry) => sameHeadingPath(entry.chunk.headingPath, headingPath));
  const dataRows = sameSection.filter((entry) =>
    entry.classification.role === "data_row" &&
    entry.chunk.ordinal < finalSummary.chunk.ordinal
  );
  const dataStart = dataRows[0];
  if (!dataStart) return undefined;

  const header = sameSection
    .filter((entry) => entry.classification.role === "header" && entry.chunk.ordinal <= dataStart.chunk.ordinal)
    .sort((left, right) => right.chunk.ordinal - left.chunk.ordinal)[0] ??
    classified
      .filter((entry) => entry.classification.role === "header" && entry.chunk.ordinal <= dataStart.chunk.ordinal)
      .sort((left, right) => right.chunk.ordinal - left.chunk.ordinal)[0];
  if (!header) return undefined;
  const subtotalChunkIds = sameSection
    .filter((entry) =>
      entry.classification.role === "summary" &&
      entry.classification.indicator === "subtotal" &&
      entry.chunk.ordinal > dataStart.chunk.ordinal &&
      entry.chunk.ordinal < finalSummary.chunk.ordinal
    )
    .map((entry) => entry.chunk.id);
  return {
    headerChunkId: header.chunk.id,
    dataStartChunkId: dataStart.chunk.id,
    dataRowChunkIds: dataRows.map((entry) => entry.chunk.id),
    subtotalChunkIds,
    finalSummaryChunkId: finalSummary.chunk.id,
    declaredValue: finalMention.value,
    unit: finalMention.unit ?? "",
    metric: finalMention.metric,
    headingPath,
    confidence: planConfidence({
      headerChunkId: header?.chunk.id,
      dataStartChunkId: dataStart.chunk.id,
      finalSummaryChunkId: finalSummary?.chunk.id,
      dataRowCount: dataRows.length,
      subtotalCount: subtotalChunkIds.length,
      finalMentionScore: finalMention.score,
    }),
  };
}

function declarationFromMention(mention: NumericMention, question: string): TraversalScoutDeclaration {
  return {
    value: mention.value,
    ...(mention.unit ? { unit: mention.unit } : {}),
    metric: mention.metric,
    scope: question,
    sourceChunkId: mention.sourceChunkId,
    ...(mention.bindingColumn ? { bindingColumn: mention.bindingColumn } : {}),
    confidence: confidenceFromScore(mention.score),
  };
}

export class ScoutExtractor {
  extract(input: ScoutExtractorInput): TraversalScoutResult {
    const maxRounds = Math.max(1, Math.min(Math.trunc(input.maxRounds ?? 2), 2));
    if (input.completenessType === "none") {
      return {
        phase: "scout",
        targets: [],
        maxRounds,
        confidence: "medium",
        competingDeclarations: [],
        calibrationStatus: "not_applicable",
      };
    }

    const targets = input.completenessType === "sum_alignment"
      ? ["header", "summary", "unit", "rowBoundary"]
      : input.completenessType === "row_count"
        ? ["header", "summary", "rowBoundary"]
        : input.completenessType === "timeline_end"
          ? ["header", "summary", "rowBoundary"]
          : ["header", "rowBoundary"];
    const mentions = numericMentions(input.question, input.chunks);
    const tableHarvestPlan = input.completenessType === "sum_alignment"
      ? buildTableHarvestPlan({
        question: input.question,
        chunks: input.chunks,
        mentions,
        declared: mentions[0],
      })
      : undefined;

    if (input.completenessType === "entity_boundary") {
      return {
        phase: "scout",
        targets,
        maxRounds,
        confidence: mentions.length > 0 ? "low" : "medium",
        competingDeclarations: mentions.slice(0, 5).map((mention) => declarationFromMention(mention, input.question)),
        calibrationStatus: mentions.length > 0 ? "calibration_missing" : "not_applicable",
      };
    }

    const declared = tableHarvestPlan?.finalSummaryChunkId
      ? mentionForChunk(mentions, tableHarvestPlan.finalSummaryChunkId)
      : input.completenessType === "sum_alignment"
        ? mentions.find((mention) => {
          const role = new TableRoleAdapter().classify(input.chunks.find((chunk) => chunk.id === mention.sourceChunkId)!);
          return role.role === "summary" && (role.indicator === "total" || role.indicator === "final_total");
        })
        : mentions[0];
    if (!declared) {
      return {
        phase: "scout",
        targets,
        maxRounds,
        confidence: "low",
        competingDeclarations: [],
        calibrationStatus: "calibration_missing",
      };
    }

    const declaration = declarationFromMention(declared, input.question);
    return {
      phase: "scout",
      targets,
      maxRounds,
      declaredValue: declaration.value,
      ...(declaration.unit ? { unit: declaration.unit } : {}),
      metric: declaration.metric,
      scope: declaration.scope,
      sourceChunkId: declaration.sourceChunkId,
      ...(declaration.bindingColumn ? { bindingColumn: declaration.bindingColumn } : {}),
      confidence: declaration.confidence,
      ...(tableHarvestPlan ? { tableHarvestPlan } : {}),
      competingDeclarations: mentions
        .filter((mention) => !(tableHarvestPlan?.subtotalChunkIds.includes(mention.sourceChunkId) ?? false))
        .filter((mention) => mention.sourceChunkId !== declared.sourceChunkId || mention.value !== declared.value)
        .slice(0, 8)
        .map((mention) => declarationFromMention(mention, input.question)),
      calibrationStatus: "calibrated",
    };
  }
}
