import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BfsExpansionDecision,
  BfsExpansionInput,
  Chunk,
  ChunkAnswerSummary,
  ChunkSummaryInput,
  DfsStepDecision,
  DfsStepInput,
  FinalAnswerFromChunksInput,
  SearchResult,
} from "@agent-thinking/contracts";
import { AgentDatabase } from "../src/db.js";
import { buildAoriDocumentIndex } from "../src/services/aori.js";
import { FakeModelProvider } from "../src/services/models.js";
import { PulseEngine } from "../src/services/pulse.js";
import { VectorStore } from "../src/services/vector-store.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-aori-traversal-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

class ThrowingVectorStore extends VectorStore {
  override search(): SearchResult[] {
    throw new Error("legacy semantic chunk search should not run when AORI traversal is available");
  }
}

class TraversalTestModel extends FakeModelProvider {
  bfsInputs: BfsExpansionInput[] = [];
  dfsInputs: DfsStepInput[] = [];

  override async selectPulseNavigation(): Promise<never> {
    throw new Error("legacy progressive navigation should not run when AORI traversal is available");
  }

  override async routeAoriSkill(): Promise<never> {
    throw new Error("routeAoriSkill should not run for Demand Plan answering");
  }

  override async decideAoriBfsExpansion(input: BfsExpansionInput): Promise<BfsExpansionDecision> {
    this.bfsInputs.push(input);
    return {
      decisions: input.currentLayer.map((node) => {
        const title = node.title;
        const isRoot = node.type === "library_root" || node.type === "document";
        const keep = isRoot || title.includes("事实") || title.includes("金额") || title.includes("杨某丙");
        return {
          nodeId: node.nodeId,
          decision: keep ? "need" : "skip",
          answerRelevant: keep,
          shouldCollectChunks: title.includes("金额") || title.includes("杨某丙财物"),
          reason: keep ? `需要检查 ${title}` : `跳过 ${title}`,
        };
      }),
      stopTraversal: false,
    };
  }

  override async chooseAoriDfsNext(input: DfsStepInput): Promise<DfsStepDecision> {
    this.dfsInputs.push(input);
    const selected = input.candidates
      .filter((candidate) => candidate.title.includes("事实") || candidate.title.includes("杨某丙") || candidate.type === "document")
      .slice(0, 2)
      .map((candidate) => candidate.nodeId);
    return {
      selectedNextNodeIds: selected,
      recordCurrentChunks: input.currentNode.title.includes("杨某丙财物"),
      backtrack: selected.length === 0,
      stopTraversal: false,
      reason: selected.length > 0 ? "沿事实路径下钻" : "当前路径没有相关候选，回溯",
    };
  }

  override async summarizeChunkForQuestion(input: ChunkSummaryInput): Promise<ChunkAnswerSummary> {
    const relevant = input.chunkText.includes("90 万") || input.chunkText.includes("杨某丙");
    return {
      chunkId: input.chunkId,
      relevant,
      shortSummary: relevant ? input.chunkText : "背景信息",
      supportedFacts: relevant ? [input.chunkText] : [],
      unsupportedClaims: [],
      keyQuotes: relevant ? [input.chunkText.slice(0, 80)] : [],
      confidence: relevant ? 0.92 : 0.25,
      usage: relevant ? "answer_core" : "background_only",
    };
  }

  override async synthesizeAnswerFromChunks(input: FinalAnswerFromChunksInput) {
    const facts = input.chunkSummaries
      .filter((summary) => summary.relevant)
      .flatMap((summary) => summary.supportedFacts.map((fact) => `[${summary.chunkId}] ${fact}`));
    return {
      answer: facts.length > 0 ? facts.join("；") : "证据不足。",
      summary: `AORI traversal used ${facts.length} source-backed fact(s).`,
    };
  }
}

class SkillCountTestModel extends FakeModelProvider {
  override async routeAoriSkill(): Promise<never> {
    throw new Error("routeAoriSkill should not run for Demand Plan answering");
  }

  override async decideAoriBfsExpansion(): Promise<never> {
    throw new Error("BFS traversal should not run for Demand Plan answering");
  }

  override async chooseAoriDfsNext(): Promise<never> {
    throw new Error("DFS traversal should not run for Demand Plan answering");
  }

  override async summarizeChunkForQuestion(): Promise<never> {
    throw new Error("Chunk summary traversal synthesis should not run for Demand Plan answering");
  }

  override async synthesizeAnswerFromChunks(): Promise<never> {
    throw new Error("Traversal final synthesis should not run for Demand Plan answering");
  }
}

function saveAoriIndex(db: AgentDatabase, input: {
  libraryId: string;
  documentName: string;
  chunks: Chunk[];
  versionId: string;
  documentId: string;
  aspects: Parameters<typeof buildAoriDocumentIndex>[0]["drafts"][number]["draft"]["aspects"];
  summary?: string;
  centralQuestion?: string;
}): void {
  db.saveAoriDocumentIndex(buildAoriDocumentIndex({
    libraryId: input.libraryId,
    documentId: input.documentId,
    documentName: input.documentName,
    versionId: input.versionId,
    chunks: input.chunks,
    drafts: [{
      groupId: "group-1",
      draft: {
        understanding: {
          summary: input.summary ?? "AORI traversal fixture.",
          centralQuestion: input.centralQuestion ?? "What should be answered?",
          evidenceChunkIds: input.chunks.map((chunk) => chunk.id),
          evidenceStatus: "supported",
          closureStatus: "partial",
          classificationRationale: "test",
          confidence: 0.8,
        },
        aspects: input.aspects,
        selfQuestions: [],
        reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
      },
    }],
    rationaleTrace: [],
    reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AORI traversal answering", () => {
  it("answers count questions through Demand Plan, not facet_count routing", async () => {
    const db = await database();
    const library = db.createLibrary("Skill Count AORI");
    const version = db.createDocumentVersion(library.id, "skill-count.md", "text/markdown", "hash", "skill-count.md", {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "fact-1", pageNumber: null, startChar: 0, endChar: 20, text: "source: SourceA; person: Alice; time: 2005; evidence: Alice paid Huang." },
      { ordinal: 1, headingPath: "fact-2", pageNumber: null, startChar: 21, endChar: 45, text: "source: SourceB; person: Bob; time: 2005; evidence: Bob paid Huang." },
      { ordinal: 2, headingPath: "fact-3", pageNumber: null, startChar: 46, endChar: 70, text: "source: SourceC; person: Charlie; time: 2010; evidence: Charlie paid Huang." },
      { ordinal: 3, headingPath: "fact-4", pageNumber: null, startChar: 71, endChar: 95, text: "source: SourceD; person: Dana; time: 2004-2006; evidence: Dana paid Huang." },
      { ordinal: 4, headingPath: "fact-5", pageNumber: null, startChar: 96, endChar: 120, text: "source: SourceE; person: Eve; evidence: Eve paid Huang but time is unclear." },
    ]);
    saveAoriIndex(db, {
      libraryId: library.id,
      documentName: "skill-count.md",
      versionId: version.id,
      documentId: version.documentId,
      chunks,
      summary: "AORI map summary is not final evidence.",
      centralQuestion: "How many people paid Huang in 2005?",
      aspects: [{
        kind: "finding",
        domainKind: "bribery_facts",
        title: "Huang bribery fact series",
        summary: "Five item fixture for count routing.",
        centralQuestion: "Who paid Huang and when?",
        classificationRationale: "test",
        confidence: 0.8,
        items: chunks.map((chunk, index) => ({
          key: `item-${index + 1}`,
          title: `Source ${index + 1}`,
          summary: `Source item ${index + 1}`,
          evidenceChunkIds: [chunk.id],
          evidenceStatus: "supported" as const,
          closureStatus: "partial" as const,
          classificationRationale: "test",
          confidence: 0.8,
        })),
        relations: [],
        gaps: [],
      }],
    });
    const events: string[] = [];

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), new SkillCountTestModel(), { aoriAnswerMode: "traversal" }).create(
      library.id,
      "How many people paid Huang in 2005? list all people",
      "full",
      (event) => {
        events.push(event.type);
      },
    );

    expect(pulse.pulse.answer).toContain('"count":2');
    expect(pulse.pulse.answer).toContain("SourceA");
    expect(pulse.pulse.answer).toContain("SourceB");
    expect(pulse.pulse.answer).not.toContain("SourceC");
    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_demand");
    const diagnostics = pulse.evidencePack?.diagnostics as Record<string, unknown>;
    expect(diagnostics.answerPipeline).toBe("aori_demand");
    expect(diagnostics.selectedSkill).toBeUndefined();
    expect(diagnostics.skillRouteFallback).toBe(true);
    expect((diagnostics.evidenceRecords as unknown[])).toHaveLength(5);
    expect(diagnostics.demandOperationResult).toBeUndefined();
    expect(pulse.evidencePack?.retrievalTrace?.map((step) => step.tool)).toEqual([
      "planDemandAnswer",
      "extractEvidenceRecords",
      "synthesizeDemandAnswer",
    ]);
    expect(events).toEqual(expect.arrayContaining([
      "demand_plan_generated",
      "demand_records_started",
      "demand_record_extracted",
      "demand_answer_synthesized",
    ]));
    expect(events).not.toContain("demand_operations_finished");
    expect(events).not.toContain("skill_route_generated");
    expect(events).not.toContain("facet_row_extracted");
    expect(events).not.toContain("bfs_node_decision");
    db.close();
  });

  it("answers argument questions through Demand Plan, not argument_response routing", async () => {
    const db = await database();
    const library = db.createLibrary("Argument Skill AORI");
    const version = db.createDocumentVersion(library.id, "argument.md", "text/markdown", "hash", "argument.md", {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "argument-1", pageNumber: null, startChar: 0, endChar: 20, text: "argument: payment was a loan; response: court rejected the defense; finding: payment was a bribe; status: not_accepted; evidence: court explains why." },
      { ordinal: 1, headingPath: "argument-2", pageNumber: null, startChar: 21, endChar: 45, text: "argument: amount was overstated; response: court accepted part of it; finding: amount reduced; status: partially_accepted; evidence: court recalculated." },
    ]);
    saveAoriIndex(db, {
      libraryId: library.id,
      documentName: "argument.md",
      versionId: version.id,
      documentId: version.documentId,
      chunks,
      summary: "Argument fixture.",
      centralQuestion: "Was the defense argument accepted?",
      aspects: [{
        kind: "argument",
        domainKind: "defense_response",
        title: "Defense arguments and court responses",
        summary: "Two argument-response items.",
        centralQuestion: "How did the court respond?",
        classificationRationale: "test",
        confidence: 0.8,
        items: chunks.map((chunk, index) => ({
          key: `argument-${index + 1}`,
          title: `Argument ${index + 1}`,
          summary: `Argument item ${index + 1}`,
          evidenceChunkIds: [chunk.id],
          evidenceStatus: "supported" as const,
          closureStatus: "partial" as const,
          classificationRationale: "test",
          confidence: 0.8,
        })),
        relations: [],
        gaps: [],
      }],
    });

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), new SkillCountTestModel(), { aoriAnswerMode: "traversal" }).create(
      library.id,
      "Was the defense argument accepted and how did the court respond?",
      "full",
    );

    expect(pulse.pulse.answer).toContain("payment was a loan");
    expect(pulse.pulse.answer).toContain("court rejected the defense");
    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_demand");
    const diagnostics = pulse.evidencePack?.diagnostics as Record<string, unknown>;
    expect(diagnostics.selectedSkill).toBeUndefined();
    expect((diagnostics.evidenceRecords as unknown[])).toHaveLength(2);
    expect(pulse.evidencePack?.retrievalTrace?.map((step) => step.tool)).toEqual([
      "planDemandAnswer",
      "extractEvidenceRecords",
      "synthesizeDemandAnswer",
    ]);
    db.close();
  });

  it("answers timeline questions through Demand Plan synthesis", async () => {
    const db = await database();
    const library = db.createLibrary("Timeline Skill AORI");
    const version = db.createDocumentVersion(library.id, "timeline.md", "text/markdown", "hash", "timeline.md", {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "event-1", pageNumber: null, startChar: 0, endChar: 20, text: "source: SourceA; event: Alice paid Huang; time: 2005; evidence: Alice payment." },
      { ordinal: 1, headingPath: "event-2", pageNumber: null, startChar: 21, endChar: 45, text: "source: SourceB; event: Bob paid Huang; time: 2004-2006; evidence: Bob payment range." },
      { ordinal: 2, headingPath: "event-3", pageNumber: null, startChar: 46, endChar: 70, text: "source: SourceC; event: Charlie paid Huang; time: 2010; evidence: Charlie payment." },
    ]);
    saveAoriIndex(db, {
      libraryId: library.id,
      documentName: "timeline.md",
      versionId: version.id,
      documentId: version.documentId,
      chunks,
      summary: "Timeline fixture.",
      centralQuestion: "Timeline of payments.",
      aspects: [{
        kind: "timeline",
        domainKind: "payment_timeline",
        title: "Payment timeline",
        summary: "Three timeline items.",
        centralQuestion: "When did payments happen?",
        classificationRationale: "test",
        confidence: 0.8,
        items: chunks.map((chunk, index) => ({
          key: `event-${index + 1}`,
          title: `Event ${index + 1}`,
          summary: `Event item ${index + 1}`,
          evidenceChunkIds: [chunk.id],
          evidenceStatus: "supported" as const,
          closureStatus: "partial" as const,
          classificationRationale: "test",
          confidence: 0.8,
        })),
        relations: [],
        gaps: [],
      }],
    });

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), new SkillCountTestModel(), { aoriAnswerMode: "traversal" }).create(
      library.id,
      "timeline 2005 events",
      "full",
    );

    expect(pulse.pulse.answer).toContain("Alice paid Huang");
    expect(pulse.pulse.answer).not.toContain("Bob paid Huang");
    expect(pulse.pulse.answer).not.toContain("Charlie paid Huang [");
    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_demand");
    const diagnostics = pulse.evidencePack?.diagnostics as Record<string, unknown>;
    expect(diagnostics.selectedSkill).toBeUndefined();
    expect(diagnostics.demandOperationResult).toBeUndefined();
    db.close();
  });

  it("uses Demand Plan for full AORI answers instead of BFS traversal", async () => {
    const db = await database();
    const library = db.createLibrary("BFS AORI");
    const version = db.createDocumentVersion(library.id, "case.md", "text/markdown", "hash", "case.md", {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "事实", pageNumber: null, startChar: 0, endChar: 20, text: "黄胜共有 21 起受贿事实。" },
      { ordinal: 1, headingPath: "金额", pageNumber: null, startChar: 21, endChar: 45, text: "原文记载：黄胜受贿总额为 90 万元。" },
      { ordinal: 2, headingPath: "量刑", pageNumber: null, startChar: 46, endChar: 70, text: "量刑情节与总额问题无关。" },
    ]);
    saveAoriIndex(db, {
      libraryId: library.id,
      documentName: "case.md",
      versionId: version.id,
      documentId: version.documentId,
      chunks,
      summary: "AORI summary claims the total is 100 万, but this must not be used as evidence.",
      centralQuestion: "黄胜受贿总额是多少？",
      aspects: [{
        kind: "finding",
        domainKind: "事实",
        title: "事实切面",
        summary: "事实切面包含 21 起事实和金额总额。",
        centralQuestion: "事实是什么？",
        classificationRationale: "test",
        confidence: 0.8,
        items: [
          { key: "facts", title: "21 起事实", summary: "21 起事实", evidenceChunkIds: [chunks[0]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
          { key: "amount", title: "金额总额", summary: "AORI item summary says 总额 100 万。", evidenceChunkIds: [chunks[1]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
        ],
        relations: [],
        gaps: [],
      }, {
        kind: "finding",
        domainKind: "量刑",
        title: "量刑切面",
        summary: "量刑切面。",
        centralQuestion: "如何量刑？",
        classificationRationale: "test",
        confidence: 0.8,
        items: [
          { key: "sentence", title: "量刑建议", summary: "量刑建议", evidenceChunkIds: [chunks[2]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
        ],
        relations: [],
        gaps: [],
      }],
    });
    const model = new TraversalTestModel();
    const events: string[] = [];

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), model, { aoriAnswerMode: "traversal" }).create(library.id, "黄胜受贿总额是多少？", "full", (event) => {
      events.push(event.type);
    });

    expect(model.bfsInputs).toHaveLength(0);
    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_demand");
    expect(pulse.evidencePack?.chunkEvidencePack?.selectedChunks.map((chunk) => chunk.chunkId)).toContain(chunks[1]!.id);
    expect(pulse.evidencePack?.chunkSummaries).toEqual([]);
    expect(pulse.pulse.answer).toContain("90 万");
    expect(pulse.pulse.answer).not.toContain("100 万");
    expect(events).toEqual(expect.arrayContaining(["demand_plan_generated", "demand_record_extracted", "demand_answer_synthesized"]));
    expect(events).not.toContain("demand_operations_finished");
    expect(events).not.toContain("aori_traversal_started");
    expect(events).not.toContain("bfs_node_decision");
    db.close();
  });

  it("uses Demand Plan for progressive AORI answers instead of DFS traversal", async () => {
    const db = await database();
    const library = db.createLibrary("DFS AORI");
    const version = db.createDocumentVersion(library.id, "gifts.md", "text/markdown", "hash", "gifts.md", {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "事实", pageNumber: null, startChar: 0, endChar: 20, text: "杨某丙送给黄胜人民币 3 万元和购物卡。" },
      { ordinal: 1, headingPath: "辩护", pageNumber: null, startChar: 21, endChar: 45, text: "辩护意见讨论量刑从轻。" },
    ]);
    saveAoriIndex(db, {
      libraryId: library.id,
      documentName: "gifts.md",
      versionId: version.id,
      documentId: version.documentId,
      chunks,
      centralQuestion: "杨某丙给了什么？",
      aspects: [{
        kind: "finding",
        domainKind: "事实",
        title: "事实切面",
        summary: "事实切面包含杨某丙财物。",
        centralQuestion: "给了什么？",
        classificationRationale: "test",
        confidence: 0.8,
        items: [
          { key: "gift", title: "杨某丙财物", summary: "杨某丙给付财物。", evidenceChunkIds: [chunks[0]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
        ],
        relations: [],
        gaps: [],
      }, {
        kind: "argument",
        domainKind: "辩护",
        title: "辩护意见",
        summary: "辩护意见。",
        centralQuestion: "辩护意见是什么？",
        classificationRationale: "test",
        confidence: 0.8,
        items: [
          { key: "defense", title: "从轻辩护", summary: "从轻辩护", evidenceChunkIds: [chunks[1]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
        ],
        relations: [],
        gaps: [],
      }],
    });
    const model = new TraversalTestModel();
    const events: string[] = [];

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), model, { aoriAnswerMode: "traversal" }).create(library.id, "杨某丙给了什么？", "progressive", (event) => {
      events.push(event.type);
    });

    expect(model.dfsInputs).toHaveLength(0);
    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_demand");
    expect(pulse.evidencePack?.chunkEvidencePack?.selectedChunks.map((chunk) => chunk.chunkId)).toEqual([chunks[0]!.id]);
    expect(pulse.pulse.answer).toContain("杨某丙");
    expect(events).toEqual(expect.arrayContaining(["demand_plan_generated", "demand_record_extracted", "demand_answer_synthesized"]));
    expect(events).not.toContain("demand_operations_finished");
    expect(events).not.toContain("dfs_node_entered");
    expect(events).not.toContain("dfs_candidate_selected");
    db.close();
  });

  it("uses demand mode by default and does not convert missing yearly amount evidence into zero", async () => {
    const db = await database();
    const library = db.createLibrary("Demand Year Amount AORI");
    const version = db.createDocumentVersion(library.id, "year-amount.md", "text/markdown", "hash", "year-amount.md", {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "cross-year", pageNumber: null, startChar: 0, endChar: 20, text: "source: SourceA; amount: 10 wan; time: 2006-2008; evidence: cross-year payment." },
      { ordinal: 1, headingPath: "other-year", pageNumber: null, startChar: 21, endChar: 45, text: "source: SourceB; amount: 20 wan; time: 2010; evidence: 2010 payment." },
    ]);
    saveAoriIndex(db, {
      libraryId: library.id,
      documentName: "year-amount.md",
      versionId: version.id,
      documentId: version.documentId,
      chunks,
      centralQuestion: "2007年黄胜受贿多少？",
      aspects: [{
        kind: "finding",
        domainKind: "bribery_facts",
        title: "黄胜受贿事实",
        summary: "Two item fixture with one cross-year amount.",
        centralQuestion: "How much belongs to 2007?",
        classificationRationale: "test",
        confidence: 0.8,
        items: [
          { key: "cross", title: "SourceA cross-year payment", summary: "SourceA payment spans 2006-2008.", evidenceChunkIds: [chunks[0]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
          { key: "other", title: "SourceB 2010 payment", summary: "SourceB payment occurred in 2010.", evidenceChunkIds: [chunks[1]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
        ],
        relations: [],
        gaps: [],
      }],
    });

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), new FakeModelProvider()).create(
      library.id,
      "2007年黄胜受贿多少？",
    );

    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_demand");
    expect(pulse.pulse.answer).toContain("2007 amount: null");
    expect(pulse.pulse.answer).not.toContain('"total":0');
    const diagnostics = pulse.evidencePack?.diagnostics as Record<string, unknown>;
    expect(diagnostics.answerPipeline).toBe("aori_demand");
    expect(diagnostics.demandOperationResult).toBeUndefined();
    db.close();
  });

  it("demand mode covers all aspect items for count and list questions", async () => {
    const db = await database();
    const library = db.createLibrary("Demand Count AORI");
    const version = db.createDocumentVersion(library.id, "count.md", "text/markdown", "hash", "count.md", {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "fact-1", pageNumber: null, startChar: 0, endChar: 20, text: "source: SourceA; person: Alice; evidence: Alice paid Huang." },
      { ordinal: 1, headingPath: "fact-2", pageNumber: null, startChar: 21, endChar: 45, text: "source: SourceB; person: Bob; evidence: Bob paid Huang." },
      { ordinal: 2, headingPath: "fact-3", pageNumber: null, startChar: 46, endChar: 70, text: "source: SourceC; person: Charlie; evidence: Charlie paid Huang." },
      { ordinal: 3, headingPath: "fact-4", pageNumber: null, startChar: 71, endChar: 95, text: "source: SourceD; person: Dana; evidence: Dana paid Huang." },
      { ordinal: 4, headingPath: "fact-5", pageNumber: null, startChar: 96, endChar: 120, text: "source: SourceE; person: Eve; evidence: Eve paid Huang." },
    ]);
    saveAoriIndex(db, {
      libraryId: library.id,
      documentName: "count.md",
      versionId: version.id,
      documentId: version.documentId,
      chunks,
      centralQuestion: "总共多少人行贿？",
      aspects: [{
        kind: "finding",
        domainKind: "bribery_facts",
        title: "全部行贿事实",
        summary: "Five item fixture for demand count coverage.",
        centralQuestion: "Who paid Huang?",
        classificationRationale: "test",
        confidence: 0.8,
        items: chunks.map((chunk, index) => ({
          key: `fact-${index + 1}`,
          title: `Payment fact ${index + 1}`,
          summary: `Payment fact ${index + 1}`,
          evidenceChunkIds: [chunk.id],
          evidenceStatus: "supported" as const,
          closureStatus: "partial" as const,
          classificationRationale: "test",
          confidence: 0.8,
        })),
        relations: [],
        gaps: [],
      }],
    });

    const streamTargets: string[] = [];
    const recordPayloads: unknown[] = [];
    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), new FakeModelProvider()).create(
      library.id,
      "总共多少人行贿？列出所有人或单位的名字",
      "full",
      (event) => {
        if (event.type === "hit") streamTargets.push(`${event.hit.targetType}:${event.hit.targetId}`);
        if (event.type === "demand_record_extracted") recordPayloads.push(event.payload);
      },
    );

    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_demand");
    expect(streamTargets.some((target) => target.startsWith("node:item:"))).toBe(true);
    expect(recordPayloads).toHaveLength(5);
    expect(recordPayloads[0]).toMatchObject({
      sourceItem: { title: "Payment fact 1" },
      chunks: [{ label: "fact-1" }],
    });
    expect(pulse.hits.filter((hit) => hit.targetType === "node")).toHaveLength(5);
    expect(pulse.pulse.answer).toContain('"count":5');
    expect(pulse.pulse.answer).toContain("SourceA");
    expect(pulse.pulse.answer).toContain("SourceE");
    expect(pulse.pulse.answer).not.toContain("16 chunks");
    expect(pulse.pulse.answer).not.toContain("16个片段");
    const diagnostics = pulse.evidencePack?.diagnostics as Record<string, unknown>;
    expect((diagnostics.evidenceRecords as unknown[])).toHaveLength(5);
    db.close();
  });

  it("demand mode narrows to the relevant item for single fact questions", async () => {
    const db = await database();
    const library = db.createLibrary("Demand Single AORI");
    const version = db.createDocumentVersion(library.id, "single.md", "text/markdown", "hash", "single.md", {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "yang", pageNumber: null, startChar: 0, endChar: 20, text: "source: 杨某丙; gift: 人民币3万元和购物卡; evidence: 杨某丙送给黄胜财物。" },
      { ordinal: 1, headingPath: "other", pageNumber: null, startChar: 21, endChar: 45, text: "source: 其他人; gift: 手表; evidence: 其他事实。" },
    ]);
    saveAoriIndex(db, {
      libraryId: library.id,
      documentName: "single.md",
      versionId: version.id,
      documentId: version.documentId,
      chunks,
      centralQuestion: "杨某丙给了什么？",
      aspects: [{
        kind: "finding",
        domainKind: "bribery_facts",
        title: "财物事实",
        summary: "Two item fixture for single item demand lookup.",
        centralQuestion: "What was given?",
        classificationRationale: "test",
        confidence: 0.8,
        items: [
          { key: "yang", title: "杨某丙财物", summary: "杨某丙给了购物卡和人民币。", evidenceChunkIds: [chunks[0]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
          { key: "other", title: "其他人财物", summary: "其他人给了手表。", evidenceChunkIds: [chunks[1]!.id], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "test", confidence: 0.8 },
        ],
        relations: [],
        gaps: [],
      }],
    });

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), new FakeModelProvider()).create(library.id, "杨某丙给了什么？");

    expect(pulse.evidencePack?.pipeline?.packBuilder).toBe("aori_demand");
    expect(pulse.pulse.answer).toContain("人民币3万元和购物卡");
    expect(pulse.pulse.answer).not.toContain("手表");
    const diagnostics = pulse.evidencePack?.diagnostics as Record<string, unknown>;
    expect((diagnostics.evidenceRecords as unknown[])).toHaveLength(1);
    db.close();
  });
});
