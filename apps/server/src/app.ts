import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  createLibrarySchema,
  createPulseSchema,
  createRelationSchema,
  addGraphEvidenceSchema,
  addStatementEvidenceSchema,
  aspectKinds,
  evidenceQuerySchema,
  loginSchema,
  modelStreamSchema,
  relationStatuses,
  relationTypes,
  registerSchema,
  reviewPulseSchema,
  searchSchema,
  updateAbstractNodeSchema,
  updateMappingAuditFindingCommentSchema,
  updateNodeAspectsSchema,
  updateLibrarySettingsSchema,
  updateAnalysisStatementSchema,
  updateRelationSchema,
  type AuthUser,
  type RelationStatus,
  type RelationType,
  type AspectKind,
  type PulseStreamEvent,
  type SearchResult,
} from "@agent-thinking/contracts";
import type { AppConfig } from "./config.js";
import { hasConfiguredModels, hasConfiguredOcr } from "./config.js";
import { AgentDatabase } from "./db.js";
import { contentHash, mediaTypeFor, safeFileName, validateFileName } from "./domain/files.js";
import type { ModelProvider } from "./services/models.js";
import { IngestionQueue } from "./services/ingestion.js";
import { VectorStore } from "./services/vector-store.js";
import { AnalysisPublisher } from "./services/analysis.js";
import { LibraryEventBus } from "./services/library-events.js";
import { MappingAuditService } from "./services/mapping-audit.js";
import { PulseEngine } from "./services/pulse.js";

export interface AppServices {
  config: AppConfig;
  db: AgentDatabase;
  vectors: VectorStore;
  model: ModelProvider;
  queue: IngestionQueue;
  events?: LibraryEventBus;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const sessionCookieName = "agent_session";

function mergeSearchResults(limit: number, ...groups: SearchResult[][]): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const result of groups.flat()) {
    const existing = merged.get(result.chunk.id);
    if (!existing || result.score > existing.score) merged.set(result.chunk.id, result);
  }
  return [...merged.values()]
    .sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal)
    .slice(0, limit);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [];
    return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}

function sessionTokenFrom(request: { headers: { cookie?: string | undefined } }): string | undefined {
  return parseCookies(request.headers.cookie)[sessionCookieName];
}

function sessionCookie(token: string, config: AppConfig): string {
  const maxAge = Math.max(1, config.sessionDays) * 24 * 60 * 60;
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(config.secureCookies ? ["Secure"] : []),
  ].join("; ");
}

function clearSessionCookie(config: AppConfig): string {
  return [
    `${sessionCookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(config.secureCookies ? ["Secure"] : []),
  ].join("; ");
}

function requireLibrary(db: AgentDatabase, id: string, user?: AuthUser): void {
  if (!db.getLibrary(id)) throw new Error("知识库不存在");
  if (user && db.getLibraryOwnerUserId(id) !== user.id) throw new Error("知识库不存在");
}

function requireLibraryAccess(db: AgentDatabase, libraryId: string | undefined, user?: AuthUser): string {
  if (!libraryId) throw new Error("知识库不存在");
  requireLibrary(db, libraryId, user);
  return libraryId;
}

function isPublicApi(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  if (path === "/api/health" || path === "/api/auth/session") return true;
  if (method === "POST" && ["/api/auth/register", "/api/auth/login", "/api/auth/logout"].includes(path)) return true;
  return false;
}

export async function createApp(services: AppServices): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });
  const { config, db, vectors, model, queue } = services;
  const events = services.events ?? new LibraryEventBus();
  const publisher = new AnalysisPublisher(db, config);
  const pulseEngine = new PulseEngine(db, vectors, model);
  const mappingAudit = new MappingAuditService(db, model, events);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { files: 100, fileSize: 60 * 1024 * 1024 } });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "请求处理失败";
    const statusCode = message.includes("请先登录")
      ? 401
      : message.includes("注册密钥")
        ? 403
        : message.includes("不存在")
          ? 404
          : message.includes("仍有待审核")
            ? 409
            : 400;
    void reply.status(statusCode).send({ error: message });
  });

  app.addHook("preHandler", async (request, reply) => {
    const user = db.getUserForSession(sessionTokenFrom(request));
    if (user) request.user = user;
    if (!config.authRequired || isPublicApi(request.method, request.url) || !request.url.startsWith("/api/")) return;
    if (!user) return reply.status(401).send({ error: "请先登录" });
  });

  app.get("/api/health", async () => ({
    ok: true,
    provider: model.name,
    aiConfigured: hasConfiguredModels(config),
    ocrProvider: config.ocrProvider,
    ocrConfigured: hasConfiguredOcr(config),
    vectorEngine: vectors.usesSqliteVec ? "sqlite-vec" : "javascript-fallback",
    authRequired: config.authRequired,
  }));

  app.get("/api/auth/session", async (request) => ({
    authRequired: config.authRequired,
    user: request.user ?? null,
  }));
  app.post("/api/auth/register", async (request, reply) => {
    if (!config.authRequired) throw new Error("当前未启用注册");
    const body = registerSchema.parse(request.body);
    if (!config.registrationKeys.includes(body.registrationKey)) throw new Error("注册密钥无效");
    const user = db.createUser(body.username, body.password);
    const token = db.createSession(user.id, config.sessionDays);
    reply.header("Set-Cookie", sessionCookie(token, config));
    return reply.status(201).send({ authRequired: true, user });
  });
  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = db.verifyUser(body.username, body.password);
    if (!user) throw new Error("用户名或密码错误");
    const token = db.createSession(user.id, config.sessionDays);
    reply.header("Set-Cookie", sessionCookie(token, config));
    return { authRequired: config.authRequired, user };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    db.deleteSession(sessionTokenFrom(request));
    reply.header("Set-Cookie", clearSessionCookie(config));
    return { authRequired: config.authRequired, user: null };
  });

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

  app.get("/api/libraries", async (request) => db.listLibraries(request.user?.id));
  app.post("/api/libraries", async (request, reply) => {
    const body = createLibrarySchema.parse(request.body);
    return reply.status(201).send(db.createLibrary(body.name, request.user?.id));
  });
  app.delete<{ Params: { libraryId: string } }>("/api/libraries/:libraryId", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    if (!db.deleteLibrary(request.params.libraryId)) return reply.status(404).send({ error: "知识库不存在" });
    await rm(join(config.filesDir, request.params.libraryId), { recursive: true, force: true });
    return reply.status(204).send();
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/settings", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return db.getSettings(request.params.libraryId);
  });
  app.patch<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/settings", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    const settings = updateLibrarySettingsSchema.parse(request.body);
    if (settings.ocrMode === "cloud" && (config.ocrProvider !== "aliyun" || !hasConfiguredOcr(config))) {
      throw new Error("阿里云 OCR 需要配置 OCR_PROVIDER=aliyun 及 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET");
    }
    return db.updateSettings(request.params.libraryId, settings.ocrMode);
  });

  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/documents", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return db.listDocuments(request.params.libraryId);
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/import", async (request, reply) => {
    const libraryId = request.params.libraryId;
    requireLibrary(db, libraryId, request.user);
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
  app.get<{ Params: { versionId: string }; Querystring: { download?: string } }>(
    "/api/versions/:versionId/source",
    async (request, reply) => {
      const source = db.getVersionSource(request.params.versionId);
      if (!source) return reply.status(404).send({ error: "导入版本不存在" });
      requireLibrary(db, source.libraryId, request.user);
      const buffer = await readFile(source.version.storagePath);
      reply.type(source.mediaType);
      if (request.query.download === "true") {
        reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(source.documentName)}`);
      }
      return reply.send(buffer);
    },
  );
  app.get<{ Params: { versionId: string } }>("/api/versions/:versionId/structure", async (request) => {
    const source = db.getVersionSource(request.params.versionId);
    if (!source) throw new Error("导入版本不存在");
    requireLibrary(db, source.libraryId, request.user);
    return {
      ...db.getSourceStructure(request.params.versionId),
      documentTree: db.getDocumentTreeForVersion(request.params.versionId),
      summaryTree: db.getSummaryTreeForVersion(request.params.versionId),
    };
  });
  app.get<{ Params: { versionId: string } }>("/api/versions/:versionId/document-tree", async (request) => {
    const source = db.getVersionSource(request.params.versionId);
    if (!source) throw new Error("导入版本不存在");
    requireLibrary(db, source.libraryId, request.user);
    return db.getDocumentTreeForVersion(request.params.versionId);
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/document-tree", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return db.getDocumentTreeForLibrary(request.params.libraryId);
  });
  app.get<{ Params: { nodeId: string } }>("/api/document-tree/:nodeId/subtree", async (request) => {
    const nodes = db.getSectionSubtree(request.params.nodeId);
    requireLibraryAccess(db, nodes[0]?.libraryId, request.user);
    return nodes;
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/summary-tree", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return db.getSummaryTreeForLibrary(request.params.libraryId);
  });
  app.get<{ Params: { versionId: string } }>("/api/versions/:versionId/mapping-audit", async (request, reply) => {
    const source = db.getVersionSource(request.params.versionId);
    if (!source) return reply.status(404).send({ error: "导入版本不存在" });
    requireLibrary(db, source.libraryId, request.user);
    const audit = db.getMappingAudit(request.params.versionId);
    if (!audit) return reply.status(404).send({ error: "尚未运行映射审计" });
    return audit;
  });
  app.post<{ Params: { versionId: string } }>("/api/versions/:versionId/mapping-audit", async (request, reply) => {
    const source = db.getVersionSource(request.params.versionId);
    if (!source) return reply.status(404).send({ error: "导入版本不存在" });
    requireLibrary(db, source.libraryId, request.user);
    if (source.version.status !== "completed") return reply.status(409).send({ error: "文档尚未完成分析，无法运行映射审计" });
    if (!model.configured) return reply.status(400).send({ error: "映射审计需要配置模型服务" });
    return mappingAudit.run(request.params.versionId);
  });
  app.patch<{ Params: { versionId: string; findingIndex: string } }>(
    "/api/versions/:versionId/mapping-audit/findings/:findingIndex/comment",
    async (request, reply) => {
      const source = db.getVersionSource(request.params.versionId);
      if (!source) return reply.status(404).send({ error: "导入版本不存在" });
      requireLibrary(db, source.libraryId, request.user);
      const body = updateMappingAuditFindingCommentSchema.parse(request.body);
      return db.updateMappingAuditFindingComment(request.params.versionId, Number(request.params.findingIndex), body.userComment);
    },
  );
  const rebuildGraphFromAudit = async (
    request: FastifyRequest<{ Params: { versionId: string } }>,
    reply: FastifyReply,
  ) => {
    const source = db.getVersionSource(request.params.versionId);
    if (!source) return reply.status(404).send({ error: "导入版本不存在" });
    requireLibrary(db, source.libraryId, request.user);
    if (source.version.status !== "completed") return reply.status(409).send({ error: "文档尚未完成分析，无法重构关系图谱" });
    if (!db.getMappingAudit(request.params.versionId)) return reply.status(404).send({ error: "尚未运行映射审计" });
    if (!model.configured) return reply.status(400).send({ error: "审计驱动图谱重构需要配置模型服务" });
    return mappingAudit.rebuildGraph(request.params.versionId);
  };
  app.post<{ Params: { versionId: string } }>("/api/versions/:versionId/mapping-audit/rebuild-graph", rebuildGraphFromAudit);
  app.post<{ Params: { versionId: string } }>("/api/versions/:versionId/mapping-audit/reanalysis", rebuildGraphFromAudit);
  app.post<{ Params: { versionId: string } }>("/api/versions/:versionId/reanalyze", async (request, reply) => {
    const source = db.getVersionSource(request.params.versionId);
    if (!source) return reply.status(404).send({ error: "导入版本不存在" });
    requireLibrary(db, source.libraryId, request.user);
    db.updateVersionStatus(source.version.id, "queued");
    const job = db.createJob(source.libraryId, source.version.id);
    queue.enqueue(job.id);
    return reply.status(202).send(job);
  });

  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/jobs", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return db.listJobs(request.params.libraryId);
  });
  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/retry", async (request) => {
    const job = db.getJob(request.params.jobId);
    requireLibraryAccess(db, job?.libraryId, request.user);
    return queue.retry(request.params.jobId);
  });
  app.delete<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const job = db.getJob(request.params.jobId);
    requireLibraryAccess(db, job?.libraryId, request.user);
    const deleted = db.deleteFailedJob(request.params.jobId);
    if (!deleted) return reply.status(404).send({ error: "处理任务不存在" });
    await rm(deleted.storagePath, { force: true });
    return reply.status(204).send();
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/events", async (request, reply) => {
    const { libraryId } = request.params;
    requireLibrary(db, libraryId, request.user);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    const listener = (event: { libraryId?: string; job?: { libraryId: string } }) => {
      const eventLibraryId = "job" in event && event.job ? event.job.libraryId : event.libraryId;
      if (eventLibraryId === libraryId) send(event);
    };
    const unsubscribe = services.events
      ? events.subscribe(listener as (event: import("@agent-thinking/contracts").LibraryStreamEvent) => void)
      : (() => {
          queue.on("job", listener as (job: { libraryId: string }) => void);
          return () => queue.off("job", listener as (job: { libraryId: string }) => void);
        })();
    send({ type: "connected" });
    const heartbeat = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get<{
    Params: { libraryId: string };
    Querystring: {
      centerId?: string;
      includeChunks?: string;
      status?: string;
      type?: string;
      limit?: string;
      view?: string;
      aspect?: string;
      pulseId?: string;
      pulseStats?: string;
    };
  }>("/api/libraries/:libraryId/graph", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    const status = relationStatuses.includes(request.query.status as RelationStatus)
      ? request.query.status as RelationStatus
      : undefined;
    const type = relationTypes.includes(request.query.type as RelationType)
      ? request.query.type as RelationType
      : undefined;
    const aspect = aspectKinds.includes(request.query.aspect as AspectKind)
      ? request.query.aspect as AspectKind
      : undefined;
    return db.getGraph(request.params.libraryId, {
      ...(request.query.centerId ? { centerId: request.query.centerId } : {}),
      includeChunks: request.query.includeChunks === "true",
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      limit: Number(request.query.limit ?? 150),
      view: request.query.view === "overview" ? "overview" : "detail",
      ...(aspect ? { aspect } : {}),
      ...(request.query.pulseId ? { pulseId: request.query.pulseId } : {}),
      pulseStats: request.query.pulseStats === "true",
    });
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/search", async (request) => {
    const { query, limit } = searchSchema.parse(request.body);
    requireLibrary(db, request.params.libraryId, request.user);
    const fuzzy = db.searchChunksFuzzy(request.params.libraryId, query, limit);
    const fullText = db.searchText(request.params.libraryId, query, limit);
    if (!model.configured) return mergeSearchResults(limit, fuzzy, fullText);
    try {
      const [embedding] = await model.embed([query]);
      const semantic = embedding ? vectors.search(request.params.libraryId, embedding, limit) : [];
      return mergeSearchResults(limit, fuzzy, fullText, semantic);
    } catch (cause) {
      request.log.warn({ err: cause }, "semantic search failed; returning fuzzy chunk matches");
      return mergeSearchResults(limit, fuzzy, fullText);
    }
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/pulses", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    const { question, mode } = createPulseSchema.parse(request.body);
    return reply.status(201).send(await pulseEngine.create(request.params.libraryId, question, mode));
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/pulses/stream", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    const { question, mode } = createPulseSchema.parse(request.body);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: PulseStreamEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await pulseEngine.create(request.params.libraryId, question, mode, send);
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "脉冲流式请求失败",
      });
    } finally {
      reply.raw.end();
    }
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/pulses", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return db.listPulses(request.params.libraryId);
  });
  app.delete<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/pulses", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return { deleted: db.clearPulses(request.params.libraryId) };
  });
  app.get<{ Params: { libraryId: string; pulseId: string } }>("/api/libraries/:libraryId/pulses/:pulseId", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    const response = db.getPulseResponse(request.params.libraryId, request.params.pulseId);
    if (!response) return reply.status(404).send({ error: "脉冲不存在" });
    return response;
  });
  app.get<{ Params: { libraryId: string; pulseId: string } }>("/api/libraries/:libraryId/pulses/:pulseId/evidence-pack", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    const pulse = db.getPulse(request.params.pulseId);
    if (!pulse || pulse.libraryId !== request.params.libraryId) return reply.status(404).send({ error: "脉冲不存在" });
    return db.getPulseEvidencePack(request.params.pulseId) ?? { error: "该脉冲没有证据包" };
  });
  app.patch<{ Params: { pulseId: string } }>("/api/pulses/:pulseId/review", async (request, reply) => {
    const { status } = reviewPulseSchema.parse(request.body);
    const existing = db.getPulse(request.params.pulseId);
    requireLibraryAccess(db, existing?.libraryId, request.user);
    const pulse = db.reviewPulse(request.params.pulseId, status);
    const response = db.getPulseResponse(pulse.libraryId, pulse.id);
    if (!response) return reply.status(404).send({ error: "脉冲不存在" });
    return reply.send(response);
  });

  app.patch<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForNode(request.params.nodeId), request.user);
    const body = updateAbstractNodeSchema.parse(request.body);
    return db.updateAbstractNode(request.params.nodeId, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
    });
  });
  app.get<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/evidence-detail", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForNode(request.params.nodeId), request.user);
    const node = db.getAbstractNode(request.params.nodeId);
    if (!node) throw new Error("抽象节点不存在");
    const chunkIds = node.citations.map((citation) => citation.chunkId);
    const parentChunks = db.getParentChildChunks(chunkIds);
    const treeNodes = db.getDocumentTreeNodesByIds([
      ...(node.evidenceNodeIds ?? []),
      ...parentChunks.map((link) => link.documentTreeNodeId),
    ]);
    const relations = db.getIncidentRelations(node.libraryId, [node.id]);
    return { node, relations, treeNodes, parentChunks };
  });
  app.post<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/evidence", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForNode(request.params.nodeId), request.user);
    const body = addGraphEvidenceSchema.parse(request.body);
    requireLibraryAccess(db, db.getLibraryIdForChunk(body.chunkId), request.user);
    return db.addNodeEvidence(request.params.nodeId, body.chunkId);
  });
  app.delete<{ Params: { nodeId: string; chunkId: string } }>("/api/nodes/:nodeId/evidence/:chunkId", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForNode(request.params.nodeId), request.user);
    return db.removeNodeEvidence(request.params.nodeId, request.params.chunkId);
  });
  app.patch<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/aspects", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForNode(request.params.nodeId), request.user);
    const body = updateNodeAspectsSchema.parse(request.body);
    return db.updateNodeAspects(request.params.nodeId, body.aspects);
  });
  app.delete<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/aspects", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForNode(request.params.nodeId), request.user);
    return db.resetNodeAspects(request.params.nodeId);
  });
  app.delete<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request, reply) => {
    requireLibraryAccess(db, db.getLibraryIdForNode(request.params.nodeId), request.user);
    if (!db.deleteAbstractNode(request.params.nodeId)) return reply.status(404).send({ error: "抽象节点不存在" });
    return reply.status(204).send();
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/relations", async (request, reply) => {
    const body = createRelationSchema.parse(request.body);
    requireLibrary(db, request.params.libraryId, request.user);
    return reply.status(201).send(db.createRelation(request.params.libraryId, body));
  });
  app.patch<{ Params: { relationId: string } }>("/api/relations/:relationId", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForRelation(request.params.relationId), request.user);
    const body = updateRelationSchema.parse(request.body);
    return db.updateRelation(request.params.relationId, {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
    });
  });
  app.post<{ Params: { relationId: string } }>("/api/relations/:relationId/evidence", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForRelation(request.params.relationId), request.user);
    const body = addGraphEvidenceSchema.parse(request.body);
    requireLibraryAccess(db, db.getLibraryIdForChunk(body.chunkId), request.user);
    return db.addRelationEvidence(request.params.relationId, body.chunkId);
  });
  app.delete<{ Params: { relationId: string; chunkId: string } }>(
    "/api/relations/:relationId/evidence/:chunkId",
    async (request) => {
      requireLibraryAccess(db, db.getLibraryIdForRelation(request.params.relationId), request.user);
      return db.removeRelationEvidence(request.params.relationId, request.params.chunkId);
    },
  );
  app.get<{ Params: { relationId: string } }>("/api/relations/:relationId", async (request, reply) => {
    requireLibraryAccess(db, db.getLibraryIdForRelation(request.params.relationId), request.user);
    const relation = db.getRelation(request.params.relationId);
    if (!relation) return reply.status(404).send({ error: "关系不存在" });
    return relation;
  });
  app.delete<{ Params: { relationId: string } }>("/api/relations/:relationId", async (request, reply) => {
    requireLibraryAccess(db, db.getLibraryIdForRelation(request.params.relationId), request.user);
    if (!db.deleteRelation(request.params.relationId)) return reply.status(404).send({ error: "关系不存在" });
    return reply.status(204).send();
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/analysis/draft", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return db.generateAnalysisDraft(request.params.libraryId);
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/analysis/draft", async (request) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return db.getAnalysisDraft(request.params.libraryId);
  });
  app.get<{ Params: { libraryId: string }; Querystring: { q?: string; versionId?: string; limit?: string } }>(
    "/api/libraries/:libraryId/evidence",
    async (request) => {
      requireLibrary(db, request.params.libraryId, request.user);
      const query = evidenceQuerySchema.parse(request.query);
      return db.listEvidenceChunks(request.params.libraryId, query.q, query.versionId, query.limit);
    },
  );
  app.patch<{ Params: { statementId: string } }>("/api/analysis/statements/:statementId", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForStatement(request.params.statementId), request.user);
    const body = updateAnalysisStatementSchema.parse(request.body);
    return db.updateAnalysisStatement(request.params.statementId, {
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
  });
  app.post<{ Params: { statementId: string } }>("/api/analysis/statements/:statementId/evidence", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForStatement(request.params.statementId), request.user);
    const body = addStatementEvidenceSchema.parse(request.body);
    requireLibraryAccess(db, db.getLibraryIdForChunk(body.chunkId), request.user);
    return db.addStatementEvidence(request.params.statementId, body.chunkId);
  });
  app.delete<{ Params: { statementId: string; chunkId: string } }>(
    "/api/analysis/statements/:statementId/evidence/:chunkId",
    async (request) => {
      requireLibraryAccess(db, db.getLibraryIdForStatement(request.params.statementId), request.user);
      requireLibraryAccess(db, db.getLibraryIdForChunk(request.params.chunkId), request.user);
      return db.deleteStatementEvidence(request.params.statementId, request.params.chunkId);
    },
  );
  app.post<{ Params: { statementId: string } }>("/api/analysis/statements/:statementId/precheck", async (request) => {
    requireLibraryAccess(db, db.getLibraryIdForStatement(request.params.statementId), request.user);
    const statement = db.getAnalysisStatement(request.params.statementId);
    if (!statement) throw new Error("分析陈述不存在");
    try {
      return db.saveStatementPrecheck(
        statement.id,
        await model.precheckStatement(statement.text, statement.citations),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 预检失败";
      return db.failStatementPrecheck(statement.id, message);
    }
  });
  app.post<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/analysis/publish", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    return reply.status(201).send(await publisher.publish(request.params.libraryId));
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/analysis", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    const analysis = db.getPublishedAnalysis(request.params.libraryId);
    if (!analysis) return reply.status(404).send({ error: "尚未发布分析笔记" });
    return analysis;
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/analysis/download", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    const analysis = db.getPublishedAnalysis(request.params.libraryId);
    if (!analysis) return reply.status(404).send({ error: "尚未发布分析笔记" });
    reply.type("text/markdown; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="analysis.md"');
    return reply.send(analysis.content);
  });
  app.get<{ Params: { libraryId: string } }>("/api/libraries/:libraryId/export", async (request, reply) => {
    requireLibrary(db, request.params.libraryId, request.user);
    reply.type("application/zip");
    reply.header("Content-Disposition", 'attachment; filename="agent-thinking-export.zip"');
    return reply.send(await publisher.exportArchive(request.params.libraryId));
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
