import { describe, expect, it } from "vitest";
import type { Chunk, EvidencePack, PulseInputMode, PulseMetrics, PulseResponse, SemanticUnit, TraversalEvidenceItem, TraversalScoutResult } from "@agent-thinking/contracts";
import { FakeModelProvider } from "../src/services/models.js";
import { ClosureVerifier } from "../src/services/traversal-retrieval/closure-verifier.js";
import { ScoutExtractor } from "../src/services/traversal-retrieval/scout-extractor.js";
import { SeedArbitrationEngine } from "../src/services/traversal-retrieval/seed-arbitration.js";
import { TableRoleAdapter } from "../src/services/traversal-retrieval/table-role-adapter.js";

function chunk(partial: Partial<Chunk> & Pick<Chunk, "id" | "text">): Chunk {
  return {
    id: partial.id,
    libraryId: partial.libraryId ?? "library-1",
    versionId: partial.versionId ?? "version-1",
    parentChunkId: partial.parentChunkId ?? null,
    documentTreeNodeId: partial.documentTreeNodeId ?? null,
    childOrdinal: partial.childOrdinal ?? null,
    parentOrdinal: partial.parentOrdinal ?? null,
    nodeType: partial.nodeType ?? "paragraph",
    ordinal: partial.ordinal ?? 0,
    headingPath: partial.headingPath ?? null,
    pageNumber: partial.pageNumber ?? null,
    startLine: partial.startLine ?? null,
    endLine: partial.endLine ?? null,
    blockId: partial.blockId ?? null,
    startChar: partial.startChar ?? 0,
    endChar: partial.endChar ?? partial.text.length,
    text: partial.text,
    aspects: partial.aspects ?? [],
  };
}

function evidence(partial: Partial<TraversalEvidenceItem> & Pick<TraversalEvidenceItem, "chunkId" | "value" | "metric">): TraversalEvidenceItem {
  return {
    chunkId: partial.chunkId,
    value: partial.value,
    unit: partial.unit ?? "万元",
    metric: partial.metric,
    status: partial.status ?? "continue",
    direction: partial.direction ?? "seed",
    pathChunkIds: partial.pathChunkIds ?? [partial.chunkId],
    reason: partial.reason ?? "test evidence",
  };
}

function calibratedScout(overrides: Partial<TraversalScoutResult> = {}): TraversalScoutResult {
  return {
    phase: "scout",
    targets: ["header", "summary", "unit", "rowBoundary"],
    maxRounds: 2,
    declaredValue: 100,
    unit: "万元",
    metric: "募集金额",
    scope: "募集金额合计是多少",
    sourceChunkId: "summary",
    confidence: "high",
    competingDeclarations: [],
    calibrationStatus: "calibrated",
    ...overrides,
  };
}

describe("traversal retrieval v2 components", () => {
  it("classifies table chunk roles from structural and numeric signals", () => {
    const adapter = new TableRoleAdapter();

    expect(adapter.classify(chunk({ id: "header", text: "募集资金使用情况", nodeType: "section" })).role).toBe("header");
    expect(adapter.classify(chunk({ id: "row", text: "| 项目A | 60万元 |", ordinal: 1 })).role).toBe("data_row");
    expect(adapter.classify(chunk({ id: "summary", text: "合计 100万元", ordinal: 2 })).role).toBe("summary");
    expect(adapter.classify(chunk({ id: "table", text: "| 项目 | 金额 |\n| --- | --- |", ordinal: 3 })).role).toBe("table");
  });

  it("extracts declared values, competing declarations, and calibration-missing scout state", () => {
    const scout = new ScoutExtractor();
    const result = scout.extract({
      question: "募集金额合计是多少？",
      completenessType: "sum_alignment",
      chunks: [
        chunk({ id: "summary", text: "募集金额合计为100万元。", ordinal: 0 }),
        chunk({ id: "row-a", text: "项目A 募集金额 60万元。", ordinal: 1 }),
        chunk({ id: "row-b", text: "项目B 募集金额 40万元。", ordinal: 2 }),
      ],
    });

    expect(result.calibrationStatus).toBe("calibrated");
    expect(result.declaredValue).toBe(100);
    expect(result.unit).toBe("万元");
    expect(result.competingDeclarations.map((entry) => entry.value)).toEqual(expect.arrayContaining([60, 40]));

    const missing = scout.extract({
      question: "募集金额合计是多少？",
      completenessType: "sum_alignment",
      chunks: [chunk({ id: "nonnumeric", text: "本节说明募集资金用途。", ordinal: 3 })],
    });
    expect(missing.calibrationStatus).toBe("calibration_missing");
    expect(missing.declaredValue).toBeUndefined();
  });

  it("verifies closure statuses for closed, partial, mismatch, and failed sum alignment", () => {
    const verifier = new ClosureVerifier();
    const matchingEvidence = [
      evidence({ chunkId: "row-a", value: 60, metric: "募集金额" }),
      evidence({ chunkId: "row-b", value: 40, metric: "募集金额" }),
    ];

    expect(verifier.verify({
      completenessType: "sum_alignment",
      scout: calibratedScout(),
      evidence: matchingEvidence,
      roleMap: new Map([
        ["row-a", { role: "data_row", confidence: 0.86 }],
        ["row-b", { role: "data_row", confidence: 0.86 }],
      ]),
      rowBoundaryChecked: true,
    }).status).toBe("closed");

    expect(verifier.verify({
      completenessType: "sum_alignment",
      scout: calibratedScout(),
      evidence: matchingEvidence,
      roleMap: new Map([
        ["row-a", { role: "data_row", confidence: 0.86 }],
        ["row-b", { role: "data_row", confidence: 0.86 }],
      ]),
      rowBoundaryChecked: false,
    }).status).toBe("partial");

    expect(verifier.verify({
      completenessType: "sum_alignment",
      scout: calibratedScout({ competingDeclarations: [{
        value: 100,
        unit: "万元",
        metric: "其他金额",
        scope: "其他金额合计",
        sourceChunkId: "other-summary",
        confidence: "high",
      }] }),
      evidence: matchingEvidence,
      roleMap: new Map([
        ["row-a", { role: "data_row", confidence: 0.86 }],
        ["row-b", { role: "data_row", confidence: 0.86 }],
        ["other-summary", { role: "summary", confidence: 0.88 }],
      ]),
      rowBoundaryChecked: true,
    }).status).toBe("mismatch");

    expect(verifier.verify({
      completenessType: "sum_alignment",
      scout: calibratedScout(),
      evidence: [evidence({ chunkId: "row-a", value: 60, metric: "募集金额" })],
      roleMap: new Map([
        ["row-a", { role: "data_row", confidence: 0.86 }],
      ]),
      rowBoundaryChecked: true,
    }).status).toBe("failed");
  });

  it("scores seed arbitration with source caps, role compatibility, and promotion thresholds", () => {
    const chunks = [
      chunk({ id: "header", text: "募集资金项目明细", headingPath: "募集资金", nodeType: "section", ordinal: 0 }),
      chunk({ id: "row-a", text: "项目A 募集金额 60万元", headingPath: "募集资金", ordinal: 1 }),
      chunk({ id: "row-b", text: "项目B 募集金额 40万元", headingPath: "募集资金", ordinal: 2 }),
      chunk({ id: "noise", text: "董事会会议通知", headingPath: "治理", ordinal: 12 }),
    ];

    const clusters = new SeedArbitrationEngine().arbitrate({
      question: "募集金额合计是多少？",
      pattern: "table_horizontal",
      chunks,
      candidates: [
        { chunkId: "row-a", source: "AORI", score: 0.9, reliability: 0.95, reason: "aori row" },
        { chunkId: "header", source: "keyword", score: 0.72, reliability: 0.6, reason: "keyword header" },
        { chunkId: "row-b", source: "keyword", score: 0.72, reliability: 0.6, reason: "keyword row" },
        { chunkId: "noise", source: "vector", score: 0.02, reliability: 0.4, reason: "weak vector hit" },
      ],
      caps: { total_cap: 2 },
    });

    const promoted = clusters.filter((cluster) => cluster.decision !== "discard");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.anchorChunkId).toBe("header");
    expect(promoted[0]?.chunkIds).toEqual(expect.arrayContaining(["header", "row-a", "row-b"]));
    expect(promoted[0]?.arbitrationScores.patternCompatibility).toBeGreaterThan(0.8);
    expect(promoted[0]?.arbitrationScores.sourceReliability).toBeGreaterThan(0.7);
    expect(clusters.find((cluster) => cluster.chunkIds.includes("noise"))?.decision).toBe("discard");
  });
});

describe("pulse traversal retrieval v2 guard", () => {
  it("does not invoke traversal v2 when default flag is not enabled", async () => {
    const { PulseEngine } = await import("../src/services/pulse.js");
    const sourceChunk = chunk({
      id: "guard-chunk",
      libraryId: "library-guard",
      versionId: "version-guard",
      headingPath: "募集金额",
      text: "项目A 60万元；项目B 40万元；募集金额合计 100万元。",
    });
    const semanticUnit: SemanticUnit = {
      id: "semantic-reconciliation-1",
      kind: "reconciliation",
      libraryId: "library-guard",
      documentId: "document-guard",
      versionId: "version-guard",
      title: "募集金额合计",
      summary: "募集金额合计是多少 募集金额合计 100万元",
      sourceChunkIds: [sourceChunk.id],
      sourceNodeIds: [],
      confidence: 1,
      reflectionStatus: "ok",
      reflectionNotes: [],
      name: "募集金额合计",
      formulaType: "sum",
      items: [
        { label: "项目A", value: 60, unit: "万元", sign: 1 },
        { label: "项目B", value: 40, unit: "万元", sign: 1 },
      ],
      computedTotal: 100,
      reportedTotal: 100,
      diff: 0,
      closed: true,
    };
    const fakeDb = new SemanticGuardDatabase(sourceChunk, semanticUnit);

    const pulse = await new PulseEngine(fakeDb as never, { usesSqliteVec: false } as never, new FakeModelProvider(), {
      aoriAnswerMode: "traversal",
    }).create("library-guard", "募集金额合计是多少？", "full");

    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_semantic");
    expect(pulse.pulse.answer).toContain("募集金额合计计算结果为100万元");
    expect(pulse.pulse.answer).not.toContain("traversal retrieval v2");
  });
});

class SemanticGuardDatabase {
  private readonly pulses = new Map<string, PulseResponse>();

  constructor(
    private readonly sourceChunk: Chunk,
    private readonly semanticUnit: SemanticUnit,
  ) {}

  listAoriDocumentIndexes(libraryId: string) {
    return [{
      libraryId,
      documentId: this.semanticUnit.documentId,
      documentName: "guard.md",
      versionId: this.semanticUnit.versionId,
      understanding: {
        versionId: this.semanticUnit.versionId,
        summary: "Guard semantic index.",
        centralQuestion: "募集金额合计是多少？",
        evidenceChunkIds: [this.sourceChunk.id],
      },
      aspects: [],
      closureReports: [],
      selfQuestions: [],
      semanticUnits: [this.semanticUnit],
      reflectiveFindings: [],
      relationLexicon: [],
      rationaleTrace: [],
      reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
  }

  getChunksByIds(ids: string[]): Chunk[] {
    return ids.includes(this.sourceChunk.id) ? [this.sourceChunk] : [];
  }

  createPulse(
    libraryId: string,
    question: string,
    answer: string,
    summary: string,
    mode: PulseInputMode,
    _hits: unknown[],
    evidencePack: EvidencePack,
    metrics?: PulseMetrics,
  ) {
    const id = "pulse-guard";
    const response: PulseResponse = {
      pulse: {
        id,
        libraryId,
        question,
        answer,
        summary,
        inputMode: mode,
        status: "unreviewed",
        createdAt: "2026-01-01T00:00:00.000Z",
        reviewedAt: null,
        ...(metrics ? { metrics } : {}),
      },
      hits: [],
      graph: { nodes: [], edges: [], truncated: false },
      evidencePack,
    };
    this.pulses.set(id, response);
    return response.pulse;
  }

  getPulseResponse(_libraryId: string, pulseId: string): PulseResponse | undefined {
    return this.pulses.get(pulseId);
  }
}
