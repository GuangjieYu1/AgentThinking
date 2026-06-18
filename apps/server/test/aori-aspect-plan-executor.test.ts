import { describe, expect, it } from "vitest";
import type { QuestionAspectPlan, SemanticUnit } from "@agent-thinking/contracts";
import { executeQuestionAspectPlan } from "../src/services/aori-aspect-plan-executor.js";

function basePlan(strategy: QuestionAspectPlan["execution"]["strategy"]): QuestionAspectPlan {
  return {
    questionType: strategy === "negative_fact"
      ? "negative_fact"
      : strategy === "deterministic_numeric"
        ? "numeric_aggregation"
        : strategy === "concept_boundary"
          ? "concept_boundary"
          : strategy === "event_boundary"
            ? "event_effect"
            : "exhaustive_list",
    target: {
      questionType: "general_qa",
      targetDescription: "fixture",
      constraints: { aggregation: "none" },
      rawQuestion: "fixture",
    },
    selectedAspects: [],
    rejectedAspects: [],
    execution: {
      strategy,
      aggregation: strategy === "deterministic_numeric" ? "sum" : "none",
      requireCompleteEvidence: true,
    },
    confidence: 0.9,
  };
}

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

describe("AORI aspect plan executor", () => {
  it("answers deterministic numeric questions from reconciliation results", () => {
    const result = executeQuestionAspectPlan(basePlan("deterministic_numeric"), [
      unit({
        id: "recon-1",
        kind: "reconciliation",
        title: "资金表",
        summary: "资金表合计",
        sourceChunkIds: ["chunk-1"],
        confidence: 0.96,
        reflectionStatus: "ok",
        name: "资金表",
        formulaType: "sum",
        items: [{ label: "A", value: 10, unit: "万元", sign: 1 }],
        computedTotal: 14,
        reportedTotal: 14,
        diff: 0,
        closed: true,
      }),
    ]);

    expect(result.answer).toContain("14万元");
    expect(result.answer).toContain("闭合");
    expect(result.verification).toMatchObject({ passed: true, computedTotal: 14 });
  });

  it("does not claim closure when no reported total exists", () => {
    const result = executeQuestionAspectPlan(basePlan("deterministic_numeric"), [
      unit({
        id: "recon-2",
        kind: "reconciliation",
        title: "分项表",
        summary: "分项表 itemized total",
        sourceChunkIds: ["chunk-1"],
        confidence: 0.9,
        reflectionStatus: "needs_review",
        name: "分项表",
        formulaType: "sum",
        items: [{ label: "A", value: 10, unit: "万元", sign: 1 }],
        computedTotal: 10,
        closed: false,
      }),
    ]);

    expect(result.answer).toContain("分项合计为10万元");
    expect(result.answer).not.toContain("闭合");
  });

  it("answers negative fact questions only from the matching target and scope", () => {
    const plan: QuestionAspectPlan = {
      ...basePlan("negative_fact"),
      questionType: "negative_fact",
      target: {
        questionType: "negative_fact",
        targetDescription: "报告期内债务融资工具是否存在违约？",
        constraints: { aggregation: "none" },
        rawQuestion: "报告期内债务融资工具是否存在违约？",
      },
    };
    const result = executeQuestionAspectPlan(plan, [
      unit({
        id: "negative-debt",
        kind: "negative_fact",
        title: "债务融资工具",
        summary: "报告期内债务融资工具不存在违约。",
        sourceChunkIds: ["chunk-1"],
        confidence: 0.92,
        reflectionStatus: "ok",
        target: "债务融资工具",
        predicate: "不存在",
        scope: "报告期内",
        statement: "报告期内债务融资工具不存在违约。",
        certainty: "explicit",
      }),
      unit({
        id: "negative-loan",
        kind: "negative_fact",
        title: "飞行学员贷款",
        summary: "报告期内飞行学员贷款不存在违约。",
        sourceChunkIds: ["chunk-2"],
        confidence: 0.92,
        reflectionStatus: "ok",
        target: "飞行学员贷款",
        predicate: "不存在",
        scope: "报告期内",
        statement: "报告期内飞行学员贷款不存在违约。",
        certainty: "explicit",
      }),
    ]);

    expect(result.answer).toContain("债务融资工具不存在违约");
    expect(result.answer).not.toContain("飞行学员贷款");
  });
});
