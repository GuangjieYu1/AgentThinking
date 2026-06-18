import { describe, expect, it } from "vitest";
import type { SemanticUnit } from "@agent-thinking/contracts";
import { buildQuestionAspectPlan, inferQuestionType, SEMANTIC_SELECTION_THRESHOLD } from "../src/services/aori-question-routing.js";

function unit(partial: Partial<SemanticUnit> & Pick<SemanticUnit, "id" | "kind" | "summary" | "sourceChunkIds" | "confidence" | "reflectionStatus">): SemanticUnit {
  return {
    documentId: "document-1",
    libraryId: "library-1",
    versionId: "version-1",
    title: partial.title,
    reflectionNotes: partial.reflectionNotes,
    metadata: partial.metadata,
    ...partial,
  } as SemanticUnit;
}

describe("AORI question routing", () => {
  it("classifies question types conservatively", () => {
    expect(inferQuestionType("资金表合计总额是多少？")).toBe("numeric_aggregation");
    expect(inferQuestionType("这项事项是否不涉及担保？")).toBe("negative_fact");
    expect(inferQuestionType("A 和 B 有什么区别？")).toBe("concept_boundary");
  });

  it("selects relevant semantic units and records rejected reasons", () => {
    const plan = buildQuestionAspectPlan("资金表合计总额是多少？", [
      unit({
        id: "recon",
        kind: "reconciliation",
        title: "资金表合计",
        summary: "资金表合计 computed from itemized rows",
        sourceChunkIds: ["chunk-1"],
        confidence: 0.95,
        reflectionStatus: "ok",
        name: "资金表",
        formulaType: "sum",
        items: [],
        computedTotal: 14,
        closed: true,
      }),
      unit({
        id: "event",
        kind: "event",
        title: "事项变化",
        summary: "some unrelated event",
        sourceChunkIds: ["chunk-2"],
        confidence: 0.4,
        reflectionStatus: "needs_review",
        eventName: "事项变化",
        eventCategory: "business_event",
        affectedItems: [],
        sourceSectionTitle: "section",
      }),
    ]);

    expect(plan.questionType).toBe("numeric_aggregation");
    expect(plan.confidence).toBeGreaterThanOrEqual(SEMANTIC_SELECTION_THRESHOLD);
    expect(plan.selectedAspects).toHaveLength(1);
    expect(plan.selectedAspects[0]?.aspectId).toBe("recon");
    expect(plan.rejectedAspects[0]).toMatchObject({
      aspectId: "event",
      decision: "rejected",
    });
  });
});
