import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { IngestionQueue } from "../src/services/ingestion.js";
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
    const queue = new IngestionQueue(db, vectors, new FakeModelProvider(), config);
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
    db.close();
  });
});
