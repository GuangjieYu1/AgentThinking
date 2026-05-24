import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createLibrarySchema,
  createRelationSchema,
  modelStreamSchema,
  relationStatuses,
  relationTypes,
  searchSchema,
  updateAbstractNodeSchema,
  updateLibrarySettingsSchema,
  updateRelationSchema,
  type RelationStatus,
  type RelationType,
} from "@agent-thinking/contracts";
import type { AppConfig } from "./config.js";
import { hasConfiguredModels } from "./config.js";
import { AgentDatabase } from "./db.js";
import { contentHash, mediaTypeFor, safeFileName, validateFileName } from "./domain/files.js";
import type { ModelProvider } from "./services/models.js";
import { IngestionQueue } from "./services/ingestion.js";
import { VectorStore } from "./services/vector-store.js";

export interface AppServices {
  config: AppConfig;
  db: AgentDatabase;
  vectors: VectorStore;
  model: ModelProvider;
  queue: IngestionQueue;
}

function requireLibrary(db: AgentDatabase, id: string): void {
  if (!db.getLibrary(id)) throw new Error("知识库不存在");
}

export async function createApp(services: AppServices): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });
  const { config, db, vectors, model, queue } = services;
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { files: 100, fileSize: 60 * 1024 * 1024 } });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "请求处理失败";
    const statusCode = message.includes("不存在") ? 404 : 400;
    void reply.status(statusCode).send({ error: message });
  });

  app.get("/api/health", async () => ({
    ok: true,
    provider: model.name,
    aiConfigured: hasConfiguredModels(config),
    vectorEngine: vectors.usesSqliteVec ? "sqlite-vec" : "javascript-fallback",
  }));

  app.post("/api/model/test", async () => {
    try {
      return await model.test();
    } catch (error) {
      return {
        ok: false,
        provider: model.name,
        message: error instanceof Error ? error.message : "模型连接测试失败",
      };
    }
  });
  app.post("/api/model/stream", async (request, reply) => {
    const { prompt } = modelStreamSchema.parse(request.body);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: "start", provider: model.name });
    try {
      for await (const delta of model.stream(prompt)) send(delta);
      send({ type: "done" });
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "模型流式请求失败",
      });
    } finally {
      reply.raw.end();
    }
  });

  app.get("/api/libraries", async () => db.listLibraries());
  app.post("/api/libraries", async (request, reply) => {
    const body = createLibrarySchema.parse(request.body);
    return reply.status(201).send(db.createLibrary(body.name));
  });
  app.delete<{ Params: { libraryId: string } }>("/api/libraries/:libraryId", async (request, reply) => {
    if (!db.deleteLibrary(request.params.libraryId)) return reply.status(404).send({ error: "知识库不存在" });
    await rm(join(config.filesDir, request.params.libraryId), { recursive: true, force: true });
    return reply.status(204).send();
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/settings", async (request) => {
    return db.getSettings(request.params.libraryId);
  });
  app.patch<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/settings", async (request) => {
    const settings = updateLibrarySettingsSchema.parse(request.body);
    if (settings.ocrMode === "cloud" && !config.visionModel) {
      throw new Error("云端 OCR 需要在服务端配置 AI_VISION_MODEL");
    }
    return db.updateSettings(request.params.libraryId, settings.ocrMode);
  });

  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/documents", async (request) => {
    requireLibrary(db, request.params.libraryId);
    return db.listDocuments(request.params.libraryId);
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/import", async (request, reply) => {
    const libraryId = request.params.libraryId;
    requireLibrary(db, libraryId);
    const imported: Array<{ fileName: string; duplicate: boolean; jobId?: string }> = [];
    for await (const part of request.files()) {
      validateFileName(part.filename);
      const buffer = await part.toBuffer();
      const hash = contentHash(buffer);
      const storagePath = join(config.filesDir, libraryId, hash, safeFileName(part.filename));
      const { version, duplicate } = db.createDocumentVersion(
        libraryId,
        part.filename,
        mediaTypeFor(part.filename),
        hash,
        storagePath,
      );
      if (duplicate) {
        imported.push({ fileName: part.filename, duplicate: true });
        continue;
      }
      await mkdir(dirname(storagePath), { recursive: true });
      await writeFile(storagePath, buffer);
      const job = db.createJob(libraryId, version.id);
      queue.enqueue(job.id);
      imported.push({ fileName: part.filename, duplicate: false, jobId: job.id });
    }
    if (imported.length === 0) throw new Error("请选择至少一个文件");
    return reply.status(202).send(imported);
  });

  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/jobs", async (request) => {
    requireLibrary(db, request.params.libraryId);
    return db.listJobs(request.params.libraryId);
  });
  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/retry", async (request) => {
    return queue.retry(request.params.jobId);
  });
  app.delete<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const deleted = db.deleteFailedJob(request.params.jobId);
    if (!deleted) return reply.status(404).send({ error: "处理任务不存在" });
    await rm(deleted.storagePath, { force: true });
    return reply.status(204).send();
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/events", async (request, reply) => {
    const { libraryId } = request.params;
    requireLibrary(db, libraryId);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    const listener = (job: { libraryId: string }) => {
      if (job.libraryId === libraryId) send(job);
    };
    queue.on("job", listener);
    send({ type: "connected" });
    const heartbeat = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      queue.off("job", listener);
    });
  });

  app.get<{
    Params: { libraryId: string };
    Querystring: { centerId?: string; includeChunks?: string; status?: string; type?: string; limit?: string };
  }>("/api/libraries/:libraryId/graph", async (request) => {
    requireLibrary(db, request.params.libraryId);
    const status = relationStatuses.includes(request.query.status as RelationStatus)
      ? request.query.status as RelationStatus
      : undefined;
    const type = relationTypes.includes(request.query.type as RelationType)
      ? request.query.type as RelationType
      : undefined;
    return db.getGraph(request.params.libraryId, {
      ...(request.query.centerId ? { centerId: request.query.centerId } : {}),
      includeChunks: request.query.includeChunks === "true",
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      limit: Number(request.query.limit ?? 150),
    });
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/search", async (request) => {
    const { query, limit } = searchSchema.parse(request.body);
    requireLibrary(db, request.params.libraryId);
    if (!model.configured) throw new Error("语义搜索需要配置模型服务");
    const [embedding] = await model.embed([query]);
    return vectors.search(request.params.libraryId, embedding ?? [], limit);
  });

  app.patch<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request) => {
    const body = updateAbstractNodeSchema.parse(request.body);
    return db.updateAbstractNode(request.params.nodeId, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
    });
  });
  app.delete<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request, reply) => {
    if (!db.deleteAbstractNode(request.params.nodeId)) return reply.status(404).send({ error: "抽象节点不存在" });
    return reply.status(204).send();
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/relations", async (request, reply) => {
    const body = createRelationSchema.parse(request.body);
    requireLibrary(db, request.params.libraryId);
    return reply.status(201).send(db.createRelation(request.params.libraryId, body));
  });
  app.patch<{ Params: { relationId: string } }>("/api/relations/:relationId", async (request) => {
    const { status } = updateRelationSchema.parse(request.body);
    return db.updateRelationStatus(request.params.relationId, status);
  });
  app.delete<{ Params: { relationId: string } }>("/api/relations/:relationId", async (request, reply) => {
    if (!db.deleteRelation(request.params.relationId)) return reply.status(404).send({ error: "关系不存在" });
    return reply.status(204).send();
  });

  const webDist = resolve(import.meta.dirname, "../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.status(404).send({ error: "接口不存在" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
