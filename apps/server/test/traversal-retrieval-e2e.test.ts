import { describe, expect, it } from "vitest";
import type { Chunk, AoriDocumentIndex } from "@agent-thinking/contracts";
import { TraversalRetrievalEngine } from "../src/services/traversal-retrieval/traversal-engine.js";
import { collectSeedCandidates } from "../src/services/traversal-retrieval/seed-provider.js";

function chunk(partial: Partial<Chunk> & Pick<Chunk, "id" | "text">): Chunk {
  return {
    id: partial.id,
    libraryId: partial.libraryId ?? "library-e2e",
    versionId: partial.versionId ?? "version-e2e",
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

const E2E_CHUNKS: Chunk[] = [
  chunk({ id: "h1",  text: "募集资金使用情况",            headingPath: "募集资金", nodeType: "section", ordinal: 0 }),
  chunk({ id: "r1",  text: "项目A 10万元",                 headingPath: "募集资金", nodeType: "paragraph", ordinal: 1 }),
  chunk({ id: "r2",  text: "项目B 15万元",                 headingPath: "募集资金", nodeType: "paragraph", ordinal: 2 }),
  chunk({ id: "st",  text: "小计 25万元",                 headingPath: "募集资金", nodeType: "paragraph", ordinal: 3 }),
  chunk({ id: "r3",  text: "项目C 10万元",                 headingPath: "募集资金", nodeType: "paragraph", ordinal: 4 }),
  chunk({ id: "sm",  text: "合计 35万元",                 headingPath: "募集资金", nodeType: "paragraph", ordinal: 5 }),
  chunk({ id: "ns",  text: "董事会会议通知",               headingPath: "公司治理", nodeType: "paragraph", ordinal: 20 }),
];

class E2EMockDb {
  getChunk(id: string): Chunk | undefined {
    return E2E_CHUNKS.find((c) => c.id === id);
  }
  getChunksByIds(ids: string[]): Chunk[] {
    return ids.map((id) => this.getChunk(id)).filter(Boolean) as Chunk[];
  }
  getNeighborChunks(chunkIds: string[], window: number): Chunk[] {
    const seeds = this.getChunksByIds(chunkIds);
    const result: Chunk[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      for (const c of E2E_CHUNKS) {
        if (c.libraryId !== seed.libraryId || c.versionId !== seed.versionId) continue;
        if (Math.abs(c.ordinal - seed.ordinal) > window) continue;
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        result.push(c);
      }
    }
    return result.sort((a, b) => a.ordinal - b.ordinal);
  }
  searchText(_libraryId: string, question: string, _limit: number): Array<{ chunk: Chunk; score: number }> {
    // 对连续中文做单字分词，对字母/数字做 token 匹配
    const chars = [...new Set([...question].filter(c => /\p{Script=Han}/u.test(c)))];
    const alnumTokens = question.match(/[a-z0-9]+/ig) ?? [];
    return E2E_CHUNKS
      .map((c) => ({
        chunk: c,
        score: chars.length === 0 ? 0.01
          : chars.some(ch => c.text.includes(ch) || c.headingPath?.includes(ch)) ? 0.85 : 0.01,
      }))
      .filter((e) => e.score > 0.3)
      .sort((a, b) => b.score - a.score);
  }
  listAoriDocumentIndexes(_libraryId: string): AoriDocumentIndex[] {
    return [];
  }
  getLibraryAoriProfile(_libraryId: string) {
    return { available: false as const, libraryId: _libraryId, summary: "",
      entities: [], aspects: [], relationLexicon: [], assertions: [], relations: [],
      documentRelations: [], staleSince: null, createdAt: "", updatedAt: "",
    };
  }
}

const e2eDb = new E2EMockDb() as any;
const e2eVectors = { usesSqliteVec: false } as any;

describe("traversal retrieval v2 E2E", () => {
  it("collectSeedCandidates should return seeds from mock DB", () => {
    let candidates: any[] = [];
    try {
      candidates = collectSeedCandidates(e2eDb as any, "library-e2e", "募集资金总额合计是多少？");
    } catch (e: any) {
      console.debug("collectSeedCandidates ERROR:", e?.message ?? String(e));
      throw e;
    }
    console.debug("collectSeedCandidates returned:", candidates.length, JSON.stringify(candidates.map(c => ({chunkId: c.chunkId, source: c.source, score: c.score}))));
    console.debug("Mock searchText returns:", (e2eDb as any).searchText("library-e2e", "募集资金总额合计是多少？", 8).length);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("header → row1 → row2 → 小计 → row3 → 合计: 小计不能closed, 合计closed", async () => {
    const engine = new TraversalRetrievalEngine(e2eDb, {
      limits: { maxRounds: 20, neighborWindow: 4, maxVisitedNodes: 50 },
    });

    const result = await engine.retrieve({
      libraryId: "library-e2e",
      question: "募集资金总额合计是多少？",
    });

    // Debug info
    console.debug("E2E stoppedReason:", result.stoppedReason);
    console.debug("E2E seedClusters:", result.seedClusters.length);
    console.debug("E2E evidencePaths:", result.evidencePaths.length);
    console.debug("E2E visited:", result.diagnostics.visitedNodeCount);
    console.debug("E2E closureStatus:", result.diagnostics.closureStatus);
    if (result.evidencePaths[0]?.traversalLog) {
      console.debug("E2E log:", JSON.stringify(result.evidencePaths[0].traversalLog));
    }

    // 1. seed 应被找到
    expect(result.seedClusters.length).toBeGreaterThan(0);
    expect(result.stoppedReason).not.toBe("no_seed");

    // 2. 引擎跑了多轮，访问了多个 chunk
    expect(result.diagnostics.visitedNodeCount).toBeGreaterThanOrEqual(4);
    expect(result.diagnostics.rounds).toBeGreaterThanOrEqual(2);

    // 3. 有证据路径
    expect(result.evidencePaths.length).toBeGreaterThan(0);

    // 4. traversalLog 包含完整路径（可追溯）
    if (result.evidencePaths[0]?.traversalLog) {
      const log = result.evidencePaths[0].traversalLog;
      expect(log.length).toBeGreaterThanOrEqual(3);
      // 应该包含 seed 条目
      expect(log.some((e) => e.direction === "seed")).toBe(true);
      // 应该包含 sibling 遍历条目
      expect(log.some((e) => e.direction === "sibling_next")).toBe(true);
    }

    // 5. scout 应该找到了声明值（合计 35）
    const scout = Object.values(result.scoutResults)[0];
    expect(scout?.calibrationStatus).toBe("calibrated");
    expect(scout?.declaredValue).toBe(35);

    const closure = result.evidencePaths[0]?.closure;
    expect(result.stoppedReason).toBe("closed");
    expect(closure?.status).toBe("closed");
    expect(closure?.verifierType).toBe("sum_alignment");

    const pathChunkIds = result.evidencePaths.flatMap((path) => path.path.map((entry) => entry.chunkId));
    expect(pathChunkIds).toContain("r3");

    const checks = closure?.checks as Record<string, unknown>;
    expect(checks.collectedSum).toBe(35);
    expect(checks.countedDataRowChunkIds).toEqual(["r1", "r2", "r3"]);
    expect(checks.countedDataRowChunkIds).not.toContain("st");

    const log = result.evidencePaths[0]?.traversalLog ?? [];
    const edges = log.flatMap((entry) => entry.to ? [`${entry.from}->${entry.to}`] : []);
    expect(edges).toEqual(expect.arrayContaining([
      "r1->r2",
      "r2->st",
      "st->r3",
      "r3->sm",
    ]));
  });

  it("returns structured traversalLog with round, direction, and reason", async () => {
    const engine = new TraversalRetrievalEngine(e2eDb, {
      limits: { maxRounds: 10, neighborWindow: 4, maxVisitedNodes: 50 },
    });

    const result = await engine.retrieve({
      libraryId: "library-e2e",
      question: "募集资金总额合计是多少？",
    });

    const log = result.evidencePaths[0]?.traversalLog;
    if (log && log.length > 0) {
      // 每个 log 条目应该有 round, direction
      for (const entry of log) {
        expect(entry.round).toBeGreaterThanOrEqual(0);
        expect(entry.direction).toBeDefined();
        expect(entry.from).toBeDefined();
        expect(typeof entry.reason).toBe("string");
      }
      // 至少有一个 seed 条目
      expect(log.some((e) => e.direction === "seed")).toBe(true);
    }

    // diagnostics 应该有基本指标
    expect(typeof result.diagnostics.visitedNodeCount).toBe("number");
    expect(typeof result.diagnostics.rounds).toBe("number");
    expect(typeof result.stoppedReason).toBe("string");
  });
});
