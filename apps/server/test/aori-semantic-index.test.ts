import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Chunk } from "@agent-thinking/contracts";
import { AgentDatabase } from "../src/db.js";
import { buildDraftSemanticIndex } from "../src/services/aori-semantic-index.js";
import { buildAoriDocumentIndex } from "../src/services/aori.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeChunk(id: string, text: string, headingPath = "Source"): Chunk {
  return {
    id,
    libraryId: "library-1",
    versionId: "version-1",
    ordinal: 0,
    headingPath,
    pageNumber: null,
    startLine: null,
    endLine: null,
    blockId: null,
    startChar: 0,
    endChar: text.length,
    text,
    aspects: [],
  };
}

describe("AORI semantic units", () => {
  it("extracts markdown tables, reconciliation, and negative facts conservatively", () => {
    const { semanticUnits, reflectiveFindings } = buildDraftSemanticIndex({
      libraryId: "library-1",
      documentId: "document-1",
      versionId: "version-1",
      chunks: [
        makeChunk(
          "chunk-table",
          [
            "项目|金额(万元)",
            "---|---:",
            "收入|10",
            "支出|4",
            "合计|14",
          ].join("\n"),
          "表格",
        ),
        makeChunk("chunk-negative", "本次报告不涉及新增担保事项。", "否定"),
      ],
    });

    const table = semanticUnits.find((unit) => unit.kind === "table");
    const reconciliation = semanticUnits.find((unit) => unit.kind === "reconciliation");
    const negativeFact = semanticUnits.find((unit) => unit.kind === "negative_fact");

    expect(table).toMatchObject({
      kind: "table",
      tableTitle: "表格",
      unitHints: ["万元"],
    });
    expect(reconciliation).toMatchObject({
      kind: "reconciliation",
      computedTotal: 14,
      reportedTotal: 14,
      closed: true,
    });
    expect(negativeFact).toMatchObject({
      kind: "negative_fact",
      predicate: "不涉及",
      certainty: "explicit",
    });
    expect(reflectiveFindings).toEqual([]);
  });

  it("round-trips semantic units and reflective findings through the database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-semantic-db-"));
    temporaryDirectories.push(dir);
    const db = new AgentDatabase(dir);
    try {
      const library = db.createLibrary("Semantic DB");
      const version = db.createDocumentVersion(library.id, "semantic.md", "text/markdown", "semantic", "semantic.md", {
        indexStrategy: "aspect_oriented_reflective",
      }).version;
      const chunks = db.replaceChunks(library.id, version.id, [
        {
          ordinal: 0,
          headingPath: "概览",
          pageNumber: null,
          startLine: null,
          endLine: null,
          blockId: null,
          startChar: 0,
          endChar: 8,
          text: "A 项目不涉及担保。",
        },
      ]);
      const chunkId = chunks[0]?.id;
      if (!chunkId) throw new Error("expected fixture chunk");
      const index = buildAoriDocumentIndex({
        libraryId: library.id,
        documentId: version.documentId,
        documentName: "semantic.md",
        versionId: version.id,
        chunks,
        drafts: [{
          groupId: "group-1",
          draft: {
            understanding: {
              summary: "Semantic index fixture.",
              centralQuestion: "What is asserted?",
              evidenceChunkIds: [chunkId],
              evidenceStatus: "supported",
              closureStatus: "partial",
              classificationRationale: "test",
              confidence: 0.8,
            },
            aspects: [],
            semanticUnits: [{
              id: "semantic-negative-1",
              kind: "negative_fact",
              title: "A 项目",
              summary: "A 项目不涉及担保。",
              sourceChunkIds: [chunkId],
              confidence: 0.88,
              reflectionStatus: "ok",
              target: "A 项目",
              predicate: "不涉及",
              scope: "概览",
              statement: "A 项目不涉及担保。",
              certainty: "explicit",
            }],
            reflectiveFindings: [{
              semanticUnitId: "semantic-negative-1",
              findingType: "ambiguous_scope",
              severity: "medium",
              message: "scope may be incomplete",
            }],
            selfQuestions: [],
            reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
          },
        }],
        rationaleTrace: [],
        reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      db.saveAoriDocumentIndex(index);

      const loaded = db.getAoriDocumentIndex(version.id);
      expect(loaded.available).toBe(true);
      if (!loaded.available) throw new Error(loaded.message);
      expect(loaded.semanticUnits).toHaveLength(1);
      expect(loaded.semanticUnits[0]).toMatchObject({
        kind: "negative_fact",
        documentId: version.documentId,
        versionId: version.id,
      });
      expect(loaded.reflectiveFindings).toHaveLength(1);
      expect(loaded.reflectiveFindings[0]).toMatchObject({
        semanticUnitId: "semantic-negative-1",
        findingType: "ambiguous_scope",
      });
    } finally {
      db.close();
    }
  });
});
