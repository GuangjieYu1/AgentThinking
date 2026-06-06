import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Chunk } from "@agent-thinking/contracts";
import { getConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { IngestionQueue } from "../src/services/ingestion.js";
import { LibraryEventBus } from "../src/services/library-events.js";
import { FakeModelProvider } from "../src/services/models.js";
import { VectorStore } from "../src/services/vector-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ingestion pipeline", () => {
  it("processes an imported markdown document into a reviewable graph using the fake provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-pipeline-"));
    temporaryDirectories.push(dir);
    const config = getConfig({ dataDir: dir, filesDir: join(dir, "files"), ocrCacheDir: join(dir, "ocr"), provider: "fake" });
    const db = new AgentDatabase(dir);
    const library = db.createLibrary("Demo");
    const filePath = join(dir, "files", "demo.md");
    await mkdir(join(dir, "files"), { recursive: true });
    await writeFile(filePath, "# 概念\n这是第一项材料。\n\n# 结论\n因此这是应当检查的结论。", "utf8");
    const version = db.createDocumentVersion(library.id, "demo.md", "text/markdown", "demo-hash", filePath).version;
    const job = db.createJob(library.id, version.id);
    const vectors = new VectorStore(db);
    expect(vectors.usesSqliteVec).toBe(true);
    const events = new LibraryEventBus();
    const governanceEvents: string[] = [];
    events.subscribe((event) => {
      if (event.type === "graph_rule_trace" || event.type === "graph_rule_summary") governanceEvents.push(event.type);
    });
    const queue = new IngestionQueue(db, vectors, new FakeModelProvider(), config, events);
    const completed = new Promise<void>((resolve, reject) => {
      queue.on("job", (update: { stage: string; error?: string }) => {
        if (update.stage === "completed") resolve();
        if (update.stage === "failed") reject(new Error(update.error));
      });
    });
    queue.enqueue(job.id);
    await completed;
    const graph = db.getGraph(library.id, { includeChunks: true });
    expect(graph.nodes.some((node) => node.nodeType === "abstract")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation?.status === "suggested")).toBe(true);
    const [queryEmbedding] = await new FakeModelProvider().embed(["结论"]);
    expect(vectors.search(library.id, queryEmbedding!, 3).length).toBeGreaterThan(0);
    expect(db.listJobs(library.id)[0]?.stage).toBe("completed");
    expect(governanceEvents).toContain("graph_rule_trace");
    expect(governanceEvents).toContain("graph_rule_summary");
    db.close();
  });

  it("revisits existing chunks with new context when documents are imported one at a time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-incremental-"));
    temporaryDirectories.push(dir);
    const config = getConfig({ dataDir: dir, filesDir: join(dir, "files"), ocrCacheDir: join(dir, "ocr"), provider: "fake" });
    const db = new AgentDatabase(dir);
    const library = db.createLibrary("Incremental");
    await mkdir(join(dir, "files"), { recursive: true });
    const firstPath = join(dir, "files", "first.txt");
    const secondPath = join(dir, "files", "second.txt");
    await writeFile(firstPath, "同一主题的旧材料", "utf8");
    await writeFile(secondPath, "同一主题的新材料", "utf8");
    const first = db.createDocumentVersion(library.id, "first.txt", "text/plain", "first", firstPath).version;
    const second = db.createDocumentVersion(library.id, "second.txt", "text/plain", "second", secondPath).version;
    const model = new RecordingModelProvider();
    const queue = new IngestionQueue(db, new VectorStore(db), model, config);

    await enqueueAndComplete(queue, db.createJob(library.id, first.id).id);
    await enqueueAndComplete(queue, db.createJob(library.id, second.id).id);

    expect(model.calls.some((call) =>
      call.primaryVersionIds.includes(first.id) &&
      call.candidateVersionIds.includes(second.id),
    )).toBe(true);
    db.close();
  });

  it("uses full-document AORI context for documents inside the model budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-aori-full-"));
    temporaryDirectories.push(dir);
    const config = getConfig({ dataDir: dir, filesDir: join(dir, "files"), ocrCacheDir: join(dir, "ocr"), provider: "fake" });
    const db = new AgentDatabase(dir);
    const library = db.createLibrary("AORI Full");
    await mkdir(join(dir, "files"), { recursive: true });
    const tailMarker = "全文阅读尾部标记";
    const filePath = join(dir, "files", "long.md");
    await writeFile(filePath, `# Long\n开头\n${"完整上下文".repeat(900)}\n${tailMarker}`, "utf8");
    const version = db.createDocumentVersion(library.id, "long.md", "text/markdown", "long", filePath, {
      indexStrategy: "aspect_oriented_reflective",
    }).version;
    const model = new RecordingModelProvider();
    const queue = new IngestionQueue(db, new VectorStore(db), model, config);

    await enqueueAndComplete(queue, db.createJob(library.id, version.id).id);

    const globalRead = model.calls.find((call) => call.aoriStage === "global_reading");
    expect(globalRead?.chunkTexts.join("\n")).toContain(tailMarker);
    expect(globalRead?.maxChunkTextLength).toBeGreaterThan(2400);
    expect(globalRead?.truncated).toBe(false);
    db.close();
  });

  it("records full-document AORI rationale when requested without truncation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-aori-full-rationale-"));
    temporaryDirectories.push(dir);
    const config = getConfig({ dataDir: dir, filesDir: join(dir, "files"), ocrCacheDir: join(dir, "ocr"), provider: "fake" });
    const db = new AgentDatabase(dir);
    const library = db.createLibrary("AORI Full Rationale");
    await mkdir(join(dir, "files"), { recursive: true });
    const filePath = join(dir, "files", "short.md");
    await writeFile(filePath, "# Short\nA 和 B 是朋友。", "utf8");
    const version = db.createDocumentVersion(library.id, "short.md", "text/markdown", "short", filePath, {
      indexStrategy: "aspect_oriented_reflective",
      recordIndexingRationale: true,
    }).version;
    const queue = new IngestionQueue(db, new VectorStore(db), new RecordingModelProvider(), config);

    await enqueueAndComplete(queue, db.createJob(library.id, version.id, {
      indexStrategy: "aspect_oriented_reflective",
      recordIndexingRationale: true,
    }).id);

    const aori = db.getAoriDocumentIndex(version.id);
    expect(aori.available).toBe(true);
    if (!aori.available) throw new Error(aori.message);
    expect(aori.rationaleTrace).toHaveLength(1);
    expect(aori.rationaleTrace[0]).toMatchObject({
      decisionType: "context_selection",
      preservedRanges: ["full_document"],
      omittedRanges: [],
      risk: "low",
    });
    expect(aori.rationaleDebug).toMatchObject({
      rationaleRequested: true,
      rationaleGenerated: true,
      rationaleSaved: true,
      rationaleCount: 1,
      rationaleMissingReason: null,
    });
    db.close();
  });

  it("explains missing AORI rationale when it was not requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-aori-no-rationale-"));
    temporaryDirectories.push(dir);
    const config = getConfig({ dataDir: dir, filesDir: join(dir, "files"), ocrCacheDir: join(dir, "ocr"), provider: "fake" });
    const db = new AgentDatabase(dir);
    const library = db.createLibrary("AORI No Rationale");
    await mkdir(join(dir, "files"), { recursive: true });
    const filePath = join(dir, "files", "short.md");
    await writeFile(filePath, "# Short\nA 和 B 是朋友。", "utf8");
    const version = db.createDocumentVersion(library.id, "short.md", "text/markdown", "short-no-rationale", filePath, {
      indexStrategy: "aspect_oriented_reflective",
      recordIndexingRationale: false,
    }).version;
    const queue = new IngestionQueue(db, new VectorStore(db), new RecordingModelProvider(), config);

    await enqueueAndComplete(queue, db.createJob(library.id, version.id, {
      indexStrategy: "aspect_oriented_reflective",
      recordIndexingRationale: false,
    }).id);

    const aori = db.getAoriDocumentIndex(version.id);
    expect(aori.available).toBe(true);
    if (!aori.available) throw new Error(aori.message);
    expect(aori.rationaleTrace).toHaveLength(0);
    expect(aori.rationaleDebug).toMatchObject({
      rationaleRequested: false,
      rationaleGenerated: false,
      rationaleSaved: false,
      rationaleCount: 0,
      rationaleMissingReason: "用户未勾选生成索引理由",
    });
    db.close();
  });

  it("uses large AORI context groups and records truncation rationale for over-budget documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-aori-truncated-"));
    temporaryDirectories.push(dir);
    const config = getConfig({
      dataDir: dir,
      filesDir: join(dir, "files"),
      ocrCacheDir: join(dir, "ocr"),
      provider: "fake",
      aoriModelContextTokens: 12000,
      aoriGlobalReadMaxInputTokens: 12000,
      aoriMinTruncatedContextTokens: 10000,
      recordIndexingRationale: true,
    });
    const db = new AgentDatabase(dir);
    const library = db.createLibrary("AORI Truncated");
    await mkdir(join(dir, "files"), { recursive: true });
    const filePath = join(dir, "files", "oversize.md");
    await writeFile(filePath, `# First\n${"甲".repeat(44000)}\n\n# Second\n${"乙".repeat(44000)}`, "utf8");
    const version = db.createDocumentVersion(library.id, "oversize.md", "text/markdown", "oversize", filePath, {
      indexStrategy: "aspect_oriented_reflective",
      recordIndexingRationale: true,
    }).version;
    const model = new RecordingModelProvider();
    const queue = new IngestionQueue(db, new VectorStore(db), model, config);

    await enqueueAndComplete(queue, db.createJob(library.id, version.id).id);

    const globalReads = model.calls.filter((call) => call.aoriStage === "global_reading");
    expect(globalReads.length).toBeGreaterThan(1);
    expect(globalReads.every((call) => (call.usedTokenEstimate ?? 0) >= 10000)).toBe(true);
    expect(globalReads.every((call) => call.minTruncatedContextTokens === 10000)).toBe(true);
    const v2Build = db.listIndexBuilds(version.id).find((build) => build.profile === "v2");
    const qualityReport = JSON.parse(v2Build?.qualityReportJson ?? "{}") as {
      aoriRationaleTrace?: Array<{ decisionType: string; usedTokenEstimate: number }>;
      reflectiveIndexReport?: { completenessRisk: string; truncationCount: number };
    };
    expect(qualityReport.aoriRationaleTrace?.length).toBe(globalReads.length);
    expect(qualityReport.aoriRationaleTrace?.every((entry) =>
      entry.decisionType === "context_truncation" && entry.usedTokenEstimate >= 10000,
    )).toBe(true);
    expect(qualityReport.reflectiveIndexReport?.completenessRisk).not.toBe("none");
    expect(qualityReport.reflectiveIndexReport?.truncationCount).toBe(globalReads.length);
    db.close();
  });
});

class RecordingModelProvider extends FakeModelProvider {
  calls: Array<{
    primaryVersionIds: string[];
    candidateVersionIds: string[];
    aoriStage?: string | undefined;
    usedTokenEstimate?: number | undefined;
    minTruncatedContextTokens?: number | undefined;
    truncated?: boolean | undefined;
    maxChunkTextLength: number;
    chunkTexts: string[];
  }> = [];

  override async extract(...args: Parameters<FakeModelProvider["extract"]>) {
    const chunks = args[0];
    const relatedChunks = args[1] ?? new Map<string, Chunk[]>();
    const options = args[2];
    this.calls.push({
      primaryVersionIds: chunks.map((chunk) => chunk.versionId),
      candidateVersionIds: [...relatedChunks.values()].flat().map((chunk) => chunk.versionId),
      aoriStage: options?.aoriContext?.stage,
      usedTokenEstimate: options?.aoriContext?.usedTokenEstimate,
      minTruncatedContextTokens: options?.aoriContext?.minTruncatedContextTokens,
      truncated: options?.aoriContext?.truncated,
      maxChunkTextLength: Math.max(0, ...chunks.map((chunk) => chunk.text.length)),
      chunkTexts: chunks.map((chunk) => chunk.text),
    });
    return { nodes: [], relations: [], themes: [] };
  }

  override async extractAoriDocument(...args: Parameters<FakeModelProvider["extractAoriDocument"]>) {
    const input = args[0];
    this.calls.push({
      primaryVersionIds: input.chunks.map((chunk) => chunk.versionId),
      candidateVersionIds: [],
      aoriStage: input.context.stage,
      usedTokenEstimate: input.context.usedTokenEstimate,
      minTruncatedContextTokens: input.context.minTruncatedContextTokens,
      truncated: input.context.truncated,
      maxChunkTextLength: Math.max(0, ...input.chunks.map((chunk) => chunk.text.length)),
      chunkTexts: input.chunks.map((chunk) => chunk.text),
    });
    return super.extractAoriDocument(...args);
  }
}

function enqueueAndComplete(queue: IngestionQueue, jobId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const listener = (update: { id: string; stage: string; error?: string | null }) => {
      if (update.id !== jobId) return;
      if (update.stage === "completed") {
        queue.off("job", listener);
        resolve();
      }
      if (update.stage === "failed") {
        queue.off("job", listener);
        reject(new Error(update.error ?? "failed"));
      }
    };
    queue.on("job", listener);
    queue.enqueue(jobId);
  });
}
