import type {
  Chunk,
  TraversalActiveFront,
  TraversalDirection,
  TraversalLegalMove,
  TraversalMoveType,
  TraversalSeedCluster,
  TraversalStopReason,
} from "@agent-thinking/contracts";
import type { ChunkGraphReader } from "./table-skeleton-extractor.js";
import { TableSkeletonExtractor } from "./table-skeleton-extractor.js";
import { byOrdinal, sameVersion } from "./utils.js";

export interface TraversalBudgetState {
  startedAtMs: number;
  round: number;
  visitedNodeCount: number;
  injectedTokens: number;
}

export interface TraversalGraphLimits {
  maxRounds: number;
  maxTimeMs: number;
  maxVisitedNodes: number;
  maxRoundNodes: number;
  maxInjectedTokens: number;
  neighborWindow: number;
}

export interface LegalMoveSet {
  frontId: string;
  moves: TraversalLegalMove[];
}

export const defaultTraversalGraphLimits: TraversalGraphLimits = {
  maxRounds: 20,
  maxTimeMs: 60_000,
  maxVisitedNodes: 400,
  maxRoundNodes: 50,
  maxInjectedTokens: 8_000,
  neighborWindow: 3,
};

export class HardStopChecker {
  check(
    fronts: TraversalActiveFront[],
    state: TraversalBudgetState,
    limits: TraversalGraphLimits = defaultTraversalGraphLimits,
  ): TraversalStopReason | undefined {
    const elapsed = Date.now() - state.startedAtMs;
    if (state.round >= limits.maxRounds) return "round_budget";
    if (elapsed >= limits.maxTimeMs) return "time_budget";
    if (state.visitedNodeCount >= limits.maxVisitedNodes) return "node_cap";
    if (state.injectedTokens >= limits.maxInjectedTokens) return "token_cap";
    if (fronts.length === 0) return "no_seed";
    if (fronts.every((front) => front.confidence === "dead_end")) return "fronts_exhausted";
    return undefined;
  }
}

function directionForMove(move: TraversalMoveType): TraversalDirection {
  return move === "parent" ? "parent"
    : move === "child" ? "child"
      : move === "sibling_prev" ? "sibling_prev"
        : move === "sibling_next" ? "sibling_next"
          : move === "nearby" ? "nearby"
            : "stop";
}

function moveReason(move: TraversalMoveType, target?: Chunk): string {
  if (move === "stop_current_front") return "front can be stopped by policy or verifier";
  if (!target) return "target unavailable";
  if (move === "parent") return "legal parent/header neighbor";
  if (move === "child") return "legal child/detail neighbor";
  if (move === "sibling_prev") return "legal previous sibling";
  if (move === "sibling_next") return "legal next sibling";
  return "legal nearby chunk";
}

export class GraphOps {
  private readonly skeletons: TableSkeletonExtractor;
  private readonly hardStops = new HardStopChecker();

  constructor(
    private readonly reader: ChunkGraphReader,
    skeletons?: TableSkeletonExtractor,
  ) {
    this.skeletons = skeletons ?? new TableSkeletonExtractor(reader);
  }

  createInitialFronts(clusters: TraversalSeedCluster[]): TraversalActiveFront[] {
    return clusters.flatMap((cluster, index) => {
      if (cluster.decision === "discard") return [];
      const skeleton = this.skeletons.skeletonForChunkId(cluster.anchorChunkId);
      if (!skeleton) return [];
      return [{
        id: `front-${index + 1}`,
        clusterId: cluster.id,
        anchorChunkId: cluster.anchorChunkId,
        direction: "seed" as const,
        pathLength: 1,
        lastSkeleton: skeleton,
        confidence: cluster.decision === "promote" ? "continue" as const : "low" as const,
        pathChunkIds: [cluster.anchorChunkId],
      }];
    });
  }

  legalMovesForFront(front: TraversalActiveFront, visitedChunkIds: Set<string>): TraversalLegalMove[] {
    const anchor = this.reader.getChunk(front.anchorChunkId);
    if (!anchor || front.confidence === "dead_end") {
      return [{ move: "stop_current_front", reason: "front exhausted or anchor missing" }];
    }
    const candidates = this.neighborCandidates(anchor)
      .filter((candidate) => !visitedChunkIds.has(candidate.chunk.id))
      .sort((left, right) => left.chunk.ordinal - right.chunk.ordinal);
    const moves: TraversalLegalMove[] = candidates.map(({ move, chunk }) => ({
      move,
      target: chunk.id,
      reason: moveReason(move, chunk),
    }));
    moves.push({ move: "stop_current_front", reason: moveReason("stop_current_front") });
    return this.dedupeMoves(moves);
  }

  legalMoves(fronts: TraversalActiveFront[], visitedChunkIds: Set<string>): LegalMoveSet[] {
    return fronts.map((front) => ({
      frontId: front.id,
      moves: this.legalMovesForFront(front, visitedChunkIds),
    }));
  }

  applyMove(front: TraversalActiveFront, move: TraversalLegalMove): TraversalActiveFront {
    if (move.move === "stop_current_front" || !move.target) {
      return { ...front, direction: "stop", confidence: "dead_end" };
    }
    const skeleton = this.skeletons.skeletonForChunkId(move.target);
    if (!skeleton) return { ...front, direction: "stop", confidence: "dead_end" };
    return {
      ...front,
      anchorChunkId: move.target,
      direction: directionForMove(move.move),
      pathLength: front.pathLength + 1,
      lastSkeleton: skeleton,
      confidence: "continue",
      pathChunkIds: [...front.pathChunkIds, move.target],
    };
  }

  hardStopReason(fronts: TraversalActiveFront[], state: TraversalBudgetState, limits: TraversalGraphLimits = defaultTraversalGraphLimits): TraversalStopReason | undefined {
    return this.hardStops.check(fronts, state, limits);
  }

  private neighborCandidates(anchor: Chunk): Array<{ move: Exclude<TraversalMoveType, "stop_current_front">; chunk: Chunk }> {
    const neighbors = this.reader.getNeighborChunks([anchor.id], defaultTraversalGraphLimits.neighborWindow)
      .filter((chunk) => chunk.id !== anchor.id && sameVersion(chunk, anchor))
      .sort(byOrdinal);
    const candidates: Array<{ move: Exclude<TraversalMoveType, "stop_current_front">; chunk: Chunk }> = [];
    if (anchor.parentChunkId) {
      const parent = this.reader.getChunk(anchor.parentChunkId);
      if (parent) candidates.push({ move: "parent", chunk: parent });
    } else {
      const parent = neighbors
        .filter((chunk) => chunk.ordinal < anchor.ordinal && chunk.headingPath === anchor.headingPath)
        .sort((left, right) => right.ordinal - left.ordinal)[0];
      if (parent) candidates.push({ move: "parent", chunk: parent });
    }
    const previous = neighbors.filter((chunk) => chunk.ordinal < anchor.ordinal).at(-1);
    const next = neighbors.find((chunk) => chunk.ordinal > anchor.ordinal);
    if (previous) candidates.push({ move: "sibling_prev", chunk: previous });
    if (next) candidates.push({ move: "sibling_next", chunk: next });
    for (const child of neighbors.filter((chunk) => chunk.parentChunkId === anchor.id || (chunk.ordinal > anchor.ordinal && chunk.headingPath === anchor.headingPath)).slice(0, 6)) {
      candidates.push({ move: "child", chunk: child });
    }
    for (const nearby of neighbors.slice(0, 6)) {
      candidates.push({ move: "nearby", chunk: nearby });
    }
    return candidates;
  }

  private dedupeMoves(moves: TraversalLegalMove[]): TraversalLegalMove[] {
    const seen = new Set<string>();
    const result: TraversalLegalMove[] = [];
    for (const move of moves) {
      const key = `${move.move}:${move.target ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(move);
    }
    return result;
  }
}
