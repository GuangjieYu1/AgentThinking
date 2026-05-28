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
      "---\ntitle: Research Notes\n---\n# First\nA useful concept with a [source](paper.pdf) and [[Second]]. ^first\n\n# Second\nTherefore this claim follows. ((claim-ref))",
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
    const documents = (await app.inject({
      method: "GET",
      url: `/api/libraries/${library.id}/documents`,
    })).json<Array<{ latestVersion: { id: string } }>>();
    const versionId = documents[0]!.latestVersion.id;
    const structure = (await app.inject({
      method: "GET",
      url: `/api/versions/${versionId}/structure`,
    })).json<{ metadata: { title: string }; links: Array<{ type: string }>; chunks: Array<{ startLine: number }> }>();
    expect(structure.metadata.title).toBe("Research Notes");
    expect(structure.links.map((link) => link.type)).toEqual(["markdown", "wiki", "block", "logseq"]);
    expect(structure.chunks[0]?.startLine).toBe(5);
    const original = await app.inject({ method: "GET", url: `/api/versions/${versionId}/source` });
    expect(original.body).toContain("title: Research Notes");
    const graph = (await app.inject({
      method: "GET",
      url: `/api/libraries/${library.id}/graph?includeChunks=true`,
    })).json<{ nodes: Array<{ id: string; nodeType: string; data: { citations?: unknown[] } }>; edges: Array<{ relation?: { id: string; citations: unknown[] } }> }>();
    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes.find((node) => node.nodeType === "abstract")?.data.citations?.length).toBeGreaterThan(0);
    const suggested = graph.edges.find((edge) => edge.relation)?.relation;
    expect(suggested?.citations.length).toBeGreaterThan(0);
    const overview = (await app.inject({
      method: "GET",
      url: `/api/libraries/${library.id}/graph?view=overview`,
    })).json<{ nodes: Array<{ nodeType: string; data: { level?: number; memberCount?: number } }> }>();
    expect(overview.nodes.some((node) => node.nodeType === "abstract" && node.data.level === 2 && (node.data.memberCount ?? 0) > 0)).toBe(true);
    const aspectGraph = (await app.inject({
      method: "GET",
      url: `/api/libraries/${library.id}/graph?aspect=claim`,
    })).json<{ nodes: Array<{ id: string; nodeType: string; focusRole?: string; data: { aspects?: string[] } }> }>();
    const claimNode = aspectGraph.nodes.find((node) => node.nodeType === "abstract" && node.focusRole === "match");
    expect(claimNode?.data.aspects).toContain("claim");
    const manuallyTagged = await app.inject({
      method: "PATCH",
      url: `/api/nodes/${claimNode!.id}/aspects`,
      payload: { aspects: ["system"] },
    });
    expect(manuallyTagged.body).toContain('"aspectSource":"manual"');
    const resetTag = await app.inject({ method: "DELETE", url: `/api/nodes/${claimNode!.id}/aspects` });
    expect(resetTag.body).toContain('"aspectSource":"ai"');
    const createdPulse = (await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/pulses`,
      payload: { question: "claim follows" },
    })).json<{
      pulse: { id: string; status: string; answer: string };
      hits: Array<{ targetType: string; pathRole: string }>;
      graph: { nodes: Array<{ pulseRole?: string; pulseStats?: { correctCount: number; wrongCount: number } }> };
    }>();
    expect(createdPulse.pulse.status).toBe("unreviewed");
    expect(createdPulse.pulse.answer).toContain("演示脉冲回答");
    expect(createdPulse.hits.some((hit) => hit.targetType === "node" && hit.pathRole === "direct")).toBe(true);
    expect(createdPulse.graph.nodes.some((node) => node.pulseRole === "direct")).toBe(true);
    const listedPulses = (await app.inject({ method: "GET", url: `/api/libraries/${library.id}/pulses` }))
      .json<Array<{ id: string }>>();
    expect(listedPulses[0]?.id).toBe(createdPulse.pulse.id);
    const streamedPulse = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/pulses/stream`,
      payload: { question: "claim follows", mode: "full" },
    });
    expect(streamedPulse.statusCode).toBe(200);
    expect(streamedPulse.body).toContain('"type":"start"');
    expect(streamedPulse.body).toContain('"type":"stage"');
    expect(streamedPulse.body).toContain('"type":"hit"');
    expect(streamedPulse.body).toContain('"type":"answer"');
    expect(streamedPulse.body).toContain('"type":"done"');
    expect(streamedPulse.body).toContain('"response"');
    const markedWrong = (await app.inject({
      method: "PATCH",
      url: `/api/pulses/${createdPulse.pulse.id}/review`,
      payload: { status: "wrong" },
    })).json<{ pulse: { status: string }; graph: { nodes: Array<{ pulseStats?: { correctCount: number; wrongCount: number } }> } }>();
    expect(markedWrong.pulse.status).toBe("wrong");
    expect(markedWrong.graph.nodes.some((node) => (node.pulseStats?.wrongCount ?? 0) > 0)).toBe(true);
    const markedCorrect = (await app.inject({
      method: "PATCH",
      url: `/api/pulses/${createdPulse.pulse.id}/review`,
      payload: { status: "correct" },
    })).json<{ pulse: { status: string }; graph: { nodes: Array<{ pulseStats?: { correctCount: number; wrongCount: number } }> } }>();
    expect(markedCorrect.pulse.status).toBe("correct");
    expect(markedCorrect.graph.nodes.some((node) => (node.pulseStats?.correctCount ?? 0) > 0)).toBe(true);
    expect(markedCorrect.graph.nodes.every((node) => (node.pulseStats?.wrongCount ?? 0) === 0)).toBe(true);
    await app.inject({
      method: "PATCH",
      url: `/api/relations/${suggested!.id}`,
      payload: { status: "accepted" },
    });
    const blockedPublish = await app.inject({ method: "POST", url: `/api/libraries/${library.id}/analysis/publish` });
    expect(blockedPublish.statusCode).toBe(409);
    const draft = (await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/analysis/draft`,
    })).json<{ statements: Array<{ id: string; citations: unknown[] }> }>();
    expect(draft.statements[0]?.citations.length).toBeGreaterThan(0);
    const checked = await app.inject({
      method: "POST",
      url: `/api/analysis/statements/${draft.statements[0]!.id}/precheck`,
    });
    expect(checked.body).toContain("supported");
    await app.inject({
      method: "PATCH",
      url: `/api/analysis/statements/${draft.statements[0]!.id}`,
      payload: { status: "approved" },
    });
    const published = await app.inject({ method: "POST", url: `/api/libraries/${library.id}/analysis/publish` });
    expect(published.statusCode).toBe(201);
    expect(published.body).toContain("已审核关系");
    expect(published.body).toContain("notes.md - 第 5-5 行");
    const downloaded = await app.inject({ method: "GET", url: `/api/libraries/${library.id}/analysis/download` });
    expect(downloaded.body).toContain("report_format");
    const archive = await app.inject({ method: "GET", url: `/api/libraries/${library.id}/export` });
    expect(archive.statusCode).toBe(200);
    expect(archive.rawPayload.includes(Buffer.from("analysis.md"))).toBe(true);
    expect(archive.rawPayload.includes(Buffer.from("notes.md"))).toBe(true);
    const reanalyze = await app.inject({ method: "POST", url: `/api/versions/${versionId}/reanalyze` });
    expect(reanalyze.statusCode).toBe(202);
    let reanalyzeStage = "queued";
    for (let attempt = 0; attempt < 30 && reanalyzeStage !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      reanalyzeStage = (await app.inject({
        method: "GET",
        url: `/api/libraries/${library.id}/jobs`,
      })).json<Array<{ stage: string }>>()[0]?.stage ?? "";
    }
    expect(reanalyzeStage).toBe("completed");
    expect((await app.inject({ method: "GET", url: `/api/libraries/${library.id}/analysis` })).statusCode).toBe(200);
    const refreshedGraph = (await app.inject({
      method: "GET",
      url: `/api/libraries/${library.id}/graph`,
    })).json<{ nodes: Array<{ id: string; nodeType: string }> }>();
    const abstractId = refreshedGraph.nodes.find((node) => node.nodeType === "abstract")!.id;
    const deletedNode = await app.inject({ method: "DELETE", url: `/api/nodes/${abstractId}` });
    expect(deletedNode.statusCode).toBe(204);
    await app.close();
    db.close();
  });
});
