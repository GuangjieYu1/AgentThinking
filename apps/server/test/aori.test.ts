import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Chunk } from "@agent-thinking/contracts";
import { AgentDatabase } from "../src/db.js";
import { aoriIndexToExtraction, buildAoriDocumentIndex, buildAoriGraphDiagnostics, buildAoriGraphView } from "../src/services/aori.js";
import { LibraryAoriService } from "../src/services/library-aori.js";

function chunk(id: string, text: string): Chunk {
  return {
    id,
    libraryId: "library-1",
    versionId: "version-1",
    ordinal: 0,
    headingPath: "Source",
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

describe("AORI document index", () => {
  it("keeps unsupported model items open without binding fallback evidence", () => {
    const chunks = [chunk("chunk-1", "Source text for supported item.")];
    const index = buildAoriDocumentIndex({
      libraryId: "library-1",
      documentId: "document-1",
      documentName: "source.md",
      versionId: "version-1",
      chunks,
      drafts: [{
        groupId: "group-1",
        draft: {
          understanding: {
            summary: "Global understanding.",
            centralQuestion: "What is covered?",
            evidenceChunkIds: [],
            evidenceStatus: "unsupported",
            closureStatus: "open",
            classificationRationale: "No source binding supplied.",
            confidence: 0.3,
          },
          aspects: [{
            kind: "event",
            domainKind: "source-local event",
            title: "Unsupported aspect",
            summary: "The model described an item but did not bind evidence.",
            centralQuestion: "What happened?",
            classificationRationale: "Model selected event from its own schema output.",
            confidence: 0.7,
            items: [{
              key: "i1",
              title: "Unsupported item",
              summary: "No valid source id was supplied by the model.",
              evidenceChunkIds: [],
              evidenceStatus: "unsupported",
              closureStatus: "open",
              classificationRationale: "Missing source evidence.",
              confidence: 0.4,
            }],
            relations: [],
            gaps: [],
          }],
          selfQuestions: [],
          reflectiveReport: { summary: "ok", completenessRisk: "low", warnings: [], truncationCount: 0 },
        },
      }],
      rationaleTrace: [],
      reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const item = index.aspects[0]?.items[0];
    expect(item).toMatchObject({
      title: "Unsupported item",
      evidenceChunkIds: [],
      evidenceStatus: "unsupported",
      closureStatus: "open",
      fallbackOnly: false,
    });
    expect(index.aspects[0]?.closureReport.status).toBe("partial");
    expect(index.aspects[0]?.closureReport.gaps[0]?.description).toContain("no source evidence");
    expect(aoriIndexToExtraction(index).nodes).toHaveLength(0);

    const diagnostics = buildAoriGraphDiagnostics(index);
    expect(diagnostics.unsupportedItemCount).toBe(1);
    expect(diagnostics.aspectKindDistribution).toMatchObject({ event: 1 });
    const graph = buildAoriGraphView(index, "detail");
    expect(graph.nodes.some((node) => node.type === "aspect_item" && node.evidenceStatus === "unsupported")).toBe(true);
    expect(graph.layoutHints.collapsedNodeIds.some((id) => id.includes(item!.id))).toBe(true);
  });

  it("projects supported AORI aspect kind and dynamic relation into legacy compatibility output", () => {
    const chunks = [chunk("chunk-1", "Source text supports both items.")];
    const index = buildAoriDocumentIndex({
      libraryId: "library-1",
      documentId: "document-1",
      documentName: "source.md",
      versionId: "version-1",
      chunks,
      drafts: [{
        groupId: "group-1",
        draft: {
          understanding: {
            summary: "Global understanding.",
            centralQuestion: "What is covered?",
            evidenceChunkIds: ["chunk-1"],
            evidenceStatus: "supported",
            closureStatus: "partial",
            classificationRationale: "Source-bound.",
            confidence: 0.8,
          },
          aspects: [{
            kind: "amount",
            domainKind: "document-local value",
            title: "Value aspect",
            summary: "A source-bound value aspect.",
            centralQuestion: "Which values matter?",
            classificationRationale: "Model selected amount from schema.",
            confidence: 0.8,
            items: [
              { key: "i1", title: "Item 1", summary: "One", evidenceChunkIds: ["chunk-1"], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "Source-bound.", confidence: 0.8 },
              { key: "i2", title: "Item 2", summary: "Two", evidenceChunkIds: ["chunk-1"], evidenceStatus: "supported", closureStatus: "partial", classificationRationale: "Source-bound.", confidence: 0.8 },
            ],
            relations: [{
              sourceKey: "i1",
              targetKey: "i2",
              domainRelation: "source-local relation",
              relationTextInSource: "source-local relation",
              normalizedRelation: "Item 1 source-local relation Item 2",
              baseRelation: "related_to",
              reason: "The relation was induced by the model and source-bound.",
              confidence: 0.8,
              evidenceChunkIds: ["chunk-1"],
              evidenceStatus: "supported",
              closureStatus: "partial",
            }],
            gaps: [],
          }],
          selfQuestions: [],
          reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
        },
      }],
      rationaleTrace: [],
      reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const extraction = aoriIndexToExtraction(index);
    expect(extraction.nodes.map((node) => node.aspects)).toEqual([["amount"], ["amount"]]);
    expect(extraction.relations[0]).toMatchObject({ type: "related_to", originalType: "source-local relation" });
    expect(index.relationLexicon.entries[0]).toMatchObject({ domainRelation: "source-local relation" });
  });

  it("builds Library AORI assertions and one aggregate relation across documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-library-aori-"));
    const db = new AgentDatabase(dir);
    try {
      const library = db.createLibrary("Library AORI");
      const firstVersion = db.createDocumentVersion(library.id, "chapter-1.md", "text/markdown", "chapter-1", "chapter-1", {
        indexStrategy: "aspect_oriented_reflective",
      }).version;
      const secondVersion = db.createDocumentVersion(library.id, "chapter-2.md", "text/markdown", "chapter-2", "chapter-2", {
        indexStrategy: "aspect_oriented_reflective",
      }).version;
      const firstChunks = db.replaceChunks(library.id, firstVersion.id, [
        { ordinal: 0, headingPath: "第一章", pageNumber: null, startChar: 0, endChar: 20, text: "A 和 B 是朋友。" },
      ]);
      const secondChunks = db.replaceChunks(library.id, secondVersion.id, [
        { ordinal: 0, headingPath: "第二章", pageNumber: null, startChar: 0, endChar: 20, text: "A 与 B 决裂，成为敌人。" },
      ]);
      const makeIndex = (versionId: string, documentId: string, documentName: string, chunks: Chunk[], domainRelation: string) =>
        buildAoriDocumentIndex({
          libraryId: library.id,
          documentId,
          documentName,
          versionId,
          chunks,
          drafts: [{
            groupId: `group-${versionId}`,
            draft: {
              understanding: {
                summary: documentName,
                centralQuestion: "A 和 B 是什么关系？",
                evidenceChunkIds: chunks.map((entry) => entry.id),
                evidenceStatus: "supported",
                closureStatus: "partial",
                classificationRationale: "source-bound",
                confidence: 0.8,
              },
              aspects: [{
                kind: "entity",
                domainKind: "人物关系",
                title: "人物关系",
                summary: "A 和 B 的关系。",
                centralQuestion: "A 和 B 是什么关系？",
                classificationRationale: "source-bound",
                confidence: 0.8,
                items: [
                  { key: "a", title: "A", summary: "人物 A", evidenceChunkIds: [chunks[0]!.id], evidenceStatus: "supported", closureStatus: "partial", confidence: 0.8 },
                  { key: "b", title: "B", summary: "人物 B", evidenceChunkIds: [chunks[0]!.id], evidenceStatus: "supported", closureStatus: "partial", confidence: 0.8 },
                ],
                relations: [{
                  sourceKey: "a",
                  targetKey: "b",
                  domainRelation,
                  relationTextInSource: domainRelation,
                  normalizedRelation: `A ${domainRelation} B`,
                  baseRelation: "related_to",
                  reason: "source-bound relation",
                  confidence: 0.85,
                  evidenceChunkIds: [chunks[0]!.id],
                  evidenceStatus: "supported",
                  closureStatus: "partial",
                }],
                gaps: [],
              }],
              selfQuestions: [],
              reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
            },
          }],
          rationaleTrace: [],
          reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
          createdAt: "2026-01-01T00:00:00.000Z",
        });

      new LibraryAoriService(db).mergeDocument(makeIndex(firstVersion.id, firstVersion.documentId, "chapter-1.md", firstChunks, "朋友"));
      new LibraryAoriService(db).mergeDocument(makeIndex(secondVersion.id, secondVersion.documentId, "chapter-2.md", secondChunks, "敌人"));

      const profile = db.getLibraryAoriProfile(library.id);
      expect(profile.available).toBe(true);
      if (!profile.available) throw new Error(profile.message);
      expect(profile.entities.map((entity) => entity.canonicalName).sort()).toEqual(["A", "B"]);
      expect(profile.assertions).toHaveLength(2);
      expect(profile.relations).toHaveLength(1);
      expect(profile.relations[0]).toMatchObject({
        aggregateRelation: "朋友 / 敌人",
        assertionIds: expect.arrayContaining(profile.assertions.map((assertion) => assertion.id)),
      });
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
