import type {
  Chunk,
  TableHarvestPlan,
  PulseInputMode,
  PulseStreamEvent,
  TraversalActiveFront,
  TraversalClosureStatus,
  TraversalEvidenceItem,
  TraversalEvidencePath,
  TraversalLegalMove,
  TraversalRetrievalResult,
  TraversalScoutResult,
  TraversalSeedCluster,
  TraversalStopReason,
} from "@agent-thinking/contracts";
import type { AgentDatabase } from "../../db.js";
import { type AoriTraversalAnswerResult } from "../aori-traversal-answer.js";
import { ClosureVerifier, type ClosureRoleInfo } from "./closure-verifier.js";
import {
  defaultTraversalGraphLimits,
  GraphOps,
  HardStopChecker,
  type TraversalBudgetState,
  type TraversalGraphLimits,
} from "./graph-ops.js";
import {
  addRoleInfos,
  answerFromRows,
  buildEvidenceItem,
  chunkEvidencePack,
  evidencePath,
  evidenceRowsFromChunks,
  hitsFromChunks,
  rowBoundaryChecked,
  roleInfoForChunk,
  storageEvidencePack,
} from "./pack-builder.js";
import { makeSubTask } from "./planner.js";
import { LocalLLMPolicy } from "./policy.js";
import { ScoutExtractor } from "./scout-extractor.js";
import { collectSeedCandidates } from "./seed-provider.js";
import { SeedArbitrationEngine } from "./seed-arbitration.js";
import { TableRoleAdapter } from "./table-role-adapter.js";
import type { ChunkGraphReader } from "./table-skeleton-extractor.js";
import { normalizeText, uniqueStrings } from "./utils.js";

type PulseEventSink = (event: PulseStreamEvent) => void | Promise<void>;

export interface TraversalRetrievalEngineOptions {
  limits?: Partial<TraversalGraphLimits> | undefined;
}

export interface TraversalAnswerInput {
  libraryId: string;
  question: string;
  mode: PulseInputMode;
  eventSink?: PulseEventSink | undefined;
}

function terminalState(status: TraversalClosureStatus): "stop" | "partial_stop" | "continue" {
  if (status === "closed") return "stop";
  if (status === "partial") return "partial_stop";
  return "continue";
}

function partialStopAllowed(reason: TraversalStopReason | undefined): boolean {
  return reason === "round_budget" ||
    reason === "time_budget" ||
    reason === "node_cap" ||
    reason === "token_cap" ||
    reason === "fronts_exhausted" ||
    reason === "no_moves" ||
    reason === "no_seed";
}

function shouldStopForClosure(status: TraversalClosureStatus, reason?: TraversalStopReason | undefined): boolean {
  const terminal = terminalState(status);
  if (terminal === "stop") return true;
  if (terminal === "partial_stop") return partialStopAllowed(reason);
  return false;
}

export class DatabaseChunkGraphReader implements ChunkGraphReader {
  constructor(private readonly db: AgentDatabase) {}

  getChunk(id: string): Chunk | undefined {
    return this.db.getChunk(id);
  }

  getChunksByIds(ids: string[]): Chunk[] {
    return this.db.getChunksByIds(ids);
  }

  getNeighborChunks(chunkIds: string[], window: number): Chunk[] {
    return this.db.getNeighborChunks(chunkIds, window);
  }
}

async function emitPulse(eventSink: PulseEventSink | undefined, event: PulseStreamEvent): Promise<void> {
  if (eventSink) await eventSink(event);
}

function uniqueChunks(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
  const result: Chunk[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    result.push(chunk);
  }
  return result.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
}

function sameHeadingPath(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizeText(left) === normalizeText(right);
}

function routeSeedClustersWithTableHarvestPlan(input: {
  seedClusters: TraversalSeedCluster[];
  scout: TraversalScoutResult;
  chunksById: Map<string, Chunk>;
}): TraversalSeedCluster[] {
  const plan = input.scout.tableHarvestPlan;
  if (!plan?.headerChunkId || !input.chunksById.has(plan.headerChunkId)) return input.seedClusters;
  const planChunkIds = new Set(uniqueStrings([
    plan.headerChunkId,
    plan.dataStartChunkId,
    ...plan.dataRowChunkIds,
    ...plan.subtotalChunkIds,
    plan.finalSummaryChunkId,
  ]));
  let routed = false;
  return input.seedClusters.map((cluster) => {
    if (cluster.decision === "discard") return cluster;
    const clusterChunkIds = uniqueStrings([cluster.anchorChunkId, ...cluster.chunkIds]);
    const relevant = clusterChunkIds.some((chunkId) => {
      if (planChunkIds.has(chunkId)) return true;
      const chunk = input.chunksById.get(chunkId);
      return chunk ? sameHeadingPath(chunk.headingPath, plan.headingPath) : false;
    });
    if (!relevant) return cluster;
    if (routed) {
      return {
        ...cluster,
        decision: "discard",
        llmNote: `${cluster.llmNote ?? ""} Scout-first TableHarvestPlan consolidated this table cluster into ${plan.headerChunkId}.`.trim(),
      };
    }
    routed = true;
    return {
      ...cluster,
      anchorChunkId: plan.headerChunkId,
      chunkIds: uniqueStrings([
        plan.headerChunkId,
        ...cluster.chunkIds,
        plan.dataStartChunkId,
        ...plan.dataRowChunkIds,
        ...plan.subtotalChunkIds,
        plan.finalSummaryChunkId,
      ]),
      llmNote: `${cluster.llmNote ?? ""} Scout-first TableHarvestPlan routed traversal seed to header ${plan.headerChunkId}.`.trim(),
    };
  });
}

function tableHarvestPlanSequence(plan: TableHarvestPlan, chunksById: Map<string, Chunk>): string[] {
  return uniqueStrings([
    plan.headerChunkId,
    plan.dataStartChunkId,
    ...plan.dataRowChunkIds,
    ...plan.subtotalChunkIds,
    plan.finalSummaryChunkId,
  ]).sort((leftId, rightId) => {
    const left = chunksById.get(leftId);
    const right = chunksById.get(rightId);
    if (left && right) return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
    if (left) return -1;
    if (right) return 1;
    return leftId.localeCompare(rightId);
  });
}

function plannedTableHarvestMove(input: {
  front: TraversalActiveFront;
  moves: TraversalLegalMove[];
  scout: TraversalScoutResult;
  chunksById: Map<string, Chunk>;
}): TraversalLegalMove | undefined {
  const plan = input.scout.tableHarvestPlan;
  if (!plan) return undefined;
  if (input.front.anchorChunkId === plan.finalSummaryChunkId) return undefined;
  const sequence = tableHarvestPlanSequence(plan, input.chunksById);
  const currentIndex = sequence.indexOf(input.front.anchorChunkId);
  if (currentIndex < 0) return undefined;
  const nextChunkIds = sequence.slice(currentIndex + 1);
  for (const chunkId of nextChunkIds) {
    const move = input.moves.find((candidate) => candidate.target === chunkId);
    if (move?.target) return move;
  }
  return undefined;
}

function continuationAfterRejectedStop(moves: TraversalLegalMove[]): TraversalLegalMove | undefined {
  return moves.find((move) => move.move === "sibling_next" && move.target);
}

function boundaryForEvidence(input: {
  evidence: TraversalEvidenceItem[];
  chunksById: Map<string, Chunk>;
  roleMap: Map<string, ClosureRoleInfo>;
  sectionChunks: Chunk[];
  scout: TraversalScoutResult;
}) {
  return rowBoundaryChecked({
    evidence: input.evidence,
    chunksById: input.chunksById,
    roleMap: input.roleMap,
    sectionChunks: input.sectionChunks,
    headingPath: input.scout.tableHarvestPlan?.headingPath,
  });
}

export class TraversalRetrievalEngine {
  private readonly limits: TraversalGraphLimits;
  private readonly reader: ChunkGraphReader;
  private readonly graphOps: GraphOps;
  private readonly hardStops = new HardStopChecker();
  private readonly seeds = new SeedArbitrationEngine();
  private readonly scout = new ScoutExtractor();
  private readonly verifier = new ClosureVerifier();
  private readonly policy = new LocalLLMPolicy();

  constructor(
    private readonly db: AgentDatabase,
    options: TraversalRetrievalEngineOptions = {},
  ) {
    this.limits = { ...defaultTraversalGraphLimits, ...options.limits };
    this.reader = new DatabaseChunkGraphReader(db);
    this.graphOps = new GraphOps(this.reader);
  }

  async answer(input: TraversalAnswerInput): Promise<AoriTraversalAnswerResult> {
    const result = await this.retrieve(input);
    const chunkIds = uniqueStrings(result.evidencePaths.flatMap((path) => path.path.map((entry) => entry.chunkId)));
    const chunks = this.db.getChunksByIds(chunkIds);
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const rows = evidenceRowsFromChunks(chunks, result.evidencePaths);
    const chunkPack = chunkEvidencePack(input.question, input.mode, chunks, result);
    const storagePack = storageEvidencePack({
      question: input.question,
      rows,
      chunksById,
      result,
      chunkPack,
    });
    const answer = answerFromRows(input.question, rows, result);
    const hits = hitsFromChunks(chunks, result.evidencePaths);
    for (const hit of hits) await emitPulse(input.eventSink, { type: "hit", hit });
    return {
      evidencePack: chunkPack,
      chunkSummaries: [],
      answer,
      chunks,
      hits,
      storageEvidencePack: storagePack,
    };
  }

  async retrieve(input: {
    libraryId: string;
    question: string;
    eventSink?: PulseEventSink | undefined;
  }): Promise<TraversalRetrievalResult> {
    await emitPulse(input.eventSink, { type: "stage", message: "正在执行 Traversal Retrieval v2" });
    const subTask = makeSubTask(input.question);
    const candidates = collectSeedCandidates(this.db, input.libraryId, input.question);
    const candidateChunks = uniqueChunks(this.db.getChunksByIds(candidates.map((candidate) => candidate.chunkId)));
    const allRelevantChunks = uniqueChunks([
      ...candidateChunks,
      ...this.db.getNeighborChunks(candidateChunks.map((chunk) => chunk.id), this.limits.neighborWindow),
    ]);
    const rawSeedClusters = this.seeds.arbitrate({
      question: input.question,
      pattern: subTask.pattern,
      candidates,
      chunks: allRelevantChunks,
    });
    const scout = this.scout.extract({
      question: input.question,
      chunks: allRelevantChunks,
      completenessType: subTask.completenessType,
    });
    const traversalSubTask = subTask.pattern === "table_horizontal" &&
      scout.tableHarvestPlan?.headerChunkId &&
      scout.tableHarvestPlan.dataStartChunkId
      ? {
        ...subTask,
        directionBias: "down_first" as const,
        rationale: `${subTask.rationale} Scout-first TableHarvestPlan starts from the table header and harvests rows in order.`,
      }
      : subTask;
    const chunksById = new Map(allRelevantChunks.map((chunk) => [chunk.id, chunk]));
    const seedClusters = subTask.pattern === "table_horizontal"
      ? routeSeedClustersWithTableHarvestPlan({ seedClusters: rawSeedClusters, scout, chunksById })
      : rawSeedClusters;
    let fronts = this.graphOps.createInitialFronts(seedClusters);
    const roleMap = new Map<string, ClosureRoleInfo>();
    const roleAdapter = new TableRoleAdapter();
    const visited = new Set<string>();
    const evidence = new Map<string, TraversalEvidenceItem>();
    const traversalLog: TraversalEvidencePath["traversalLog"] = [];
    const state: TraversalBudgetState = {
      startedAtMs: Date.now(),
      round: 0,
      visitedNodeCount: 0,
      injectedTokens: 0,
    };
    for (const front of fronts) {
      const chunk = this.reader.getChunk(front.anchorChunkId);
      if (!chunk) continue;
      chunksById.set(chunk.id, chunk);
      roleInfoForChunk(chunk, roleMap, roleAdapter);
      visited.add(chunk.id);
      evidence.set(chunk.id, buildEvidenceItem(chunk, front));
      state.visitedNodeCount += 1;
      state.injectedTokens += Math.ceil(chunk.text.length / 4);
      traversalLog.push({
        round: 0,
        from: chunk.id,
        to: chunk.id,
        direction: "seed",
        reason: "seed cluster promoted into traversal front",
      });
    }
    addRoleInfos([...chunksById.values()], roleMap, roleAdapter);
    let finalClosure = this.verifier.verify({
      completenessType: subTask.completenessType,
      evidence: [...evidence.values()],
      scout,
      roleMap,
      rowBoundaryChecked: false,
      rowBoundaryEvidence: {},
      exhaustedDirections: [],
    });

    let stoppedReason: TraversalStopReason | undefined = fronts.length === 0 ? "no_seed" : undefined;
    while (!stoppedReason) {
      const hardStop = this.hardStops.check(fronts, state, this.limits);
      if (hardStop) {
        stoppedReason = hardStop;
        break;
      }
      state.round += 1;
      const nextFronts: TraversalActiveFront[] = [];
      let appliedMoveCount = 0;
      for (const front of fronts.filter((entry) => entry.confidence !== "dead_end")) {
        if (state.visitedNodeCount >= this.limits.maxVisitedNodes || appliedMoveCount >= this.limits.maxRoundNodes) break;
        const moves = this.graphOps.legalMovesForFront(front, visited);
        const plannedMove = subTask.pattern === "table_horizontal"
          ? plannedTableHarvestMove({ front, moves, scout, chunksById })
          : undefined;
        const decision = plannedMove
          ? {
            selected: {
              move: plannedMove.move,
              ...(plannedMove.target ? { target: plannedMove.target } : {}),
              reason: `TableHarvestPlan selected next chunk ${plannedMove.target}`,
              confidence: 0.94,
            },
            stopProposal: false,
          }
          : this.policy.choose({
            subTask: traversalSubTask,
            front,
            moves,
            scout,
            evidence: [...evidence.values()],
          });
        if (decision.stopProposal || decision.selected.move === "stop_current_front") {
          const boundary = boundaryForEvidence({
            evidence: [...evidence.values()],
            chunksById,
            roleMap,
            sectionChunks: allRelevantChunks,
            scout,
          });
          finalClosure = this.verifier.verify({
            completenessType: subTask.completenessType,
            evidence: [...evidence.values()],
            scout,
            roleMap,
            rowBoundaryChecked: boundary.checked,
            rowBoundaryEvidence: boundary.evidence,
            exhaustedDirections: ["summary_candidate_stop_proposal"],
          });
          traversalLog.push({
            round: state.round,
            from: front.anchorChunkId,
            direction: "stop",
            reason: `ClosureVerifier on stop proposal: ${finalClosure.status}. ${finalClosure.summary}`,
          });
          if (finalClosure.status === "closed") {
            nextFronts.push({ ...front, direction: "stop", confidence: "dead_end" });
            stoppedReason = "closed";
            break;
          }
          const fallbackMove = continuationAfterRejectedStop(moves);
          if (fallbackMove?.target) {
            const next = this.graphOps.applyMove(front, fallbackMove);
            const chunk = this.reader.getChunk(fallbackMove.target);
            if (chunk) {
              chunksById.set(chunk.id, chunk);
              roleInfoForChunk(chunk, roleMap, roleAdapter);
              visited.add(chunk.id);
              evidence.set(chunk.id, buildEvidenceItem(chunk, next));
              state.visitedNodeCount += 1;
              state.injectedTokens += Math.ceil(chunk.text.length / 4);
              appliedMoveCount += 1;
              traversalLog.push({
                round: state.round,
                from: front.anchorChunkId,
                to: chunk.id,
                direction: next.direction,
                reason: `ClosureVerifier rejected stop (${finalClosure.status}); continuing via ${fallbackMove.reason}`,
              });
              nextFronts.push(next);
              continue;
            }
          }
          nextFronts.push({ ...front, direction: "stop", confidence: "dead_end" });
          continue;
        }
        const legalMove = moves.find((move) => move.move === decision.selected.move && move.target === decision.selected.target);
        if (!legalMove || !legalMove.target) {
          nextFronts.push({ ...front, direction: "stop", confidence: "dead_end" });
          continue;
        }
        const next = this.graphOps.applyMove(front, legalMove);
        const chunk = this.reader.getChunk(legalMove.target);
        if (!chunk) {
          nextFronts.push({ ...front, direction: "stop", confidence: "dead_end" });
          continue;
        }
        chunksById.set(chunk.id, chunk);
        roleInfoForChunk(chunk, roleMap, roleAdapter);
        visited.add(chunk.id);
        evidence.set(chunk.id, buildEvidenceItem(chunk, next));
        state.visitedNodeCount += 1;
        state.injectedTokens += Math.ceil(chunk.text.length / 4);
        appliedMoveCount += 1;
        traversalLog.push({
          round: state.round,
          from: front.anchorChunkId,
          to: chunk.id,
          direction: next.direction,
          reason: decision.selected.reason,
        });
        nextFronts.push(next);
      }
      fronts = nextFronts;
      if (!stoppedReason && appliedMoveCount === 0 && fronts.every((front) => front.confidence === "dead_end")) stoppedReason = "fronts_exhausted";
      if (!stoppedReason && appliedMoveCount === 0 && fronts.length === 0) stoppedReason = "no_moves";
    }

    if (!shouldStopForClosure(finalClosure.status, stoppedReason)) {
      const boundary = boundaryForEvidence({
        evidence: [...evidence.values()],
        chunksById,
        roleMap,
        sectionChunks: allRelevantChunks,
        scout,
      });
      finalClosure = this.verifier.verify({
        completenessType: subTask.completenessType,
        evidence: [...evidence.values()],
        scout,
        roleMap,
        rowBoundaryChecked: boundary.checked,
        rowBoundaryEvidence: boundary.evidence,
        exhaustedDirections: [stoppedReason ?? "unknown_stop"],
      });
    }
    const evidenceChunkIds = uniqueStrings([...evidence.keys()]);
    const evidencePaths = evidenceChunkIds.length > 0 ? [evidencePath({
      subTask: traversalSubTask,
      chunksById,
      pathChunkIds: evidenceChunkIds,
      log: traversalLog,
      closure: finalClosure,
    })] : [];
    return {
      question: input.question,
      subTasks: [traversalSubTask],
      seedClusters,
      scoutResults: { [subTask.id]: scout },
      evidencePaths,
      conflicts: [],
      stoppedReason: stoppedReason ?? (finalClosure.status === "closed" ? "closed" : finalClosure.status === "partial" ? "partial" : "fronts_exhausted"),
      diagnostics: {
        visitedNodeCount: state.visitedNodeCount,
        rounds: state.round,
        injectedTokens: state.injectedTokens,
        legalMoveSets: this.graphOps.legalMoves(fronts, visited),
        closureStatus: finalClosure.status,
      },
    };
  }
}
