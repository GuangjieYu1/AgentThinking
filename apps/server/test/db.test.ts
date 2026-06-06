import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { buildDocumentIndex } from "../src/domain/document-tree.js";
import { FakeModelProvider } from "../src/services/models.js";
import { VectorStore } from "../src/services/vector-store.js";

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
  it("persists document tree, parent-child chunks, summaries, and evidence node links", async () => {
    const db = await database();
    const vectors = new VectorStore(db);
    const model = new FakeModelProvider();
    const library = db.createLibrary("RAG Index");
    const version = db.createDocumentVersion(library.id, "rag.md", "text/markdown", "rag", "rag").version;
    const documentId = db.getVersionSource(version.id)!.documentId;
    const index = buildDocumentIndex({
      libraryId: library.id,
      documentId,
      versionId: version.id,
      documentName: "rag.md",
      sections: [{ headingPath: "Overview", text: "Graph retrieval works. Parent context returns the section." }],
    });
    const chunks = db.replaceChunks(library.id, version.id, index.chunks);
    db.saveDocumentIndex(index, chunks);
    for (const chunk of chunks.filter((chunk) => chunk.nodeType === "paragraph")) {
      const [embedding] = await model.embed([chunk.text]);
      vectors.save(chunk, embedding ?? []);
    }
    for (const summary of index.summaryNodes) {
      const [embedding] = await model.embed([summary.summary]);
      vectors.saveSummary(library.id, summary, embedding ?? []);
    }

    const tree = db.getDocumentTreeForVersion(version.id);
    expect(tree.map((node) => node.nodeType)).toEqual(expect.arrayContaining(["document", "section", "paragraph", "sentence"]));
    const child = chunks.find((chunk) => chunk.nodeType === "paragraph")!;
    expect(child.parentChunkId).toBeTruthy();
    expect(db.getParentChildChunks([child.id])[0]).toMatchObject({
      childChunkId: child.id,
      parentChunkId: child.parentChunkId,
      documentTreeNodeId: child.documentTreeNodeId,
    });
    expect(vectors.search(library.id, (await model.embed(["Parent context"]))[0]!, 5).every((result) => result.chunk.nodeType !== "section")).toBe(true);
    expect(vectors.searchSummaries(library.id, (await model.embed(["Overview"]))[0]!, 5).length).toBeGreaterThan(0);

    db.saveExtraction(library.id, {
      nodes: [{
        key: "graph",
        kind: "concept",
        title: "Graph retrieval",
        summary: "Graph retrieval works.",
        evidenceChunkIds: [child.id],
        aspects: ["system"],
      }],
      relations: [],
    }, version.id);
    const node = db.searchAbstractNodes(library.id, "Graph retrieval", 1)[0]!.node;
    expect(node.evidenceNodeIds).toEqual([child.documentTreeNodeId]);
    db.close();
  });

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
        { key: "a", kind: "concept", title: "Alpha", summary: "", evidenceChunkIds: [chunks[0]!.id], aspects: [] },
        { key: "b", kind: "claim", title: "Beta", summary: "", evidenceChunkIds: [chunks[1]!.id], aspects: [] },
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

  it("updates relation details and graph evidence safely", async () => {
    const db = await database();
    const library = db.createLibrary("Audit Tools");
    const version = db.createDocumentVersion(library.id, "source.txt", "text/plain", "hash", "source").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 5, text: "alpha" },
      { ordinal: 1, headingPath: null, pageNumber: null, startChar: 6, endChar: 10, text: "beta" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [
        { key: "a", kind: "concept", title: "Alpha", summary: "alpha", evidenceChunkIds: [chunks[0]!.id], aspects: [] },
        { key: "b", kind: "claim", title: "Beta", summary: "beta", evidenceChunkIds: [chunks[1]!.id], aspects: [] },
      ],
      relations: [{
        sourceKey: "a",
        targetKey: "b",
        type: "related_to",
        reason: "loose relation",
        confidence: 0.4,
        evidenceChunkIds: [chunks[0]!.id],
      }],
    }, version.id);

    const graph = db.getGraph(library.id, {});
    const relation = graph.edges[0]!.relation!;
    const node = graph.nodes.find((item) => item.nodeType === "abstract" && item.data.title === "Alpha")!.data;
    const updated = db.updateRelation(relation.id, {
      type: "depends_on",
      reason: "alpha depends on beta",
      confidence: null,
      status: "accepted",
    });
    expect(updated).toMatchObject({ type: "depends_on", reason: "alpha depends on beta", confidence: null, status: "accepted" });

    expect(db.addRelationEvidence(relation.id, chunks[1]!.id).evidenceChunkIds).toEqual(expect.arrayContaining(chunks.map((chunk) => chunk.id)));
    expect(db.removeRelationEvidence(relation.id, chunks[0]!.id).evidenceChunkIds).toEqual([chunks[1]!.id]);
    expect(db.addNodeEvidence(node.id, chunks[1]!.id).citations.map((citation) => citation.chunkId))
      .toEqual(expect.arrayContaining(chunks.map((chunk) => chunk.id)));
    expect(db.removeNodeEvidence(node.id, chunks[0]!.id).citations.map((citation) => citation.chunkId)).toEqual([chunks[1]!.id]);

    const other = db.createLibrary("Other");
    const otherVersion = db.createDocumentVersion(other.id, "other.txt", "text/plain", "other", "other").version;
    const otherChunk = db.replaceChunks(other.id, otherVersion.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 5, text: "other" },
    ])[0]!;
    expect(() => db.addRelationEvidence(relation.id, otherChunk.id)).toThrow(/不属于当前知识库/);
    expect(() => db.addNodeEvidence(node.id, otherChunk.id)).toThrow(/不属于当前知识库/);
    db.close();
  });

  it("stores mapping audit results and builds AI-only version context", async () => {
    const db = await database();
    const library = db.createLibrary("Mapping Audit");
    const version = db.createDocumentVersion(library.id, "audit.txt", "text/plain", "hash", "a").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 5, text: "alpha" },
      { ordinal: 1, headingPath: null, pageNumber: null, startChar: 6, endChar: 12, text: "beta" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [
        { key: "a", kind: "concept", title: "Alpha", summary: "alpha summary", evidenceChunkIds: [chunks[0]!.id], aspects: [] },
        { key: "b", kind: "claim", title: "Beta", summary: "beta summary", evidenceChunkIds: [chunks[1]!.id], aspects: [] },
      ],
      relations: [{
        sourceKey: "a",
        targetKey: "b",
        type: "supports",
        reason: "alpha supports beta",
        confidence: 0.8,
        evidenceChunkIds: [chunks[0]!.id],
      }],
    }, version.id);
    const context = db.getMappingAuditContext(version.id);
    expect(context?.chunks).toHaveLength(2);
    expect(context?.nodes.map((node) => node.title)).toContain("Alpha");
    expect(context?.relations[0]?.evidenceChunkIds).toEqual([chunks[0]!.id]);
    const saved = db.saveMappingAudit(library.id, version.id, {
      status: "minor_issues",
      summary: "needs review",
      reconstruction: "semantic outline",
      findings: [{
        kind: "overgeneralization",
        severity: "low",
        title: "Check summary",
        description: "Summary may be broad.",
        suggestion: "Compare against source chunk.",
        evidenceChunkIds: [chunks[0]!.id],
        nodeIds: [context!.nodes[0]!.id],
        relationIds: [],
        userComment: "",
      }],
    });
    expect(db.getMappingAudit(version.id)?.id).toBe(saved.id);
    expect(db.updateMappingAuditFindingComment(version.id, 0, "优先保留节点，调整摘要。").findings[0]?.userComment)
      .toBe("优先保留节点，调整摘要。");
    const rebuildReport = db.saveMappingAuditGraphRebuildReport(version.id, "审计驱动图谱重构已完成");
    expect(rebuildReport.graphRebuildReport).toBe("审计驱动图谱重构已完成");
    expect(rebuildReport.graphRebuiltAt).toBeTruthy();
    db.saveMappingAudit(library.id, version.id, {
      status: "clean",
      summary: "ok",
      reconstruction: "updated",
      findings: [],
    });
    expect(db.getMappingAudit(version.id)?.summary).toBe("ok");
    expect(db.getMappingAudit(version.id)?.graphRebuildReport).toBe("");
    expect(db.deleteLibrary(library.id)).toBe(true);
    expect(db.getMappingAudit(version.id)).toBeUndefined();
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
        { key: "a", kind: "concept" as const, title: "A", summary: "", evidenceChunkIds: [chunks[0]!.id], aspects: [] },
        { key: "b", kind: "claim" as const, title: "B", summary: "", evidenceChunkIds: [chunks[1]!.id], aspects: [] },
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
    db.saveExtraction(library.id, extraction([chunks[0]!.id]), version.id);
    db.saveExtraction(library.id, extraction([chunks[1]!.id]), version.id);
    const relations = db.getGraph(library.id, {}).edges.map((edge) => edge.relation).filter(Boolean);
    expect(relations).toHaveLength(1);
    expect(relations[0]?.evidenceChunkIds).toEqual(expect.arrayContaining(chunks.map((chunk) => chunk.id)));
    db.close();
  });

  it("stores theme abstractions and aggregates their child relations in overview mode", async () => {
    const db = await database();
    const library = db.createLibrary("Themes");
    const version = db.createDocumentVersion(library.id, "themes.txt", "text/plain", "themes", "themes").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 8, text: "airport system" },
      { ordinal: 1, headingPath: null, pageNumber: null, startChar: 9, endChar: 18, text: "flight action" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [
        { key: "system", kind: "concept", title: "航班系统", summary: "", evidenceChunkIds: [chunks[0]!.id], aspects: ["system"] },
        { key: "operation", kind: "concept", title: "实时更新", summary: "", evidenceChunkIds: [chunks[1]!.id], aspects: ["operation"] },
      ],
      relations: [{
        sourceKey: "system",
        targetKey: "operation",
        type: "supports",
        reason: "system supports operation",
        confidence: 0.8,
        evidenceChunkIds: chunks.map((chunk) => chunk.id),
      }],
      themes: [
        { title: "基础设施", summary: "系统主题", memberKeys: ["system"], evidenceChunkIds: [chunks[0]!.id], aspects: ["system"] },
        { title: "运行流程", summary: "操作主题", memberKeys: ["operation"], evidenceChunkIds: [chunks[1]!.id], aspects: ["operation"] },
      ],
    }, version.id);
    const overview = db.getGraph(library.id, { view: "overview" });
    expect(overview.nodes.filter((node) => node.nodeType === "abstract").map((node) => node.data.level)).toEqual([2, 2]);
    expect(overview.edges[0]?.aggregate).toMatchObject({ type: "supports", count: 1 });
    const theme = overview.nodes.find((node) => node.nodeType === "abstract" && node.data.title === "基础设施");
    expect(theme?.nodeType === "abstract" && theme.data.aspects).toContain("system");
    const expanded = db.getGraph(library.id, { centerId: theme!.id });
    expect(expanded.edges.some((edge) => edge.edgeType === "membership")).toBe(true);
    db.close();
  });

  it("focuses aspect paths and preserves manual aspect overrides across reanalysis", async () => {
    const db = await database();
    const library = db.createLibrary("Aspects");
    const version = db.createDocumentVersion(library.id, "aspects.txt", "text/plain", "aspects", "aspects").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 6, text: "system" },
      { ordinal: 1, headingPath: null, pageNumber: null, startChar: 7, endChar: 13, text: "bridge" },
      { ordinal: 2, headingPath: null, pageNumber: null, startChar: 14, endChar: 20, text: "engine" },
      { ordinal: 3, headingPath: null, pageNumber: null, startChar: 21, endChar: 30, text: "neighbor" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [
        { key: "a", kind: "concept", title: "System A", summary: "", evidenceChunkIds: [chunks[0]!.id], aspects: ["system"] },
        { key: "bridge", kind: "concept", title: "Bridge", summary: "", evidenceChunkIds: [chunks[1]!.id], aspects: ["other"] },
        { key: "b", kind: "concept", title: "System B", summary: "", evidenceChunkIds: [chunks[2]!.id], aspects: ["system"] },
        { key: "neighbor", kind: "claim", title: "Neighbor", summary: "", evidenceChunkIds: [chunks[3]!.id], aspects: ["claim"] },
      ],
      relations: [
        { sourceKey: "a", targetKey: "bridge", type: "related_to", reason: "path", confidence: 0.7, evidenceChunkIds: [] },
        { sourceKey: "bridge", targetKey: "b", type: "related_to", reason: "path", confidence: 0.7, evidenceChunkIds: [] },
        { sourceKey: "a", targetKey: "neighbor", type: "supports", reason: "context", confidence: 0.7, evidenceChunkIds: [] },
      ],
    }, version.id);

    const focused = db.getGraph(library.id, { aspect: "system" });
    const roles = new Map(focused.nodes.map((node) => [node.nodeType === "abstract" ? node.data.title : node.id, node.focusRole]));
    expect(roles.get("System A")).toBe("match");
    expect(roles.get("System B")).toBe("match");
    expect(roles.get("Bridge")).toBe("bridge");
    expect(roles.get("Neighbor")).toBe("neighbor");
    const systemA = focused.nodes.find((node) => node.nodeType === "abstract" && node.data.title === "System A")!;
    const manual = db.updateNodeAspects(systemA.id, ["person"]);
    expect(manual).toMatchObject({ aspects: ["person"], aspectSource: "manual" });

    const regenerated = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 6, text: "system" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [{ key: "a", kind: "concept", title: "System A", summary: "", evidenceChunkIds: [regenerated[0]!.id], aspects: ["system"] }],
      relations: [],
    }, version.id);
    const retained = db.getGraph(library.id, {}).nodes.find((node) => node.nodeType === "abstract" && node.data.title === "System A");
    expect(retained?.nodeType === "abstract" && retained.data.aspectSource).toBe("manual");
    expect(retained?.nodeType === "abstract" && retained.data.aspects).toEqual(["person"]);
    expect(db.resetNodeAspects(systemA.id)).toMatchObject({ aspects: ["system"], aspectSource: "ai" });
    db.close();
  });

  it("rebuilds AI aspects from individual source contributions and respects manual-empty effective labels", async () => {
    const db = await database();
    const library = db.createLibrary("Shared aspects");
    const firstVersion = db.createDocumentVersion(library.id, "first.txt", "text/plain", "first", "first").version;
    const secondVersion = db.createDocumentVersion(library.id, "second.txt", "text/plain", "second", "second").version;
    const [firstChunk] = db.replaceChunks(library.id, firstVersion.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 7, text: "system" },
    ]);
    const [secondChunk] = db.replaceChunks(library.id, secondVersion.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 5, text: "claim" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [{ key: "shared", kind: "concept", title: "Shared", summary: "", evidenceChunkIds: [firstChunk!.id], aspects: ["system"] }],
      relations: [],
    }, firstVersion.id);
    db.saveExtraction(library.id, {
      nodes: [{ key: "shared", kind: "concept", title: "Shared", summary: "", evidenceChunkIds: [secondChunk!.id], aspects: ["claim"] }],
      relations: [],
    }, secondVersion.id);

    const shared = db.getGraph(library.id, {}).nodes.find((node) => node.nodeType === "abstract")!;
    expect(shared.nodeType === "abstract" && shared.data.aspects).toEqual(["claim", "system"]);
    expect(db.updateNodeAspects(shared.id, [])).toMatchObject({ aspects: [], aspectSource: "manual" });
    expect(db.getGraph(library.id, { aspect: "system" }).aspectFilter).toMatchObject({ anyLabeled: false, matchCount: 0 });
    db.resetNodeAspects(shared.id);

    const [replacedChunk] = db.replaceChunks(library.id, firstVersion.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 7, text: "person" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [{ key: "shared", kind: "concept", title: "Shared", summary: "", evidenceChunkIds: [replacedChunk!.id], aspects: ["person"] }],
      relations: [],
    }, firstVersion.id);
    const updated = db.getGraph(library.id, {}).nodes.find((node) => node.nodeType === "abstract");
    expect(updated?.nodeType === "abstract" && updated.data.aspects).toEqual(["person", "claim"]);
    db.close();
  });

  it("backfills existing non-empty AI aspect labels when adding contribution storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-migration-"));
    temporaryDirectories.push(dir);
    const db = new AgentDatabase(dir);
    const library = db.createLibrary("Migrated aspects");
    const version = db.createDocumentVersion(library.id, "old.txt", "text/plain", "old", "old").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 6, text: "tagged" },
      { ordinal: 1, headingPath: null, pageNumber: null, startChar: 7, endChar: 14, text: "untagged" },
    ]);
    db.saveExtraction(library.id, {
      nodes: [
        { key: "tagged", kind: "concept", title: "Tagged", summary: "", evidenceChunkIds: [chunks[0]!.id], aspects: ["system"] },
        { key: "untagged", kind: "concept", title: "Untagged", summary: "", evidenceChunkIds: [chunks[1]!.id], aspects: [] },
      ],
      relations: [],
    });
    db.sql.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
    db.close();

    const migrated = new AgentDatabase(dir);
    const contributions = migrated.sql.prepare("SELECT aspects_json FROM abstract_node_aspect_contributions").all() as Array<{ aspects_json: string }>;
    expect(contributions.map((entry) => JSON.parse(entry.aspects_json))).toEqual([["system"]]);
    migrated.close();
  });

  it("prevents relations between different libraries", async () => {
    const db = await database();
    const left = db.createLibrary("Left");
    const right = db.createLibrary("Right");
    db.saveExtraction(left.id, {
      nodes: [{ key: "a", kind: "concept", title: "Left", summary: "", evidenceChunkIds: [], aspects: [] }],
      relations: [],
    });
    db.saveExtraction(right.id, {
      nodes: [{ key: "b", kind: "concept", title: "Right", summary: "", evidenceChunkIds: [], aspects: [] }],
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
      nodes: [{ key: "bad", kind: "concept", title: "Failed", summary: "", evidenceChunkIds: [chunks[0]!.id], aspects: [] }],
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
        { key: "one", kind: "concept", title: "One", summary: "", evidenceChunkIds: [], aspects: [] },
        { key: "two", kind: "claim", title: "Two", summary: "", evidenceChunkIds: [], aspects: [] },
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
        { key: "a", kind: "concept", title: "A", summary: "", evidenceChunkIds: [chunks[0]!.id], aspects: [] },
        { key: "b", kind: "claim", title: "B", summary: "", evidenceChunkIds: [chunks[1]!.id], aspects: [] },
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
    const advised = db.saveStatementPrecheck(statement.id, {
      status: "unsupported",
      reason: "论据无法直接推出该结论。",
      suggestions: ["添加明确支持关系的原文证据。"],
    });
    expect(advised.precheck.suggestions).toEqual(["添加明确支持关系的原文证据。"]);
    const withEvidence = db.addStatementEvidence(statement.id, chunks[0]!.id);
    expect(withEvidence.precheck.suggestions).toEqual([]);
    expect(db.updateAnalysisStatement(statement.id, { status: "approved" }).status).toBe("approved");
    const changed = db.addStatementEvidence(statement.id, chunks[1]!.id);
    expect(changed.status).toBe("pending");
    expect(changed.invalidatedReason).toContain("证据引用");
    db.close();
  });
});
