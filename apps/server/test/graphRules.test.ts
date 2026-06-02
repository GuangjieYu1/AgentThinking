import { describe, expect, it } from "vitest";
import type { Chunk, ExtractionOutput } from "@agent-thinking/contracts";
import {
  applyGraphRulesToExtraction,
  composeRelationTypes,
  getInverseRelationLabel,
  requiresReviewByComposition,
} from "../src/services/graphRules.js";

const chunk: Chunk = {
  id: "chunk-1",
  libraryId: "library-1",
  versionId: "version-1",
  ordinal: 0,
  headingPath: "Topic",
  pageNumber: null,
  startLine: null,
  endLine: null,
  blockId: null,
  startChar: 0,
  endChar: 12,
  text: "source text",
  aspects: [],
};

function extraction(relations: ExtractionOutput["relations"]): ExtractionOutput {
  return {
    nodes: [
      { key: "a", kind: "claim", title: "A", summary: "A", evidenceChunkIds: ["chunk-1"], aspects: ["claim"] },
      { key: "b", kind: "claim", title: "B", summary: "B", evidenceChunkIds: ["chunk-1"], aspects: ["claim"] },
      { key: "c", kind: "concept", title: "C", summary: "C", evidenceChunkIds: ["chunk-1"], aspects: ["other"] },
    ],
    relations,
    themes: [],
  };
}

describe("graph rules", () => {
  it("drops dangling relations", () => {
    const result = applyGraphRulesToExtraction(extraction([{
      sourceKey: "a",
      targetKey: "missing",
      type: "related_to",
      reason: "bad target",
      confidence: 0.5,
      evidenceChunkIds: ["chunk-1"],
    }]), { allowedChunks: [chunk] });
    expect(result.output.relations).toHaveLength(0);
    expect(result.traces.some((trace) => trace.action === "dangling_relation_dropped")).toBe(true);
  });

  it("downgrades sanitized invalid relation types to related_to with low confidence", () => {
    const result = applyGraphRulesToExtraction(extraction([{
      sourceKey: "a",
      targetKey: "b",
      type: "related_to",
      reason: "invalid type was sanitized before rules",
      confidence: 0.9,
      evidenceChunkIds: ["chunk-1"],
      originalType: "causes",
    }]), { allowedChunks: [chunk] });
    expect(result.output.relations[0]?.type).toBe("related_to");
    expect(result.output.relations[0]?.confidence).toBeLessThanOrEqual(0.3);
    expect(result.output.relations[0]?.ruleDecision).toBe("downgraded");
    expect(result.traces.some((trace) => trace.action === "relation_type_downgraded")).toBe(true);
  });

  it("drops self loops", () => {
    const result = applyGraphRulesToExtraction(extraction([{
      sourceKey: "a",
      targetKey: "a",
      type: "related_to",
      reason: "self",
      confidence: 0.5,
      evidenceChunkIds: ["chunk-1"],
    }]), { allowedChunks: [chunk] });
    expect(result.output.relations).toHaveLength(0);
    expect(result.traces.some((trace) => trace.action === "self_loop_dropped")).toBe(true);
  });

  it("filters invalid evidence chunk ids", () => {
    const result = applyGraphRulesToExtraction(extraction([{
      sourceKey: "a",
      targetKey: "b",
      type: "related_to",
      reason: "evidence",
      confidence: 0.5,
      evidenceChunkIds: ["chunk-1", "unknown"],
    }]), { allowedChunks: [chunk] });
    expect(result.output.relations[0]?.evidenceChunkIds).toEqual(["chunk-1"]);
    expect(result.traces.some((trace) => trace.action === "invalid_evidence_filtered")).toBe(true);
  });

  it("drops strong relations without evidence", () => {
    const result = applyGraphRulesToExtraction(extraction([{
      sourceKey: "a",
      targetKey: "b",
      type: "supports",
      reason: "needs evidence",
      confidence: 0.8,
      evidenceChunkIds: [],
    }]), { allowedChunks: [chunk] });
    expect(result.output.relations).toHaveLength(0);
    expect(result.traces.some((trace) => trace.action === "strong_relation_without_evidence_dropped")).toBe(true);
  });

  it("caps related_to confidence", () => {
    const result = applyGraphRulesToExtraction(extraction([{
      sourceKey: "a",
      targetKey: "b",
      type: "related_to",
      reason: "weak",
      confidence: 0.95,
      evidenceChunkIds: ["chunk-1"],
    }]), { allowedChunks: [chunk] });
    expect(result.output.relations[0]?.confidence).toBe(0.6);
    expect(result.traces.some((trace) => trace.action === "related_to_confidence_capped")).toBe(true);
  });

  it("merges duplicate relations", () => {
    const result = applyGraphRulesToExtraction(extraction([
      { sourceKey: "a", targetKey: "b", type: "supports", reason: "one", confidence: 0.4, evidenceChunkIds: ["chunk-1"] },
      { sourceKey: "a", targetKey: "b", type: "supports", reason: "two", confidence: 0.8, evidenceChunkIds: ["chunk-1"] },
    ]), { allowedChunks: [chunk] });
    expect(result.output.relations).toHaveLength(1);
    expect(result.output.relations[0]?.confidence).toBe(0.8);
    expect(result.traces.some((trace) => trace.action === "duplicate_relation_merged")).toBe(true);
  });

  it("removes weak relations covered by strong relations", () => {
    const result = applyGraphRulesToExtraction(extraction([
      { sourceKey: "a", targetKey: "b", type: "supports", reason: "strong", confidence: 0.8, evidenceChunkIds: ["chunk-1"] },
      { sourceKey: "a", targetKey: "b", type: "related_to", reason: "weak", confidence: 0.5, evidenceChunkIds: ["chunk-1"] },
    ]), { allowedChunks: [chunk] });
    expect(result.output.relations.map((relation) => relation.type)).toEqual(["supports"]);
    expect(result.traces.some((trace) => trace.action === "weak_relation_removed_by_strong_relation")).toBe(true);
  });

  it("marks conflicting strong relations as needs_review", () => {
    const result = applyGraphRulesToExtraction(extraction([
      { sourceKey: "a", targetKey: "b", type: "supports", reason: "yes", confidence: 0.8, evidenceChunkIds: ["chunk-1"] },
      { sourceKey: "a", targetKey: "b", type: "contradicts", reason: "no", confidence: 0.8, evidenceChunkIds: ["chunk-1"] },
    ]), { allowedChunks: [chunk] });
    expect(result.output.relations.every((relation) => relation.ruleDecision === "needs_review")).toBe(true);
    expect(result.summary.reviewCount).toBe(2);
  });

  it("exposes relation algebra helpers", () => {
    expect(composeRelationTypes("supports", "supports")).toBe("possible_inference_path");
    expect(composeRelationTypes("supports", "contradicts")).toBe("review");
    expect(composeRelationTypes("related_to", "supports")).toBe("weak_path");
    expect(requiresReviewByComposition("depends_on", "contradicts")).toBe(true);
    expect(getInverseRelationLabel("example_of")).toBe("has_example");
  });
});
