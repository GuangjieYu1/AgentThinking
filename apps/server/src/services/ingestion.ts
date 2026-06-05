import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type {
  AoriContextPolicy,
  AoriIndexingRationale,
  Chunk,
  GraphRulesSummary,
  IngestJob,
  ReflectiveIndexReport,
} from "@agent-thinking/contracts";
import type { AppConfig } from "../config.js";
import { AgentDatabase } from "../db.js";
import { parseTextSections } from "../domain/chunker.js";
import { buildContextIndex } from "../domain/context-units.js";
import { buildDocumentIndex } from "../domain/document-tree.js";
import { isWordMediaType } from "../domain/files.js";
import { parseMarkdownStructure } from "../domain/source-structure.js";
import type { GraphRulesResult } from "./graphRules.js";
import { aoriIndexToExtraction, buildAoriDocumentIndex, type AoriDraftGroup } from "./aori.js";
import { LibraryAoriService } from "./library-aori.js";
import { LibraryEventBus } from "./library-events.js";
import type { ModelProvider } from "./models.js";
import { parseDocument } from "./parser.js";
import { VectorStore } from "./vector-store.js";

interface AoriContextGroup {
  groupId: string;
  chunks: Chunk[];
  documentTokenEstimate: number;
  inputTokenEstimate: number;
  usedTokenEstimate: number;
  preservedRanges: string[];
  omittedRanges: string[];
  truncated: boolean;
  risk: "low" | "medium" | "high";
}

interface AoriContextPlan {
  policy: AoriContextPolicy;
  contextChunks: Chunk[];
  groups: AoriContextGroup[];
  rationaleTrace: AoriIndexingRationale[];
  reflectiveReport: ReflectiveIndexReport;
}

function estimateAoriTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function aoriChunkPayloadText(chunk: Chunk): string {
  const source = chunk.headingPath ?? (chunk.pageNumber ? `PDF page ${chunk.pageNumber}` : `chunk ${chunk.ordinal + 1}`);
  return [`[chunk:${chunk.id}] ${source}`, chunk.text].join("\n");
}

function estimateAoriChunkTokens(chunks: Chunk[]): number {
  return estimateAoriTokens(chunks.map(aoriChunkPayloadText).join("\n\n"));
}

function estimateAoriTextAsChunkTokens(chunk: Chunk, text: string): number {
  return estimateAoriChunkTokens([{ ...chunk, text }]);
}

function splitAoriNaturalUnits(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const lines = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const sentences = text.match(/[^。！？.!?；;]+[。！？.!?；;]?/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  return sentences.length > 1 ? sentences : [text.trim()].filter(Boolean);
}

function splitOversizedAoriChunk(chunk: Chunk, budget: number, minTokens: number): Chunk[] {
  if (estimateAoriChunkTokens([chunk]) <= budget) return [chunk];
  const units = splitAoriNaturalUnits(chunk.text);
  const pieces: Chunk[] = [];
  const pushPiece = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    pieces.push({ ...chunk, text: trimmed });
  };
  let current: string[] = [];
  for (const unit of units) {
    const candidate = [...current, unit].join("\n\n");
    if (current.length > 0 && estimateAoriTextAsChunkTokens(chunk, candidate) > budget && estimateAoriTextAsChunkTokens(chunk, current.join("\n\n")) >= minTokens) {
      pushPiece(current.join("\n\n"));
      current = [unit];
      continue;
    }
    if (current.length === 0 && estimateAoriTextAsChunkTokens(chunk, unit) > budget) {
      const maxChars = Math.max(1, Math.floor(budget * 4 * 0.92));
      for (let start = 0; start < unit.length; start += maxChars) pushPiece(unit.slice(start, start + maxChars));
      current = [];
      continue;
    }
    current = [...current, unit];
  }
  pushPiece(current.join("\n\n"));
  return pieces;
}

function selectAoriContextChunks(chunks: Chunk[], budget: number, minTokens: number): Chunk[] {
  const sectionChunks = chunks.filter((chunk) => chunk.nodeType === "section" && chunk.text.trim());
  const base = (sectionChunks.length > 0
    ? sectionChunks
    : chunks.filter((chunk) => chunk.nodeType !== "sentence" && chunk.text.trim()))
    .sort((left, right) => left.ordinal - right.ordinal);
  return base.flatMap((chunk) => splitOversizedAoriChunk(chunk, budget, minTokens));
}

function describeAoriRange(chunks: Chunk[]): string {
  const first = chunks[0];
  const last = chunks.at(-1) ?? first;
  if (!first || !last) return "";
  const firstLabel = first.headingPath ?? (first.pageNumber ? `PDF page ${first.pageNumber}` : `chunk ${first.ordinal + 1}`);
  const lastLabel = last.headingPath ?? (last.pageNumber ? `PDF page ${last.pageNumber}` : `chunk ${last.ordinal + 1}`);
  const label = firstLabel === lastLabel ? firstLabel : `${firstLabel} -> ${lastLabel}`;
  return `${label} (ordinals ${first.ordinal + 1}-${last.ordinal + 1}, tokens ~= ${estimateAoriChunkTokens(chunks)})`;
}

function omittedAoriRanges(allChunks: Chunk[], groupChunks: Chunk[]): string[] {
  const first = groupChunks[0];
  const last = groupChunks.at(-1) ?? first;
  if (!first || !last) return [];
  const firstIndex = allChunks.indexOf(first);
  const lastIndex = allChunks.indexOf(last);
  if (firstIndex >= 0 && lastIndex >= firstIndex) {
    return [
      describeAoriRange(allChunks.slice(0, firstIndex)),
      describeAoriRange(allChunks.slice(lastIndex + 1)),
    ].filter(Boolean);
  }
  return [
    describeAoriRange(allChunks.filter((chunk) => chunk.ordinal < first.ordinal)),
    describeAoriRange(allChunks.filter((chunk) => chunk.ordinal > last.ordinal)),
  ].filter(Boolean);
}

function uniqueChunksById(chunks: Chunk[]): Chunk[] {
  return [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()]
    .sort((left, right) => left.ordinal - right.ordinal);
}

function buildAoriContextPlan(chunks: Chunk[], config: AppConfig, recordIndexingRationale: boolean): AoriContextPlan {
  const policy: AoriContextPolicy = {
    modelContextTokens: config.aoriModelContextTokens,
    globalReadMaxInputTokens: config.aoriGlobalReadMaxInputTokens,
    minTruncatedContextTokens: config.aoriMinTruncatedContextTokens,
    evidenceBindingMinContextTokens: config.aoriEvidenceBindingMinContextTokens,
    allowSmallContextOnlyForQuoteLookup: config.aoriAllowSmallContextOnlyForQuoteLookup,
  };
  const budget = Math.max(1, Math.min(policy.modelContextTokens, policy.globalReadMaxInputTokens));
  const minTruncated = Math.max(1, Math.min(policy.minTruncatedContextTokens, budget));
  const contextChunks = selectAoriContextChunks(chunks, budget, minTruncated);
  const documentTokenEstimate = estimateAoriChunkTokens(contextChunks);
  const groups: AoriContextGroup[] = [];

  const pushGroup = (groupChunks: Chunk[]) => {
    if (groupChunks.length === 0) return;
    const usedTokenEstimate = estimateAoriChunkTokens(groupChunks);
    const truncated = documentTokenEstimate > budget;
    const preservedRanges = [describeAoriRange(groupChunks)].filter(Boolean);
    const omittedRanges = truncated ? omittedAoriRanges(contextChunks, groupChunks) : [];
    const risk: AoriContextGroup["risk"] = usedTokenEstimate > budget
      ? "high"
      : !truncated
      ? "low"
      : usedTokenEstimate < minTruncated && omittedRanges.length > 0
        ? "high"
        : omittedRanges.length > 1
          ? "medium"
          : "low";
    groups.push({
      groupId: `aori-global-${groups.length + 1}`,
      chunks: groupChunks,
      documentTokenEstimate,
      inputTokenEstimate: documentTokenEstimate,
      usedTokenEstimate,
      preservedRanges,
      omittedRanges,
      truncated,
      risk,
    });
  };

  if (documentTokenEstimate <= budget) {
    pushGroup(contextChunks);
  } else {
    let current: Chunk[] = [];
    for (const chunk of contextChunks) {
      const candidate = [...current, chunk];
      const candidateTokens = estimateAoriChunkTokens(candidate);
      if (current.length > 0 && candidateTokens > budget && estimateAoriChunkTokens(current) >= minTruncated) {
        pushGroup(current);
        current = [chunk];
      } else {
        current = candidate;
      }
    }
    pushGroup(current);
  }

  const truncationGroups = groups.filter((group) => group.truncated);
  const rationaleTrace: AoriIndexingRationale[] = recordIndexingRationale
    ? groups.map((group) => ({
      stage: "global_reading",
      decisionType: group.truncated ? "context_truncation" : "context_selection",
      summary: group.truncated
        ? `Document estimate ${group.inputTokenEstimate} tokens exceeded AORI global read budget ${budget}; preserved ${group.preservedRanges.join("; ")} for this large-context read.`
        : "全文未超过模型预算，使用完整文档作为 AORI 全局阅读输入。",
      inputTokenEstimate: group.inputTokenEstimate,
      usedTokenEstimate: group.usedTokenEstimate,
      omittedRanges: group.truncated ? group.omittedRanges : [],
      preservedRanges: group.truncated ? group.preservedRanges : ["full_document"],
      risk: group.truncated ? group.risk : "low",
    }))
    : [];
  const highestRisk: ReflectiveIndexReport["completenessRisk"] = truncationGroups.some((group) => group.risk === "high")
    ? "high"
    : truncationGroups.some((group) => group.risk === "medium")
      ? "medium"
      : truncationGroups.length > 0
        ? "low"
        : "none";
  const reflectiveReport: ReflectiveIndexReport = {
    summary: truncationGroups.length > 0
      ? "The source exceeded the AORI global reading budget, so indexing used large section/page context groups instead of a single full-document read."
      : "AORI Global Reading used the full document context within the configured model budget.",
    completenessRisk: highestRisk,
    warnings: truncationGroups.length > 0
      ? ["由于原文超过模型上下文预算，Global Reading 分组阅读；事件切面、关系词表和闭合性检查可能受未同屏章节影响。"]
      : [],
    truncationCount: truncationGroups.length,
  };

  return { policy, contextChunks, groups, rationaleTrace, reflectiveReport };
}

export class IngestionQueue extends EventEmitter {
  private readonly pending: string[] = [];
  private active = false;

  constructor(
    private readonly db: AgentDatabase,
    private readonly vectors: VectorStore,
    private readonly model: ModelProvider,
    private readonly config: AppConfig,
    private readonly events?: LibraryEventBus,
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
    this.events?.emitEvent({ type: "job", job });
    return job;
  }

  private emitGraphRuleEvents(
    source: { libraryId: string; documentId: string; version: { id: string } },
    jobId: string,
    type: "graph_rule_trace" | "graph_rebuild_rule_trace",
    result: GraphRulesResult,
  ): void {
    const createdAt = new Date().toISOString();
    const traces = result.traces.slice(-8);
    this.events?.emitEvent({
      type,
      libraryId: source.libraryId,
      documentId: source.documentId,
      versionId: source.version.id,
      jobId,
      stage: "extraction",
      createdAt,
      traces,
      summary: result.summary,
    });
    this.events?.emitEvent({
      type: "graph_rule_summary",
      libraryId: source.libraryId,
      documentId: source.documentId,
      versionId: source.version.id,
      jobId,
      stage: "extraction",
      createdAt,
      summary: result.summary,
    });
  }

  private emitCandidateReady(
    source: { libraryId: string; documentId: string; version: { id: string } },
    jobId: string,
    batchIndex: number,
    totalBatches: number,
    summary: GraphRulesSummary,
    counts: { nodes: number; relations: number; themes: number },
  ): void {
    this.events?.emitEvent({
      type: "graph_candidate_batch_ready",
      libraryId: source.libraryId,
      documentId: source.documentId,
      versionId: source.version.id,
      jobId,
      stage: "extraction",
      createdAt: new Date().toISOString(),
      batchIndex,
      totalBatches,
      nodeCount: counts.nodes,
      relationCount: counts.relations,
      themeCount: counts.themes,
      summary,
    });
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
      const documentIndex = buildDocumentIndex({
        libraryId: source.libraryId,
        documentId: source.documentId,
        versionId: source.version.id,
        documentName: source.documentName,
        sections,
      });
      const chunks = this.db.replaceChunks(source.libraryId, source.version.id, documentIndex.chunks);
      this.db.saveDocumentIndex(documentIndex, chunks);
      if (chunks.length === 0) throw new Error("文档中没有可处理的文本内容");
      const shouldRunAori = job.indexStrategy === "aspect_oriented_reflective";
      const aoriContextPlan = shouldRunAori
        ? buildAoriContextPlan(chunks, this.config, job.recordIndexingRationale)
        : undefined;
      {
        const build = this.db.createIndexBuild(source.version.id, "v2");
        try {
          const contextIndex = buildContextIndex({
            buildId: build.buildId,
            versionId: source.version.id,
            chunks,
            treeNodes: documentIndex.treeNodes,
            contextTokenBudget: this.config.modelPreferredContextTokens,
          });
          this.db.saveContextIndex(
            build.buildId,
            contextIndex.contextUnits,
            contextIndex.retrievalUnits,
            {
              ...contextIndex.qualityReport,
              ...(aoriContextPlan ? {
                aoriContextPolicy: aoriContextPlan.policy,
                ...(aoriContextPlan.rationaleTrace.length > 0 ? { aoriRationaleTrace: aoriContextPlan.rationaleTrace } : {}),
                reflectiveIndexReport: aoriContextPlan.reflectiveReport,
              } : {}),
            },
            contextIndex.performanceReport,
          );
          let vectorCount = 0;
          for (let start = 0; start < contextIndex.retrievalUnits.length; start += 32) {
            const batch = contextIndex.retrievalUnits.slice(start, start + 32);
            const embeddings = await this.model.embed(batch.map((unit) => unit.text));
            if (embeddings.length !== batch.length) throw new Error("RetrievalUnit embedding 返回数量与输入不一致");
            batch.forEach((unit, index) => {
              this.vectors.saveRetrievalUnit(source.libraryId, unit, embeddings[index] ?? []);
              vectorCount += 1;
            });
          }
          this.db.markIndexBuildReady(build.buildId, { vectorCount });
        } catch (error) {
          this.db.markIndexBuildFailed(build.buildId, error);
        }
      }

      this.setStage(jobId, "embedding", 0.48);
      const childChunks = chunks.filter((chunk) => chunk.nodeType === null || chunk.nodeType === "paragraph" || chunk.nodeType === "sentence" || chunk.nodeType === "unknown");
      for (let start = 0; start < childChunks.length; start += 32) {
        const batch = childChunks.slice(start, start + 32);
        const embeddings = await this.model.embed(batch.map((chunk) => chunk.text));
        if (embeddings.length !== batch.length) throw new Error("Embedding 返回数量与 chunk 不一致");
        batch.forEach((chunk, index) => this.vectors.save(chunk, embeddings[index] ?? []));
      }
      const v1Build = this.db.createIndexBuild(source.version.id, "v1");
      this.db.markIndexBuildReady(v1Build.buildId, { vectorCount: childChunks.length });
      for (let start = 0; start < documentIndex.summaryNodes.length; start += 32) {
        const batch = documentIndex.summaryNodes.slice(start, start + 32);
        const embeddings = await this.model.embed(batch.map((summary) => summary.summary));
        if (embeddings.length !== batch.length) throw new Error("Summary embedding 返回数量与 summary 不一致");
        batch.forEach((summary, index) => this.vectors.saveSummary(source.libraryId, summary, embeddings[index] ?? []));
      }

      this.setStage(jobId, "extracting", 0.7);
      const currentVersionChunkIds = new Set(childChunks.map((chunk) => chunk.id));
      if (shouldRunAori && aoriContextPlan) {
        const draftGroups: AoriDraftGroup[] = [];
        for (const group of aoriContextPlan.groups) {
          const draft = await this.model.extractAoriDocument({
            documentName: source.documentName,
            chunks: group.chunks,
            context: {
              stage: "global_reading",
              groupId: group.groupId,
              documentName: source.documentName,
              documentTokenEstimate: group.documentTokenEstimate,
              inputTokenEstimate: group.inputTokenEstimate,
              usedTokenEstimate: group.usedTokenEstimate,
              preservedRanges: group.preservedRanges,
              omittedRanges: group.omittedRanges,
              truncated: group.truncated,
              risk: group.risk,
              minTruncatedContextTokens: this.config.aoriMinTruncatedContextTokens,
              evidenceBindingMinContextTokens: this.config.aoriEvidenceBindingMinContextTokens,
              allowSmallContextOnlyForQuoteLookup: this.config.aoriAllowSmallContextOnlyForQuoteLookup,
            },
          });
          draftGroups.push({ groupId: group.groupId, draft });
        }
        const aoriIndex = buildAoriDocumentIndex({
          libraryId: source.libraryId,
          documentId: source.documentId,
          documentName: source.documentName,
          versionId: source.version.id,
          chunks,
          drafts: draftGroups,
          rationaleTrace: job.recordIndexingRationale ? aoriContextPlan.rationaleTrace : [],
          reflectiveReport: aoriContextPlan.reflectiveReport,
        });
        this.db.saveAoriDocumentIndex(aoriIndex);
        new LibraryAoriService(this.db).mergeDocument(aoriIndex);
        const compatibleExtraction = aoriIndexToExtraction(aoriIndex);
        if (compatibleExtraction.nodes.length > 0) this.db.saveExtraction(source.libraryId, compatibleExtraction, source.version.id);
      } else {
        const relatedByChunk = new Map<string, Chunk[]>();
        const affectedExistingChunks = new Map<string, { chunk: Chunk; newContext: Map<string, Chunk> }>();
        for (const chunk of childChunks) {
          const embedding = await this.model.embed([chunk.text]);
          const crossDocumentCandidates = this.vectors.search(
            source.libraryId,
            embedding[0] ?? [],
            6,
            currentVersionChunkIds,
          ).map((result) => result.chunk)
            .filter((candidate) => candidate.versionId !== source.version.id);
          relatedByChunk.set(chunk.id, crossDocumentCandidates);
          for (const candidate of crossDocumentCandidates) {
            const affected = affectedExistingChunks.get(candidate.id) ?? {
              chunk: candidate,
              newContext: new Map<string, Chunk>(),
            };
            affected.newContext.set(chunk.id, chunk);
            affectedExistingChunks.set(candidate.id, affected);
          }
        }

        const batchSize = 8;
        const primaryBatchCount = Math.ceil(childChunks.length / batchSize);
        for (let start = 0; start < childChunks.length; start += batchSize) {
          const batch = childChunks.slice(start, start + batchSize);
          const relatedBatch = new Map(batch.map((chunk) => [chunk.id, relatedByChunk.get(chunk.id) ?? []]));
          let graphRules: GraphRulesResult | undefined;
          const extraction = await this.model.extract(batch, relatedBatch, {
            stage: "extraction",
            onGraphRules: (result) => {
              graphRules = result;
              this.emitGraphRuleEvents(source, jobId, "graph_rule_trace", result);
            },
          });
          this.db.saveExtraction(source.libraryId, extraction, source.version.id);
          if (graphRules) {
            this.emitCandidateReady(source, jobId, Math.floor(start / batchSize) + 1, Math.max(1, primaryBatchCount), graphRules.summary, {
              nodes: extraction.nodes.length,
              relations: extraction.relations.length,
              themes: extraction.themes?.length ?? 0,
            });
          }
        }

        // Existing chunks need a reciprocal look at new material so import order does not
        // determine whether a cross-document relationship can be proposed.
        const affected = [...affectedExistingChunks.values()];
        const reciprocalAnchorBatchSize = 20;
        const reciprocalBatchCount = Math.ceil(affected.length / reciprocalAnchorBatchSize);
        for (let start = 0; start < affected.length; start += reciprocalAnchorBatchSize) {
          const batch = affected.slice(start, start + reciprocalAnchorBatchSize);
          const anchors = batch.map((entry) => entry.chunk);
          const reciprocalRelated = new Map(batch.map((entry) => [entry.chunk.id, uniqueChunksById([...entry.newContext.values()])]));
          let graphRules: GraphRulesResult | undefined;
          const extraction = await this.model.extract(anchors, reciprocalRelated, {
            stage: "extraction",
            onGraphRules: (result) => {
              graphRules = result;
              this.emitGraphRuleEvents(source, jobId, "graph_rule_trace", result);
            },
          });
          this.db.saveExtraction(source.libraryId, extraction, source.version.id);
          if (graphRules) {
            this.emitCandidateReady(source, jobId, primaryBatchCount + Math.floor(start / reciprocalAnchorBatchSize) + 1, primaryBatchCount + Math.max(0, reciprocalBatchCount), graphRules.summary, {
              nodes: extraction.nodes.length,
              relations: extraction.relations.length,
              themes: extraction.themes?.length ?? 0,
            });
          }
        }
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
