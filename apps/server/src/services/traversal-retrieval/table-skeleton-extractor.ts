import type { Chunk, TraversalChunkSkeleton, TraversalNeighborSkeleton } from "@agent-thinking/contracts";
import { byOrdinal, hasNumericSignal, previewText, sameVersion } from "./utils.js";
import { TableRoleAdapter } from "./table-role-adapter.js";

export interface ChunkGraphReader {
  getChunk(id: string): Chunk | undefined;
  getChunksByIds(ids: string[]): Chunk[];
  getNeighborChunks(chunkIds: string[], window: number): Chunk[];
}

export interface SkeletonExtractionOptions {
  siblingWindow?: number;
  maxChildren?: number;
}

export class TableSkeletonExtractor {
  constructor(
    private readonly reader: ChunkGraphReader,
    private readonly roleAdapter = new TableRoleAdapter(),
  ) {}

  skeletonForChunkId(chunkId: string, options: SkeletonExtractionOptions = {}): TraversalChunkSkeleton | undefined {
    const chunk = this.reader.getChunk(chunkId);
    return chunk ? this.skeletonForChunk(chunk, options) : undefined;
  }

  skeletonForChunk(chunk: Chunk, options: SkeletonExtractionOptions = {}): TraversalChunkSkeleton {
    const siblingWindow = Math.max(1, Math.min(Math.trunc(options.siblingWindow ?? 2), 8));
    const maxChildren = Math.max(0, Math.min(Math.trunc(options.maxChildren ?? 8), 30));
    const parent = this.parentOf(chunk);
    const siblings = this.siblingsOf(chunk, siblingWindow);
    const children = this.childrenOf(chunk, maxChildren);
    const classification = this.roleAdapter.classify(chunk);
    return {
      id: chunk.id,
      role: classification.role,
      ...(classification.indicator ? { indicator: classification.indicator } : {}),
      headingPath: chunk.headingPath,
      ordinal: chunk.ordinal,
      hasNumeric: hasNumericSignal(chunk.text),
      preview: previewText(chunk.text),
      connected: {
        ...(parent ? { parent: this.neighborSkeleton(parent) } : {}),
        children: children.map((child) => this.neighborSkeleton(child)),
        siblings: siblings.map((sibling) => this.neighborSkeleton(sibling)),
      },
    };
  }

  private neighborSkeleton(chunk: Chunk): TraversalNeighborSkeleton {
    const classification = this.roleAdapter.classify(chunk);
    return {
      id: chunk.id,
      role: classification.role,
      ...(classification.indicator ? { indicator: classification.indicator } : {}),
      preview: previewText(chunk.text),
    };
  }

  private parentOf(chunk: Chunk): Chunk | undefined {
    if (chunk.parentChunkId) return this.reader.getChunk(chunk.parentChunkId);
    if (!chunk.headingPath) return undefined;
    const neighbors = this.reader.getNeighborChunks([chunk.id], 8)
      .filter((candidate) => candidate.id !== chunk.id && sameVersion(candidate, chunk))
      .filter((candidate) => candidate.ordinal < chunk.ordinal)
      .sort((left, right) => right.ordinal - left.ordinal);
    return neighbors.find((candidate) => {
      const role = this.roleAdapter.classify(candidate).role;
      return role === "header" && candidate.headingPath === chunk.headingPath;
    }) ?? neighbors.find((candidate) => this.roleAdapter.classify(candidate).role === "header");
  }

  private childrenOf(chunk: Chunk, limit: number): Chunk[] {
    if (limit <= 0) return [];
    const neighbors = this.reader.getNeighborChunks([chunk.id], limit + 4)
      .filter((candidate) => candidate.id !== chunk.id && sameVersion(candidate, chunk))
      .filter((candidate) => candidate.parentChunkId === chunk.id || (
        candidate.ordinal > chunk.ordinal &&
        candidate.headingPath === chunk.headingPath &&
        this.roleAdapter.classify(chunk).role === "header"
      ))
      .sort(byOrdinal);
    return neighbors.slice(0, limit);
  }

  private siblingsOf(chunk: Chunk, window: number): Chunk[] {
    return this.reader.getNeighborChunks([chunk.id], window)
      .filter((candidate) => candidate.id !== chunk.id && sameVersion(candidate, chunk))
      .filter((candidate) => Math.abs(candidate.ordinal - chunk.ordinal) <= window)
      .sort(byOrdinal);
  }
}
