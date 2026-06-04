import type {
  AbstractNodeKind,
  AoriDocumentDraft,
  AoriIndexingStage,
  AoriRiskLevel,
  AspectKind,
  Chunk,
  Citation,
  ExtractionOutput,
  GraphRuleStage,
  MappingAudit,
  MappingAuditResult,
  MappingAuditStatus,
  ModelTestResult,
  PulseAnswerContext,
  PulseAnswerOutput,
  PulseEvidenceMemory,
  PulseEvidencePlan,
  PulseEvidenceRow,
  PulseEvidenceStatus,
  PulseEvidenceStep,
  PulseQuestionPlan,
  PulseNavigationCandidate,
  PulseNavigationDecision,
  RelationType,
  StatementPrecheckOutput,
} from "@agent-thinking/contracts";
import {
  abstractNodeKinds,
  aoriDocumentDraftSchema,
  aspectKinds,
  extractionSchema,
  mappingAuditFindingKinds,
  mappingAuditResultSchema,
  mappingAuditSeverities,
  mappingAuditStatuses,
  pulseAnswerSchema,
  pulseEvidencePlanSchema,
  pulseEvidenceRowSchema,
  pulseEvidenceStatusSchema,
  pulseNavigationDecisionSchema,
  pulseQuestionPlanSchema,
  relationTypes,
  statementPrecheckSchema,
} from "@agent-thinking/contracts";
import { ZodError } from "zod";
import type { AppConfig } from "../config.js";
import { applyGraphRulesToExtraction, type GraphRulesResult } from "./graphRules.js";

export interface MappingAuditNodeContext {
  id: string;
  kind: AbstractNodeKind;
  title: string;
  summary: string;
  level: 1 | 2;
  evidenceChunkIds: string[];
}

export interface MappingAuditRelationContext {
  id: string;
  type: RelationType;
  sourceNodeId: string;
  sourceTitle: string;
  targetNodeId: string;
  targetTitle: string;
  reason: string;
  confidence: number | null;
  evidenceChunkIds: string[];
}

export interface MappingAuditContext {
  versionId: string;
  documentName: string;
  chunks: Chunk[];
  nodes: MappingAuditNodeContext[];
  relations: MappingAuditRelationContext[];
  note?: string;
}

export interface AoriExtractionContext {
  stage: AoriIndexingStage;
  groupId: string;
  documentName: string;
  documentTokenEstimate: number;
  inputTokenEstimate: number;
  usedTokenEstimate: number;
  preservedRanges: string[];
  omittedRanges: string[];
  truncated: boolean;
  risk: AoriRiskLevel;
  minTruncatedContextTokens: number;
  evidenceBindingMinContextTokens: number;
  allowSmallContextOnlyForQuoteLookup: boolean;
}

interface ExtractionRuleOptions {
  stage?: GraphRuleStage;
  onGraphRules?: (result: GraphRulesResult) => void;
  aoriContext?: AoriExtractionContext | undefined;
}

interface FinalizedExtraction {
  output: ExtractionOutput;
  graphRules: GraphRulesResult;
}

interface ExtractionOutputLimits {
  maxNodes: number;
  maxRelations: number;
  maxThemes: number;
}

type MappingAuditReview = Pick<MappingAuditResult, "status" | "summary" | "findings">;
const mappingAuditReviewSchema = mappingAuditResultSchema.omit({ reconstruction: true });
const auditTextLimits = {
  summary: 1000,
  title: 80,
  description: 800,
  suggestion: 400,
};
const truncationSuffix = "...（已截断）";

function stripModelFences(value: string): string {
  return value.trim().replace(/^```(?:json|markdown|md)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function jsonCandidate(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : undefined;
}

function parseJsonModelObject(raw: string): unknown {
  const cleaned = stripModelFences(raw);
  const candidates = [cleaned, jsonCandidate(cleaned)].filter((candidate): candidate is string => Boolean(candidate));
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型返回了不可解析的 JSON");
}

function modelText(raw: string): string {
  const cleaned = stripModelFences(raw);
  try {
    const parsed = parseJsonModelObject(cleaned) as { reconstruction?: unknown };
    if (typeof parsed.reconstruction === "string" && parsed.reconstruction.trim()) {
      return parsed.reconstruction.trim();
    }
  } catch {
    // Plain text is the preferred format for reconstruction; malformed JSON is shown as text.
  }
  return cleaned;
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - truncationSuffix.length))}${truncationSuffix}`;
}

function normalizedText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return truncateText(text || fallback, max);
}

function normalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizedAuditEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return allowed.includes(text as T) ? text as T : text;
}

function sanitizeMappingAuditReview(value: unknown): unknown {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const findings = Array.isArray(source.findings) ? source.findings.slice(0, 5).map((entry) => {
    const finding = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    return {
      kind: normalizedAuditEnum(finding.kind, mappingAuditFindingKinds, "other"),
      severity: normalizedAuditEnum(finding.severity, mappingAuditSeverities, "medium"),
      title: normalizedText(finding.title, "审计发现", auditTextLimits.title),
      description: normalizedText(
        finding.description,
        "审计模型没有提供具体说明，请对照相关原文与图谱节点人工核对。",
        auditTextLimits.description,
      ),
      suggestion: normalizedText(
        finding.suggestion,
        "重新运行审计，或手动核对相关 chunk、节点和关系。",
        auditTextLimits.suggestion,
      ),
      evidenceChunkIds: normalizedStringArray(finding.evidenceChunkIds),
      nodeIds: normalizedStringArray(finding.nodeIds),
      relationIds: normalizedStringArray(finding.relationIds),
      userComment: normalizedText(finding.userComment, "", 1200),
    };
  }) : [];
  return {
    status: normalizedAuditEnum(source.status, mappingAuditStatuses, "failed" satisfies MappingAuditStatus),
    summary: normalizedText(source.summary, "审计模型没有提供摘要。", auditTextLimits.summary),
    findings,
  };
}

function parseMappingAuditReview(raw: string): MappingAuditReview {
  return mappingAuditReviewSchema.parse(sanitizeMappingAuditReview(parseJsonModelObject(raw)));
}

function fallbackPulseQuestionPlan(): PulseQuestionPlan {
  return {
    questionType: "normal",
    requiresExhaustiveEvidence: false,
    requiresStructuredEvidence: true,
    requiresNumericalReconciliation: false,
    requiresSourceQuotes: true,
    requiresTimelineCompleteness: false,
    requiresEntityCoverage: false,
    allowedPartialAnswer: true,
    answerMustExposeGaps: true,
    evidenceTargets: ["answerable source evidence", "source quotes", "remaining gaps"],
    keyEntities: [],
    expectedEvidenceTypes: ["quote", "claim", "fact"],
    riskLevel: "medium",
    reasoning: "Planner fallback: use conservative evidence requirements and expose gaps when context is incomplete.",
  };
}

function fallbackPulseEvidencePlan(question: string, mode: PulseAnswerContext["mode"], tools: string[]): PulseEvidencePlan {
  const available = new Set(tools);
  const preferred = [
    { tool: "semanticSearchChildChunks", query: question, purpose: "Find semantically related child chunks.", expectedResult: "Relevant source child chunks." },
    { tool: "fullTextSearchChildChunks", query: question, purpose: "Find literal source matches in child chunks.", expectedResult: "Chunks with explicit wording from the question." },
    { tool: "retrieveSummaryTree", query: question, purpose: "Find section or document summaries for broader context.", expectedResult: "Relevant summary tree nodes." },
    { tool: "graphSearch", query: question, purpose: "Find graph context that may point to source evidence.", expectedResult: "Relevant nodes and relations." },
  ].filter((step) => available.has(step.tool));
  return {
    objective: "Build a question-focused evidence pack from generic retrieval tools.",
    steps: preferred as PulseEvidenceStep[],
    stopCondition: "Stop when source-backed evidence can answer the question or remaining gaps are explicit.",
    expectedEvidenceShape: "Source chunks, quotes, and structured evidence rows with chunk citations.",
    maxIterations: mode === "progressive" ? 4 : 2,
  };
}

function cleanPulseEvidenceRows(rowsValue: unknown, allowedChunkIds: Set<string>): PulseEvidenceRow[] {
  const rows = Array.isArray(rowsValue) ? rowsValue : (rowsValue && typeof rowsValue === "object" && Array.isArray((rowsValue as { rows?: unknown }).rows) ? (rowsValue as { rows: unknown[] }).rows : []);
  return rows.flatMap((entry, index): PulseEvidenceRow[] => {
    const parsed = pulseEvidenceRowSchema.safeParse({
      ...(entry && typeof entry === "object" ? entry as Record<string, unknown> : {}),
      rowId: entry && typeof entry === "object" && typeof (entry as { rowId?: unknown }).rowId === "string"
        ? (entry as { rowId: string }).rowId
        : `row-${index + 1}`,
    });
    if (!parsed.success) return [];
    if (!allowedChunkIds.has(parsed.data.evidenceChunkId)) return [];
    return [parsed.data];
  });
}

function cleanAoriDraft(value: unknown, chunks: Chunk[]): AoriDocumentDraft {
  const allowedChunkIds = new Set(chunks.map((chunk) => chunk.id));
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawUnderstanding = source.understanding && typeof source.understanding === "object" && !Array.isArray(source.understanding)
    ? source.understanding as Record<string, unknown>
    : {};
  const fallbackSummary = chunks.map((chunk) => chunk.text).join("\n\n").slice(0, 1200) || "AORI 没有可用原文。";
  const aspects = (Array.isArray(source.aspects) ? source.aspects : []).slice(0, 24).map((entry, aspectIndex) => {
    const aspect = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const rawItems = Array.isArray(aspect.items) ? aspect.items : [];
    const items = rawItems.slice(0, 80).map((itemEntry, itemIndex) => {
      const item = itemEntry && typeof itemEntry === "object" && !Array.isArray(itemEntry) ? itemEntry as Record<string, unknown> : {};
      const evidenceChunkIds = safeEvidenceIds(item.evidenceChunkIds, allowedChunkIds);
      const fallbackChunk = chunks.find((chunk) => evidenceChunkIds.includes(chunk.id)) ?? chunks[itemIndex % Math.max(1, chunks.length)];
      return {
        key: normalizedText(item.key, `a${aspectIndex + 1}_i${itemIndex + 1}`, 100),
        title: normalizedText(item.title, fallbackChunk ? firstSentence(fallbackChunk.text, `切面条目 ${itemIndex + 1}`) : `切面条目 ${itemIndex + 1}`, 240),
        summary: normalizedText(item.summary, fallbackChunk?.text.slice(0, 500) ?? "模型未提供条目摘要。", 2000),
        evidenceChunkIds: evidenceChunkIds.length > 0 ? evidenceChunkIds : (fallbackChunk ? [fallbackChunk.id] : []),
        sourceNodeIds: normalizedStringArray(item.sourceNodeIds),
      };
    });
    const itemKeys = new Set(items.map((item) => item.key));
    const relations = (Array.isArray(aspect.relations) ? aspect.relations : []).slice(0, 160).flatMap((relationEntry) => {
      const relation = relationEntry && typeof relationEntry === "object" && !Array.isArray(relationEntry) ? relationEntry as Record<string, unknown> : {};
      const sourceKey = typeof relation.sourceKey === "string" ? relation.sourceKey.trim() : "";
      const targetKey = typeof relation.targetKey === "string" ? relation.targetKey.trim() : "";
      if (!itemKeys.has(sourceKey) || !itemKeys.has(targetKey)) return [];
      return [{
        sourceKey,
        targetKey,
        relationTextInSource: typeof relation.relationTextInSource === "string" ? truncateText(relation.relationTextInSource.trim(), 240) : undefined,
        normalizedRelation: typeof relation.normalizedRelation === "string" ? truncateText(relation.normalizedRelation.trim(), 240) : undefined,
        baseRelation: relationTypes.includes(relation.baseRelation as RelationType) ? relation.baseRelation as RelationType : "related_to",
        reason: normalizedText(relation.reason, "模型未提供关系理由。", 1000),
        confidence: safeConfidence(relation.confidence),
        evidenceChunkIds: safeEvidenceIds(relation.evidenceChunkIds, allowedChunkIds),
      }];
    });
    return {
      title: normalizedText(aspect.title, `切面 ${aspectIndex + 1}`, 240),
      summary: normalizedText(aspect.summary, "模型未提供切面摘要。", 3000),
      centralQuestion: normalizedText(aspect.centralQuestion, "该切面的中心问题是什么？", 1000),
      items,
      relations,
      gaps: Array.isArray(aspect.gaps) ? aspect.gaps.slice(0, 20).flatMap((gapEntry) => {
        const gap = gapEntry && typeof gapEntry === "object" && !Array.isArray(gapEntry) ? gapEntry as Record<string, unknown> : {};
        const description = typeof gap.description === "string" ? gap.description.trim() : "";
        if (!description) return [];
        return [{
          description: truncateText(description, 1000),
          severity: gap.severity === "low" || gap.severity === "high" ? gap.severity : "medium" as const,
          evidenceChunkIds: safeEvidenceIds(gap.evidenceChunkIds, allowedChunkIds),
        }];
      }) : [],
    };
  });
  const fallbackAspect = aspects.length > 0 ? aspects : [{
    title: "全局切面",
    summary: fallbackSummary.slice(0, 1000),
    centralQuestion: "这份文档的核心内容是什么？",
    items: chunks.slice(0, 12).map((chunk, index) => ({
      key: `fallback_${index + 1}`,
      title: chunk.headingPath || firstSentence(chunk.text, `条目 ${index + 1}`),
      summary: chunk.text.slice(0, 500),
      evidenceChunkIds: [chunk.id],
      sourceNodeIds: chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : [],
    })),
    relations: [],
    gaps: [],
  }];
  return aoriDocumentDraftSchema.parse({
    understanding: {
      summary: normalizedText(rawUnderstanding.summary, fallbackSummary, 4000),
      centralQuestion: normalizedText(rawUnderstanding.centralQuestion, "这份文档的核心问题是什么？", 1000),
      centralNodeTitle: typeof rawUnderstanding.centralNodeTitle === "string" ? truncateText(rawUnderstanding.centralNodeTitle.trim(), 240) : undefined,
      evidenceChunkIds: safeEvidenceIds(rawUnderstanding.evidenceChunkIds, allowedChunkIds),
    },
    aspects: fallbackAspect,
    selfQuestions: (Array.isArray(source.selfQuestions) ? source.selfQuestions : []).slice(0, 24).flatMap((entry) => {
      const question = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      const text = typeof question.question === "string" ? question.question.trim() : "";
      if (!text) return [];
      return [{
        question: truncateText(text, 1000),
        answer: typeof question.answer === "string" && question.answer.trim() ? truncateText(question.answer.trim(), 2000) : undefined,
        evidenceChunkIds: safeEvidenceIds(question.evidenceChunkIds, allowedChunkIds),
        status: question.status === "answered" || question.status === "gap" ? question.status : "unchecked",
      }];
    }),
    reflectiveReport: {
      summary: typeof (source.reflectiveReport as { summary?: unknown } | undefined)?.summary === "string"
        ? (source.reflectiveReport as { summary: string }).summary
        : "AORI draft 已完成基础反思检查。",
      completenessRisk: ["none", "low", "medium", "high"].includes(String((source.reflectiveReport as { completenessRisk?: unknown } | undefined)?.completenessRisk))
        ? (source.reflectiveReport as { completenessRisk: "none" | AoriRiskLevel }).completenessRisk
        : "none",
      warnings: normalizedStringArray((source.reflectiveReport as { warnings?: unknown } | undefined)?.warnings),
      truncationCount: Number((source.reflectiveReport as { truncationCount?: unknown } | undefined)?.truncationCount ?? 0),
    },
  });
}

function firstSentence(text: string, fallback: string): string {
  return text.split(/[。\n.!?]/, 1)[0]?.trim() || fallback;
}

function safeAspectArray(value: unknown, fallback: AspectKind[] = []): AspectKind[] {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.filter((entry): entry is AspectKind => aspectKinds.includes(entry as AspectKind)))];
}

function safeEvidenceIds(value: unknown, allowedChunkIds: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => (
    typeof entry === "string" && (!allowedChunkIds.size || allowedChunkIds.has(entry))
  )))];
}

function safeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(1, Math.max(0, numeric));
}

function fallbackExtractionFromChunks(chunks: Chunk[], note = "模型结构化输出不可用，系统生成保守候选。"): ExtractionOutput {
  const selected = chunks.slice(0, 8);
  const nodes = selected.map((chunk, index) => {
    const kind = /认为|证明|应当|导致|因此|所以|主张|结论|claim|therefore/i.test(chunk.text)
      ? "claim" as const
      : "concept" as const;
    return {
      key: `fallback_${index}`,
      kind,
      title: truncateText(chunk.headingPath || firstSentence(chunk.text, `片段 ${index + 1}`), 80),
      summary: truncateText(`${note} ${chunk.text.trim()}`.trim(), 500),
      evidenceChunkIds: [chunk.id],
      aspects: demoAspects(chunk.text, kind),
    };
  });
  return { nodes, relations: [], themes: [] };
}

function extractionOutputLimits(options: ExtractionRuleOptions): ExtractionOutputLimits {
  return options.aoriContext
    ? { maxNodes: 96, maxRelations: 192, maxThemes: 32 }
    : { maxNodes: 32, maxRelations: 64, maxThemes: 12 };
}

function sanitizeExtractionOutput(
  value: unknown,
  allowedChunks: Chunk[],
  fallbackNote?: string,
  limits: ExtractionOutputLimits = { maxNodes: 32, maxRelations: 64, maxThemes: 12 },
): ExtractionOutput {
  const allowedChunkIds = new Set(allowedChunks.map((chunk) => chunk.id));
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes = rawNodes.slice(0, limits.maxNodes).map((entry, index) => {
    const node = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    const key = normalizedText(node.key, `n${index}`, 80);
    const kind = abstractNodeKinds.includes(node.kind as AbstractNodeKind) ? node.kind as AbstractNodeKind : "concept";
    const evidenceChunkIds = safeEvidenceIds(node.evidenceChunkIds, allowedChunkIds);
    const fallbackChunk = allowedChunks.find((chunk) => evidenceChunkIds.includes(chunk.id)) ?? allowedChunks[index % Math.max(1, allowedChunks.length)];
    return {
      key,
      kind,
      title: normalizedText(node.title, fallbackChunk ? firstSentence(fallbackChunk.text, `候选节点 ${index + 1}`) : `候选节点 ${index + 1}`, 180),
      summary: normalizedText(node.summary, fallbackChunk?.text.slice(0, 500) ?? "模型未提供摘要。", 2000),
      evidenceChunkIds: evidenceChunkIds.length > 0 ? evidenceChunkIds : (fallbackChunk ? [fallbackChunk.id] : []),
      aspects: safeAspectArray(node.aspects, demoAspects(String(node.title ?? node.summary ?? fallbackChunk?.text ?? ""), kind)),
    };
  });
  if (nodes.length === 0 && allowedChunks.length > 0) return fallbackExtractionFromChunks(allowedChunks, fallbackNote);
  const nodeKeys = new Set(nodes.map((node) => node.key));
  const rawRelations = Array.isArray(source.relations) ? source.relations : [];
  const relations = rawRelations.slice(0, limits.maxRelations).flatMap((entry) => {
    const relation = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    const sourceKey = typeof relation.sourceKey === "string" ? relation.sourceKey.trim() : "";
    const targetKey = typeof relation.targetKey === "string" ? relation.targetKey.trim() : "";
    if (!sourceKey || !targetKey) return [];
    const rawType = typeof relation.type === "string" ? relation.type.trim() : "";
    const rawConfidence = typeof relation.confidence === "number" ? relation.confidence : Number(relation.confidence);
    const confidence = safeConfidence(relation.confidence);
    const originalType = rawType && !relationTypes.includes(rawType as RelationType) ? rawType : undefined;
    const originalConfidence = Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1 ? undefined : rawConfidence;
    return [{
      sourceKey,
      targetKey,
      type: relationTypes.includes(rawType as RelationType) ? rawType as RelationType : "related_to",
      reason: normalizedText(relation.reason, "模型未提供关系说明。", 1000),
      confidence,
      evidenceChunkIds: safeEvidenceIds(relation.evidenceChunkIds, allowedChunkIds),
      ...(originalType ? { originalType } : {}),
      ...(originalConfidence !== undefined ? { originalConfidence } : {}),
      ruleWarnings: [],
      ruleDecision: "kept" as const,
    }];
  });
  const rawThemes = Array.isArray(source.themes) ? source.themes : [];
  const themes = rawThemes.slice(0, limits.maxThemes).flatMap((entry, index) => {
    const theme = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    const memberKeys = Array.isArray(theme.memberKeys)
      ? [...new Set(theme.memberKeys.filter((key): key is string => typeof key === "string" && nodeKeys.has(key)))]
      : [];
    if (memberKeys.length === 0) return [];
    return [{
      title: normalizedText(theme.title, `主题 ${index + 1}`, 180),
      summary: normalizedText(theme.summary, "模型未提供主题摘要。", 2000),
      memberKeys,
      evidenceChunkIds: safeEvidenceIds(theme.evidenceChunkIds, allowedChunkIds),
      aspects: safeAspectArray(theme.aspects, ["other"]),
    }];
  });
  return extractionSchema.parse({ nodes, relations, themes });
}

function finalizeExtractionOutput(
  value: unknown,
  allowedChunks: Chunk[],
  fallbackNote?: string,
  options: ExtractionRuleOptions = {},
): FinalizedExtraction {
  const sanitized = sanitizeExtractionOutput(value, allowedChunks, fallbackNote, extractionOutputLimits(options));
  const graphRules = applyGraphRulesToExtraction(sanitized, {
    allowedChunks,
    ...(options.stage ? { mode: options.stage } : {}),
  });
  const output = extractionSchema.parse(graphRules.output);
  const finalized = { output, graphRules: { ...graphRules, output } };
  options.onGraphRules?.(finalized.graphRules);
  return finalized;
}

function parseExtractionOutput(
  raw: string,
  allowedChunks: Chunk[],
  fallbackNote?: string,
  options: ExtractionRuleOptions = {},
): FinalizedExtraction {
  return finalizeExtractionOutput(parseJsonModelObject(raw), allowedChunks, fallbackNote, options);
}

function isMappingAuditEnumValidationError(cause: unknown): boolean {
  return cause instanceof ZodError && cause.issues.some((issue) => issue.code === "invalid_enum_value");
}

export interface ModelProvider {
  readonly name: string;
  readonly configured: boolean;
  embed(texts: string[]): Promise<number[][]>;
  extract(chunks: Chunk[], relatedChunks: Map<string, Chunk[]>, options?: ExtractionRuleOptions): Promise<ExtractionOutput>;
  extractAoriDocument(input: {
    documentName: string;
    chunks: Chunk[];
    context: AoriExtractionContext;
  }): Promise<AoriDocumentDraft>;
  precheckStatement(text: string, citations: Citation[]): Promise<StatementPrecheckOutput>;
  reconstructMapping(context: MappingAuditContext): Promise<string>;
  auditMapping(reconstruction: string, originalChunks: Chunk[], graphContext: MappingAuditContext): Promise<MappingAuditReview>;
  rebuildGraphFromMappingAudit(
    audit: MappingAudit,
    originalChunks: Chunk[],
    graphContext: MappingAuditContext,
    options?: ExtractionRuleOptions,
  ): Promise<ExtractionOutput>;
  analyzePulseQuestion(question: string, mode: PulseAnswerContext["mode"]): Promise<PulseQuestionPlan>;
  planPulseEvidence(input: {
    question: string;
    mode: PulseAnswerContext["mode"];
    questionPlan: PulseQuestionPlan;
    memorySummary: unknown;
    tools: string[];
  }): Promise<PulseEvidencePlan>;
  extractPulseEvidenceRows(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    purpose: string;
    chunks: Array<{ id: string; text: string; headingPath: string | null; pageNumber: number | null }>;
    existingRows: PulseEvidenceRow[];
  }): Promise<PulseEvidenceRow[]>;
  judgePulseEvidenceSufficiency(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    memory: unknown;
    computedReconciliation?: unknown;
  }): Promise<PulseEvidenceStatus>;
  synthesizePulseAnswer(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    memory: unknown;
    evidenceStatus: PulseEvidenceStatus;
  }): Promise<PulseAnswerOutput>;
  rewritePulseAnswer(input: {
    question: string;
    draft: PulseAnswerOutput;
    rewriteInstructions: string;
    memory: unknown;
    evidenceStatus: PulseEvidenceStatus;
  }): Promise<PulseAnswerOutput>;
  answerPulse(question: string, context: PulseAnswerContext): Promise<PulseAnswerOutput>;
  selectPulseNavigation(question: string, step: string, candidates: PulseNavigationCandidate[]): Promise<PulseNavigationDecision>;
  stream(prompt: string): AsyncGenerator<{ type: "reasoning" | "content"; text: string }>;
  test(): Promise<ModelTestResult>;
}

function normalizedVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / magnitude);
}

function hashedEmbedding(text: string, dimensions = 384): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const normalized = text.normalize("NFKC").toLowerCase();
  const latinTokens = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjkRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const cjkTokens = cjkRuns.flatMap((run) => {
    const characters = [...run];
    return [
      ...characters,
      ...characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`),
    ];
  });
  for (const token of [...latinTokens, ...cjkTokens]) {
    let hash = 2166136261;
    for (const char of token) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    vector[(hash >>> 0) % dimensions] = (vector[(hash >>> 0) % dimensions] ?? 0) + 1;
  }
  return normalizedVector(vector);
}

function demoAspects(text: string, kind: "concept" | "claim"): AspectKind[] {
  if (kind === "claim") return ["claim"];
  if (/人|用户|研究者|author|person|team/i.test(text)) return ["person"];
  if (/系统|模型|平台|数据集|system|model|dataset|schema|programming/i.test(text)) return ["system"];
  if (/步骤|操作|更新|流程|方法|operation|process|update/i.test(text)) return ["operation"];
  if (/时间|阶段|日期|年|time|date|phase/i.test(text)) return ["time"];
  return ["other"];
}

export class FakeModelProvider implements ModelProvider {
  readonly name = "fake";
  readonly configured = true;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashedEmbedding(text));
  }

  async extract(chunks: Chunk[], _relatedChunks: Map<string, Chunk[]> = new Map(), options: ExtractionRuleOptions = {}): Promise<ExtractionOutput> {
    const selected = chunks.slice(0, options.aoriContext ? 32 : 10);
    const nodes = selected.map((chunk, index) => {
      const opening = chunk.text.split(/[。\n.!?]/, 1)[0]?.trim() || `片段 ${index + 1}`;
      const kind = /因此|所以|therefore|conclusion|should|必须/i.test(chunk.text) ? "claim" as const : "concept" as const;
      return {
        key: `n${index}`,
        kind,
        title: chunk.headingPath || opening.slice(0, 44),
        summary: chunk.text.slice(0, 160),
        evidenceChunkIds: [chunk.id],
        aspects: demoAspects(chunk.text, kind),
      };
    });
    const relations = nodes.slice(1).map((node, index) => ({
      sourceKey: nodes[index]?.key ?? node.key,
      targetKey: node.key,
      type: "related_to" as const,
      reason: "演示模型根据相邻材料生成的待审核关联。",
      confidence: 0.55,
      evidenceChunkIds: [
        ...(nodes[index]?.evidenceChunkIds ?? []),
        ...node.evidenceChunkIds,
      ],
    }));
    const themes = nodes.length > 1 ? [{
      title: "材料主题概览",
      summary: "演示模型归纳的上层主题，用于概览与展开查看。",
      memberKeys: nodes.map((node) => node.key),
      evidenceChunkIds: nodes.flatMap((node) => node.evidenceChunkIds),
      aspects: [...new Set(nodes.flatMap((node) => node.aspects))],
    }] : [];
    return finalizeExtractionOutput({ nodes, relations, themes }, chunks, undefined, { ...options, stage: "extraction" }).output;
  }

  async extractAoriDocument(input: {
    documentName: string;
    chunks: Chunk[];
    context: AoriExtractionContext;
  }): Promise<AoriDocumentDraft> {
    const selected = input.chunks.slice(0, 16);
    const items = selected.map((chunk, index) => ({
      key: `item_${index + 1}`,
      title: chunk.headingPath || firstSentence(chunk.text, `条目 ${index + 1}`),
      summary: chunk.text.slice(0, 300),
      evidenceChunkIds: [chunk.id],
      sourceNodeIds: chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : [],
    }));
    const relations = items.slice(1).map((item, index) => ({
      sourceKey: items[index]?.key ?? item.key,
      targetKey: item.key,
      relationTextInSource: "相邻叙述",
      normalizedRelation: "相邻叙述",
      baseRelation: "related_to" as const,
      reason: "演示模型根据相邻材料生成的 AORI 关系。",
      confidence: 0.55,
      evidenceChunkIds: [...(items[index]?.evidenceChunkIds ?? []), ...item.evidenceChunkIds],
    }));
    return cleanAoriDraft({
      understanding: {
        summary: `${input.documentName} 的 AORI 全局理解。`,
        centralQuestion: "这份文档的核心内容是什么？",
        evidenceChunkIds: selected.flatMap((chunk) => [chunk.id]),
      },
      aspects: [{
        title: "全局理解",
        summary: "演示模型生成的切面，用于验证 AORI 独立产物保存和展示。",
        centralQuestion: "文档整体表达了什么？",
        items,
        relations,
        gaps: input.context.truncated ? [{
          description: "当前 AORI 输入发生截断，部分范围需要人工复核。",
          severity: input.context.risk,
          evidenceChunkIds: [],
        }] : [],
      }],
      selfQuestions: [{
        question: "当前切面是否覆盖了主要证据？",
        answer: input.context.truncated ? "存在截断风险，需要复核。": "已覆盖当前输入范围。",
        evidenceChunkIds: selected.slice(0, 3).map((chunk) => chunk.id),
        status: input.context.truncated ? "gap" : "answered",
      }],
      reflectiveReport: {
        summary: input.context.truncated ? "AORI 输入发生截断。" : "AORI 输入未截断。",
        completenessRisk: input.context.truncated ? input.context.risk : "none",
        warnings: input.context.truncated ? ["AORI global reading used a truncated context group."] : [],
        truncationCount: input.context.truncated ? 1 : 0,
      },
    }, input.chunks);
  }

  async precheckStatement(_text: string, citations: Citation[]): Promise<StatementPrecheckOutput> {
    if (citations.length === 0) {
      return {
        status: "unsupported",
        reason: "尚未关联原文证据，无法验证陈述。",
        suggestions: ["为该陈述添加能够直接支撑其结论或关联关系的原文引用。"],
      };
    }
    return {
      status: "supported",
      reason: "演示模式：该陈述已附带可定位来源，请由审核者核对原文后裁决。",
      suggestions: [],
    };
  }

  async reconstructMapping(context: MappingAuditContext): Promise<string> {
    const chunkOutline = context.chunks
      .slice(0, 8)
      .map((chunk) => `${chunk.ordinal + 1}. ${chunk.headingPath ? `${chunk.headingPath}：` : ""}${chunk.text.slice(0, 120)}`)
      .join("\n");
    const graphOutline = context.nodes
      .slice(0, 8)
      .map((node) => `- ${node.title}：${node.summary || "暂无摘要"}`)
      .join("\n");
    return [
      `演示语义重构：${context.documentName}`,
      "原文片段要点：",
      chunkOutline || "暂无可重构的原文片段。",
      "图谱映射要点：",
      graphOutline || "当前批次没有映射节点。",
    ].join("\n");
  }

  async auditMapping(_reconstruction: string, originalChunks: Chunk[], graphContext: MappingAuditContext): Promise<MappingAuditReview> {
    const firstChunk = originalChunks[0];
    if (graphContext.nodes.length === 0) {
      return {
        status: "major_issues",
        summary: "演示审计发现：当前原文片段没有形成可追踪的 AI 节点，mapping 覆盖不足。",
        findings: [{
          kind: "missing_source_meaning",
          severity: "high",
          title: "原文片段缺少映射节点",
          description: "这些 chunk 已完成切分，但审计上下文中没有可对应的 AI 节点或主题。",
          suggestion: "重新分析该文档，或检查 chunk 是否过长、标题是否缺失、模型抽取是否失败。",
          evidenceChunkIds: firstChunk ? [firstChunk.id] : [],
          nodeIds: [],
          relationIds: [],
          userComment: "",
        }],
      };
    }
    const relationWithoutEvidence = graphContext.relations.find((relation) => relation.evidenceChunkIds.length === 0);
    if (relationWithoutEvidence) {
      return {
        status: "minor_issues",
        summary: "演示审计发现：至少一条 AI 关系缺少直接证据，需要人工核对。",
        findings: [{
          kind: "unsupported_graph_claim",
          severity: "medium",
          title: "关系缺少原文证据",
          description: `关系 ${relationWithoutEvidence.sourceTitle} → ${relationWithoutEvidence.targetTitle} 没有关联证据 chunk。`,
          suggestion: "补充关系证据，或在关系审核中拒绝/改写该关系。",
          evidenceChunkIds: firstChunk ? [firstChunk.id] : [],
          nodeIds: [relationWithoutEvidence.sourceNodeId, relationWithoutEvidence.targetNodeId],
          relationIds: [relationWithoutEvidence.id],
          userComment: "",
        }],
      };
    }
    const firstNode = graphContext.nodes[0]!;
    return {
      status: "minor_issues",
      summary: "演示审计建议：mapping 基本可读，但仍建议核对节点摘要是否保留原文限定条件。",
      findings: [{
        kind: "overgeneralization",
        severity: "low",
        title: "核对节点摘要的限定条件",
        description: `节点“${firstNode.title}”由原文抽象而来，演示审计建议人工确认摘要没有扩大原文含义。`,
        suggestion: "打开相关 chunk，对照节点标题和摘要，必要时手动修改节点摘要或关系说明。",
        evidenceChunkIds: firstNode.evidenceChunkIds.length > 0 ? firstNode.evidenceChunkIds : firstChunk ? [firstChunk.id] : [],
        nodeIds: [firstNode.id],
        relationIds: [],
        userComment: "",
      }],
    };
  }

  async rebuildGraphFromMappingAudit(
    audit: MappingAudit,
    originalChunks: Chunk[],
    graphContext: MappingAuditContext,
    options: ExtractionRuleOptions = {},
  ): Promise<ExtractionOutput> {
    const chunks = originalChunks.length > 0 ? originalChunks : graphContext.chunks.slice(0, 8);
    const nodes = chunks.map((chunk, index) => {
      const finding = audit.findings[index % Math.max(1, audit.findings.length)];
      const opening = chunk.text.trim().split(/\s+/).slice(0, 14).join(" ");
      const kind = finding?.kind === "unsupported_graph_claim" || finding?.kind === "overgeneralization" ? "claim" : "concept";
      return {
        key: `audit-node-${index + 1}`,
        kind: kind as AbstractNodeKind,
        title: finding ? `${finding.title}：${opening.slice(0, 30)}` : chunk.headingPath || opening.slice(0, 44),
        summary: `审计驱动重构：${finding?.description ?? chunk.text.slice(0, 160)}`,
        evidenceChunkIds: [chunk.id],
        aspects: demoAspects(`${chunk.text} ${finding?.title ?? ""}`, kind),
      };
    });
    const relations = nodes.slice(1).map((node, index) => ({
      sourceKey: nodes[index]?.key ?? node.key,
      targetKey: node.key,
      type: "related_to" as const,
      reason: "演示模型基于原文、当前图谱和映射审计报告重新生成的关系建议。",
      confidence: 0.6,
      evidenceChunkIds: [
        ...(nodes[index]?.evidenceChunkIds ?? []),
        ...node.evidenceChunkIds,
      ],
    }));
    const themes = nodes.length > 1 ? [{
      title: "审计驱动重构主题",
      summary: `根据映射审计中 ${audit.findings.length} 个发现，对当前关系图谱进行重新组织后的主题。`,
      memberKeys: nodes.map((node) => node.key),
      evidenceChunkIds: nodes.flatMap((node) => node.evidenceChunkIds),
      aspects: [...new Set(nodes.flatMap((node) => node.aspects))],
    }] : [];
    return finalizeExtractionOutput({ nodes, relations, themes }, originalChunks, undefined, { ...options, stage: "rebuild" }).output;
  }

  async answerPulse(question: string, context: PulseAnswerContext): Promise<PulseAnswerOutput> {
    const topNodes = context.nodes.slice(0, 3).map((node) => node.title).join("、") || "暂无节点";
    const topChunks = context.chunks.slice(0, 2).map((chunk) => chunk.text.slice(0, 80)).join("；") || "暂无证据片段";
    return {
      answer: `演示脉冲回答：问题“${question}”主要激活了 ${topNodes}。相关证据包括：${topChunks}`,
      summary: `激活 ${context.nodes.length} 个节点、${context.relations.length} 条关系、${context.chunks.length} 个证据片段。`,
    };
  }

  async analyzePulseQuestion(_question: string, _mode: PulseAnswerContext["mode"]): Promise<PulseQuestionPlan> {
    return fallbackPulseQuestionPlan();
  }

  async planPulseEvidence(input: {
    question: string;
    mode: PulseAnswerContext["mode"];
    questionPlan: PulseQuestionPlan;
    memorySummary: unknown;
    tools: string[];
  }): Promise<PulseEvidencePlan> {
    return fallbackPulseEvidencePlan(input.question, input.mode, input.tools);
  }

  async extractPulseEvidenceRows(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    purpose: string;
    chunks: Array<{ id: string; text: string; headingPath: string | null; pageNumber: number | null }>;
    existingRows: PulseEvidenceRow[];
  }): Promise<PulseEvidenceRow[]> {
    return input.chunks.slice(0, 12).map((chunk, index) => ({
      rowId: `fake-row-${chunk.id}-${index}`,
      evidenceType: "quote",
      claimText: chunk.text.slice(0, 180) || "证据片段",
      evidenceChunkId: chunk.id,
      evidenceQuote: chunk.text.slice(0, 220) || "证据片段",
      confidence: 0.55,
    }));
  }

  async judgePulseEvidenceSufficiency(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    memory: unknown;
    computedReconciliation?: unknown;
  }): Promise<PulseEvidenceStatus> {
    const reconciliation = input.computedReconciliation as PulseEvidenceStatus["reconciliation"] | undefined;
    return {
      sufficient: Boolean(reconciliation?.closed),
      status: reconciliation && !reconciliation.closed ? "failed_reconciliation" : "partial_answer_only",
      gaps: reconciliation && !reconciliation.closed ? [{
        type: "sum_mismatch",
        description: "演示模型发现结构化证据尚未闭合。",
        suggestedQueries: [input.question],
        severity: "high",
      }] : [],
      reasoning: "演示模型使用保守充分性判断。",
      ...(reconciliation ? { reconciliation } : {}),
    };
  }

  async synthesizePulseAnswer(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    memory: unknown;
    evidenceStatus: PulseEvidenceStatus;
  }): Promise<PulseAnswerOutput> {
    const memory = input.memory as Partial<PulseEvidenceMemory>;
    const quote = memory.evidenceRows?.find((row) => row.evidenceQuote.trim())?.evidenceQuote.trim();
    const gapNote = input.evidenceStatus.gaps.length > 0
      ? ` 当前证据缺口：${input.evidenceStatus.gaps.map((gap) => gap.description).join("；")}`
      : input.evidenceStatus.sufficient ? "" : " 当前证据不足，只能作为部分回答。";
    return {
      answer: `演示脉冲回答：问题“${input.question}”已基于动态证据控制器生成。${quote ? `来源：“${quote}”。` : ""}${gapNote}`,
      summary: `证据控制器状态：${input.evidenceStatus.status}`,
    };
  }

  async rewritePulseAnswer(input: {
    question: string;
    draft: PulseAnswerOutput;
    rewriteInstructions: string;
    memory: unknown;
    evidenceStatus: PulseEvidenceStatus;
  }): Promise<PulseAnswerOutput> {
    return {
      answer: `${input.draft.answer}\n\n校验补充：${input.rewriteInstructions}`,
      summary: input.draft.summary,
    };
  }

  async selectPulseNavigation(question: string, step: string, candidates: PulseNavigationCandidate[]): Promise<PulseNavigationDecision> {
    const terms = question.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
    const ranked = candidates
      .map((candidate) => {
        const text = `${candidate.label} ${candidate.summary} ${candidate.relationLabel ?? ""} ${candidate.relationReason ?? ""}`
          .normalize("NFKC")
          .toLowerCase();
        const matches = terms.filter((term) => text.includes(term)).length;
        return { candidate, score: matches * 2 + candidate.score };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .map((entry) => entry.candidate);
    const selected = ranked.length > 0 ? ranked : candidates.slice(0, 1);
    return {
      selectedIds: selected.map((candidate) => candidate.id),
      observation: `演示模式在“${step}”看到 ${candidates.length} 个候选：${candidates.slice(0, 5).map((candidate) => candidate.label).join("、")}。`,
      rationale: selected.length > 0
        ? `选择 ${selected.map((candidate) => candidate.label).join("、")}，因为它们与问题词或候选分数更接近。`
        : "没有足够候选可继续展开。",
    };
  }

  async *stream(prompt: string): AsyncGenerator<{ type: "content"; text: string }> {
    const response = `演示模型已收到请求：“${prompt.slice(0, 80)}”。配置 DeepSeek 密钥后，此窗口会显示真实的逐段输出。`;
    for (const part of response.match(/.{1,10}/gu) ?? []) {
      yield { type: "content", text: part };
    }
  }

  async test(): Promise<ModelTestResult> {
    return { ok: true, provider: this.name, message: "演示模型已启用；不会发送文档到云端。" };
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;

  constructor(private readonly config: AppConfig) {
    this.name = config.provider === "deepseek" ? "deepseek" : "openai-compatible";
  }

  get configured(): boolean {
    return Boolean(
      this.config.aiApiKey &&
      this.config.chatModel &&
      (this.config.embeddingProvider === "local" ||
        (this.config.embeddingApiKey && this.config.embeddingModel)),
    );
  }

  private async request<T>(baseUrl: string, apiKey: string | undefined, path: string, body: unknown): Promise<T> {
    if (!apiKey) throw new Error(this.config.provider === "deepseek" ? "未配置 DEEPSEEK_API_KEY" : "未配置 AI_API_KEY");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`模型服务请求失败 (${response.status}): ${text.slice(0, 240)}`);
    }
    return response.json() as Promise<T>;
  }

  private async repairMappingAuditJson(raw: string, parseError: unknown): Promise<MappingAuditReview> {
    const errorMessage = parseError instanceof Error ? parseError.message : "JSON parse failed";
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Repair the supplied malformed JSON into valid JSON that matches exactly this shape: " +
            '{"status":"clean|minor_issues|major_issues|failed","summary":"...","findings":[{"kind":"missing_source_meaning|unsupported_graph_claim|wrong_relation|chunk_boundary_loss|overgeneralization|other","severity":"low|medium|high","title":"...","description":"...","suggestion":"...","evidenceChunkIds":["..."],"nodeIds":["..."],"relationIds":["..."]}]}. ' +
            "Preserve the meaning of any recoverable fields. If a field is missing, choose a conservative valid value. " +
            "Keep summary under 1000 characters, each title under 80 characters, each description under 800 characters, each suggestion under 400 characters, and at most 5 findings. " +
            "All human-readable strings must be Simplified Chinese. Return JSON only.",
        },
        { role: "user", content: JSON.stringify({ parseError: errorMessage, malformedJson: raw.slice(0, 12000) }) },
      ],
      max_tokens: 1_000_000,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const repaired = response.choices[0]?.message.content ?? "{}";
    return parseMappingAuditReview(repaired);
  }

  private async repairExtractionJson(
    raw: string,
    parseError: unknown,
    allowedChunks: Chunk[],
    options: ExtractionRuleOptions = {},
  ): Promise<ExtractionOutput> {
    const errorMessage = parseError instanceof Error ? parseError.message : "JSON parse failed";
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Repair the supplied malformed knowledge-graph JSON into valid JSON matching exactly this shape: " +
            '{"nodes":[{"key":"n1","kind":"concept|claim","title":"...","summary":"...","evidenceChunkIds":["..."],"aspects":["system"]}],"relations":[{"sourceKey":"n1","targetKey":"n2","type":"supports|contradicts|explains|depends_on|example_of|related_to","reason":"...","confidence":0.8,"evidenceChunkIds":["..."]}],"themes":[{"title":"...","summary":"...","memberKeys":["n1"],"evidenceChunkIds":["..."],"aspects":["other"]}]}. ' +
            "Use only the supplied allowedChunkIds in evidenceChunkIds. Use only valid relation types and aspects. " +
            "If a field is missing, choose a conservative valid value. All human-readable strings must be Simplified Chinese. Return JSON only.",
        },
        { role: "user", content: JSON.stringify({ parseError: errorMessage, allowedChunkIds: allowedChunks.map((chunk) => chunk.id), malformedJson: raw.slice(0, 14000) }) },
      ],
      max_tokens: 4096,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    return parseExtractionOutput(
      response.choices[0]?.message.content ?? "{}",
      allowedChunks,
      "模型修复后仍缺少结构化字段。",
      options,
    ).output;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.config.embeddingProvider === "local") return texts.map((text) => hashedEmbedding(text));
    if (!this.config.embeddingModel) throw new Error("未配置 AI_EMBEDDING_MODEL");
    const result = await this.request<{ data: Array<{ embedding: number[]; index: number }> }>(
      this.config.embeddingBaseUrl,
      this.config.embeddingApiKey,
      "/embeddings",
      { model: this.config.embeddingModel, input: texts },
    );
    return result.data.sort((left, right) => left.index - right.index).map((item) => item.embedding);
  }

  async extract(
    chunks: Chunk[],
    relatedChunks: Map<string, Chunk[]>,
    options: ExtractionRuleOptions = {},
  ): Promise<ExtractionOutput> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const aori = options.aoriContext;
    const evidence = chunks.map((chunk) => ({
      id: chunk.id,
      source: chunk.headingPath ?? (chunk.pageNumber ? `PDF page ${chunk.pageNumber}` : ""),
      ordinal: chunk.ordinal,
      estimatedTokens: Math.max(1, Math.ceil(chunk.text.length / 4)),
      text: aori ? chunk.text : chunk.text.slice(0, 2400),
      candidates: (relatedChunks.get(chunk.id) ?? []).map((candidate) => ({
        id: candidate.id,
        source: candidate.headingPath ?? (candidate.pageNumber ? `PDF page ${candidate.pageNumber}` : ""),
        ordinal: candidate.ordinal,
        estimatedTokens: Math.max(1, Math.ceil(candidate.text.length / 4)),
        text: aori ? candidate.text : candidate.text.slice(0, 1200),
      })),
    }));
    const compactExtractionPrompt =
      "You extract a compact knowledge graph from evidence chunks. Return JSON with this shape: " +
      '{"nodes":[{"key":"n1","kind":"concept","title":"...","summary":"...","evidenceChunkIds":["..."],"aspects":["system"]}],' +
      '"relations":[{"sourceKey":"n1","targetKey":"n2","type":"supports","reason":"...","confidence":0.8,"evidenceChunkIds":["..."]}],' +
      '"themes":[{"title":"...","summary":"...","memberKeys":["n1","n2"],"evidenceChunkIds":["..."],"aspects":["system"]}]}. ' +
      "Node kind is concept or claim. Relation type must be supports, contradicts, explains, depends_on, example_of, or related_to. " +
      "Every node and theme must include an aspects array (it may be empty) chosen from person, operation, system, story, claim, conflict, time, other. " +
      "Create a small number of themes only when multiple nodes share a defensible higher-level subject; themes organize navigation and must cite evidence. " +
      "Candidate evidence may come from other documents and should be used to identify contradictions. " +
      "Every node and relation must cite evidenceChunkIds from supplied evidence or candidate ids; only create defensible relationships. " +
      "Use Simplified Chinese for every title, summary, and reason. Keep nodes atomic and source-faithful: preserve uncertainty, hearsay, temporal order, and who claims what. " +
      "Do not turn enemy/opposition, sequence, or narrative tension into contradicts unless the source states a logical contradiction. " +
      "Prefer 1-4 high-value relations for each central chunk when the source or candidate chunks explicitly support them; avoid isolated nodes when a clear relation exists. " +
      "Relation Governance Rules: " +
      "1. Only use allowed relation types. " +
      "2. Co-occurrence is not a strong relation. " +
      "3. Strong relations require direct evidence. " +
      "4. related_to is the weakest fallback relation. " +
      "5. Direction matters. " +
      "6. Contradiction requires same scope. " +
      "7. If unsure, omit the relation or use related_to with low confidence.";
    const aoriExtractionPrompt =
      "AORI indexing mode. First read the supplied full document or large context group globally, then generate aspects, aspect items, self-check questions, relation vocabulary, candidate nodes, themes, and relations. " +
      "Do not treat the supplied chunks as independent small retrieval windows. They are source-locator and evidence-binding units only. " +
      "If the context is truncated, reason from the preserved ranges and expose uncertainty in summaries or relation reasons where coverage may be incomplete. " +
      "Never infer from omitted ranges. Do not use paragraph-sized or sentence-sized fragments as the main understanding unit; small chunks are only for quote lookup and evidence backtracking. " +
      `When this group is truncated, its usedTokenEstimate must be at least ${aori?.minTruncatedContextTokens ?? 10_000} unless the remaining original text is smaller. ` +
      "Return JSON with exactly this shape: " +
      '{"nodes":[{"key":"n1","kind":"concept|claim","title":"...","summary":"...","evidenceChunkIds":["..."],"aspects":["person|operation|system|story|claim|conflict|time|other"]}],' +
      '"relations":[{"sourceKey":"n1","targetKey":"n2","type":"supports|contradicts|explains|depends_on|example_of|related_to","reason":"...","confidence":0.8,"evidenceChunkIds":["..."]}],' +
      '"themes":[{"title":"...","summary":"...","memberKeys":["n1","n2"],"evidenceChunkIds":["..."],"aspects":["system"]}]}. ' +
      "Every node, relation, and theme must cite evidenceChunkIds from supplied evidence ids. Use Simplified Chinese for every title, summary, and reason. " +
      "Relation Governance Rules: only use allowed relation types; co-occurrence is not a strong relation; strong relations require direct evidence; direction matters; contradiction requires same scope; if unsure, omit the relation or use related_to with low confidence. " +
      "Closure Check: before returning, check whether important sections in the supplied large context group are missing from nodes/themes, and prefer adding a source-faithful node over over-compressing unrelated meanings.";
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: aori ? aoriExtractionPrompt : compactExtractionPrompt,
        },
        { role: "user", content: JSON.stringify(aori ? { aoriContext: aori, evidence } : { evidence }) },
      ],
      max_tokens: aori ? 12000 : 4096,
    };
    if (this.config.provider === "deepseek") {
      body.thinking = { type: this.config.thinkingMode };
    }
    const response = await this.request<{
      choices: Array<{ message: { content: string } }>;
    }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
    const raw = response.choices[0]?.message.content ?? "{}";
    const allowedChunks = [
      ...chunks,
      ...chunks.flatMap((chunk) => relatedChunks.get(chunk.id) ?? []),
    ];
    try {
      return parseExtractionOutput(
        raw,
        allowedChunks,
        "模型抽取结构化输出不可用，系统生成保守导入候选。",
        { ...options, stage: "extraction" },
      ).output;
    } catch (cause) {
      try {
        return await this.repairExtractionJson(raw, cause, allowedChunks, { ...options, stage: "extraction" });
      } catch {
        return finalizeExtractionOutput(
          fallbackExtractionFromChunks(chunks, "模型结构化输出修复失败，系统生成保守导入候选。"),
          allowedChunks,
          undefined,
          { ...options, stage: "extraction" },
        ).output;
      }
    }
  }

  async extractAoriDocument(input: {
    documentName: string;
    chunks: Chunk[];
    context: AoriExtractionContext;
  }): Promise<AoriDocumentDraft> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const evidence = input.chunks.map((chunk) => ({
      id: chunk.id,
      source: chunk.headingPath ?? (chunk.pageNumber ? `PDF page ${chunk.pageNumber}` : `chunk ${chunk.ordinal + 1}`),
      ordinal: chunk.ordinal,
      estimatedTokens: Math.max(1, Math.ceil(chunk.text.length / 4)),
      text: chunk.text,
    }));
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are building an Aspect-Oriented Reflective Index (AORI), not the legacy enum graph. " +
            "Read the supplied large document context as a whole, then return JSON only. " +
            "Every item, relation, self-question answer, and global understanding must cite evidenceChunkIds from the supplied evidence ids. " +
            "Aspect relations must use sourceKey/targetKey from the same aspect items. " +
            "The formal document relation name must come from relationTextInSource or normalizedRelation; baseRelation is only a compatibility enum. " +
            "Do not invent relation names without source evidence. If coverage is incomplete, add gaps. " +
            "Use Simplified Chinese for human-readable text. Return exactly this shape: " +
            '{"understanding":{"summary":"...","centralQuestion":"...","centralNodeTitle":"...","evidenceChunkIds":["chunk-id"]},' +
            '"aspects":[{"title":"...","summary":"...","centralQuestion":"...","items":[{"key":"i1","title":"...","summary":"...","evidenceChunkIds":["chunk-id"],"sourceNodeIds":["optional-tree-node-id"]}],' +
            '"relations":[{"sourceKey":"i1","targetKey":"i2","relationTextInSource":"source phrase","normalizedRelation":"document relation name","baseRelation":"supports|contradicts|explains|depends_on|example_of|related_to","reason":"...","confidence":0.8,"evidenceChunkIds":["chunk-id"]}],' +
            '"gaps":[{"description":"...","severity":"low|medium|high","evidenceChunkIds":["chunk-id"]}]}],' +
            '"selfQuestions":[{"question":"...","answer":"...","evidenceChunkIds":["chunk-id"],"status":"answered|gap|unchecked"}],' +
            '"reflectiveReport":{"summary":"...","completenessRisk":"none|low|medium|high","warnings":["..."],"truncationCount":0}}',
        },
        {
          role: "user",
          content: JSON.stringify({
            documentName: input.documentName,
            aoriContext: input.context,
            evidence,
          }),
        },
      ],
      max_tokens: 12000,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{
      choices: Array<{ message: { content: string } }>;
    }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
    const raw = response.choices[0]?.message.content ?? "{}";
    try {
      return cleanAoriDraft(parseJsonModelObject(raw), input.chunks);
    } catch {
      return cleanAoriDraft({}, input.chunks);
    }
  }

  async precheckStatement(text: string, citations: Citation[]): Promise<StatementPrecheckOutput> {
    if (citations.length === 0) {
      return {
        status: "unsupported",
        reason: "尚未关联原文证据，无法验证陈述。",
        suggestions: ["补充直接支持该陈述及其关系判断的原文证据。"],
      };
    }
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const evidence = citations.map((citation) => ({
      document: citation.documentName,
      location: citation.pageNumber
        ? `page ${citation.pageNumber}`
        : `lines ${citation.startLine ?? "?"}-${citation.endLine ?? citation.startLine ?? "?"}`,
      heading: citation.headingPath,
      excerpt: citation.excerpt,
    }));
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Review whether the supplied source excerpts support the analysis statement and whether any asserted relationship between concepts or claims is justified. " +
            'Return JSON only: {"status":"supported|partially_supported|unsupported","reason":"...","suggestions":["..."]}. ' +
            "Use supported only when the statement and asserted relationship are directly justified by the excerpts. " +
            "When support is weak, missing, or the relationship appears irrelevant, provide up to three concise, actionable suggestions, such as what evidence is missing or which relationship needs reconsideration. " +
            "Return an empty suggestions array only when there is no meaningful improvement to recommend. Be conservative.",
        },
        { role: "user", content: JSON.stringify({ statement: text, evidence }) },
      ],
      max_tokens: 800,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    return statementPrecheckSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")));
  }

  async reconstructMapping(context: MappingAuditContext): Promise<string> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const evidence = context.chunks.map((chunk) => ({
      id: chunk.id,
      ordinal: chunk.ordinal,
      heading: chunk.headingPath,
      pageNumber: chunk.pageNumber,
      text: chunk.text.slice(0, 2400),
    }));
    const graph = {
      nodes: context.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        level: node.level,
        title: node.title,
        summary: node.summary,
        evidenceChunkIds: node.evidenceChunkIds,
      })),
      relations: context.relations.map((relation) => ({
        id: relation.id,
        type: relation.type,
        source: relation.sourceTitle,
        target: relation.targetTitle,
        reason: relation.reason,
        evidenceChunkIds: relation.evidenceChunkIds,
      })),
    };
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "Reconstruct the semantic outline of the original document section using only the supplied knowledge graph mapping. " +
            "Do not try to reproduce exact wording. Capture what the graph claims the source means, including important qualifiers, causal/argument links, and uncertainty. " +
            "Use Simplified Chinese for the whole answer. Return plain text only, not JSON and not Markdown code fences.",
        },
        { role: "user", content: JSON.stringify({ document: context.documentName, evidence, graph, note: context.note ?? "" }) },
      ],
      max_tokens: 2400,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const reconstruction = modelText(response.choices[0]?.message.content ?? "");
    if (!reconstruction.trim()) throw new Error("语义重构模型没有返回可展示文本");
    return reconstruction.slice(0, 20000);
  }

  async auditMapping(reconstruction: string, originalChunks: Chunk[], graphContext: MappingAuditContext): Promise<MappingAuditReview> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const original = originalChunks.map((chunk) => ({
      id: chunk.id,
      ordinal: chunk.ordinal,
      heading: chunk.headingPath,
      pageNumber: chunk.pageNumber,
      text: chunk.text.slice(0, 2600),
    }));
    const graph = {
      nodes: graphContext.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        summary: node.summary,
        evidenceChunkIds: node.evidenceChunkIds,
      })),
      relations: graphContext.relations.map((relation) => ({
        id: relation.id,
        type: relation.type,
        sourceNodeId: relation.sourceNodeId,
        sourceTitle: relation.sourceTitle,
        targetNodeId: relation.targetNodeId,
        targetTitle: relation.targetTitle,
        reason: relation.reason,
        evidenceChunkIds: relation.evidenceChunkIds,
      })),
    };
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an auditor for chunking and knowledge-graph mapping quality. Compare the original chunks with the semantic reconstruction and graph mapping. " +
            "Find semantic divergence only: missing important source meaning, unsupported graph claims, wrong relation type or direction, overgeneralization, and meaning lost at chunk boundaries. " +
            "Do not penalize harmless wording changes. Prefer actionable findings with exact chunk, node, and relation ids when relevant. " +
            "Keep summary under 1000 characters. Return at most 5 findings. For each finding keep title under 80 characters, description under 800 characters, and suggestion under 400 characters; put long explanations into concise issue plus action. " +
            "All human-readable strings in summary, title, description, and suggestion must be Simplified Chinese. " +
            'Return JSON only: {"status":"clean|minor_issues|major_issues|failed","summary":"...","findings":[{"kind":"missing_source_meaning|unsupported_graph_claim|wrong_relation|chunk_boundary_loss|overgeneralization|other","severity":"low|medium|high","title":"...","description":"...","suggestion":"...","evidenceChunkIds":["..."],"nodeIds":["..."],"relationIds":["..."]}]}. ' +
            "Semantic Coverage Rules: " +
            "1. Judge whether the graph preserves important source meaning. " +
            "2. Report missing_source_meaning when important source content is absent from the graph. " +
            "3. Report unsupported_graph_claim when a graph node or relation is not grounded in source chunks. " +
            "4. Report chunk_boundary_loss when meaning spanning adjacent chunks is lost. " +
            "5. Report overgeneralization when distinct source meanings are merged into a broad unsupported claim. " +
            "6. Treat reconstruction as a diagnostic aid, not as evidence.",
        },
        { role: "user", content: JSON.stringify({ original, reconstruction, graph, note: graphContext.note ?? "" }) },
      ],
      max_tokens: 1800,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    try {
      return parseMappingAuditReview(raw);
    } catch (cause) {
      if (isMappingAuditEnumValidationError(cause)) throw cause;
      try {
        return await this.repairMappingAuditJson(raw, cause);
      } catch (repairCause) {
        if (isMappingAuditEnumValidationError(repairCause)) throw repairCause;
        return {
          status: "failed",
          summary: "审计模型返回的结构化 JSON 无法整理；已保留语义重构文本，请重新运行审计。",
          findings: [{
            kind: "other",
            severity: "medium",
            title: "审计结构化输出不可用",
            description: "模型返回的审计 JSON 不完整、格式异常或字段超出预期，系统未将其作为正式审计结论。",
            suggestion: "点击重新运行；如果反复出现，可缩短输入文档或检查当前模型的 JSON 输出稳定性。",
            evidenceChunkIds: originalChunks.slice(0, 3).map((chunk) => chunk.id),
            nodeIds: graphContext.nodes.slice(0, 3).map((node) => node.id),
            relationIds: graphContext.relations.slice(0, 3).map((relation) => relation.id),
            userComment: "",
          }],
        };
      }
    }
  }

  async rebuildGraphFromMappingAudit(
    audit: MappingAudit,
    originalChunks: Chunk[],
    graphContext: MappingAuditContext,
    options: ExtractionRuleOptions = {},
  ): Promise<ExtractionOutput> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const original = originalChunks.map((chunk) => ({
      id: chunk.id,
      ordinal: chunk.ordinal,
      heading: chunk.headingPath,
      pageNumber: chunk.pageNumber,
      text: chunk.text.slice(0, 2600),
    }));
    const graph = {
      nodes: graphContext.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        level: node.level,
        title: node.title,
        summary: node.summary,
        evidenceChunkIds: node.evidenceChunkIds,
      })),
      relations: graphContext.relations.map((relation) => ({
        id: relation.id,
        type: relation.type,
        status: "current",
        sourceTitle: relation.sourceTitle,
        targetTitle: relation.targetTitle,
        reason: relation.reason,
        evidenceChunkIds: relation.evidenceChunkIds,
      })),
    };
    const findings = audit.findings.map((finding) => ({
      kind: finding.kind,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      suggestion: finding.suggestion,
      evidenceChunkIds: finding.evidenceChunkIds,
      nodeIds: finding.nodeIds,
      relationIds: finding.relationIds,
      userComment: finding.userComment,
    }));
    const previousGraphRebuild = audit.graphRebuildReport
      ? audit.graphRebuildReport.slice(0, 6000)
      : "";
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是关系图谱重构助手。请把原文 chunk、当前关系图谱、映射审计报告一起作为素材，重新生成一份更准确的候选关系图谱。 " +
            "必须使用简体中文。审计发现只是线索，不是事实；所有节点、主题和关系都必须由原文 chunk 支撑。 " +
            "若审计发现包含 userComment，它代表用户对该问题的修正意图，应作为重构时的重要参考，但仍必须受原文证据约束。 " +
            "优先修复审计报告指出的缺失含义、无证据图谱声明、错误关系方向/类型、过度概括和 chunk 边界造成的语义损失。 " +
            "若输入包含 previousGraphRebuild，它是上一轮“审计驱动图谱重构”的处理记录；请避免重复上一轮无效修复，并优先补足仍未解决的问题。 " +
            "不要简单复述旧图谱。对无证据、过度绝对、方向错误或类型错误的旧关系，应生成更保守、更有证据的新候选来替代；缺失的原文含义应补成新的候选节点或关系。 " +
            "Graph Evolution Rules: " +
            "1. Rebuild only the local subgraph affected by audit findings. " +
            "2. Prefer minimal corrections over rewriting the whole graph. " +
            "3. Audit findings are hints, not facts. " +
            "4. All rebuilt nodes and relations must be grounded in source chunks. " +
            "5. Rebuild output is candidate graph only. " +
            "6. It will be checked by graphRules and quick rule audit. " +
            "不要输出解释文本，只返回 JSON，形状必须是：" +
            '{"nodes":[{"key":"n1","kind":"concept|claim","title":"...","summary":"...","evidenceChunkIds":["..."],"aspects":["claim"]}],"relations":[{"sourceKey":"n1","targetKey":"n2","type":"supports|contradicts|explains|depends_on|example_of|related_to","reason":"...","confidence":0.8,"evidenceChunkIds":["..."]}],"themes":[{"title":"...","summary":"...","memberKeys":["n1"],"evidenceChunkIds":["..."],"aspects":["system"]}]}. ' +
            "aspects 只能从 person, operation, system, story, claim, conflict, time, other 中选择。所有 evidenceChunkIds 必须来自提供的 original chunk id。节点数量保持紧凑，关系只生成可由原文支撑的候选。",
        },
        { role: "user", content: JSON.stringify({ document: graphContext.documentName, auditSummary: audit.summary, findings, original, graph, reconstruction: audit.reconstruction, previousGraphRebuild }) },
      ],
      max_tokens: 4096,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    try {
      return parseExtractionOutput(
        raw,
        originalChunks,
        "模型重构结构化输出不可用，系统生成保守候选。",
        { ...options, stage: "rebuild" },
      ).output;
    } catch (cause) {
      try {
        return await this.repairExtractionJson(raw, cause, originalChunks, { ...options, stage: "rebuild" });
      } catch {
        return finalizeExtractionOutput(
          fallbackExtractionFromChunks(originalChunks, "模型重构结构化输出修复失败，系统生成保守候选。"),
          originalChunks,
          undefined,
          { ...options, stage: "rebuild" },
        ).output;
      }
    }
  }

  async analyzePulseQuestion(question: string, mode: PulseAnswerContext["mode"]): Promise<PulseQuestionPlan> {
    if (!this.config.chatModel) return fallbackPulseQuestionPlan();
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.05,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Pulse Question Planner. Analyze the user question semantically. Do not answer it. " +
            "Decide what evidence is required: exhaustive evidence, structured evidence, numerical reconciliation, source quotes, timeline completeness, or entity coverage. " +
            "Do not use or request question-specific regex rules. Return JSON only with exactly these fields: " +
            '{"questionType":"normal|exhaustive_list|numerical_aggregation|timeline|entity_relation|causal_explanation|claim_support|summary|critique|comparison|mixed","requiresExhaustiveEvidence":true,"requiresStructuredEvidence":true,"requiresNumericalReconciliation":false,"requiresSourceQuotes":true,"requiresTimelineCompleteness":false,"requiresEntityCoverage":false,"allowedPartialAnswer":true,"answerMustExposeGaps":true,"evidenceTargets":["..."],"keyEntities":["..."],"expectedEvidenceTypes":["..."],"riskLevel":"low|medium|high","reasoning":"..."}.',
        },
        { role: "user", content: JSON.stringify({ question, mode }) },
      ],
      max_tokens: 900,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    try {
      const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
      return pulseQuestionPlanSchema.parse(parseJsonModelObject(response.choices[0]?.message.content ?? "{}"));
    } catch {
      return fallbackPulseQuestionPlan();
    }
  }

  async planPulseEvidence(input: {
    question: string;
    mode: PulseAnswerContext["mode"];
    questionPlan: PulseQuestionPlan;
    memorySummary: unknown;
    tools: string[];
  }): Promise<PulseEvidencePlan> {
    if (!this.config.chatModel) return fallbackPulseEvidencePlan(input.question, input.mode, input.tools);
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.05,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Pulse Evidence Planner. Plan retrieval using only the supplied generic tools. " +
            "Do not request amountRegexScan, timelineRegexScan, legalMode, or any question-specific scanner. Prefer raw chunks when exact evidence is needed. " +
            "If EvidenceMemory contains a declared total but itemized rows do not reconcile, or existing rows look like part of the same source list/section, generate continuation actions: readRemainingChunksAfter the last covered chunk, readSameSectionChunks, and readNeighborChunks before broad semantic search. " +
            "For exhaustive questions, plan to extract remaining itemized rows from continued raw chunks instead of stopping at a partial answer. " +
            'Return JSON only: {"objective":"...","steps":[{"tool":"semanticSearch|fullTextSearch|graphExpand|readChunks|readNeighborChunks|readSameSectionChunks|readRemainingChunksAfter|getDocumentOutline|getChunkEvidenceAround|getGraphContext","query":"...","basedOnChunkIds":["..."],"basedOnNodeIds":["..."],"purpose":"...","expectedResult":"..."}],"stopCondition":"...","expectedEvidenceShape":"...","maxIterations":4}.',
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      max_tokens: 1200,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    try {
      const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
      const parsed = pulseEvidencePlanSchema.parse(parseJsonModelObject(response.choices[0]?.message.content ?? "{}"));
      const allowed = new Set(input.tools);
      const progressiveCap = input.questionPlan.riskLevel === "high" && input.questionPlan.requiresExhaustiveEvidence ? 6 : 5;
      return {
        ...parsed,
        steps: parsed.steps.filter((step) => allowed.has(step.tool)),
        maxIterations: input.mode === "progressive" ? Math.min(progressiveCap, Math.max(parsed.maxIterations, 1)) : Math.min(2, Math.max(parsed.maxIterations, 1)),
      };
    } catch {
      return fallbackPulseEvidencePlan(input.question, input.mode, input.tools);
    }
  }

  async extractPulseEvidenceRows(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    purpose: string;
    chunks: Array<{ id: string; text: string; headingPath: string | null; pageNumber: number | null }>;
    existingRows: PulseEvidenceRow[];
  }): Promise<PulseEvidenceRow[]> {
    if (!this.config.chatModel || input.chunks.length === 0) return [];
    const allowedChunkIds = new Set(input.chunks.map((chunk) => chunk.id));
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.05,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Pulse Evidence Extractor. Extract structured EvidenceRows only from supplied chunks. " +
            "Every row must cite evidenceChunkId and evidenceQuote. Do not infer facts not present. If uncertain, lower confidence or omit the row. " +
            "For exhaustive/list questions, distinguish declared totals from itemized rows. Do not mix declared totals with itemized amounts. " +
            'Return JSON only: {"rows":[{"rowId":"...","evidenceType":"fact|amount|date|entity_relation|claim|quote|other","claimText":"...","structuredValue":{},"sourceEntity":"...","targetEntity":"...","relationType":"...","evidenceChunkId":"...","evidenceQuote":"...","confidence":0.8,"countedInAnswer":true,"dedupeKey":"...","warnings":["..."]}]}',
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      max_tokens: 1600,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    try {
      const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
      return cleanPulseEvidenceRows(parseJsonModelObject(response.choices[0]?.message.content ?? "{}"), allowedChunkIds);
    } catch {
      return [];
    }
  }

  async judgePulseEvidenceSufficiency(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    memory: unknown;
    computedReconciliation?: unknown;
  }): Promise<PulseEvidenceStatus> {
    if (!this.config.chatModel) {
      return {
        sufficient: false,
        status: "partial_answer_only",
        gaps: [],
        reasoning: "Planner unavailable; answer must stay guarded.",
        ...(input.computedReconciliation ? { reconciliation: input.computedReconciliation as PulseEvidenceStatus["reconciliation"] } : {}),
      };
    }
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.05,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Pulse Sufficiency Judge. Judge whether evidence is sufficient for the question plan. Use EvidenceMemory and computed reconciliation. " +
            "If insufficient, return concrete gaps and suggested generic search queries. Do not hide reconciliation failure. " +
            "For exhaustive questions, if you see a partial list, numbered/list structure, or sections that appear to continue after the current chunks, return needs_gap_retrieval and recommend continuing the same section or subsequent chunks; do not return partial_answer_only unless the document has truly been covered or the details are absent from the document. " +
            'Return JSON only: {"sufficient":false,"status":"sufficient|insufficient_context|needs_gap_retrieval|failed_reconciliation|partial_answer_only","gaps":[{"type":"missing_itemized_evidence|declared_total_without_breakdown|sum_mismatch|missing_source_quote|missing_entity_coverage|timeline_gap|unsupported_claim|other","description":"...","suggestedQueries":["..."],"severity":"low|medium|high"}],"reasoning":"...","reconciliation":{"declaredTotal":0,"itemizedSum":0,"difference":0,"unit":"万","closed":false,"explanation":"..."}}.',
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      max_tokens: 1200,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    try {
      const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
      const parsed = pulseEvidenceStatusSchema.parse(parseJsonModelObject(response.choices[0]?.message.content ?? "{}"));
      if (input.computedReconciliation && typeof input.computedReconciliation === "object") {
        return { ...parsed, reconciliation: parsed.reconciliation ?? input.computedReconciliation as PulseEvidenceStatus["reconciliation"] };
      }
      return parsed;
    } catch {
      return {
        sufficient: false,
        status: "partial_answer_only",
        gaps: [],
        reasoning: "Sufficiency judge failed; answer must expose uncertainty.",
        ...(input.computedReconciliation ? { reconciliation: input.computedReconciliation as PulseEvidenceStatus["reconciliation"] } : {}),
      };
    }
  }

  async synthesizePulseAnswer(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    memory: unknown;
    evidenceStatus: PulseEvidenceStatus;
  }): Promise<PulseAnswerOutput> {
    if (!this.config.chatModel) return this.answerPulse(input.question, { chunks: [], nodes: [], relations: [] });
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Pulse Answer Synthesizer. Use only supplied EvidenceMemory. Do not imply exhaustive coverage unless evidenceStatus.sufficient is true. " +
            "If evidence is insufficient, explicitly state gaps. If numerical reconciliation failed, state declared total, itemized sum, and difference. " +
            "If source quotes are required, include quote-level evidence or state missing quote. Return JSON only: {\"answer\":\"...\",\"summary\":\"...\"}.",
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      max_tokens: 1600,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
    return pulseAnswerSchema.parse(parseJsonModelObject(response.choices[0]?.message.content ?? "{}"));
  }

  async rewritePulseAnswer(input: {
    question: string;
    draft: PulseAnswerOutput;
    rewriteInstructions: string;
    memory: unknown;
    evidenceStatus: PulseEvidenceStatus;
  }): Promise<PulseAnswerOutput> {
    if (!this.config.chatModel) return input.draft;
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.05,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Pulse Answer Rewrite Gate. Rewrite the draft to satisfy verification instructions. Keep only supported claims and expose gaps. " +
            "Do not add facts that are not in EvidenceMemory. Return JSON only: {\"answer\":\"...\",\"summary\":\"...\"}.",
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      max_tokens: 1400,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
    return pulseAnswerSchema.parse(parseJsonModelObject(response.choices[0]?.message.content ?? "{}"));
  }

  async answerPulse(question: string, context: PulseAnswerContext): Promise<PulseAnswerOutput> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Answer the user's question using only the supplied knowledge graph context. " +
            'Return JSON only: {"answer":"...","summary":"..."}. ' +
            "The answer should be concise, grounded in the chunks, nodes, and relations provided, and must mention uncertainty when evidence is thin. " +
            "The summary should briefly describe which graph areas were activated.",
        },
        { role: "user", content: JSON.stringify({ question, context }) },
      ],
      max_tokens: 1200,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    return pulseAnswerSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")));
  }

  async selectPulseNavigation(
    question: string,
    step: string,
    candidates: PulseNavigationCandidate[],
  ): Promise<PulseNavigationDecision> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Choose the next visible knowledge-graph node for a progressive retrieval pulse. " +
            'Return JSON only: {"selectedIds":["..."],"observation":"...","rationale":"...","rejectedCandidates":[{"id":"...","reason":"..."}]}. ' +
            "selectedIds must come from the supplied candidates and include one to three ids. " +
            "observation should state what information was visible at this step. " +
            "rationale should be a concise, user-facing navigation reason based only on visible candidate labels, summaries, relation labels, and relation reasons. " +
            "rejectedCandidates should briefly explain why up to four visible but unselected candidates were less useful than the selected ones. " +
            "Do not reveal hidden chain-of-thought or private scratchpad reasoning; provide an auditable explanation instead.",
        },
        { role: "user", content: JSON.stringify({ question, step, candidates }) },
      ],
      max_tokens: 700,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    const parsed = pulseNavigationDecisionSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")));
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const selectedIds = parsed.selectedIds.filter((id) => candidateIds.has(id)).slice(0, 3);
    if (selectedIds.length === 0 && candidates[0]) {
      return {
        selectedIds: [candidates[0].id],
        observation: parsed.observation,
        rationale: `${parsed.rationale}（模型返回的候选不在当前可见集合中，已回退到最高候选。）`,
      };
    }
    return { ...parsed, selectedIds };
  }

  async *stream(prompt: string): AsyncGenerator<{ type: "reasoning" | "content"; text: string }> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    if (!this.config.aiApiKey) throw new Error(this.config.provider === "deepseek" ? "未配置 DEEPSEEK_API_KEY" : "未配置 AI_API_KEY");
    const response = await fetch(`${this.config.aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.aiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.chatModel,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
        ...(this.config.provider === "deepseek" ? { thinking: { type: this.config.thinkingMode } } : {}),
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`模型服务请求失败 (${response.status}): ${text.slice(0, 240)}`);
    }
    if (!response.body) throw new Error("模型服务没有返回流式响应体");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const parts = buffered.split(/\r?\n\r?\n/);
      buffered = done ? "" : parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
          };
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.reasoning_content) yield { type: "reasoning", text: delta.reasoning_content };
          if (delta?.content) yield { type: "content", text: delta.content };
        }
      }
      if (done) break;
    }
  }

  async test(): Promise<ModelTestResult> {
    if (!this.configured) {
      return {
        ok: false,
        provider: this.name,
        message: this.config.provider === "deepseek"
          ? "请在 .env 中填写 DEEPSEEK_API_KEY；本地 embedding 已启用。"
          : "请在 .env 中配置 API 密钥以及聊天和 embedding 模型。",
      };
    }
    await this.request(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", {
      model: this.config.chatModel,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 8,
      ...(this.config.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
    });
    await this.embed(["AgentThinking connection test"]);
    return { ok: true, provider: this.name, message: "模型连接正常。" };
  }
}

export function createModelProvider(config: AppConfig): ModelProvider {
  return config.provider === "fake" ? new FakeModelProvider() : new OpenAICompatibleProvider(config);
}
