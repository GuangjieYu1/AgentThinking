import type {
  Chunk,
  TraversalCompletenessType,
  TraversalScoutDeclaration,
  TraversalScoutResult,
} from "@agent-thinking/contracts";
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

function metricFromText(text: string, question: string): string {
  const normalized = normalizeText(text);
  const metricMatch = normalized.match(metricPattern)?.[1]?.trim();
  if (metricMatch && metricMatch.length <= 24) return metricMatch;
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
      const metric = metricFromText(`${before} ${after}`, question);
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

    const declared = mentions[0];
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
      competingDeclarations: mentions
        .filter((mention) => mention.sourceChunkId !== declared.sourceChunkId || mention.value !== declared.value)
        .slice(0, 8)
        .map((mention) => declarationFromMention(mention, input.question)),
      calibrationStatus: "calibrated",
    };
  }
}
