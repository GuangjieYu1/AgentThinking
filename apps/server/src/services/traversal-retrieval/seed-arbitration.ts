import type {
  Chunk,
  TraversalRetrievalPattern,
  TraversalSeedCandidate,
  TraversalSeedCluster,
  TraversalSeedScore,
  TraversalSeedSource,
} from "@agent-thinking/contracts";
import { TableRoleAdapter } from "./table-role-adapter.js";
import { chunkDistance, clamp01, sameHeadingPath, termOverlap } from "./utils.js";

export interface SeedArbitrationInput {
  question: string;
  pattern: TraversalRetrievalPattern;
  candidates: TraversalSeedCandidate[];
  chunks: Chunk[];
  caps?: Partial<SeedArbitrationCaps> | undefined;
}

export interface SeedArbitrationCaps {
  AORI_max: number;
  vector_max: number;
  keyword_max: number;
  total_cap: number;
}

const defaultCaps: SeedArbitrationCaps = {
  AORI_max: 2,
  vector_max: 3,
  keyword_max: 2,
  total_cap: 5,
};

const sourceCaps: Record<TraversalSeedSource, keyof Pick<SeedArbitrationCaps, "AORI_max" | "vector_max" | "keyword_max">> = {
  AORI: "AORI_max",
  vector: "vector_max",
  keyword: "keyword_max",
};

const roleCompatibility: Record<TraversalRetrievalPattern, Partial<Record<ReturnType<TableRoleAdapter["classify"]>["role"], number>>> = {
  table_horizontal: {
    header: 0.85,
    data_row: 1,
    summary: 0.92,
    table: 0.88,
    paragraph: 0.35,
    list_item: 0.35,
    unknown: 0.2,
  },
  entity_scatter: {
    header: 0.55,
    data_row: 0.72,
    summary: 0.45,
    table: 0.55,
    paragraph: 0.9,
    list_item: 0.88,
    unknown: 0.25,
  },
  timeline_chain: {
    header: 0.6,
    data_row: 0.7,
    summary: 0.45,
    table: 0.55,
    paragraph: 0.85,
    list_item: 0.82,
    unknown: 0.25,
  },
  hierarchical_depth: {
    header: 0.9,
    data_row: 0.58,
    summary: 0.62,
    table: 0.62,
    paragraph: 0.78,
    list_item: 0.72,
    unknown: 0.25,
  },
  single_point: {
    header: 0.62,
    data_row: 0.72,
    summary: 0.7,
    table: 0.62,
    paragraph: 0.9,
    list_item: 0.82,
    unknown: 0.3,
  },
};

function decisionForScore(score: number): TraversalSeedCluster["decision"] {
  if (score > 0.7) return "promote";
  if (score >= 0.4) return "promote_low_priority";
  return "discard";
}

function sourceRank(source: TraversalSeedSource): number {
  return source === "AORI" ? 0 : source === "vector" ? 1 : 2;
}

export class SeedArbitrationEngine {
  constructor(private readonly roleAdapter = new TableRoleAdapter()) {}

  arbitrate(input: SeedArbitrationInput): TraversalSeedCluster[] {
    const caps = { ...defaultCaps, ...input.caps };
    const chunksById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
    const cappedCandidates = this.applySourceCaps(input.candidates, caps)
      .filter((candidate) => chunksById.has(candidate.chunkId));
    const scored = cappedCandidates
      .map((candidate) => {
        const chunk = chunksById.get(candidate.chunkId)!;
        return { candidate, chunk, score: this.scoreCandidate(input.question, input.pattern, candidate, chunk, input.chunks) };
      })
      .sort((left, right) =>
        right.score.finalScore - left.score.finalScore ||
        sourceRank(left.candidate.source) - sourceRank(right.candidate.source) ||
        left.chunk.ordinal - right.chunk.ordinal,
      );

    const clusters = this.cluster(scored, input.question, input.pattern);
    const promoted = clusters
      .filter((cluster) => cluster.decision !== "discard")
      .sort((left, right) => right.arbitrationScores.finalScore - left.arbitrationScores.finalScore)
      .slice(0, caps.total_cap);
    const promotedIds = new Set(promoted.map((cluster) => cluster.id));
    return clusters
      .map((cluster) => promotedIds.has(cluster.id) || cluster.decision === "discard"
        ? cluster
        : { ...cluster, decision: "discard" as const })
      .sort((left, right) => right.arbitrationScores.finalScore - left.arbitrationScores.finalScore);
  }

  private applySourceCaps(candidates: TraversalSeedCandidate[], caps: SeedArbitrationCaps): TraversalSeedCandidate[] {
    const bySource = new Map<TraversalSeedSource, TraversalSeedCandidate[]>();
    for (const candidate of candidates) {
      const list = bySource.get(candidate.source) ?? [];
      list.push(candidate);
      bySource.set(candidate.source, list);
    }
    return [...bySource.entries()].flatMap(([source, list]) =>
      list
        .sort((left, right) => right.score - left.score)
        .slice(0, caps[sourceCaps[source]]),
    );
  }

  private scoreCandidate(
    question: string,
    pattern: TraversalRetrievalPattern,
    candidate: TraversalSeedCandidate,
    chunk: Chunk,
    allChunks: Chunk[],
  ): TraversalSeedScore {
    const term = clamp01(Math.max(termOverlap(question, chunk.text), candidate.score));
    const role = this.roleAdapter.classify(chunk).role;
    const patternCompatibility = clamp01(roleCompatibility[pattern][role] ?? 0.25);
    const sameZoneNeighbors = allChunks.filter((other) =>
      other.id !== chunk.id &&
      chunkDistance(other, chunk) <= 2 &&
      sameHeadingPath(other, chunk) &&
      this.roleAdapter.classify(other).role === role,
    );
    const neighborConsistency = clamp01(sameZoneNeighbors.length / 2);
    const sourceReliability = clamp01(candidate.reliability);
    const ordinalPrior = allChunks.length <= 1 ? 0.5 : 1 - (chunk.ordinal / Math.max(1, Math.max(...allChunks.map((entry) => entry.ordinal))));
    const headingPrior = chunk.headingPath && termOverlap(question, chunk.headingPath) > 0 ? 0.85 : 0;
    const positionPrior = clamp01(Math.max(headingPrior, ordinalPrior * 0.45));
    const finalScore = clamp01(
      0.30 * term +
      0.25 * neighborConsistency +
      0.20 * patternCompatibility +
      0.15 * sourceReliability +
      0.10 * positionPrior,
    );
    return {
      termOverlap: term,
      neighborConsistency,
      patternCompatibility,
      sourceReliability,
      positionPrior,
      finalScore,
    };
  }

  private cluster(
    scored: Array<{ candidate: TraversalSeedCandidate; chunk: Chunk; score: TraversalSeedScore }>,
    question: string,
    pattern: TraversalRetrievalPattern,
  ): TraversalSeedCluster[] {
    const clusters: Array<{
      entries: Array<{ candidate: TraversalSeedCandidate; chunk: Chunk; score: TraversalSeedScore }>;
    }> = [];
    for (const entry of scored) {
      const existing = clusters.find((cluster) => cluster.entries.some((other) => this.shouldMerge(entry.chunk, other.chunk, question)));
      if (existing) {
        existing.entries.push(entry);
      } else {
        clusters.push({ entries: [entry] });
      }
    }
    return clusters.map((cluster, index) => {
      const sortedEntries = cluster.entries.sort((left, right) => right.score.finalScore - left.score.finalScore || left.chunk.ordinal - right.chunk.ordinal);
      const anchor = sortedEntries[0]!;
      const score = this.averageScores(sortedEntries.map((entry) => entry.score));
      return {
        id: `seed-cluster-${index + 1}`,
        chunkIds: sortedEntries.map((entry) => entry.chunk.id),
        anchorChunkId: anchor.chunk.id,
        decision: decisionForScore(score.finalScore),
        arbitrationScores: score,
        pattern,
        llmNote: this.clusterNote(sortedEntries.map((entry) => entry.chunk)),
      };
    });
  }

  private shouldMerge(left: Chunk, right: Chunk, question: string): boolean {
    if (chunkDistance(left, right) <= 2 && sameHeadingPath(left, right)) return true;
    if (termOverlap(left.text, right.text) > 0.7) return true;
    if (left.parentChunkId && left.parentChunkId === right.parentChunkId) return true;
    if (left.headingPath && left.headingPath === right.headingPath && termOverlap(question, `${left.text} ${right.text}`) > 0.4) return true;
    return false;
  }

  private averageScores(scores: TraversalSeedScore[]): TraversalSeedScore {
    const total = scores.reduce((sum, score) => ({
      termOverlap: sum.termOverlap + score.termOverlap,
      neighborConsistency: sum.neighborConsistency + score.neighborConsistency,
      patternCompatibility: sum.patternCompatibility + score.patternCompatibility,
      sourceReliability: sum.sourceReliability + score.sourceReliability,
      positionPrior: sum.positionPrior + score.positionPrior,
      finalScore: sum.finalScore + score.finalScore,
    }), {
      termOverlap: 0,
      neighborConsistency: 0,
      patternCompatibility: 0,
      sourceReliability: 0,
      positionPrior: 0,
      finalScore: 0,
    });
    const divisor = Math.max(1, scores.length);
    return {
      termOverlap: clamp01(total.termOverlap / divisor),
      neighborConsistency: clamp01(total.neighborConsistency / divisor),
      patternCompatibility: clamp01(total.patternCompatibility / divisor),
      sourceReliability: clamp01(total.sourceReliability / divisor),
      positionPrior: clamp01(total.positionPrior / divisor),
      finalScore: clamp01(total.finalScore / divisor),
    };
  }

  private clusterNote(chunks: Chunk[]): string {
    if (chunks.length <= 1) return "single seed chunk";
    const sameHeading = chunks.every((chunk) => chunk.headingPath === chunks[0]?.headingPath);
    return sameHeading ? "merged nearby chunks under the same heading path" : "merged semantically overlapping seed chunks";
  }
}
