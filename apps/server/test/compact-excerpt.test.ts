import { describe, expect, it } from "vitest";
import type { ContextBlock, ContextUnit, ModelContextProfile, PulseQuestionPlan, RetrievalUnit } from "@agent-thinking/contracts";
import { buildCompactContextPack } from "../src/services/context-packs.js";

const profile: ModelContextProfile = {
  provider: "test",
  model: "test-model",
  maxInputTokens: 8192,
  preferredContextTokens: 4096,
  strategy: "retrieval-compact",
  allowDocumentPack: false,
  allowSectionPack: true,
  allowMultiContextUnitPack: true,
  compactExcerptTokens: 200,
  tokenBudget: {
    maxInputTokens: 8192,
    reservedForSystem: 800,
    reservedForQuestion: 600,
    reservedForInstructions: 1000,
    reservedForEvidenceJson: 1200,
    reservedForOutput: 1200,
    reservedForVerification: 600,
    availableForContext: 2792,
  },
};

function plan(questionType: PulseQuestionPlan["questionType"]): PulseQuestionPlan {
  return {
    questionType,
    requiresExhaustiveEvidence: questionType === "exhaustive_list" || questionType === "numerical_aggregation",
    requiresStructuredEvidence: questionType === "numerical_aggregation",
    requiresNumericalReconciliation: questionType === "numerical_aggregation",
    requiresSourceQuotes: true,
    requiresTimelineCompleteness: questionType === "timeline",
    requiresEntityCoverage: false,
    allowedPartialAnswer: true,
    answerMustExposeGaps: questionType === "exhaustive_list" || questionType === "numerical_aggregation",
    evidenceTargets: [],
    keyEntities: [],
    expectedEvidenceTypes: [],
    riskLevel: "medium",
    reasoning: "test plan",
  };
}

function contextUnit(parts: Array<{ blockId: string; type: ContextBlock["type"]; text: string }>): ContextUnit {
  let text = "";
  const blocks: ContextBlock[] = [];
  for (const [index, part] of parts.entries()) {
    const prefix = text.length === 0 ? "" : "\n\n";
    const startChar = text.length + prefix.length;
    text += `${prefix}${part.text}`;
    blocks.push({
      blockId: part.blockId,
      type: part.type,
      startChar,
      endChar: startChar + part.text.length,
      ordinal: index,
      sourceNodeId: `node-${index}`,
      textPreview: part.text,
    });
  }
  return {
    id: "cu-main",
    stableKey: "stable-main",
    buildId: "build-v2",
    versionId: "version-1",
    sourceNodeIds: ["node-0"],
    primarySourceNodeId: "node-0",
    sourceRange: { startSourceNodeId: "node-0", endSourceNodeId: `node-${parts.length - 1}`, startChar: 0, endChar: text.length },
    headingPath: ["Report"],
    displayHeadingPath: ["Report"],
    ordinal: 0,
    ordinalInPrimarySource: 0,
    text,
    blocks,
    retrievalUnitIds: ["ru-hit"],
    estimatedTokens: Math.ceil(text.length / 4),
    boundaryReason: "document_tree_boundary",
  };
}

function retrievalFor(unit: ContextUnit, blockId: string, textOverride?: string): RetrievalUnit {
  const block = unit.blocks.find((entry) => entry.blockId === blockId)!;
  return {
    id: "ru-hit",
    stableKey: "ru-stable",
    buildId: unit.buildId,
    versionId: unit.versionId,
    contextUnitId: unit.id,
    text: textOverride ?? unit.text.slice(block.startChar, block.endChar),
    headingPath: unit.headingPath,
    ordinal: 0,
    startChar: block.startChar,
    endChar: block.endChar,
    startLine: null,
    endLine: null,
    pageNumber: null,
    estimatedTokens: 20,
  };
}

describe("compact excerpts", () => {
  it("builds query_window packs around the retrieval hit", () => {
    const unit = contextUnit([
      { blockId: "p0", type: "paragraph", text: "Outside before." },
      { blockId: "p1", type: "paragraph", text: "Neighbor before one." },
      { blockId: "p2", type: "paragraph", text: "Neighbor before two." },
      { blockId: "p3", type: "paragraph", text: "Retrieval hit fact." },
      { blockId: "p4", type: "paragraph", text: "Neighbor after one." },
      { blockId: "p5", type: "paragraph", text: "Neighbor after two." },
      { blockId: "p6", type: "paragraph", text: "Outside after." },
    ]);

    const pack = buildCompactContextPack(plan("normal"), unit, retrievalFor(unit, "p3"), profile);

    expect(pack.strategy).toBe("query_window");
    expect(pack.selectedBlocks.map((block) => block.blockId)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(pack.omittedBlocks.map((block) => block.blockId)).toEqual(["p0", "p6"]);
    expect(pack.text).toContain("Retrieval hit fact.");
    expect(pack.text).not.toContain("Outside before.");
    expect(pack.selectedBlocks.every((block) => block.contextUnitId === unit.id && block.headingPath[0] === "Report" && block.reason.length > 0)).toBe(true);
    expect(pack.omittedBlocks.every((block) => block.contextUnitId === unit.id && block.headingPath[0] === "Report" && block.reason === "outside query window")).toBe(true);
  });

  it("expands contiguous list_or_sequence_group packs and stops at headings or strong boundaries", () => {
    const unit = contextUnit([
      { blockId: "h0", type: "heading", text: "Section A" },
      { blockId: "li1", type: "list_item", text: "- Source A contributes 10 units." },
      { blockId: "li2", type: "list_item", text: "- Source B contributes 20 units." },
      { blockId: "li3", type: "list_item", text: "- Source C contributes 30 units." },
      { blockId: "tbl4", type: "table", text: "| Strong | Boundary |" },
      { blockId: "li5", type: "list_item", text: "- Source D should not be crossed into." },
    ]);

    const pack = buildCompactContextPack(plan("numerical_aggregation"), unit, retrievalFor(unit, "li2"), profile);

    expect(pack.strategy).toBe("list_or_sequence_group");
    expect(pack.selectedBlocks.map((block) => block.blockId)).toEqual(["li1", "li2", "li3"]);
    expect(pack.selectedBlocks.map((block) => block.reason)).toEqual([
      "contiguous sequence block",
      "retrieval hit block",
      "contiguous sequence block",
    ]);
    expect(pack.text).toContain("Source A contributes 10 units.");
    expect(pack.text).toContain("Source C contributes 30 units.");
    expect(pack.text).not.toContain("Source D should not be crossed into.");
    expect(pack.omittedBlocks.find((block) => block.blockId === "h0")).toMatchObject({
      contextUnitId: unit.id,
      ordinal: 0,
      reason: "strong boundary not crossed",
    });
    expect(pack.omittedBlocks.find((block) => block.blockId === "tbl4")?.reason).toBe("strong boundary not crossed");
  });

  it("builds section_outline_plus_hits packs with outline headings and local hit context", () => {
    const unit = contextUnit([
      { blockId: "h0", type: "heading", text: "Executive Summary" },
      { blockId: "p1", type: "paragraph", text: "General intro not near the hit." },
      { blockId: "h2", type: "heading", text: "Findings" },
      { blockId: "p3", type: "paragraph", text: "Matched finding with citeable quote." },
      { blockId: "p4", type: "paragraph", text: "Immediate explanation for matched finding." },
      { blockId: "p5", type: "paragraph", text: "Distant body detail." },
      { blockId: "h6", type: "heading", text: "Appendix" },
      { blockId: "p7", type: "paragraph", text: "Appendix body should be omitted." },
    ]);

    const pack = buildCompactContextPack(plan("summary"), unit, retrievalFor(unit, "p3"), profile);

    expect(pack.strategy).toBe("section_outline_plus_hits");
    expect(pack.selectedBlocks.map((block) => block.blockId)).toEqual(["h0", "h2", "p3", "p4", "h6"]);
    expect(pack.selectedBlocks.find((block) => block.blockId === "h0")?.reason).toBe("section outline heading");
    expect(pack.selectedBlocks.find((block) => block.blockId === "p3")?.reason).toBe("retrieval hit block");
    expect(pack.text).toContain("Executive Summary");
    expect(pack.text).toContain("Matched finding with citeable quote.");
    expect(pack.text).not.toContain("Appendix body should be omitted.");
    expect(pack.omittedBlocks.map((block) => block.blockId)).toEqual(["p1", "p5", "p7"]);
    expect(pack.omittedBlocks.every((block) => block.reason === "outside section outline and hit window")).toBe(true);
  });

  it("uses v2 ContextUnit blocks instead of legacy child chunk top-k text", () => {
    const unit = contextUnit([
      { blockId: "v2-hit", type: "paragraph", text: "V2 context unit evidence text." },
      { blockId: "v2-neighbor", type: "paragraph", text: "V2 context unit neighbor text." },
    ]);
    const retrieval = {
      ...retrievalFor(unit, "v2-hit", "Legacy child chunk top-k text that is not part of the ContextUnit."),
      startChar: null,
      endChar: null,
    };

    const pack = buildCompactContextPack(plan("normal"), unit, retrieval, profile);

    expect(pack.contextUnitId).toBe(unit.id);
    expect(pack.selectedBlocks.every((block) => block.contextUnitId === unit.id)).toBe(true);
    expect(pack.selectedBlocks.map((block) => block.blockId)).not.toContain("legacy-child-top-1");
    expect(pack.text).toContain("V2 context unit evidence text.");
    expect(pack.text).not.toContain("Legacy child chunk top-k text");
  });
});
