import { createHash } from "node:crypto";
import type {
  CitationLocator,
  ContextUnit,
  GenericEvidenceRole,
  NumericStructuredValue,
  PulseEvidenceReconciliation,
  PulseEvidenceRow,
  PulseQuestionPlan,
  QuoteMatchLevel,
  RetrievalUnit,
} from "@agent-thinking/contracts";

const exactAggregationRoles = new Set<string>(["itemized_value", "source_value", "normalized_value"]);
const excludedRoles = new Set<string>([
  "declared_total",
  "stated_total",
  "component_value",
  "approximate_value",
  "excluded_value",
  "disputed_value",
  "background_value",
  "unexpanded_value",
]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeQuote(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[，]/g, ",")
    .replace(/[。]/g, ".")
    .replace(/[；]/g, ";")
    .replace(/[：]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveCitationLocator(input: {
  quote: string;
  contextUnit: ContextUnit;
  retrievalUnit?: RetrievalUnit | undefined;
  sourceNodeId?: string | null | undefined;
}): CitationLocator {
  const normalizedQuote = normalizeQuote(input.quote);
  const normalizedText = normalizeQuote(input.contextUnit.text);
  const exactIndex = input.contextUnit.text.indexOf(input.quote);
  const normalizedIndex = normalizedText.indexOf(normalizedQuote);
  const matchLevel: QuoteMatchLevel = exactIndex >= 0 ? "exact" : normalizedIndex >= 0 ? "normalized" : "not_found";
  const startChar = exactIndex >= 0 ? exactIndex : null;
  const endChar = exactIndex >= 0 ? exactIndex + input.quote.length : null;
  const occurrenceIndex = matchLevel === "not_found"
    ? undefined
    : normalizedText.slice(0, Math.max(0, normalizedIndex)).split(normalizedQuote).length - 1;
  const contextAround = startChar === null ? { beforeText: "", afterText: "" } : {
    beforeText: input.contextUnit.text.slice(Math.max(0, startChar - 120), startChar),
    afterText: input.contextUnit.text.slice(endChar ?? startChar, (endChar ?? startChar) + 120),
  };
  return {
    versionId: input.contextUnit.versionId,
    contextUnitId: input.contextUnit.id,
    contextUnitStableKey: input.contextUnit.stableKey,
    retrievalUnitId: input.retrievalUnit?.id ?? null,
    sourceNodeId: input.sourceNodeId ?? input.contextUnit.primarySourceNodeId ?? null,
    quote: input.quote,
    normalizedQuote,
    quoteHash: hash(`${input.contextUnit.versionId}:${normalizedQuote}`),
    locatorHash: hash(`${input.contextUnit.versionId}:${input.contextUnit.stableKey}:${normalizedQuote}:${occurrenceIndex ?? 0}`),
    ...(occurrenceIndex !== undefined ? { occurrenceIndex } : {}),
    ...contextAround,
    startChar,
    endChar,
    pageNumber: input.retrievalUnit?.pageNumber ?? null,
    startLine: input.retrievalUnit?.startLine ?? null,
    endLine: input.retrievalUnit?.endLine ?? null,
    matchLevel,
    validationWarnings: matchLevel === "normalized" ? ["normalized_quote_match"] : matchLevel === "not_found" ? ["quote_not_found"] : [],
  };
}

export function normalizeNumericValue(originalText: string): NumericStructuredValue | undefined {
  const normalized = originalText.normalize("NFKC").replaceAll(",", "");
  const match = /[-+]?\d+(?:\.\d+)?/.exec(normalized);
  if (!match) return undefined;
  const originalValue = Number(match[0]);
  if (!Number.isFinite(originalValue)) return undefined;
  const approximate = /约|左右|余|多|approximately|about/i.test(normalized);
  const percent = /%|百分比|百分之/.test(normalized);
  const unitMatch = /(万|千|百|元|美元|%|个|件|次|年|月|日|米|公里|kg|千克)/i.exec(normalized);
  const normalizedUnit = percent ? "%" : unitMatch?.[1];
  return {
    originalText,
    originalValue,
    originalUnit: unitMatch?.[1],
    normalizedValue: originalValue,
    normalizedUnit,
    approximate,
    ...(approximate ? { lowerBound: originalValue, upperBound: originalValue } : {}),
    exactForAggregation: !approximate,
    valueKind: percent ? "percentage" : normalizedUnit ? "other" : "count",
    normalizationWarnings: approximate ? ["approximate_value_excluded_from_exact_aggregation"] : [],
  };
}

function roleFor(row: PulseEvidenceRow): string {
  const structured = row.structuredValue && typeof row.structuredValue === "object" && !Array.isArray(row.structuredValue)
    ? row.structuredValue as Record<string, unknown>
    : {};
  return String(row.role ?? structured.role ?? structured.kind ?? "").toLowerCase();
}

function numericFor(row: PulseEvidenceRow): number | undefined {
  const structured = row.structuredValue && typeof row.structuredValue === "object" && !Array.isArray(row.structuredValue)
    ? row.structuredValue as Record<string, unknown>
    : {};
  const value = structured.normalizedValue ?? structured.normalizedAmountWan ?? structured.amountWan ?? structured.amount ?? structured.value;
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function shouldCountInAggregation(row: PulseEvidenceRow): boolean {
  if (row.countedInAggregation !== undefined) return row.countedInAggregation;
  const role = roleFor(row);
  if (excludedRoles.has(role)) return false;
  const structured = row.structuredValue && typeof row.structuredValue === "object" && !Array.isArray(row.structuredValue)
    ? row.structuredValue as Record<string, unknown>
    : {};
  if (structured.exactForAggregation === false || structured.approximate === true) return false;
  if (row.citation?.matchLevel === "fuzzy" || row.citation?.matchLevel === "not_found") return false;
  return exactAggregationRoles.has(role) || (!role && row.countedInAnswer !== false);
}

export function validateEvidenceRow(row: PulseEvidenceRow, contextUnit?: ContextUnit, retrievalUnit?: RetrievalUnit): PulseEvidenceRow {
  const warnings = new Set(row.warnings ?? []);
  let citation = row.citation;
  if (!citation && contextUnit && row.evidenceQuote.trim()) {
    citation = resolveCitationLocator({ quote: row.evidenceQuote, contextUnit, retrievalUnit, sourceNodeId: row.treeNodeId });
  }
  for (const warning of citation?.validationWarnings ?? []) warnings.add(warning);
  const role = row.role ?? (row.evidenceType === "amount" ? "itemized_value" satisfies GenericEvidenceRole : undefined);
  const countedInAggregation = shouldCountInAggregation({ ...row, ...(citation ? { citation } : {}), ...(role ? { role } : {}) });
  if (citation?.matchLevel === "not_found") warnings.add("unsupported_quote");
  if (citation?.matchLevel === "fuzzy") warnings.add("fuzzy_quote_excluded_from_high_risk_aggregation");
  return {
    ...row,
    ...(role ? { role } : {}),
    ...(contextUnit ? {
      contextUnitId: contextUnit.id,
      versionId: contextUnit.versionId,
      headingPath: contextUnit.headingPath,
    } : {}),
    ...(retrievalUnit ? { retrievalUnitId: retrievalUnit.id } : {}),
    ...(citation ? { citation } : {}),
    countedInAggregation,
    warnings: [...warnings],
  };
}

export function computeGenericReconciliation(rows: PulseEvidenceRow[]): PulseEvidenceReconciliation | undefined {
  const numericRows = rows.filter((row) => numericFor(row) !== undefined);
  if (numericRows.length === 0) return undefined;
  const declared = numericRows
    .filter((row) => ["declared_total", "stated_total"].includes(roleFor(row)))
    .map((row) => numericFor(row)!)
    .filter(Number.isFinite);
  const exactItems = numericRows
    .filter(shouldCountInAggregation)
    .map((row) => numericFor(row)!)
    .filter(Number.isFinite);
  if (declared.length === 0 && exactItems.length === 0) return undefined;
  const declaredTotal = declared[0];
  const exactItemizedSum = exactItems.length > 0 ? Number(exactItems.reduce((sum, value) => sum + value, 0).toFixed(6)) : undefined;
  const difference = declaredTotal !== undefined && exactItemizedSum !== undefined
    ? Number((declaredTotal - exactItemizedSum).toFixed(6))
    : undefined;
  const closed = difference !== undefined ? Math.abs(difference) <= 0.0001 : false;
  return {
    ...(declaredTotal !== undefined ? { declaredTotal } : {}),
    ...(exactItemizedSum !== undefined ? { itemizedSum: exactItemizedSum, exactItemizedSum } : {}),
    ...(difference !== undefined ? { difference } : {}),
    closed,
    explanation: difference === undefined
      ? "Structured numeric evidence does not contain both a stated total and exact itemized values."
      : closed
        ? "The stated total and exact itemized values reconcile within tolerance."
        : `The stated total and exact itemized values differ by ${difference}.`,
    warnings: rows.some((row) => row.citation?.matchLevel === "fuzzy" || row.citation?.matchLevel === "not_found")
      ? ["unsupported_or_fuzzy_quotes_excluded"]
      : [],
  };
}

export function normalizeAnswerMode(plan: PulseQuestionPlan): {
  answerMode: "evidence_heavy" | "citation_supported" | "summary_answer";
  reason: string;
  overridden: boolean;
} {
  if (
    plan.questionType === "numerical_aggregation" ||
    plan.questionType === "exhaustive_list" ||
    plan.questionType === "timeline" ||
    plan.requiresNumericalReconciliation ||
    plan.requiresExhaustiveEvidence
  ) {
    return { answerMode: "evidence_heavy", reason: "Question requires exhaustive, timeline, or numerical evidence.", overridden: true };
  }
  if (plan.requiresSourceQuotes) return { answerMode: "citation_supported", reason: "Question requires source quotes.", overridden: false };
  return { answerMode: "summary_answer", reason: "Question can be answered as a guarded summary.", overridden: false };
}

export function overclaimErrors(answer: string, plan: PulseQuestionPlan, sufficient: boolean): string[] {
  if (sufficient) return [];
  if (!plan.answerMustExposeGaps && !plan.requiresExhaustiveEvidence) return [];
  return /全部|每一|完整|无遗漏|complete|all|every/i.test(answer)
    ? ["insufficient_evidence_overclaim"]
    : [];
}
