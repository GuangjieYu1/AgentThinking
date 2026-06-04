import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Chunk,
  PulseAnswerContext,
  PulseAnswerOutput,
  PulseEvidencePlan,
  PulseEvidenceRow,
  PulseEvidenceStatus,
  PulseQuestionPlan,
} from "@agent-thinking/contracts";
import { AgentDatabase } from "../src/db.js";
import { buildContextIndex } from "../src/domain/context-units.js";
import { FakeModelProvider } from "../src/services/models.js";
import { PulseEngine } from "../src/services/pulse.js";
import { VectorStore } from "../src/services/vector-store.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-pulse-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

function seedPulseGraph(db: AgentDatabase) {
  const library = db.createLibrary("Pulse paths");
  const version = db.createDocumentVersion(library.id, "pulse.txt", "text/plain", "pulse", "pulse").version;
  const chunks = db.replaceChunks(library.id, version.id, [
    { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 11, text: "alpha topic" },
    { ordinal: 1, headingPath: null, pageNumber: null, startChar: 12, endChar: 23, text: "bridge node" },
    { ordinal: 2, headingPath: null, pageNumber: null, startChar: 24, endChar: 34, text: "beta topic" },
    { ordinal: 3, headingPath: null, pageNumber: null, startChar: 35, endChar: 49, text: "loose neighbor" },
  ]);
  db.saveExtraction(library.id, {
    nodes: [
      { key: "alpha", kind: "concept", title: "Alpha", summary: "alpha topic", evidenceChunkIds: [chunks[0]!.id], aspects: [] },
      { key: "bridge", kind: "concept", title: "Bridge", summary: "bridge node", evidenceChunkIds: [chunks[1]!.id], aspects: [] },
      { key: "beta", kind: "claim", title: "Beta", summary: "beta topic", evidenceChunkIds: [chunks[2]!.id], aspects: [] },
      { key: "loose", kind: "concept", title: "Loose", summary: "loose neighbor", evidenceChunkIds: [chunks[3]!.id], aspects: [] },
    ],
    relations: [
      { sourceKey: "alpha", targetKey: "bridge", type: "related_to", reason: "alpha to bridge", confidence: 0.8, evidenceChunkIds: [] },
      { sourceKey: "bridge", targetKey: "beta", type: "related_to", reason: "bridge to beta", confidence: 0.8, evidenceChunkIds: [] },
      { sourceKey: "alpha", targetKey: "loose", type: "related_to", reason: "incidental neighbor", confidence: 0.8, evidenceChunkIds: [] },
    ],
  }, version.id);
  return { library };
}

function evidencePlan(): PulseQuestionPlan {
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

class RecordingLegacyModel extends FakeModelProvider {
  answerPulseCalls = 0;
  evidenceControllerCalls = 0;

  override async analyzePulseQuestion(): Promise<PulseQuestionPlan> {
    this.evidenceControllerCalls += 1;
    throw new Error("v2 controller should not run");
  }

  override async answerPulse(_question: string, context: PulseAnswerContext): Promise<PulseAnswerOutput> {
    this.answerPulseCalls += 1;
    return {
      answer: `legacy answer with ${context.chunks.length} chunks`,
      summary: "legacy summary",
    };
  }
}

class V2PulseEngineModel extends FakeModelProvider {
  answerPulseCalls = 0;

  override async analyzePulseQuestion(): Promise<PulseQuestionPlan> {
    return evidencePlan();
  }

  override async planPulseEvidence(): Promise<PulseEvidencePlan> {
    return {
      objective: "Find source values.",
      steps: [
        { tool: "semanticSearchChildChunks", query: "Declared total Source A Source B", purpose: "semantic", expectedResult: "retrieval units" },
      ],
      stopCondition: "reconciled",
      expectedEvidenceShape: "EvidenceRows",
      maxIterations: 1,
    };
  }

  override async extractPulseEvidenceRows(input: { chunks: Array<{ id: string; text: string }> }): Promise<PulseEvidenceRow[]> {
    return input.chunks.flatMap((chunk) => {
      if (!chunk.id.startsWith("cu-")) return [];
      const rows: PulseEvidenceRow[] = [];
      if (chunk.text.includes("Declared total is 100 units")) {
        rows.push({
          rowId: `declared-${chunk.id}`,
          evidenceType: "amount",
          claimText: "Declared total is 100 units",
          structuredValue: { normalizedValue: 100, role: "declared_total", exactForAggregation: true },
          role: "declared_total",
          evidenceChunkId: chunk.id,
          evidenceQuote: "Declared total is 100 units.",
          confidence: 0.95,
          dedupeKey: "declared-total",
        });
      }
      if (chunk.text.includes("Source A contributes 40 units")) {
        rows.push({
          rowId: `source-a-${chunk.id}`,
          evidenceType: "amount",
          claimText: "Source A contributes 40 units",
          structuredValue: { normalizedValue: 40, role: "itemized_value", exactForAggregation: true },
          role: "itemized_value",
          evidenceChunkId: chunk.id,
          evidenceQuote: "Source A contributes 40 units.",
          confidence: 0.95,
          dedupeKey: "source-a",
        });
      }
      if (chunk.text.includes("Source B contributes 60 units")) {
        rows.push({
          rowId: `source-b-${chunk.id}`,
          evidenceType: "amount",
          claimText: "Source B contributes 60 units",
          structuredValue: { normalizedValue: 60, role: "itemized_value", exactForAggregation: true },
          role: "itemized_value",
          evidenceChunkId: chunk.id,
          evidenceQuote: "Source B contributes 60 units.",
          confidence: 0.95,
          dedupeKey: "source-b",
        });
      }
      return rows;
    });
  }

  override async judgePulseEvidenceSufficiency(input: { computedReconciliation?: unknown }): Promise<PulseEvidenceStatus> {
    const reconciliation = input.computedReconciliation as PulseEvidenceStatus["reconciliation"] | undefined;
    return {
      sufficient: reconciliation?.closed === true,
      status: reconciliation?.closed ? "sufficient" : "needs_gap_retrieval",
      gaps: reconciliation?.closed ? [] : [{ type: "sum_mismatch", description: "Values do not reconcile.", suggestedQueries: [], severity: "high" }],
      reasoning: "Use computed reconciliation.",
      ...(reconciliation ? { reconciliation } : {}),
    };
  }

  override async synthesizePulseAnswer(input: { evidenceStatus: PulseEvidenceStatus }): Promise<PulseAnswerOutput> {
    return {
      answer: `v2 answer closed=${input.evidenceStatus.reconciliation?.closed === true}. Source: Declared total is 100 units.`,
      summary: "v2 summary",
    };
  }

  override async answerPulse(_question: string, _context: PulseAnswerContext): Promise<PulseAnswerOutput> {
    this.answerPulseCalls += 1;
    return { answer: "legacy fallback answer", summary: "legacy fallback summary" };
  }
}

class FailingV2Model extends V2PulseEngineModel {
  override async analyzePulseQuestion(): Promise<PulseQuestionPlan> {
    throw new Error("forced v2 failure");
  }
}

async function seedReadyV2Index(db: AgentDatabase, vectors: VectorStore, model: FakeModelProvider) {
  const library = db.createLibrary("Pulse v2 gate");
  const version = db.createDocumentVersion(library.id, "values.md", "text/markdown", "values-hash", "values.md").version;
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
  return { library };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pulse activation", () => {
  it("keeps direct evidence and bridge paths without lighting unrelated one-hop neighbors", async () => {
    const db = await database();
    const { library } = seedPulseGraph(db);

    const pulse = await new PulseEngine(db, new VectorStore(db), new FakeModelProvider()).create(library.id, "alpha beta");
    const labels = pulse.hits.map((hit) => hit.label);
    expect(labels).toEqual(expect.arrayContaining(["Alpha", "Beta", "Bridge"]));
    expect(labels).not.toContain("Loose");
    expect(pulse.hits.some((hit) => hit.pathRole === "expanded")).toBe(false);
    expect(pulse.hits.filter((hit) => hit.targetType === "relation").map((hit) => hit.label).join("\n")).not.toContain("Loose");
    db.close();
  });

  it("records progressive input mode and visible navigation explanations", async () => {
    const db = await database();
    const { library } = seedPulseGraph(db);
    const streamedEvents: string[] = [];

    const pulse = await new PulseEngine(db, new VectorStore(db), new FakeModelProvider())
      .create(library.id, "alpha beta", "progressive", (event) => {
        streamedEvents.push(event.type);
      });

    expect(pulse.pulse.inputMode).toBe("progressive");
    expect(pulse.hits.length).toBeGreaterThan(0);
    expect(pulse.hits.every((hit) => hit.stepIndex !== null)).toBe(true);
    expect(pulse.hits.some((hit) => hit.observation?.length)).toBe(true);
    expect(pulse.hits.some((hit) => hit.rationale?.length)).toBe(true);
    expect(pulse.hits.map((hit) => hit.label)).toContain("Bridge");
    expect(streamedEvents).toEqual(expect.arrayContaining(["candidates", "decision", "backtrack"]));
    db.close();
  });

  it("uses legacy answerPulse when ENABLE_V2_PULSE_PACK is false", async () => {
    const db = await database();
    const { library } = seedPulseGraph(db);
    const model = new RecordingLegacyModel();

    const pulse = await new PulseEngine(db, new VectorStore(db), model, { enableV2PulsePack: false })
      .create(library.id, "alpha beta");

    expect(model.answerPulseCalls).toBe(1);
    expect(model.evidenceControllerCalls).toBe(0);
    expect(pulse.pulse.answer).toContain("legacy answer");
    expect(pulse.evidencePack?.pipeline?.kind).toBe("v1 legacy");
    expect(pulse.evidencePack?.evidencePackSchemaVersion).toBe(1);
    expect(pulse.evidencePack?.contextUnits ?? []).toHaveLength(0);
    expect(pulse.evidencePack?.retrievalUnits ?? []).toHaveLength(0);
    db.close();
  });

  it("uses v2 evidence pipeline when ENABLE_V2_PULSE_PACK is true and v2 index is ready", async () => {
    const db = await database();
    const vectors = new VectorStore(db);
    const model = new V2PulseEngineModel();
    const { library } = await seedReadyV2Index(db, vectors, model);

    const pulse = await new PulseEngine(db, vectors, model, { enableV2PulsePack: true })
      .create(library.id, "What is the declared total and each source value?");

    expect(model.answerPulseCalls).toBe(0);
    expect(pulse.pulse.answer).toContain("v2 answer");
    expect(pulse.evidencePack?.pipeline?.kind).toBe("v2 evidence-heavy");
    expect(pulse.evidencePack?.usedIndexProfile).toBe("v2");
    expect(pulse.evidencePack?.retrievalTrace.some((trace) => trace.actualIndexProfile === "v2" && trace.targetType === "retrieval_unit")).toBe(true);
    expect(pulse.evidencePack?.evidenceRows.every((row) => row.contextUnitId && row.citation?.matchLevel === "exact")).toBe(true);
    db.close();
  });

  it("falls back to legacy answerPulse when v2 flag is true but no v2 index is ready", async () => {
    const db = await database();
    const { library } = seedPulseGraph(db);
    const model = new RecordingLegacyModel();

    const pulse = await new PulseEngine(db, new VectorStore(db), model, { enableV2PulsePack: true })
      .create(library.id, "alpha beta");

    expect(model.answerPulseCalls).toBe(1);
    expect(model.evidenceControllerCalls).toBe(0);
    expect(pulse.pulse.answer).toContain("legacy answer");
    expect(pulse.evidencePack?.pipeline?.kind).toBe("v2 fallback_to_v1");
    expect(pulse.evidencePack?.warnings?.join("\n")).toContain("v2 index is not ready");
    expect(pulse.evidencePack?.contextUnits ?? []).toHaveLength(0);
    expect(pulse.evidencePack?.retrievalUnits ?? []).toHaveLength(0);
    db.close();
  });

  it("falls back to legacy answerPulse without throwing when the v2 pipeline fails", async () => {
    const db = await database();
    const vectors = new VectorStore(db);
    const model = new FailingV2Model();
    const { library } = await seedReadyV2Index(db, vectors, model);

    const pulse = await new PulseEngine(db, vectors, model, { enableV2PulsePack: true })
      .create(library.id, "What is the declared total?");

    expect(model.answerPulseCalls).toBe(1);
    expect(pulse.pulse.answer).toBe("legacy fallback answer");
    expect(pulse.evidencePack?.pipeline?.kind).toBe("v2 fallback_to_v1");
    expect(pulse.evidencePack?.warnings?.join("\n")).toContain("forced v2 failure");
    db.close();
  });
});
