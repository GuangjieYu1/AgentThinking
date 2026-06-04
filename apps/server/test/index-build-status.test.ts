import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexBuildRecord } from "@agent-thinking/contracts";
import { AgentDatabase } from "../src/db.js";
import { buildContextIndex } from "../src/domain/context-units.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-index-status-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

function toBlob(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

function setStartedAt(db: AgentDatabase, buildId: string, startedAt: string): void {
  db.sql.prepare("UPDATE index_builds SET started_at = ? WHERE build_id = ?").run(startedAt, buildId);
}

function fixture(db: AgentDatabase): { libraryId: string; versionId: string } {
  const library = db.createLibrary("Index status");
  const version = db.createDocumentVersion(library.id, "status.txt", "text/plain", `hash-${library.id}`, "status.txt").version;
  return { libraryId: library.id, versionId: version.id };
}

function saveContextSidecar(
  db: AgentDatabase,
  libraryId: string,
  versionId: string,
  build: IndexBuildRecord,
  texts: string[],
) {
  let cursor = 0;
  const chunks = db.replaceChunks(libraryId, versionId, texts.map((text, ordinal) => {
    const startChar = cursor;
    cursor += text.length + 2;
    return {
      ordinal,
      headingPath: `Section ${ordinal + 1}`,
      pageNumber: null,
      startChar,
      endChar: startChar + text.length,
      text,
    };
  }));
  const sidecar = buildContextIndex({ buildId: build.buildId, versionId, chunks, treeNodes: [] });
  db.saveContextIndex(build.buildId, sidecar.contextUnits, sidecar.retrievalUnits, sidecar.qualityReport, sidecar.performanceReport);
  return sidecar;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("index build status", () => {
  it("tracks non-ready v2 build states and keeps their context index unreadable by default", async () => {
    const db = await database();
    const { libraryId, versionId } = fixture(db);

    const building = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, building.buildId, "2026-01-01T00:00:00.000Z");
    saveContextSidecar(db, libraryId, versionId, building, ["Building context should not be readable yet."]);
    expect(db.getIndexProfileStatus(versionId).v2).toBe("building");
    expect(db.getReadyContextUnits(versionId)).toHaveLength(0);
    expect(db.getReadyRetrievalUnits(versionId)).toHaveLength(0);

    const failed = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, failed.buildId, "2026-01-02T00:00:00.000Z");
    expect(db.markIndexBuildFailed(failed.buildId, new Error("embedding failed"))?.status).toBe("failed");
    expect(db.getIndexProfileStatus(versionId).v2).toBe("failed");

    const partial = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, partial.buildId, "2026-01-03T00:00:00.000Z");
    saveContextSidecar(db, libraryId, versionId, partial, ["Partial context is persisted but must stay non-ready."]);
    expect(db.markIndexBuildFailed(partial.buildId, new Error("vector batch failed"), "partial")?.status).toBe("partial");
    expect(db.getIndexProfileStatus(versionId).v2).toBe("partial");
    expect(db.getReadyContextUnits(versionId)).toHaveLength(0);
    expect(() => db.markIndexBuildReady(partial.buildId)).toThrow(/Only building/);

    const abandoned = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, abandoned.buildId, "2026-01-04T00:00:00.000Z");
    expect(db.markIndexBuildFailed(abandoned.buildId, new Error("worker stopped"), "abandoned")?.status).toBe("abandoned");
    expect(db.getIndexProfileStatus(versionId).v2).toBe("abandoned");

    const health = db.getV2IndexHealth(versionId);
    expect(health).toMatchObject({ retrievalUnitCount: 0, contextUnitCount: 0, vectorCount: 0 });
    expect(health.buildId).toBeUndefined();
    expect(health.buildHistory.map((entry) => entry.status).slice(0, 4)).toEqual([
      "abandoned",
      "partial",
      "failed",
      "building",
    ]);
    db.close();
  });

  it("keeps previous ready v2 builds readable until a newer ready build replaces them", async () => {
    const db = await database();
    const { libraryId, versionId } = fixture(db);

    const firstReady = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, firstReady.buildId, "2026-02-01T00:00:00.000Z");
    const firstSidecar = saveContextSidecar(db, libraryId, versionId, firstReady, ["Old ready context."]);
    db.markIndexBuildReady(firstReady.buildId, { vectorCount: firstSidecar.retrievalUnits.length });
    expect(db.getReadyContextUnits(versionId).map((unit) => unit.id)).toEqual(firstSidecar.contextUnits.map((unit) => unit.id));

    const partial = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, partial.buildId, "2026-02-02T00:00:00.000Z");
    const partialSidecar = saveContextSidecar(db, libraryId, versionId, partial, ["Newer partial context."]);
    db.markIndexBuildFailed(partial.buildId, new Error("partial write"), "partial");
    expect(db.getIndexProfileStatus(versionId).v2).toBe("ready");
    expect(db.getReadyContextUnits(versionId).map((unit) => unit.id)).toEqual(firstSidecar.contextUnits.map((unit) => unit.id));
    expect(db.getReadyContextUnits(versionId).map((unit) => unit.id)).not.toContain(partialSidecar.contextUnits[0]?.id);

    const latestReady = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, latestReady.buildId, "2026-02-03T00:00:00.000Z");
    const latestSidecar = saveContextSidecar(db, libraryId, versionId, latestReady, ["Latest ready context."]);
    db.markIndexBuildReady(latestReady.buildId, { vectorCount: latestSidecar.retrievalUnits.length });

    expect(db.getVersion(versionId)?.latestReadyV2BuildId).toBe(latestReady.buildId);
    expect(db.getReadyContextUnits(versionId).map((unit) => unit.id)).toEqual(latestSidecar.contextUnits.map((unit) => unit.id));
    expect(db.getReadyRetrievalUnits(versionId).map((unit) => unit.id)).toEqual(latestSidecar.retrievalUnits.map((unit) => unit.id));
    expect(db.getContextUnitsByIds([firstSidecar.contextUnits[0]!.id])).toHaveLength(1);
    db.close();
  });

  it("abandons stale building index builds during startup recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-index-recovery-"));
    temporaryDirectories.push(dir);
    const db = new AgentDatabase(dir);
    const { versionId } = fixture(db);
    const build = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, build.buildId, "2000-01-01T00:00:00.000Z");
    db.close();

    const recovered = new AgentDatabase(dir);
    const recoveredBuild = recovered.getIndexBuild(build.buildId);
    expect(recoveredBuild).toMatchObject({
      status: "abandoned",
      errorMessage: "Build abandoned during startup recovery.",
    });
    expect(recoveredBuild?.finishedAt).toBeTruthy();
    expect(recovered.getIndexProfileStatus(versionId).v2).toBe("abandoned");
    recovered.close();
  });

  it("returns latest ready v2 health and index status report with history and warnings", async () => {
    const db = await database();
    const { libraryId, versionId } = fixture(db);

    const ready = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, ready.buildId, "2026-03-01T00:00:00.000Z");
    const sidecar = saveContextSidecar(db, libraryId, versionId, ready, [
      "Ready context includes retrieval evidence.",
      "Second ready context adds another retrieval unit.",
    ]);
    for (const unit of sidecar.retrievalUnits) {
      db.saveVectorRecord(libraryId, versionId, ready.buildId, 2, "retrieval_unit", unit.id, 3, toBlob([1, unit.ordinal, 0]));
    }
    db.saveVectorRecord(libraryId, versionId, ready.buildId, 2, "summary_node", "summary-1", 3, toBlob([0, 1, 0]));
    db.markIndexBuildReady(ready.buildId, { vectorCount: sidecar.retrievalUnits.length, summaryVectorCount: 1 });

    const failed = db.createIndexBuild(versionId, "v2");
    setStartedAt(db, failed.buildId, "2026-03-02T00:00:00.000Z");
    db.markIndexBuildFailed(failed.buildId, new Error("later failed"));

    const health = db.getV2IndexHealth(versionId);
    expect(health.status.v2).toBe("ready");
    expect(health.buildId).toBe(ready.buildId);
    expect(health.contextUnitCount).toBe(sidecar.contextUnits.length);
    expect(health.retrievalUnitCount).toBe(sidecar.retrievalUnits.length);
    expect(health.vectorCount).toBe(sidecar.retrievalUnits.length);
    expect(health.summaryVectorCount).toBe(1);
    expect(health.qualityReport?.contextUnitCount).toBe(sidecar.contextUnits.length);
    expect(health.performanceReport?.retrievalUnitCount).toBe(sidecar.retrievalUnits.length);
    expect(health.buildHistory.map((entry) => entry.status).slice(0, 2)).toEqual(["failed", "ready"]);
    expect(health.warnings).toContain("v2 index build failed: later failed");

    const report = db.getIndexStatusReport(versionId);
    expect(report).toMatchObject({
      versionId,
      activeIndexProfile: "v2",
      latestReadyV2BuildId: ready.buildId,
      contextUnitCount: sidecar.contextUnits.length,
      retrievalUnitCount: sidecar.retrievalUnits.length,
      retrievalUnitVectorCount: sidecar.retrievalUnits.length,
      summaryVectorCount: 1,
      warnings: health.warnings,
    });
    db.close();
  });
});
