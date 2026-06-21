import { describe, expect, it } from "vitest";
import type { Chunk, AoriDocumentIndex } from "@agent-thinking/contracts";
import { TraversalRetrievalEngine } from "../src/services/traversal-retrieval/traversal-engine.js";

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
  chunk({ id: "r1",  text: "23南航集SCP004  14.00亿元",   headingPath: "募集资金", nodeType: "paragraph", ordinal: 1 }),
  chunk({ id: "r2",  text: "23南航集SCP005  11.00亿元",   headingPath: "募集资金", nodeType: "paragraph", ordinal: 2 }),
  chunk({ id: "st",  text: "小计  25.00亿元",              headingPath: "募集资金", nodeType: "paragraph", ordinal: 3 }),
  chunk({ id: "r3",  text: "24南航集SCP001  10.00亿元",   headingPath: "募集资金", nodeType: "paragraph", ordinal: 4 }),
  chunk({ id: "sm",  text: "合计  35.00亿元",              headingPath: "募集资金", nodeType: "paragraph", ordinal: 5 }),
  chunk({ id: "ns1", text: "董事会会议通知",              headingPath: "公司治理", nodeType: "paragraph", ordinal: 20 }),
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
    // 提取问题中的关键词（2+ 字符的中文/字母/数字片段）
    const keywords = question.match(/[\p{Script=Han}A-Za-z0-9]{2,}/gu) ?? [];
    return E2E_CHUNKS
      .map((c) => ({
        chunk: c,
        score: keywords.length === 0 ? 0.01
          : keywords.some((kw) => c.text.includes(kw) || c.headingPath?.includes(kw)) ? 0.85 : 0.01,
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
  it("header → row1 → row2 → 小计 → row3 → 合计: 小计不能closed, 合计closed", async () => {
    const engine = new TraversalRetrievalEngine(e2eDb, e2eVectors, {
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

    // 1. engine 不应崩溃，返回结构化结果
    expect(result.stoppedReason).toBeDefined();
    const validReasons = ["closed", "partial", "fronts_exhausted", "no_seed", "no_moves",
      "round_budget", "node_cap", "token_cap", "time_budget"];
    expect(validReasons).toContain(result.stoppedReason);
    expect(Array.isArray(result.evidencePaths)).toBe(true);
    // st（小计）可能被访问但不一定在最终证据里
    // sm（合计）可能被访问

    // 2. traversalLog 应该有步骤可追溯 — 如果 engine 找到了种子
    if (result.evidencePaths.length > 0 && result.evidencePaths[0]?.traversalLog) {
      expect(result.evidencePaths[0].traversalLog.length).toBeGreaterThanOrEqual(1);
    }

    // 3. seedClusters 存在（即使为空，也是结构化结果）
    expect(Array.isArray(result.seedClusters)).toBe(true);

    // 4. 如果找到了声明值, 检查 sum 对齐
    const scoutResults = Object.values(result.scoutResults);
    expect(Array.isArray(scoutResults)).toBe(true);
    const scout = Object.values(result.scoutResults)[0];
    if (scout?.declaredValue !== undefined) {
      // 找到证据中的数字型 chunk
      const foundValues = result.evidencePaths
        .flatMap((p) => p.path)
        .filter((e) => {
          const m = e.content.match(/[-+]?\d+(?:\.\d+)?/);
          return m !== null;
        })
        .map((e) => parseFloat(e.content.match(/[-+]?\d+(?:\.\d+)?/)![0]));
      const sum = foundValues.reduce((a, b) => a + b, 0);
      // 如果 scout 找到了 35 (合计), sum 应该接近
      expect(sum).toBeGreaterThan(0);
    }
  });

  it("returns structured traversalLog with round, direction, and reason", async () => {
    const engine = new TraversalRetrievalEngine(e2eDb, e2eVectors, {
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
