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
import { FakeModelProvider } from "../src/services/models.js";
import {
  computePulseReconciliation,
  PulseEvidenceController,
  verifyPulseAnswer,
} from "../src/services/pulse-evidence-controller.js";
import { VectorStore } from "../src/services/vector-store.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-pulse-evidence-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

function amountRow(id: string, amount: number, options: { declared?: boolean; counted?: boolean } = {}): PulseEvidenceRow {
  return {
    rowId: id,
    evidenceType: "amount",
    claimText: `${amount} 万`,
    structuredValue: { normalizedAmountWan: amount, ...(options.declared ? { role: "declared_total" } : {}) },
    evidenceChunkId: `chunk-${id}`,
    evidenceQuote: `${amount} 万`,
    confidence: 0.9,
    ...(options.counted !== undefined ? { countedInAnswer: options.counted } : {}),
  };
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
    evidenceTargets: ["金额总数", "分项金额"],
    keyEntities: ["bribery"],
    expectedEvidenceTypes: ["amount", "quote"],
    riskLevel: "high",
    reasoning: "金额问题需要结构化证据和闭合校验。",
  };
}

class RecordingPulseModel extends FakeModelProvider {
  readonly plannedTools: string[] = [];
  readonly extractionInputs: Array<{ purpose: string; chunkIds: string[] }> = [];
  judgeCalls = 0;

  async analyzePulseQuestion(): Promise<PulseQuestionPlan> {
    return plan();
  }

  async planPulseEvidence(): Promise<PulseEvidencePlan> {
    return {
      objective: "Find bribery totals and itemized facts.",
      steps: [
        { tool: "semanticSearch", query: "bribery total", purpose: "semantic", expectedResult: "chunks" },
        { tool: "fullTextSearch", query: "617.496083", purpose: "literal", expectedResult: "chunks" },
        { tool: "readNeighborChunks", basedOnChunkIds: [], purpose: "neighbors", expectedResult: "nearby chunks" },
        { tool: "readSameSectionChunks", basedOnChunkIds: [], purpose: "section", expectedResult: "section chunks" },
        { tool: "amountRegexScan" as any, query: "bad", purpose: "bad", expectedResult: "bad" },
      ],
      stopCondition: "enough",
      expectedEvidenceShape: "EvidenceRows",
      maxIterations: 4,
    };
  }

  async extractPulseEvidenceRows(input: {
    purpose: string;
    chunks: Array<{ id: string; text: string }>;
  }): Promise<PulseEvidenceRow[]> {
    this.extractionInputs.push({ purpose: input.purpose, chunkIds: input.chunks.map((chunk) => chunk.id) });
    return input.chunks.map((chunk, index) => ({
      rowId: `${chunk.id}-${index}`,
      evidenceType: "quote",
      claimText: chunk.text,
      evidenceChunkId: chunk.id,
      evidenceQuote: chunk.text,
      confidence: 0.8,
      dedupeKey: chunk.id,
    }));
  }

  async judgePulseEvidenceSufficiency(): Promise<PulseEvidenceStatus> {
    this.judgeCalls += 1;
    if (this.judgeCalls === 1) {
      return {
        sufficient: false,
        status: "needs_gap_retrieval",
        gaps: [{
          type: "missing_itemized_evidence",
          description: "缺少 606.42607 万差额来源。",
          suggestedQueries: ["606.42607"],
          severity: "high",
        }],
        reasoning: "需要 gap retrieval。",
      };
    }
    return { sufficient: true, status: "sufficient", gaps: [], reasoning: "gap closed" };
  }

  async synthesizePulseAnswer(): Promise<PulseAnswerOutput> {
    return {
      answer: "引用：受贿总额 617.496083 万。差额来源 606.42607。",
      summary: "sufficient",
    };
  }

  async rewritePulseAnswer(input: { draft: PulseAnswerOutput }): Promise<PulseAnswerOutput> {
    return input.draft;
  }
}

function seed(db: AgentDatabase): { libraryId: string; chunks: Chunk[] } {
  const library = db.createLibrary("Pulse evidence");
  const version = db.createDocumentVersion(library.id, "case.md", "text/markdown", "case", "case").version;
  const chunks = db.replaceChunks(library.id, version.id, [
    { ordinal: 0, headingPath: "Facts", pageNumber: null, startChar: 0, endChar: 20, text: "受贿总额 617.496083 万。" },
    { ordinal: 1, headingPath: "Facts", pageNumber: null, startChar: 21, endChar: 48, text: "差额来源 606.42607。" },
    { ordinal: 2, headingPath: "Other", pageNumber: null, startChar: 49, endChar: 70, text: "unrelated" },
  ]);
  return { libraryId: library.id, chunks };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PulseEvidenceController", () => {
  it("reconciles closed and mismatched amount rows", () => {
    expect(computePulseReconciliation([
      amountRow("declared", 100, { declared: true, counted: false }),
      amountRow("a", 40),
      amountRow("b", 60),
    ])).toMatchObject({ declaredTotal: 100, itemizedSum: 100, difference: 0, closed: true });

    expect(computePulseReconciliation([
      amountRow("declared", 1223.922153, { declared: true, counted: false }),
      amountRow("itemized", 617.496083),
    ])).toMatchObject({ declaredTotal: 1223.922153, itemizedSum: 617.496083, difference: 606.42607, closed: false });
  });

  it("blocks missing difference, false completeness, and missing source quote", () => {
    const memory = {
      question: "金额?",
      questionPlan: plan(),
      collectedChunks: [],
      graphNodes: [],
      graphRelations: [],
      evidenceRows: [{
        rowId: "quote",
        evidenceType: "quote" as const,
        claimText: "受贿总额 617.496083 万",
        evidenceChunkId: "chunk-1",
        evidenceQuote: "受贿总额 617.496083 万",
        confidence: 0.9,
      }],
      citedChunkIds: ["chunk-1"],
      retrievalHistory: [],
      currentFindings: [],
      gaps: [{ type: "sum_mismatch" as const, description: "差额不一致", suggestedQueries: [], severity: "high" as const }],
      sufficiencyHistory: [],
    };
    const status: PulseEvidenceStatus = {
      sufficient: false,
      status: "failed_reconciliation",
      gaps: memory.gaps,
      reasoning: "bad",
      reconciliation: { declaredTotal: 1223.922153, itemizedSum: 617.496083, difference: 606.42607, unit: "万", closed: false, explanation: "bad" },
    };
    const result = verifyPulseAnswer({ answer: "全部金额已经完整闭合。", summary: "bad" }, plan(), memory, status);
    expect(result.passed).toBe(false);
    expect(result.errors.join("\n")).toContain("原文引用");
    expect(result.errors.join("\n")).toContain("完整");
    expect(result.errors.join("\n")).toContain("差额");
  });

  it("uses only generic tools and performs progressive gap retrieval", async () => {
    const db = await database();
    const { libraryId, chunks } = seed(db);
    const vectors = new VectorStore(db);
    const model = new RecordingPulseModel();
    for (const chunk of chunks) {
      const [embedding] = await model.embed([chunk.text]);
      vectors.save(chunk, embedding!);
    }

    const result = await new PulseEvidenceController(db, vectors, model).answer(
      libraryId,
      "受贿总额是多少?",
      "progressive",
      {
        hits: [{
          targetType: "chunk",
          targetId: chunks[0]!.id,
          score: 0.9,
          reason: "seed",
          pathRole: "direct",
          stepIndex: 1,
          observation: "seed",
          rationale: "seed",
          label: "seed",
          excerpt: chunks[0]!.text,
        }],
        chunks: [chunks[0]!],
        nodes: [],
        relations: [],
      },
    );

    const tools = result.diagnostics?.retrievalSteps?.map((step) => step.tool) ?? [];
    expect(tools).toEqual(expect.arrayContaining(["semanticSearch", "fullTextSearch", "readNeighborChunks", "readSameSectionChunks"]));
    expect(tools).not.toContain("amountRegexScan");
    expect(model.judgeCalls).toBe(2);
    expect(result.diagnostics?.retrievalSteps?.some((step) => step.query === "606.42607")).toBe(true);
    expect(result.evidenceRows?.some((row) => row.evidenceChunkId === chunks[0]!.id && row.evidenceQuote)).toBe(true);
    db.close();
  });
});
