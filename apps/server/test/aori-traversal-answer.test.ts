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
  it("uses BFS full traversal and answers from chunk text instead of AORI summaries", async () => {
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

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), model).create(library.id, "黄胜受贿总额是多少？", "full", (event) => {
      events.push(event.type);
    });

    expect(model.bfsInputs.length).toBeGreaterThan(0);
    expect(pulse.evidencePack?.chunkEvidencePack?.mode).toBe("bfs_full");
    expect(pulse.evidencePack?.chunkEvidencePack?.selectedChunks.map((chunk) => chunk.chunkId)).toContain(chunks[1]!.id);
    expect(pulse.evidencePack?.chunkSummaries?.every((summary) => summary.chunkId)).toBe(true);
    expect(pulse.pulse.answer).toContain("90 万");
    expect(pulse.pulse.answer).not.toContain("100 万");
    expect(events).toEqual(expect.arrayContaining(["aori_traversal_started", "bfs_node_decision", "bfs_chunk_collected", "chunk_summary_finished", "final_answer_finished"]));
    db.close();
  });

  it("uses DFS progressive traversal and backtracks after finding a chunk", async () => {
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

    const pulse = await new PulseEngine(db, new ThrowingVectorStore(db), model).create(library.id, "杨某丙给了什么？", "progressive", (event) => {
      events.push(event.type);
    });

    expect(model.dfsInputs.length).toBeGreaterThan(0);
    expect(pulse.evidencePack?.chunkEvidencePack?.mode).toBe("dfs_pulse");
    expect(pulse.evidencePack?.chunkEvidencePack?.selectedChunks.map((chunk) => chunk.chunkId)).toEqual([chunks[0]!.id]);
    expect(pulse.pulse.answer).toContain("杨某丙");
    expect(events).toEqual(expect.arrayContaining(["dfs_node_entered", "dfs_candidate_selected", "dfs_chunk_found", "dfs_backtrack"]));
    db.close();
  });
});
