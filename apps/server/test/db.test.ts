import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-db-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("knowledge database", () => {
  it("deduplicates matching document content while retaining changed versions", async () => {
    const db = await database();
    const library = db.createLibrary("Research");
    const first = db.createDocumentVersion(library.id, "a.md", "text/markdown", "hash-1", "a");
    const duplicate = db.createDocumentVersion(library.id, "a.md", "text/markdown", "hash-1", "a");
    const changed = db.createDocumentVersion(library.id, "a.md", "text/markdown", "hash-2", "b");
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(changed.version.id).not.toBe(first.version.id);
    db.close();
  });

  it("stores suggested extracted relations and expands their evidence chunks", async () => {
    const db = await database();
    const library = db.createLibrary("Graph");
    const version = db.createDocumentVersion(library.id, "a.txt", "text/plain", "hash", "a").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 4, text: "alpha" },
      { ordinal: 1, headingPath: null, pageNumber: null, startChar: 5, endChar: 9, text: "beta" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [
        { key: "a", kind: "concept", title: "Alpha", summary: "", evidenceChunkIds: [chunks[0]!.id] },
        { key: "b", kind: "claim", title: "Beta", summary: "", evidenceChunkIds: [chunks[1]!.id] },
      ],
      relations: [{
        sourceKey: "a",
        targetKey: "b",
        type: "supports",
        reason: "Evidence supports claim.",
        confidence: 0.8,
        evidenceChunkIds: chunks.map((chunk) => chunk.id),
      }],
    });
    const graph = db.getGraph(library.id, { includeChunks: true });
    expect(graph.nodes.filter((node) => node.nodeType === "chunk")).toHaveLength(2);
    expect(graph.edges.find((edge) => edge.relation?.status === "suggested")).toBeTruthy();
    db.close();
  });

  it("merges evidence when AI suggests the same pending relation again", async () => {
    const db = await database();
    const library = db.createLibrary("Merged suggestions");
    const version = db.createDocumentVersion(library.id, "a.txt", "text/plain", "hash", "a").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 5, text: "first" },
      { ordinal: 1, headingPath: null, pageNumber: null, startChar: 6, endChar: 12, text: "second" },
    ]);
    const extraction = (evidenceChunkIds: string[]) => ({
      nodes: [
        { key: "a", kind: "concept" as const, title: "A", summary: "", evidenceChunkIds: [chunks[0]!.id] },
        { key: "b", kind: "claim" as const, title: "B", summary: "", evidenceChunkIds: [chunks[1]!.id] },
      ],
      relations: [{
        sourceKey: "a",
        targetKey: "b",
        type: "supports" as const,
        reason: "same pending relationship",
        confidence: 0.8,
        evidenceChunkIds,
      }],
    });
    db.saveExtraction(library.id, extraction([chunks[0]!.id]));
    db.saveExtraction(library.id, extraction([chunks[1]!.id]));
    const relations = db.getGraph(library.id, {}).edges.map((edge) => edge.relation).filter(Boolean);
    expect(relations).toHaveLength(1);
    expect(relations[0]?.evidenceChunkIds).toEqual(expect.arrayContaining(chunks.map((chunk) => chunk.id)));
    db.close();
  });

  it("prevents relations between different libraries", async () => {
    const db = await database();
    const left = db.createLibrary("Left");
    const right = db.createLibrary("Right");
    db.saveExtraction(left.id, {
      nodes: [{ key: "a", kind: "concept", title: "Left", summary: "", evidenceChunkIds: [] }],
      relations: [],
    });
    db.saveExtraction(right.id, {
      nodes: [{ key: "b", kind: "concept", title: "Right", summary: "", evidenceChunkIds: [] }],
      relations: [],
    });
    const leftNode = db.getGraph(left.id, {}).nodes[0]!;
    const rightNode = db.getGraph(right.id, {}).nodes[0]!;
    expect(() => db.createRelation(left.id, {
      sourceNodeId: leftNode.id,
      targetNodeId: rightNode.id,
      type: "related_to",
      reason: "bad edge",
    })).toThrow(/不属于/);
    db.close();
  });

  it("deletes a failed import version and its generated graph residue", async () => {
    const db = await database();
    const library = db.createLibrary("Cleanup");
    const version = db.createDocumentVersion(library.id, "broken.txt", "text/plain", "bad", "broken.txt").version;
    const job = db.createJob(library.id, version.id);
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 6, text: "failed" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [{ key: "bad", kind: "concept", title: "Failed", summary: "", evidenceChunkIds: [chunks[0]!.id] }],
      relations: [],
    });
    db.updateJob(job.id, "failed", 0, "provider error");

    expect(db.deleteFailedJob(job.id)).toEqual({ storagePath: "broken.txt" });
    expect(db.listJobs(library.id)).toHaveLength(0);
    expect(db.listDocuments(library.id)).toHaveLength(0);
    expect(db.getGraph(library.id, {}).nodes).toHaveLength(0);
    db.close();
  });

  it("deleting an abstract node removes attached relations", async () => {
    const db = await database();
    const library = db.createLibrary("Node removal");
    db.saveExtraction(library.id, {
      nodes: [
        { key: "one", kind: "concept", title: "One", summary: "", evidenceChunkIds: [] },
        { key: "two", kind: "claim", title: "Two", summary: "", evidenceChunkIds: [] },
      ],
      relations: [{
        sourceKey: "one",
        targetKey: "two",
        type: "explains",
        reason: "one explains two",
        confidence: 0.7,
        evidenceChunkIds: [],
      }],
    });
    const initial = db.getGraph(library.id, {});
    expect(initial.edges).toHaveLength(1);
    expect(db.deleteAbstractNode(initial.nodes[0]!.id)).toBe(true);
    expect(db.getGraph(library.id, {}).edges).toHaveLength(0);
    db.close();
  });

  it("requires review of accepted and manual analysis statements and resets changed evidence", async () => {
    const db = await database();
    const library = db.createLibrary("Analysis");
    const version = db.createDocumentVersion(library.id, "source.txt", "text/plain", "hash", "source").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 9, text: "evidence A" },
      { ordinal: 1, headingPath: null, pageNumber: null, startChar: 10, endChar: 19, text: "evidence B" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [
        { key: "a", kind: "concept", title: "A", summary: "", evidenceChunkIds: [chunks[0]!.id] },
        { key: "b", kind: "claim", title: "B", summary: "", evidenceChunkIds: [chunks[1]!.id] },
      ],
      relations: [],
    });
    const nodes = db.getGraph(library.id, {}).nodes;
    const manual = db.createRelation(library.id, {
      sourceNodeId: nodes[0]!.id,
      targetNodeId: nodes[1]!.id,
      type: "supports",
      reason: "manual relation",
    });
    const draft = db.generateAnalysisDraft(library.id);
    expect(draft.statements.map((statement) => statement.relationId)).toContain(manual.id);
    const statement = draft.statements[0]!;
    expect(() => db.updateAnalysisStatement(statement.id, { status: "approved" })).toThrow(/至少一条原文证据/);
    db.addStatementEvidence(statement.id, chunks[0]!.id);
    expect(db.updateAnalysisStatement(statement.id, { status: "approved" }).status).toBe("approved");
    const changed = db.addStatementEvidence(statement.id, chunks[1]!.id);
    expect(changed.status).toBe("pending");
    expect(changed.invalidatedReason).toContain("证据引用");
    db.close();
  });
});
