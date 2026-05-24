import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { IngestionQueue } from "../src/services/ingestion.js";
import { FakeModelProvider } from "../src/services/models.js";
import { VectorStore } from "../src/services/vector-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("HTTP application", () => {
  it("imports a document through the API without disclosing server credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-thinking-api-"));
    dirs.push(dir);
    const config = getConfig({
      dataDir: dir,
      filesDir: join(dir, "files"),
      ocrCacheDir: join(dir, "ocr"),
      provider: "fake",
      aiApiKey: "never-return-this-key",
    });
    const db = new AgentDatabase(dir);
    const vectors = new VectorStore(db);
    const model = new FakeModelProvider();
    const queue = new IngestionQueue(db, vectors, model, config);
    const app = await createApp({ config, db, vectors, model, queue });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.body).not.toContain("never-return-this-key");
    const tested = await app.inject({ method: "POST", url: "/api/model/test", payload: {} });
    expect(tested.json<{ ok: boolean }>().ok).toBe(true);
    const streamed = await app.inject({
      method: "POST",
      url: "/api/model/stream",
      payload: { prompt: "展示流式输出" },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain('"type":"start"');
    expect(streamed.body).toContain('"type":"content"');
    expect(streamed.body).toContain('"type":"done"');
    const libraryResponse = await app.inject({
      method: "POST",
      url: "/api/libraries",
      payload: { name: "API Demo" },
    });
    const library = libraryResponse.json<{ id: string }>();
    const boundary = "----agent-thinking-test-boundary";
    const documentBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="notes.md"',
      "Content-Type: text/markdown",
      "",
      "# First\nA useful concept.\n\n# Second\nTherefore this claim follows.",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const imported = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/import`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: documentBody,
    });
    expect(imported.statusCode).toBe(202);

    let stage = "queued";
    for (let attempt = 0; attempt < 30 && stage !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const jobs = (await app.inject({
        method: "GET",
        url: `/api/libraries/${library.id}/jobs`,
      })).json<Array<{ stage: string }>>();
      stage = jobs[0]?.stage ?? "";
    }
    expect(stage).toBe("completed");
    const graph = (await app.inject({
      method: "GET",
      url: `/api/libraries/${library.id}/graph?includeChunks=true`,
    })).json<{ nodes: unknown[]; edges: unknown[] }>();
    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(graph.edges.length).toBeGreaterThan(0);
    const abstractId = (graph.nodes as Array<{ id: string; nodeType: string }>).find((node) => node.nodeType === "abstract")!.id;
    const deletedNode = await app.inject({ method: "DELETE", url: `/api/nodes/${abstractId}` });
    expect(deletedNode.statusCode).toBe(204);
    await app.close();
    db.close();
  });
});
