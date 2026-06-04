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
  selectedBlocks: Array<ContextBlock & { contextUnitId: string; headingPath: string[]; includedReason: string; reason: string }>;
  omittedBlocks: Array<{
    blockId: string;
    contextUnitId: string;
    headingPath: string[];
    ordinal: number;
    type: ContextBlock["type"];
    omittedReason: string;
    reason: string;
    textPreview?: string | undefined;
  }>;
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

function contextHeadingPath(contextUnit: ContextUnit): string[] {
  return contextUnit.displayHeadingPath.length > 0 ? contextUnit.displayHeadingPath : contextUnit.headingPath;
}

function selectedBlock(contextUnit: ContextUnit, block: ContextBlock, reason: string): CompactContextPack["selectedBlocks"][number] {
  return {
    ...block,
    contextUnitId: contextUnit.id,
    headingPath: contextHeadingPath(contextUnit),
    includedReason: reason,
    reason,
  };
}

function omittedBlock(contextUnit: ContextUnit, block: ContextBlock, reason: string): CompactContextPack["omittedBlocks"][number] {
  return {
    blockId: block.blockId,
    contextUnitId: contextUnit.id,
    headingPath: contextHeadingPath(contextUnit),
    ordinal: block.ordinal,
    type: block.type,
    omittedReason: reason,
    reason,
    ...(block.textPreview ? { textPreview: block.textPreview } : {}),
  };
}

function isStrongSequenceBoundary(block: ContextBlock, hitType: ContextBlock["type"]): boolean {
  return block.type === "heading" || (block.type === "table" && hitType !== "table");
}

function isSequenceCompatible(block: ContextBlock, hitBlock: ContextBlock): boolean {
  if (isStrongSequenceBoundary(block, hitBlock.type)) return false;
  if (hitBlock.type === "table") return block.type === "table";
  if (hitBlock.type === "list_item" || hitBlock.type === "paragraph") {
    return block.type === "list_item" || block.type === "paragraph";
  }
  return block.type === hitBlock.type;
}

function isAdjacent(left: ContextBlock, right: ContextBlock): boolean {
  return right.ordinal - left.ordinal === 1;
}

function queryWindowBlocks(blocks: ContextBlock[], hitBlock: ContextBlock, radius = 2): ContextBlock[] {
  return blocks.filter((block) => Math.abs(block.ordinal - hitBlock.ordinal) <= radius);
}

function sequenceGroupBlocks(blocks: ContextBlock[], hitBlock: ContextBlock): ContextBlock[] {
  const hitIndex = blocks.findIndex((block) => block.blockId === hitBlock.blockId);
  if (hitIndex < 0) return [hitBlock];
  let start = hitIndex;
  while (start > 0) {
    const previous = blocks[start - 1]!;
    const current = blocks[start]!;
    if (!isAdjacent(previous, current) || !isSequenceCompatible(previous, hitBlock)) break;
    start -= 1;
  }
  let end = hitIndex;
  while (end + 1 < blocks.length) {
    const current = blocks[end]!;
    const next = blocks[end + 1]!;
    if (!isAdjacent(current, next) || !isSequenceCompatible(next, hitBlock)) break;
    end += 1;
  }
  return blocks.slice(start, end + 1);
}

function sectionOutlinePlusHitBlocks(blocks: ContextBlock[], hitBlock: ContextBlock): ContextBlock[] {
  const selected = new Map<string, ContextBlock>();
  for (const block of blocks) {
    if (block.type === "heading") selected.set(block.blockId, block);
  }
  for (const block of queryWindowBlocks(blocks, hitBlock, 1)) selected.set(block.blockId, block);
  return [...selected.values()].sort((left, right) => left.ordinal - right.ordinal);
}

function compactStrategy(questionPlan: PulseQuestionPlan): CompactContextPack["strategy"] {
  if (
    questionPlan.questionType === "exhaustive_list"
    || questionPlan.questionType === "numerical_aggregation"
    || questionPlan.questionType === "timeline"
  ) return "list_or_sequence_group";
  if (
    questionPlan.questionType === "summary"
    || questionPlan.questionType === "comparison"
    || questionPlan.questionType === "critique"
  ) return "section_outline_plus_hits";
  return "query_window";
}

function nonCandidateReason(strategy: CompactContextPack["strategy"], block: ContextBlock): string {
  if (strategy === "list_or_sequence_group") {
    return block.type === "heading" || block.type === "table"
      ? "strong boundary not crossed"
      : "outside contiguous sequence group";
  }
  if (strategy === "section_outline_plus_hits") return "outside section outline and hit window";
  return "outside query window";
}

function candidateReason(strategy: CompactContextPack["strategy"], block: ContextBlock, hitBlock: ContextBlock): string {
  if (block.blockId === hitBlock.blockId) return "retrieval hit block";
  if (strategy === "list_or_sequence_group") return "contiguous sequence block";
  if (strategy === "section_outline_plus_hits") return block.type === "heading" ? "section outline heading" : "hit window block";
  return "query window block";
}

export function buildCompactContextPack(
  questionPlan: PulseQuestionPlan,
  contextUnit: ContextUnit,
  retrievalUnit: RetrievalUnit,
  profile: ModelContextProfile,
): CompactContextPack {
  const hitBlock = blockForRetrievalUnit(contextUnit, retrievalUnit);
  const orderedBlocks = [...contextUnit.blocks].sort((left, right) => left.ordinal - right.ordinal);
  const strategy = compactStrategy(questionPlan);
  const candidateBlocks = hitBlock
    ? strategy === "list_or_sequence_group"
      ? sequenceGroupBlocks(orderedBlocks, hitBlock)
      : strategy === "section_outline_plus_hits"
        ? sectionOutlinePlusHitBlocks(orderedBlocks, hitBlock)
        : queryWindowBlocks(orderedBlocks, hitBlock)
    : [];
  let used = 0;
  const selectedBlocks: CompactContextPack["selectedBlocks"] = [];
  const omittedBlocks: CompactContextPack["omittedBlocks"] = [];
  const budgetChars = Math.max(500, (profile.compactExcerptTokens ?? 12000) * 4);
  for (const block of candidateBlocks) {
    const text = contextUnit.text.slice(block.startChar, block.endChar);
    if (used + text.length <= budgetChars || block.blockId === hitBlock?.blockId) {
      selectedBlocks.push(selectedBlock(contextUnit, block, hitBlock ? candidateReason(strategy, block, hitBlock) : "compact candidate block"));
      used += text.length;
    } else {
      omittedBlocks.push(omittedBlock(contextUnit, block, "compact excerpt budget exceeded"));
    }
  }
  const selectedIds = new Set(selectedBlocks.map((block) => block.blockId));
  for (const block of orderedBlocks) {
    if (!selectedIds.has(block.blockId) && !omittedBlocks.some((entry) => entry.blockId === block.blockId)) {
      omittedBlocks.push(omittedBlock(contextUnit, block, nonCandidateReason(strategy, block)));
    }
  }
  return {
    strategy,
    modelProfile: profile,
    tokenBudget: profile.tokenBudget,
    contextUnitId: contextUnit.id,
    selectedBlocks,
    omittedBlocks,
    text: [...selectedBlocks]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((block) => contextUnit.text.slice(block.startChar, block.endChar))
      .join("\n\n"),
    coverageWarnings: omittedBlocks.length > 0 ? [`${omittedBlocks.length} blocks omitted from compact pack.`] : [],
  };
}
