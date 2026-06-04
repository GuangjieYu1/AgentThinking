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
    keyEntities: ["value aggregation"],
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
      objective: "Find value aggregation totals and itemized facts.",
      steps: [
        { tool: "semanticSearch", query: "value aggregation total", purpose: "semantic", expectedResult: "chunks" },
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
      role: "direct_fact",
      authority: "unknown",
      usage: "answer_core",
      classificationRationale: "Test row is directly quoted from the source chunk.",
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
      answer: "引用：声明总额 617.496083 万。差额来源 606.42607。",
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
    { ordinal: 0, headingPath: "Facts", pageNumber: null, startChar: 0, endChar: 20, text: "声明总额 617.496083 万。" },
    { ordinal: 1, headingPath: "Facts", pageNumber: null, startChar: 21, endChar: 48, text: "差额来源 606.42607。" },
    { ordinal: 2, headingPath: "Other", pageNumber: null, startChar: 49, endChar: 70, text: "unrelated" },
  ]);
  return { libraryId: library.id, chunks };
}

function seedTwentyOneItems(db: AgentDatabase): { libraryId: string; chunks: Chunk[]; amountByChunkId: Map<string, { amount: number; declared?: boolean; itemIndex?: number }> } {
  const library = db.createLibrary("Pulse evidence 21 items");
  const version = db.createDocumentVersion(library.id, "case-21.md", "text/markdown", "case-21", "case-21").version;
  const itemAmounts = [556.782683, 144.8512, ...Array.from({ length: 18 }, () => 25), 72.28827];
  const pending = [
    { ordinal: 0, headingPath: "数值清单", pageNumber: null, startChar: 0, endChar: 20, text: "声明总额 1223.922153 万。" },
    ...itemAmounts.map((amount, index) => ({
      ordinal: index + 1,
      headingPath: "数值清单",
      pageNumber: null,
      startChar: 21 + index * 20,
      endChar: 40 + index * 20,
      text: `第 ${index + 1} 笔来源：来源 ${index + 1}，金额 ${amount} 万。`,
    })),
  ];
  const chunks = db.replaceChunks(library.id, version.id, pending);
  const amountByChunkId = new Map<string, { amount: number; declared?: boolean; itemIndex?: number }>();
  amountByChunkId.set(chunks[0]!.id, { amount: 1223.922153, declared: true });
  for (let index = 0; index < itemAmounts.length; index += 1) {
    amountByChunkId.set(chunks[index + 1]!.id, { amount: itemAmounts[index]!, itemIndex: index + 1 });
  }
  return { libraryId: library.id, chunks, amountByChunkId };
}

class TwentyOneItemPulseModel extends FakeModelProvider {
  readonly extractionInputs: Array<{ purpose: string; chunkIds: string[] }> = [];
  judgeCalls = 0;
  synthesizeCalls = 0;

  constructor(private readonly amountByChunkId: Map<string, { amount: number; declared?: boolean; itemIndex?: number }>) {
    super();
  }

  async analyzePulseQuestion(): Promise<PulseQuestionPlan> {
    return plan();
  }

  async planPulseEvidence(): Promise<PulseEvidencePlan> {
    return {
      objective: "Read the initially visible total and first itemized rows.",
      steps: [],
      stopCondition: "Judge after seed evidence.",
      expectedEvidenceShape: "Declared total and itemized rows.",
      maxIterations: 6,
    };
  }

  async extractPulseEvidenceRows(input: {
    purpose: string;
    chunks: Array<{ id: string; text: string }>;
  }): Promise<PulseEvidenceRow[]> {
    this.extractionInputs.push({ purpose: input.purpose, chunkIds: input.chunks.map((chunk) => chunk.id) });
    return input.chunks.flatMap((chunk): PulseEvidenceRow[] => {
      const amount = this.amountByChunkId.get(chunk.id);
      if (!amount) return [];
      return [{
        rowId: amount.declared ? "declared-total" : `item-${amount.itemIndex}`,
        evidenceType: "amount",
        claimText: amount.declared
          ? `声明总额 ${amount.amount} 万`
          : `第 ${amount.itemIndex} 笔 ${amount.amount} 万`,
        structuredValue: {
          normalizedAmountWan: amount.amount,
          ...(amount.declared ? { role: "declared_total" } : { itemIndex: amount.itemIndex }),
        },
        evidenceChunkId: chunk.id,
        evidenceQuote: chunk.text,
        role: amount.declared ? "declared_total" : "itemized_value",
        authority: "documentary_record",
        usage: "answer_core",
        classificationRationale: "Test row is a source-bound numeric evidence row.",
        confidence: 0.95,
        countedInAnswer: !amount.declared,
        dedupeKey: amount.declared ? "declared-total" : `item-${amount.itemIndex}`,
      }];
    });
  }

  async judgePulseEvidenceSufficiency(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    memory: unknown;
    computedReconciliation?: unknown;
  }): Promise<PulseEvidenceStatus> {
    this.judgeCalls += 1;
    const memory = input.memory as { evidenceRows?: PulseEvidenceRow[] };
    const reconciliation = input.computedReconciliation as PulseEvidenceStatus["reconciliation"] | undefined;
    const rows = memory.evidenceRows ?? [];
    const itemizedCount = rows.filter((row) => row.evidenceType === "amount" && (row.structuredValue as { role?: string } | undefined)?.role !== "declared_total").length;
    if (reconciliation?.closed && itemizedCount >= 21) {
      return {
        sufficient: true,
        status: "sufficient",
        gaps: [],
        reasoning: "All 21 itemized rows reconcile to the declared total.",
        reconciliation,
      };
    }
    return {
      sufficient: false,
      status: "needs_gap_retrieval",
      gaps: [{
        type: "missing_itemized_evidence",
        description: `Only ${itemizedCount} of 21 itemized rows have been extracted; continue the same section.`,
        suggestedQueries: [],
        severity: "high",
      }],
      reasoning: "The visible rows are a partial list and require continuation retrieval.",
      ...(reconciliation ? { reconciliation } : {}),
    };
  }

  async synthesizePulseAnswer(input: {
    question: string;
    questionPlan: PulseQuestionPlan;
    memory: unknown;
    evidenceStatus: PulseEvidenceStatus;
  }): Promise<PulseAnswerOutput> {
    this.synthesizeCalls += 1;
    const memory = input.memory as { evidenceRows?: PulseEvidenceRow[] };
    const rows = memory.evidenceRows ?? [];
    const itemizedCount = rows.filter((row) => row.evidenceType === "amount" && (row.structuredValue as { role?: string } | undefined)?.role !== "declared_total").length;
    return {
      answer: `声明总额 1223.922153 万。声明总额 1223.922153 万。已列明 ${itemizedCount} 笔，分项合计 ${input.evidenceStatus.reconciliation?.itemizedSum} 万。`,
      summary: "sufficient",
    };
  }

  async rewritePulseAnswer(input: { draft: PulseAnswerOutput }): Promise<PulseAnswerOutput> {
    return input.draft;
  }
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
        claimText: "声明总额 617.496083 万",
        evidenceChunkId: "chunk-1",
        evidenceQuote: "声明总额 617.496083 万",
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
    const exhaustive = verifyPulseAnswer({ answer: "已经穷尽所有来源。", summary: "bad" }, plan(), memory, status);
    expect(exhaustive.passed).toBe(false);
    expect(exhaustive.errors.join("\n")).toContain("complete or exhaustive");
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
      "声明总额是多少?",
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
    expect(tools).toEqual(expect.arrayContaining([
      "semanticSearchChildChunks",
      "fullTextSearchChildChunks",
      "retrieveSiblingNodes",
      "retrieveSectionSubtree",
    ]));
    expect(tools).not.toContain("amountRegexScan");
    expect(model.judgeCalls).toBe(2);
    expect(result.diagnostics?.retrievalSteps?.some((step) => step.query === "606.42607")).toBe(true);
    expect(result.evidenceRows?.some((row) => row.evidenceChunkId === chunks[0]!.id && row.evidenceQuote)).toBe(true);
    db.close();
  });

  it("continues progressive retrieval across consecutive chunks before guarding exhaustive gaps", async () => {
    const db = await database();
    const { libraryId, chunks, amountByChunkId } = seedTwentyOneItems(db);
    const vectors = new VectorStore(db);
    const model = new TwentyOneItemPulseModel(amountByChunkId);
    for (const chunk of chunks) {
      const [embedding] = await model.embed([chunk.text]);
      vectors.save(chunk, embedding!);
    }

    const result = await new PulseEvidenceController(db, vectors, model).answer(
      libraryId,
      "此汇总事项的总共汇总金额是多少？列出每一笔来源",
      "progressive",
      {
        hits: chunks.slice(0, 3).map((chunk, index) => ({
          targetType: "chunk",
          targetId: chunk.id,
          score: 0.9,
          reason: "seed",
          pathRole: "direct",
          stepIndex: index + 1,
          observation: "seed",
          rationale: "seed",
          label: "seed",
          excerpt: chunk.text,
        })),
        chunks: chunks.slice(0, 3),
        nodes: [],
        relations: [],
      },
    );

    const tools = result.diagnostics?.retrievalSteps?.map((step) => step.tool) ?? [];
    const itemRows = result.evidenceRows?.filter((row) => row.evidenceType === "amount" && (row.structuredValue as { role?: string } | undefined)?.role !== "declared_total") ?? [];
    expect(model.judgeCalls).toBeGreaterThan(1);
    expect(model.synthesizeCalls).toBe(1);
    expect(result.answer).not.toContain("当前证据不足");
    expect(tools).toEqual(expect.arrayContaining(["retrieveRemainingNodesAfter"]));
    expect(itemRows).toHaveLength(21);
    expect(result.evidenceStatus?.reconciliation).toMatchObject({
      declaredTotal: 1223.922153,
      itemizedSum: 1223.922153,
      difference: 0,
      closed: true,
    });
    db.close();
  });
});
