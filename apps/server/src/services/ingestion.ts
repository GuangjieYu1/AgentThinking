import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { Chunk, IngestJob } from "@agent-thinking/contracts";
import type { AppConfig } from "../config.js";
import { AgentDatabase } from "../db.js";
import { chunkSections, parseTextSections } from "../domain/chunker.js";
import { isWordMediaType } from "../domain/files.js";
import { parseMarkdownStructure } from "../domain/source-structure.js";
import type { ModelProvider } from "./models.js";
import { parseDocument } from "./parser.js";
import { VectorStore } from "./vector-store.js";

export class IngestionQueue extends EventEmitter {
  private readonly pending: string[] = [];
  private active = false;

  constructor(
    private readonly db: AgentDatabase,
    private readonly vectors: VectorStore,
    private readonly model: ModelProvider,
    private readonly config: AppConfig,
  ) {
    super();
  }

  enqueue(jobId: string): void {
    if (!this.pending.includes(jobId)) this.pending.push(jobId);
    void this.runNext();
  }

  retry(jobId: string): IngestJob {
    const job = this.db.getJob(jobId);
    if (!job) throw new Error("处理任务不存在");
    if (job.stage !== "failed") throw new Error("只有失败的任务可以重试");
    const queued = this.setStage(job.id, "queued", 0, null);
    this.enqueue(job.id);
    return queued;
  }

  private async runNext(): Promise<void> {
    if (this.active) return;
    const jobId = this.pending.shift();
    if (!jobId) return;
    this.active = true;
    try {
      await this.process(jobId);
    } finally {
      this.active = false;
      void this.runNext();
    }
  }

  private setStage(
    jobId: string,
    stage: IngestJob["stage"],
    progress: number,
    error: string | null = null,
  ): IngestJob {
    const job = this.db.updateJob(jobId, stage, progress, error);
    this.emit("job", job);
    return job;
  }

  private async process(jobId: string): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job) return;
    const source = this.db.getVersionSource(job.versionId);
    if (!source) {
      this.setStage(jobId, "failed", 0, "导入版本不存在");
      return;
    }

    try {
      this.db.updateVersionStatus(source.version.id, "processing");
      this.setStage(jobId, "parsing", 0.08);
      const buffer = await readFile(source.version.storagePath);
      let enteredOcr = false;
      let sections = await parseDocument({
        buffer,
        mediaType: source.mediaType,
        ocrMode: this.db.getSettings(source.libraryId).ocrMode,
        config: this.config,
        model: this.model,
        onOcrRequired: () => {
          if (!enteredOcr) {
            enteredOcr = true;
            this.setStage(jobId, "ocr", 0.2);
          }
        },
      });
      if (source.mediaType === "text/markdown") {
        const structure = parseMarkdownStructure(buffer.toString("utf8"));
        sections = structure.sections;
        this.db.saveSourceStructure(source.version.id, structure);
      } else if (source.mediaType === "text/plain" || isWordMediaType(source.mediaType)) {
        sections = parseTextSections(sections.map((section) => section.text).join("\n\n"));
        this.db.saveSourceStructure(source.version.id, {
          title: null,
          frontmatterRaw: null,
          frontmatter: {},
          links: [],
        });
      } else {
        this.db.saveSourceStructure(source.version.id, {
          title: null,
          frontmatterRaw: null,
          frontmatter: {},
          links: [],
        });
      }

      this.setStage(jobId, "chunking", 0.34);
      const chunks = this.db.replaceChunks(source.libraryId, source.version.id, chunkSections(sections));
      if (chunks.length === 0) throw new Error("文档中没有可处理的文本内容");

      this.setStage(jobId, "embedding", 0.48);
      for (let start = 0; start < chunks.length; start += 32) {
        const batch = chunks.slice(start, start + 32);
        const embeddings = await this.model.embed(batch.map((chunk) => chunk.text));
        if (embeddings.length !== batch.length) throw new Error("Embedding 返回数量与 chunk 不一致");
        batch.forEach((chunk, index) => this.vectors.save(chunk, embeddings[index] ?? []));
      }

      this.setStage(jobId, "extracting", 0.7);
      const currentVersionChunkIds = new Set(chunks.map((chunk) => chunk.id));
      const affectedExistingChunks = new Map<string, { chunk: Chunk; newContext: Map<string, Chunk> }>();
      for (let start = 0; start < chunks.length; start += 20) {
        const batch = chunks.slice(start, start + 20);
        const related = new Map<string, typeof chunks>();
        for (const chunk of batch) {
          const embedding = await this.model.embed([chunk.text]);
          const localCandidates = this.vectors.search(source.libraryId, embedding[0] ?? [], 4, new Set([chunk.id]))
            .map((result) => result.chunk);
          const crossDocumentCandidates = this.vectors.search(
            source.libraryId,
            embedding[0] ?? [],
            4,
            currentVersionChunkIds,
          ).map((result) => result.chunk)
            .filter((candidate) => candidate.versionId !== source.version.id);
          const candidates = [...new Map(
            [...localCandidates, ...crossDocumentCandidates].map((candidate) => [candidate.id, candidate]),
          ).values()];
          related.set(
            chunk.id,
            candidates,
          );
          for (const candidate of crossDocumentCandidates) {
            const affected = affectedExistingChunks.get(candidate.id) ?? {
              chunk: candidate,
              newContext: new Map<string, Chunk>(),
            };
            affected.newContext.set(chunk.id, chunk);
            affectedExistingChunks.set(candidate.id, affected);
          }
        }
        const extraction = await this.model.extract(batch, related);
        this.db.saveExtraction(source.libraryId, extraction, source.version.id);
      }

      // Existing chunks need a reciprocal look at new material so import order does not
      // determine whether a cross-document relationship can be proposed.
      const affected = [...affectedExistingChunks.values()];
      for (let start = 0; start < affected.length; start += 20) {
        const batch = affected.slice(start, start + 20);
        const anchors = batch.map((entry) => entry.chunk);
        const related = new Map(batch.map((entry) => [entry.chunk.id, [...entry.newContext.values()]]));
        const extraction = await this.model.extract(anchors, related);
        this.db.saveExtraction(source.libraryId, extraction, source.version.id);
      }

      this.setStage(jobId, "indexing", 0.94);
      this.db.updateVersionStatus(source.version.id, "completed");
      this.setStage(jobId, "completed", 1);
    } catch (error) {
      this.db.updateVersionStatus(source.version.id, "failed");
      const message = error instanceof Error ? error.message : "处理失败";
      this.setStage(jobId, "failed", 0, message);
    }
  }
}
