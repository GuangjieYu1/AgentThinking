import type { Chunk, SearchResult, SummaryTreeNode } from "@agent-thinking/contracts";
import * as sqliteVec from "sqlite-vec";
import { AgentDatabase } from "../db.js";

function toBlob(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

function fromBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export class VectorStore {
  private extensionLoaded = false;

  constructor(private readonly db: AgentDatabase) {
    try {
      sqliteVec.load(db.sql);
      this.extensionLoaded = true;
    } catch {
      // A pure JavaScript cosine fallback keeps imports usable if native loading is unavailable.
      this.extensionLoaded = false;
    }
  }

  get usesSqliteVec(): boolean {
    return this.extensionLoaded;
  }

  save(chunk: Chunk, embedding: number[]): void {
    this.db.saveEmbedding(chunk.id, embedding.length, toBlob(embedding));
  }

  saveSummary(libraryId: string, summary: SummaryTreeNode, embedding: number[]): void {
    this.db.saveSummaryEmbedding(libraryId, summary.id, embedding.length, toBlob(embedding));
  }

  search(
    libraryId: string,
    queryEmbedding: number[],
    limit: number,
    excludedChunkIds: Set<string> = new Set(),
  ): SearchResult[] {
    if (this.extensionLoaded) {
      const candidates = this.db.sql.prepare(`
        SELECT e.chunk_id, vec_distance_cosine(e.embedding, ?) AS distance
        FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
        WHERE c.library_id = ? AND e.dimensions = ?
        ORDER BY distance ASC LIMIT ?
      `).all(toBlob(queryEmbedding), libraryId, queryEmbedding.length, limit + excludedChunkIds.size + 5) as unknown as Array<{
        chunk_id: string;
        distance: number;
      }>;
      return candidates
        .filter((candidate) => !excludedChunkIds.has(candidate.chunk_id))
        .slice(0, limit)
        .flatMap((candidate) => {
          const chunk = this.db.getChunk(candidate.chunk_id);
          return chunk ? [{ chunk, score: 1 - Number(candidate.distance) }] : [];
        });
    }
    return this.db.listEmbeddings(libraryId, queryEmbedding.length)
      .filter(({ chunk }) => !excludedChunkIds.has(chunk.id))
      .map(({ chunk, embedding }) => ({ chunk, score: cosine(queryEmbedding, fromBlob(embedding)) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  searchSummaries(
    libraryId: string,
    queryEmbedding: number[],
    limit: number,
  ): Array<{ summary: SummaryTreeNode; score: number }> {
    if (this.extensionLoaded) {
      const candidates = this.db.sql.prepare(`
        SELECT e.summary_id, vec_distance_cosine(e.embedding, ?) AS distance
        FROM summary_embeddings e
        WHERE e.library_id = ? AND e.dimensions = ?
        ORDER BY distance ASC LIMIT ?
      `).all(toBlob(queryEmbedding), libraryId, queryEmbedding.length, limit) as unknown as Array<{
        summary_id: string;
        distance: number;
      }>;
      const summaries = new Map(this.db.getSummaryTreeForLibrary(libraryId).map((summary) => [summary.id, summary]));
      return candidates.flatMap((candidate) => {
        const summary = summaries.get(candidate.summary_id);
        return summary ? [{ summary, score: 1 - Number(candidate.distance) }] : [];
      });
    }
    return this.db.listSummaryEmbeddings(libraryId, queryEmbedding.length)
      .map(({ summary, embedding }) => ({ summary, score: cosine(queryEmbedding, fromBlob(embedding)) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}
