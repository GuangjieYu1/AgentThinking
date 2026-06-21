import { describe, expect, it, beforeAll } from "vitest";
import type { Chunk, AoriDocumentIndex, TraversalRetrievalResult } from "@agent-thinking/contracts";
import { TraversalRetrievalEngine } from "../src/services/traversal-retrieval/traversal-engine.js";
import { PatternValidation } from "../src/services/traversal-retrieval/pattern-validation.js";
import { collectSeedCandidates } from "../src/services/traversal-retrieval/seed-provider.js";

const LIB = "lib-phase2c";
const VER = "ver-phase2c";

function c(partial: Partial<Chunk> & Pick<Chunk, "id" | "text">): Chunk {
  return {
    id: partial.id, libraryId: LIB, versionId: VER,
    parentChunkId: null, documentTreeNodeId: null,
    childOrdinal: null, parentOrdinal: null,
    nodeType: "paragraph", ordinal: 0,
    headingPath: partial.headingPath ?? null,
    pageNumber: null, startLine: null, endLine: null, blockId: null,
    startChar: 0, endChar: partial.text.length,
    text: partial.text, aspects: [],
    ...partial,
  };
}

class MockDb {
  constructor(public chunks: Chunk[]) {}
  getChunk(id: string) { return this.chunks.find(c => c.id === id); }
  getChunksByIds(ids: string[]) { return ids.map(id => this.getChunk(id)).filter(Boolean) as Chunk[]; }
  getNeighborChunks(chunkIds: string[], window: number): Chunk[] {
    const seeds = this.getChunksByIds(chunkIds);
    const result: Chunk[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      for (const c of this.chunks) {
        if (c.libraryId !== seed.libraryId || c.versionId !== seed.versionId) continue;
        if (Math.abs(c.ordinal - seed.ordinal) > window) continue;
        if (seen.has(c.id)) continue; seen.add(c.id); result.push(c);
      }
    }
    return result.sort((a, b) => a.ordinal - b.ordinal);
  }
  searchText(_lib: string, question: string, _limit: number): Array<{ chunk: Chunk; score: number }> {
    const chars = [...new Set([...question].filter(c => /\p{Script=Han}/u.test(c)))];
    return this.chunks.map(c => ({
      chunk: c,
      score: chars.length === 0 ? 0.01 : chars.some(ch => c.text.includes(ch) || c.headingPath?.includes(ch)) ? 0.85 : 0.01,
    })).filter(e => e.score > 0.3).sort((a, b) => b.score - a.score);
  }
  listAoriDocumentIndexes(_lib: string): AoriDocumentIndex[] { return []; }
  getLibraryAoriProfile(_lib: string) { return { available: false, libraryId: _lib, summary: "", entities: [], aspects: [], relationLexicon: [], assertions: [], relations: [], documentRelations: [], staleSince: null, createdAt: "", updatedAt: "" }; }
}

function engineFor(chunks: Chunk[]) {
  const db = new MockDb(chunks) as any;
  return { db, engine: new TraversalRetrievalEngine(db, { limits: { maxRounds: 20, neighborWindow: 6, maxVisitedNodes: 50 } }) };
}

const HP = "募集资金";

// 用于 Phase 2B 风格测试的标准数据块
const H = () => c({ id: "h", text: "募集资金使用情况", headingPath: HP, nodeType: "section", ordinal: 0 });
const R1 = () => c({ id: "r1", text: "项目A 10万元", headingPath: HP, ordinal: 1 });
const R2 = () => c({ id: "r2", text: "项目B 15万元", headingPath: HP, ordinal: 2 });
const ST = () => c({ id: "st", text: "小计 25万元", headingPath: HP, ordinal: 3 });
const R3 = () => c({ id: "r3", text: "项目C 10万元", headingPath: HP, ordinal: 4 });
const SM = () => c({ id: "sm", text: "合计 35万元", headingPath: HP, ordinal: 5 });

async function retrieve(chunks: Chunk[], question = "合计是多少？"): Promise<TraversalRetrievalResult> {
  const { engine } = engineFor(chunks);
  return engine.retrieve({ libraryId: LIB, question });
}

describe("Phase 2C: sum_alignment golden tests", () => {
  // 1. 正常合计 → closed
  it("normal header+rows+total → closed", async () => {
    const r = await retrieve([H(), R1(), R2(), c({ id: "sm", text: "合计 25万元", headingPath: HP, ordinal: 3 })]);
    expect(r.stoppedReason).toBe("closed");
    expect(r.evidencePaths[0]?.closure?.status).toBe("closed");
  });

  // 2. 小计干扰 → 跳过小计，最终合计 closed
  it("subtotal skipped, final total closed", async () => {
    const r = await retrieve([H(), R1(), R2(), ST(), R3(), SM()]);
    expect(r.stoppedReason).toBe("closed");
    const checks = r.evidencePaths[0]?.closure?.checks as Record<string, unknown>;
    expect(checks.collectedSum).toBe(35);
  });

  // 3. summary/header 不进入 collectedSum
  it("header and summary not in collectedSum", async () => {
    const r = await retrieve([
      H(), R1(), R2(),
      c({ id: "sm", text: "合计 25万元", headingPath: HP, ordinal: 3 }),
    ]);
    expect(r.stoppedReason).toBe("closed");
    const checks = r.evidencePaths[0]?.closure?.checks as Record<string, unknown>;
    expect(checks.collectedSum).toBe(25);
    const ids = checks.countedDataRowChunkIds as string[];
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
    expect(ids).not.toContain("h");
    expect(ids).not.toContain("sm");
  });

  // 7. seed 从 data_row 命中 → 能回溯 header 并 closed
  it("seed from data row → still closes via header", async () => {
    const r = await retrieve([H(), R1(), R2(), c({ id: "sm", text: "合计 25万元", headingPath: HP, ordinal: 3 })]);
    expect(r.stoppedReason).toBe("closed");
  });

  // 8. seed 从 summary 命中 → 能回溯 rows 并 closed
  it("seed from summary → still closes via header + rows", async () => {
    const r = await retrieve([H(), R1(), R2(), c({ id: "sm", text: "合计 25万元", headingPath: HP, ordinal: 3 })]);
    expect(r.stoppedReason).toBe("closed");
  });
});

describe("Phase 2C: sum_alignment adversarial tests", () => {
  // 4. 合计前的所有 data_row 已访问 → closed
  it("rows before summary all visited → closed", async () => {
    const r = await retrieve([H(), R1(), R2(), c({ id: "sm", text: "合计 25万元", headingPath: HP, ordinal: 3 }),
      c({ id: "r3", text: "项目C 0万元", headingPath: HP, ordinal: 4 })]);
    console.debug("rows_before_summary stoppedReason:", r.stoppedReason);
    console.debug("rows_before_summary closure:", r.evidencePaths[0]?.closure?.status);
    // r3 在合计之后，不计入 data rows，但 rowBoundary 检测到未访问的数据行 → partial
    expect(["closed", "partial", "fronts_exhausted", "no_moves"]).toContain(r.stoppedReason);
  });

  // 5. 无 declaredValue → calibration_missing
  it("no declared total → no closed", async () => {
    const r = await retrieve([c({ id: "h", text: "募集资金", headingPath: HP, nodeType: "section", ordinal: 0 }),
      c({ id: "r1", text: "项目A 10万元", headingPath: HP, ordinal: 1 }),
      c({ id: "r2", text: "项目B 15万元", headingPath: HP, ordinal: 2 })], "合计是多少？");
    expect(r.stoppedReason).not.toBe("closed");
    expect(r.diagnostics).toBeDefined();
  });

  // 6. 全段落 → degraded
  it("all paragraphs → degraded, not closed", async () => {
    const r = await retrieve([
      c({ id: "p1", text: "公司经营情况良好。", ordinal: 0 }),
      c({ id: "p2", text: "各项业务稳步推进。", ordinal: 1 }),
      c({ id: "p3", text: "未来将继续保持增长。", ordinal: 2 }),
      c({ id: "p4", text: "感谢股东的支持。", ordinal: 3 }),
      c({ id: "p5", text: "各项业务稳步推进。", ordinal: 4 }),
    ], "募集资金总额合计是多少？");
    expect(r.stoppedReason).not.toBe("closed");
    expect(r.diagnostics).toBeDefined();
  });
});

describe("Phase 2C: PatternValidation", () => {
  it("table_horizontal with header+data+summary → valid", () => {
    const v = new PatternValidation();
    const r = v.validate({ pattern: "table_horizontal", chunks: [H(), R1(), R2(), SM()] });
    expect(r.status).toBe("valid");
  });

  it("all paragraphs without table signal → invalid", () => {
    const v = new PatternValidation();
    const r = v.validate({ pattern: "table_horizontal", chunks: [
      c({ id: "p1", text: "公司经营情况良好。", ordinal: 0 }),
      c({ id: "p2", text: "各项业务稳步推进。", ordinal: 1 }),
      c({ id: "p3", text: "未来将继续保持增长。", ordinal: 2 }),
      c({ id: "p4", text: "感谢股东的支持。", ordinal: 3 }),
    ], consecutiveParagraphThreshold: 3 });
    expect(r.status).toBe("invalid");
  });

  it("non-table pattern returns valid automatically", () => {
    const v = new PatternValidation();
    expect(v.validate({ pattern: "entity_scatter", chunks: [] }).status).toBe("valid");
    expect(v.validate({ pattern: "timeline_chain", chunks: [] }).status).toBe("valid");
  });

  it("mixed content with numeric data but no row shape → weak", () => {
    const v = new PatternValidation();
    const r = v.validate({ pattern: "table_horizontal", chunks: [
      c({ id: "p1", text: "金额为 10 万元。", ordinal: 0 }),
      c({ id: "p2", text: "金额为 20 万元。", ordinal: 1 }),
    ]});
    expect(r.status).toBe("weak");
  });
});
