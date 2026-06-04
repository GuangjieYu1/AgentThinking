import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Chunk,
  PulseAnswerOutput,
  PulseEvidencePlan,
  PulseEvidenceRow,
  PulseEvidenceStatus,
  PulseQuestionPlan,
} from "@agent-thinking/contracts";
import { AgentDatabase } from "../src/db.js";
import { buildContextIndex } from "../src/domain/context-units.js";
import { FakeModelProvider } from "../src/services/models.js";
import { PulseEvidenceController } from "../src/services/pulse-evidence-controller.js";
import { VectorStore } from "../src/services/vector-store.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-pulse-v2-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

function plan(): PulseQuestionPlan {
  return {
    questionType: "numerical_aggregation",
    requiresExhaustiveEvidence: true,
    requiresStructuredEvidence: true,
    requiresNumericalReconciliation: true,
    requiresSourceQuotes: true,
    requiresTimelineCompleteness: false,
    requiresEntityCoverage: false,
    allowedPartialAnswer: true,
    answerMustExposeGaps: true,
    evidenceTargets: ["declared total", "itemized values"],
    keyEntities: ["values"],
    expectedEvidenceTypes: ["amount", "quote"],
    riskLevel: "high",
    reasoning: "Needs exact source-backed aggregation.",
  };
}

class V2PulseModel extends FakeModelProvider {
  async analyzePulseQuestion(): Promise<PulseQuestionPlan> {
    return plan();
  }

  async planPulseEvidence(): Promise<PulseEvidencePlan> {
    return {
      objective: "Find declared and itemized values.",
      steps: [
        { tool: "semanticSearchChildChunks", query: "declared total source values", purpose: "semantic", expectedResult: "evidence units" },
        { tool: "fullTextSearchChildChunks", query: "Declared total Source A Source B", purpose: "literal", expectedResult: "evidence units" },
      ],
      stopCondition: "reconciled",
      expectedEvidenceShape: "EvidenceRows",
      maxIterations: 2,
    };
  }

  async extractPulseEvidenceRows(input: { chunks: Array<{ id: string; text: string }> }): Promise<PulseEvidenceRow[]> {
    return input.chunks.flatMap((chunk) => {
      const rows: PulseEvidenceRow[] = [];
      if (chunk.text.includes("Declared total is 100 units")) {
        rows.push({
          rowId: "declared-total",
          evidenceType: "amount",
          claimText: "Declared total is 100 units",
          structuredValue: { normalizedValue: 100, role: "declared_total", exactForAggregation: true },
          role: "declared_total",
          evidenceChunkId: chunk.id,
          evidenceQuote: "Declared total is 100 units.",
          confidence: 0.95,
          countedInAnswer: true,
          dedupeKey: "declared-total",
        });
      }
      if (chunk.text.includes("Source A contributes 40 units")) {
        rows.push({
          rowId: "source-a",
          evidenceType: "amount",
          claimText: "Source A contributes 40 units",
          structuredValue: { normalizedValue: 40, role: "itemized_value", exactForAggregation: true },
          role: "itemized_value",
          evidenceChunkId: chunk.id,
          evidenceQuote: "Source A contributes 40 units.",
          confidence: 0.95,
          countedInAnswer: true,
          dedupeKey: "source-a",
        });
      }
      if (chunk.text.includes("Source B contributes 60 units")) {
        rows.push({
          rowId: "source-b",
          evidenceType: "amount",
          claimText: "Source B contributes 60 units",
          structuredValue: { normalizedValue: 60, role: "itemized_value", exactForAggregation: true },
          role: "itemized_value",
          evidenceChunkId: chunk.id,
          evidenceQuote: "Source B contributes 60 units.",
          confidence: 0.95,
          countedInAnswer: true,
          dedupeKey: "source-b",
        });
      }
      return rows;
    });
  }

  async judgePulseEvidenceSufficiency(input: { computedReconciliation?: unknown }): Promise<PulseEvidenceStatus> {
    const reconciliation = input.computedReconciliation as PulseEvidenceStatus["reconciliation"] | undefined;
    return {
      sufficient: reconciliation?.closed === true,
      status: reconciliation?.closed ? "sufficient" : "needs_gap_retrieval",
      gaps: reconciliation?.closed ? [] : [{ type: "sum_mismatch", description: "Values do not reconcile.", suggestedQueries: [], severity: "high" }],
      reasoning: "Use computed reconciliation.",
      ...(reconciliation ? { reconciliation } : {}),
    };
  }

  async synthesizePulseAnswer(input: { evidenceStatus: PulseEvidenceStatus }): Promise<PulseAnswerOutput> {
    return {
      answer: `Declared total is 100 units. Source A contributes 40 units. Source B contributes 60 units. Difference ${input.evidenceStatus.reconciliation?.difference}.`,
      summary: "v2 evidence sufficient",
    };
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pulse v2 evidence-heavy path", () => {
  it("uses retrieval units internally while preserving full mode", async () => {
    const db = await database();
    const model = new V2PulseModel();
    const vectors = new VectorStore(db);
    const library = db.createLibrary("Pulse v2");
    const version = db.createDocumentVersion(library.id, "values.md", "text/markdown", "hash", "values.md").version;
    const chunks: Chunk[] = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "Values", pageNumber: null, startChar: 0, endChar: 96, text: "Declared total is 100 units.\n\nSource A contributes 40 units.\n\nSource B contributes 60 units." },
    ]);
    const build = db.createIndexBuild(version.id, "v2");
    const sidecar = buildContextIndex({ buildId: build.buildId, versionId: version.id, chunks, treeNodes: [] });
    db.saveContextIndex(build.buildId, sidecar.contextUnits, sidecar.retrievalUnits, sidecar.qualityReport, sidecar.performanceReport);
    for (const unit of sidecar.retrievalUnits) {
      const [embedding] = await model.embed([unit.text]);
      vectors.saveRetrievalUnit(library.id, unit, embedding ?? []);
    }
    db.markIndexBuildReady(build.buildId, { vectorCount: sidecar.retrievalUnits.length });

    const result = await new PulseEvidenceController(db, vectors, model).answer(library.id, "What is the declared total and each source value?", "full", {
      hits: [],
      chunks: [],
      nodes: [],
      relations: [],
    });

    expect(result.evidencePack.usedIndexProfile).toBe("v2");
    expect(result.evidencePack.answerMode).toBe("evidence_heavy");
    expect(result.evidencePack.retrievalTrace.some((trace) => trace.actualIndexProfile === "v2" && trace.targetType === "retrieval_unit")).toBe(true);
    expect(result.evidencePack.retrievalTrace.some((trace) => (trace.outputRetrievalUnitIds ?? []).length > 0)).toBe(true);
    expect(result.evidenceRows?.every((row) => row.contextUnitId && row.citation?.matchLevel === "exact")).toBe(true);
    expect(result.evidenceStatus?.reconciliation).toMatchObject({ declaredTotal: 100, exactItemizedSum: 100, difference: 0, closed: true });
    db.close();
  });
});
