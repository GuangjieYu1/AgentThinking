import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDatabase } from "../src/db.js";
import { parseTextSections } from "../src/domain/chunker.js";
import { buildContextIndex } from "../src/domain/context-units.js";
import { buildDocumentIndex } from "../src/domain/document-tree.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-context-units-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ContextUnit v2 builder", () => {
  it("builds sidecar context and retrieval units without sentence context units", async () => {
    const db = await database();
    const library = db.createLibrary("generic context fixture");
    const version = db.createDocumentVersion(library.id, "values.txt", "text/plain", "hash", "values.txt").version;
    const sections = parseTextSections([
      "Declared total is 100 units.",
      "Source A contributes 40 units.",
      "Source B contributes 60 units.",
    ].join("\n\n"));
    const documentIndex = buildDocumentIndex({
      libraryId: library.id,
      documentId: version.documentId,
      versionId: version.id,
      documentName: "values.txt",
      sections,
    });
    const chunks = db.replaceChunks(library.id, version.id, documentIndex.chunks);
    db.saveDocumentIndex(documentIndex, chunks);
    const build = db.createIndexBuild(version.id, "v2");
    const sidecar = buildContextIndex({ buildId: build.buildId, versionId: version.id, chunks, treeNodes: documentIndex.treeNodes });

    expect(sidecar.contextUnits.length).toBeGreaterThan(0);
    expect(sidecar.retrievalUnits.length).toBeGreaterThan(0);
    expect(sidecar.contextUnits.every((unit) => unit.blocks.length > 0)).toBe(true);
    expect(sidecar.contextUnits.some((unit) => unit.boundaryReason === "document_tree_boundary")).toBe(true);
    expect(sidecar.qualityReport.contextUnitCount).toBe(sidecar.contextUnits.length);
    expect(sidecar.qualityReport.retrievalUnitCount).toBe(sidecar.retrievalUnits.length);
    expect(sidecar.contextUnits.flatMap((unit) => unit.blocks).every((block) => block.type !== "unknown" || block.textPreview !== undefined)).toBe(true);
    db.close();
  });

  it("keeps partial v2 builds unreadable until marked ready", async () => {
    const db = await database();
    const library = db.createLibrary("index status fixture");
    const version = db.createDocumentVersion(library.id, "values.txt", "text/plain", "hash", "values.txt").version;
    const chunks = db.replaceChunks(library.id, version.id, [
      { ordinal: 0, headingPath: "Values", pageNumber: null, startChar: 0, endChar: 29, text: "Declared total is 100 units." },
    ]);
    const build = db.createIndexBuild(version.id, "v2");
    const sidecar = buildContextIndex({ buildId: build.buildId, versionId: version.id, chunks, treeNodes: [] });
    db.saveContextIndex(build.buildId, sidecar.contextUnits, sidecar.retrievalUnits, sidecar.qualityReport, sidecar.performanceReport);

    expect(db.getReadyContextUnits(version.id)).toHaveLength(0);
    expect(db.getIndexProfileStatus(version.id).v2).toBe("building");

    db.markIndexBuildReady(build.buildId);
    expect(db.getReadyContextUnits(version.id)).toHaveLength(sidecar.contextUnits.length);
    expect(db.getIndexProfileStatus(version.id).v2).toBe("ready");
    expect(db.getV2IndexHealth(version.id).contextUnitCount).toBe(sidecar.contextUnits.length);
    db.close();
  });
});
