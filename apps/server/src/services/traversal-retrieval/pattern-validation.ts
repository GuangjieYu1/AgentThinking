import type { Chunk, TraversalRetrievalPattern, TraversalScoutResult } from "@agent-thinking/contracts";
import { TableRoleAdapter } from "./table-role-adapter.js";
import { hasNumericSignal, normalizeText } from "./utils.js";

export type PatternValidationResult =
  | { status: "valid"; reason: string }
  | { status: "weak"; reason: string }
  | { status: "invalid"; reason: string; suggestedFallback?: TraversalRetrievalPattern };

export interface PatternValidationInput {
  pattern: TraversalRetrievalPattern;
  chunks: Chunk[];
  scout?: TraversalScoutResult | undefined;
  fallbackPatterns?: TraversalRetrievalPattern[] | undefined;
  consecutiveParagraphThreshold?: number | undefined;
}

interface ClassifiedCounts {
  headerCount: number;
  dataRowCount: number;
  stableDataRowCount: number;
  summaryCount: number;
  paragraphRun: number;
  hasNumeric: boolean;
}

function sameShapeKey(text: string): string {
  const normalized = normalizeText(text);
  const hasUnit = /亿元|万元|千元|元|亿|万|%/.test(normalized) ? "unit" : "number";
  const separators = [
    /\|/.test(normalized) ? "pipe" : "",
    /\t/.test(normalized) ? "tab" : "",
    / {2,}/.test(normalized) ? "spaces" : "",
    /[,，]/.test(normalized) ? "comma" : "",
  ].filter(Boolean).join("+");
  const labelShape = /^[\p{Script=Han}A-Za-z0-9（）()]{1,24}\s+/u.test(normalized) ? "label" : "free";
  return `${labelShape}:${separators || "plain"}:${hasUnit}`;
}

function classifiedCounts(input: PatternValidationInput): ClassifiedCounts {
  const roleAdapter = new TableRoleAdapter();
  const dataRowShapes = new Map<string, number>();
  let headerCount = 0;
  let dataRowCount = 0;
  let summaryCount = 0;
  let paragraphRun = 0;
  let currentParagraphRun = 0;
  let hasNumeric = false;

  for (const chunk of [...input.chunks].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
    const role = roleAdapter.classify(chunk).role;
    hasNumeric = hasNumeric || hasNumericSignal(chunk.text);
    if (role === "header") headerCount += 1;
    if (role === "summary") summaryCount += 1;
    if (role === "data_row") {
      dataRowCount += 1;
      const key = `${normalizeText(chunk.headingPath)}:${sameShapeKey(chunk.text)}`;
      dataRowShapes.set(key, (dataRowShapes.get(key) ?? 0) + 1);
    }
    if (role === "paragraph") {
      currentParagraphRun += 1;
      paragraphRun = Math.max(paragraphRun, currentParagraphRun);
    } else {
      currentParagraphRun = 0;
    }
  }

  const plannedRows = input.scout?.tableHarvestPlan?.dataRowChunkIds.length ?? 0;
  const stableDataRowCount = Math.max(plannedRows, ...dataRowShapes.values(), 0);
  return {
    headerCount,
    dataRowCount,
    stableDataRowCount,
    summaryCount,
    paragraphRun,
    hasNumeric,
  };
}

export class PatternValidation {
  validate(input: PatternValidationInput): PatternValidationResult {
    if (input.pattern !== "table_horizontal") {
      return { status: "valid", reason: `pattern ${input.pattern} does not require table-horizontal validation` };
    }

    const threshold = Math.max(1, Math.trunc(input.consecutiveParagraphThreshold ?? 3));
    const counts = classifiedCounts(input);
    const hasHeaderSignal = counts.headerCount > 0 || Boolean(input.scout?.tableHarvestPlan?.headerChunkId);
    const hasDataRowSignal = counts.stableDataRowCount >= 2 || Boolean(input.scout?.tableHarvestPlan?.dataStartChunkId);
    const hasSummarySignal = counts.summaryCount > 0 || Boolean(input.scout?.tableHarvestPlan?.finalSummaryChunkId);
    const strongSignals = [hasHeaderSignal, hasDataRowSignal, hasSummarySignal].filter(Boolean).length;

    if (counts.paragraphRun >= threshold && !hasHeaderSignal && !hasDataRowSignal && !hasSummarySignal) {
      const suggestedFallback = input.fallbackPatterns?.[0];
      return {
        status: "invalid",
        reason: `pattern_invalid: ${counts.paragraphRun} consecutive paragraph chunks and no header/data_row/summary table signal`,
        ...(suggestedFallback ? { suggestedFallback } : {}),
      };
    }

    if (strongSignals >= 2) {
      return {
        status: "valid",
        reason: `table_horizontal has ${strongSignals} strong signals: header=${hasHeaderSignal}, data_row=${hasDataRowSignal}, summary=${hasSummarySignal}`,
      };
    }

    if (hasSummarySignal && !hasDataRowSignal) {
      return { status: "weak", reason: "summary signal exists without stable data_row evidence" };
    }
    if (counts.hasNumeric) {
      return { status: "weak", reason: "numeric signal exists without stable table row shape" };
    }

    return { status: "weak", reason: "insufficient table_horizontal signal; traversal may continue cautiously" };
  }
}

export function validatePattern(input: PatternValidationInput): PatternValidationResult {
  return new PatternValidation().validate(input);
}
