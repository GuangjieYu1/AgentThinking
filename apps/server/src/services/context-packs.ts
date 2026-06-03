import type {
  ContextBlock,
  ContextUnit,
  ModelContextProfile,
  PulseQuestionPlan,
  RetrievalUnit,
  TokenBudget,
} from "@agent-thinking/contracts";
import type { AppConfig } from "../config.js";
import { normalizeAnswerMode } from "./evidence-v2.js";

export interface LongContextPack {
  strategy: "document" | "section" | "multi_context_unit";
  modelProfile: ModelContextProfile;
  tokenBudget: TokenBudget;
  selectedContextUnits: Array<{ contextUnitId: string; priority: number; includedReason: string; estimatedTokens: number }>;
  omittedContextUnits: Array<{ contextUnitId: string; omittedReason: string; estimatedTokens: number }>;
  coverageWarnings: string[];
}

export interface CompactContextPack {
  strategy: "query_window" | "list_or_sequence_group" | "section_outline_plus_hits";
  modelProfile: ModelContextProfile;
  tokenBudget: TokenBudget;
  contextUnitId: string;
  selectedBlocks: Array<ContextBlock & { includedReason: string }>;
  omittedBlocks: Array<{ blockId: string; omittedReason: string }>;
  text: string;
  coverageWarnings: string[];
}

export function resolveModelContextProfile(config: AppConfig): ModelContextProfile {
  const reservedForSystem = 800;
  const reservedForQuestion = 600;
  const reservedForInstructions = 1000;
  const reservedForEvidenceJson = 1200;
  const reservedForOutput = 1200;
  const reservedForVerification = 600;
  const maxInputTokens = Math.max(1024, config.modelMaxInputTokens);
  const availableForContext = Math.max(512, maxInputTokens - reservedForSystem - reservedForQuestion - reservedForInstructions - reservedForEvidenceJson - reservedForOutput - reservedForVerification);
  return {
    provider: config.provider,
    model: config.chatModel ?? "unconfigured",
    maxInputTokens,
    preferredContextTokens: Math.min(config.modelPreferredContextTokens, availableForContext),
    strategy: config.modelContextStrategy,
    allowDocumentPack: config.modelContextStrategy === "long-context",
    allowSectionPack: true,
    allowMultiContextUnitPack: true,
    compactExcerptTokens: config.compactExcerptTokens,
    tokenBudget: {
      maxInputTokens,
      reservedForSystem,
      reservedForQuestion,
      reservedForInstructions,
      reservedForEvidenceJson,
      reservedForOutput,
      reservedForVerification,
      availableForContext,
    },
  };
}

export function buildLongContextPack(
  questionPlan: PulseQuestionPlan,
  contextUnits: ContextUnit[],
  profile: ModelContextProfile,
): LongContextPack {
  const answerMode = normalizeAnswerMode(questionPlan);
  let used = 0;
  const selectedContextUnits: LongContextPack["selectedContextUnits"] = [];
  const omittedContextUnits: LongContextPack["omittedContextUnits"] = [];
  for (const [index, unit] of contextUnits.entries()) {
    const estimatedTokens = unit.estimatedTokens ?? Math.ceil(unit.text.length / 4);
    if (used + estimatedTokens <= profile.tokenBudget.availableForContext) {
      selectedContextUnits.push({
        contextUnitId: unit.id,
        priority: index,
        includedReason: index === 0 ? "question-matched context" : "neighboring or supporting context",
        estimatedTokens,
      });
      used += estimatedTokens;
    } else {
      omittedContextUnits.push({ contextUnitId: unit.id, omittedReason: "token budget exceeded", estimatedTokens });
    }
  }
  return {
    strategy: selectedContextUnits.length === contextUnits.length ? "document" : selectedContextUnits.length > 1 ? "multi_context_unit" : "section",
    modelProfile: profile,
    tokenBudget: profile.tokenBudget,
    selectedContextUnits,
    omittedContextUnits,
    coverageWarnings: omittedContextUnits.length > 0
      ? [`${omittedContextUnits.length} context units omitted by token budget for ${answerMode.answerMode}.`]
      : [],
  };
}

function blockForRetrievalUnit(contextUnit: ContextUnit, retrievalUnit: RetrievalUnit): ContextBlock | undefined {
  if (retrievalUnit.startChar === null || retrievalUnit.startChar === undefined) return contextUnit.blocks[0];
  return contextUnit.blocks.find((block) => (
    block.startChar <= (retrievalUnit.startChar ?? 0) && block.endChar >= (retrievalUnit.startChar ?? 0)
  )) ?? contextUnit.blocks[0];
}

export function buildCompactContextPack(
  questionPlan: PulseQuestionPlan,
  contextUnit: ContextUnit,
  retrievalUnit: RetrievalUnit,
  profile: ModelContextProfile,
): CompactContextPack {
  const hitBlock = blockForRetrievalUnit(contextUnit, retrievalUnit);
  const hitOrdinal = hitBlock?.ordinal ?? 0;
  const prefersSequence = questionPlan.questionType === "exhaustive_list" || questionPlan.questionType === "numerical_aggregation";
  const candidateBlocks = contextUnit.blocks.filter((block) => (
    prefersSequence
      ? Math.abs(block.ordinal - hitOrdinal) <= 4 && (block.type === hitBlock?.type || block.type === "list_item" || block.type === "paragraph")
      : Math.abs(block.ordinal - hitOrdinal) <= 2
  ));
  let used = 0;
  const selectedBlocks: CompactContextPack["selectedBlocks"] = [];
  const omittedBlocks: CompactContextPack["omittedBlocks"] = [];
  const budgetChars = Math.max(500, (profile.compactExcerptTokens ?? 12000) * 4);
  for (const block of candidateBlocks) {
    const text = contextUnit.text.slice(block.startChar, block.endChar);
    if (used + text.length <= budgetChars || block.ordinal === hitOrdinal) {
      selectedBlocks.push({ ...block, includedReason: block.ordinal === hitOrdinal ? "retrieval hit block" : "neighbor block" });
      used += text.length;
    } else {
      omittedBlocks.push({ blockId: block.blockId, omittedReason: "compact excerpt budget exceeded" });
    }
  }
  const selectedIds = new Set(selectedBlocks.map((block) => block.blockId));
  for (const block of contextUnit.blocks) {
    if (!selectedIds.has(block.blockId) && !omittedBlocks.some((entry) => entry.blockId === block.blockId)) {
      omittedBlocks.push({ blockId: block.blockId, omittedReason: "not in query window" });
    }
  }
  return {
    strategy: prefersSequence ? "list_or_sequence_group" : "query_window",
    modelProfile: profile,
    tokenBudget: profile.tokenBudget,
    contextUnitId: contextUnit.id,
    selectedBlocks,
    omittedBlocks,
    text: selectedBlocks
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((block) => contextUnit.text.slice(block.startChar, block.endChar))
      .join("\n\n"),
    coverageWarnings: omittedBlocks.length > 0 ? [`${omittedBlocks.length} blocks omitted from compact pack.`] : [],
  };
}
