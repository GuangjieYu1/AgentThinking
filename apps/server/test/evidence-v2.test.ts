import { describe, expect, it } from "vitest";
import type { ContextUnit, PulseEvidenceRow, PulseQuestionPlan } from "@agent-thinking/contracts";
import {
  computeGenericReconciliation,
  normalizeAnswerMode,
  normalizeNumericValue,
  resolveCitationLocator,
  validateEvidenceRow,
} from "../src/services/evidence-v2.js";

function contextUnit(): ContextUnit {
  return {
    id: "cu-1",
    stableKey: "stable-cu-1",
    buildId: "build-1",
    versionId: "version-1",
    sourceNodeIds: ["node-1"],
    primarySourceNodeId: "node-1",
    sourceRange: { startSourceNodeId: "node-1", endSourceNodeId: "node-1", startChar: 0, endChar: 100 },
    headingPath: ["Values"],
    displayHeadingPath: ["Values"],
    ordinal: 0,
    ordinalInPrimarySource: 0,
    text: "Declared total is 100 units.\n\nSource A contributes 40 units.\n\nApproximately 30 units are mentioned for context.",
    blocks: [
      { blockId: "b1", type: "paragraph", startChar: 0, endChar: 28, ordinal: 0, textPreview: "Declared total is 100 units." },
      { blockId: "b2", type: "paragraph", startChar: 30, endChar: 60, ordinal: 1, textPreview: "Source A contributes 40 units." },
      { blockId: "b3", type: "paragraph", startChar: 62, endChar: 109, ordinal: 2, textPreview: "Approximately 30 units are mentioned for context." },
    ],
    retrievalUnitIds: ["ru-1"],
    estimatedTokens: 25,
    boundaryReason: "document_tree_boundary",
  };
}

describe("Evidence v2 validators", () => {
  it("resolves exact and normalized quotes with stable hashes", () => {
    const unit = contextUnit();
    const exact = resolveCitationLocator({ quote: "Source A contributes 40 units.", contextUnit: unit });
    const normalized = resolveCitationLocator({ quote: "Source A contributes 40 units。", contextUnit: unit });
    const missing = resolveCitationLocator({ quote: "Source Z contributes 99 units.", contextUnit: unit });

    expect(exact.matchLevel).toBe("exact");
    expect(normalized.matchLevel).toBe("normalized");
    expect(missing.matchLevel).toBe("not_found");
    expect(exact.quoteHash).toMatch(/[a-f0-9]{64}/);
    expect(exact.locatorHash).toMatch(/[a-f0-9]{64}/);
  });

  it("normalizes approximate numeric values and excludes unsupported rows from exact reconciliation", () => {
    expect(normalizeNumericValue("approximately 30 units")).toMatchObject({
      normalizedValue: 30,
      approximate: true,
      exactForAggregation: false,
    });
    const rows: PulseEvidenceRow[] = [
      {
        rowId: "declared",
        evidenceType: "amount",
        claimText: "Declared total 100",
        structuredValue: { normalizedValue: 100 },
        role: "declared_total",
        evidenceChunkId: "chunk-1",
        evidenceQuote: "Declared total is 100 units.",
        confidence: 0.9,
      },
      validateEvidenceRow({
        rowId: "item",
        evidenceType: "amount",
        claimText: "Source A 40",
        structuredValue: { normalizedValue: 40, exactForAggregation: true },
        role: "itemized_value",
        evidenceChunkId: "chunk-2",
        evidenceQuote: "Source A contributes 40 units.",
        confidence: 0.9,
      }, contextUnit()),
      validateEvidenceRow({
        rowId: "approximate",
        evidenceType: "amount",
        claimText: "Approximately 30",
        structuredValue: { normalizedValue: 30, approximate: true, exactForAggregation: false },
        role: "approximate_value",
        evidenceChunkId: "chunk-3",
        evidenceQuote: "Approximately 30 units are mentioned for context.",
        confidence: 0.8,
      }, contextUnit()),
    ];

    expect(computeGenericReconciliation(rows)).toMatchObject({
      declaredTotal: 100,
      exactItemizedSum: 40,
      difference: 60,
      closed: false,
    });
  });

  it("forces evidence-heavy answer mode for high-risk aggregation plans", () => {
    const plan: PulseQuestionPlan = {
      questionType: "numerical_aggregation",
      requiresExhaustiveEvidence: true,
      requiresStructuredEvidence: true,
      requiresNumericalReconciliation: true,
      requiresSourceQuotes: true,
      requiresTimelineCompleteness: false,
      requiresEntityCoverage: false,
      allowedPartialAnswer: true,
      answerMustExposeGaps: true,
      evidenceTargets: ["total", "items"],
      keyEntities: ["values"],
      expectedEvidenceTypes: ["amount"],
      riskLevel: "high",
      reasoning: "Needs exact aggregation.",
    };
    expect(normalizeAnswerMode(plan)).toMatchObject({ answerMode: "evidence_heavy", overridden: true });
  });
});
