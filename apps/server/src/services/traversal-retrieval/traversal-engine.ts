import type {
  Chunk,
  ChunkEvidencePack,
  EvidenceCitation,
  EvidencePack,
  PulseAnswerOutput,
  PulseEvidenceGap,
  PulseEvidenceRow,
  PulseInputMode,
  PulseStreamEvent,
  RetrievalTrace,
  TraversalActiveFront,
  TraversalClosureStatus,
  TraversalClosureVerdict,
  TraversalEvidenceItem,
  TraversalEvidencePath,
  TraversalLegalMove,
  TraversalRetrievalPattern,
  TraversalRetrievalResult,
  TraversalScoutResult,
  TraversalSeedCandidate,
  TraversalSelectedMove,
  TraversalStopReason,
  TraversalSubTask,
} from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../../db.js";
import { type AoriTraversalAnswerResult, buildAoriTraversalMap } from "../aori-traversal-answer.js";
import type { VectorStore } from "../vector-store.js";
import { ClosureVerifier } from "./closure-verifier.js";
import {
  defaultTraversalGraphLimits,
  GraphOps,
  HardStopChecker,
  type TraversalBudgetState,
  type TraversalGraphLimits,
} from "./graph-ops.js";
import { ScoutExtractor } from "./scout-extractor.js";
import { SeedArbitrationEngine } from "./seed-arbitration.js";
import { TableRoleAdapter } from "./table-role-adapter.js";
import type { ChunkGraphReader } from "./table-skeleton-extractor.js";
import { chunkLabel, hasNumericSignal, previewText, termOverlap, uniqueStrings } from "./utils.js";

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

interface LLMPolicyInput {
  subTask: TraversalSubTask;
  front: TraversalActiveFront;
  moves: TraversalLegalMove[];
  scout: TraversalScoutResult;
  evidence: TraversalEvidenceItem[];
}

interface LLMPolicyDecision {
  selected: TraversalSelectedMove;
  stopProposal: boolean;
}

const defaultClosedVerdict: TraversalClosureVerdict = {
  status: "closed",
  verifierType: "none",
  confidence: "high",
  summary: "No typed closure required.",
  checks: { notApplicable: true },
};

function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, Math.max(0, max - 1)).trimEnd() : normalized;
}

function numericValue(text: string): number | undefined {
  const match = text.match(/[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[-+]?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unitFromText(text: string): string | undefined {
  return text.match(/亿元|万元|千元|元|亿|万|%/)?.[0];
}

function closedEnough(status: TraversalClosureStatus): boolean {
  return status === "closed" || status === "partial" || status === "mismatch" || status === "failed" || status === "low_confidence";
}

function patternForQuestion(question: string): TraversalRetrievalPattern {
  if (/合计|总计|总额|募集|金额|余额|表|明细|sum|total/i.test(question)) return "table_horizontal";
  if (/时间|日期|年度|年|月|timeline|when/i.test(question)) return "timeline_chain";
  if (/哪些|名单|变动|成员|entity|who/i.test(question)) return "entity_scatter";
  if (/说明|详细|原因|政策|章节|section/i.test(question)) return "hierarchical_depth";
  return "single_point";
}

function completenessForPattern(pattern: TraversalRetrievalPattern, question: string): TraversalSubTask["completenessType"] {
  if (pattern === "table_horizontal" && /合计|总计|总额|金额|余额|sum|total/i.test(question)) return "sum_alignment";
  if (pattern === "table_horizontal" && /几|多少|count|number/i.test(question)) return "row_count";
  if (pattern === "timeline_chain") return "timeline_end";
  if (pattern === "single_point") return "none";
  return "entity_boundary";
}

function directionBiasForPattern(pattern: TraversalRetrievalPattern): TraversalSubTask["directionBias"] {
  if (pattern === "hierarchical_depth" || pattern === "timeline_chain") return "down_first";
  if (pattern === "single_point") return "none";
  return "side_first";
}

function fallbackPatterns(pattern: TraversalRetrievalPattern): TraversalRetrievalPattern[] {
  if (pattern === "table_horizontal") return ["hierarchical_depth", "entity_scatter"];
  if (pattern === "entity_scatter") return ["timeline_chain", "hierarchical_depth"];
  if (pattern === "timeline_chain") return ["entity_scatter", "hierarchical_depth"];
  if (pattern === "hierarchical_depth") return ["entity_scatter", "table_horizontal"];
  return [];
}

function makeSubTask(question: string): TraversalSubTask {
  const pattern = patternForQuestion(question);
  return {
    id: "subtask-1",
    question,
    pattern,
    patternConfidence: pattern === "single_point" ? 0.6 : 0.72,
    fallbackPatterns: fallbackPatterns(pattern),
    completenessType: completenessForPattern(pattern, question),
    mergePolicy: "independent_section",
    directionBias: directionBiasForPattern(pattern),
    rationale: "Traversal v2 deterministic planner selected the closest retrieval pattern from question terms.",
  };
}

class LocalLLMPolicy {
  choose(input: LLMPolicyInput): LLMPolicyDecision {
    const summaryStop = input.front.lastSkeleton.role === "summary" || (
      input.subTask.pattern === "table_horizontal" &&
      input.evidence.length > 0 &&
      input.scout.calibrationStatus === "calibrated" &&
      /合计|总计|小计|汇总|total|subtotal|summary/i.test(input.front.lastSkeleton.preview)
    );
    const stop = input.moves.find((move) => move.move === "stop_current_front");
    if (summaryStop && stop) {
      return {
        selected: {
          move: stop.move,
          ...(stop.target ? { target: stop.target } : {}),
          reason: "summary_candidate stop proposal",
          confidence: 0.72,
        },
        stopProposal: true,
      };
    }

    const orderedMoveTypes = input.subTask.pattern === "table_horizontal"
      ? ["sibling_next", "child", "nearby", "sibling_prev", "parent"] as const
      : input.subTask.directionBias === "down_first"
        ? ["child", "sibling_next", "nearby", "parent", "sibling_prev"] as const
        : ["sibling_next", "nearby", "child", "sibling_prev", "parent"] as const;
    for (const moveType of orderedMoveTypes) {
      const move = input.moves.find((candidate) => candidate.move === moveType);
      if (move) {
        return {
          selected: {
            move: move.move,
            ...(move.target ? { target: move.target } : {}),
            reason: input.subTask.pattern === "table_horizontal" && move.move === "sibling_next"
              ? "table_horizontal policy prioritizes sibling_next"
              : `policy selected ${move.move}`,
            confidence: input.subTask.pattern === "table_horizontal" && move.move === "sibling_next" ? 0.82 : 0.64,
          },
          stopProposal: false,
        };
      }
    }
    return {
      selected: {
        move: "stop_current_front",
        reason: "no non-stop legal moves remain",
        confidence: 0.5,
      },
      stopProposal: true,
    };
  }
}

class DatabaseChunkGraphReader implements ChunkGraphReader {
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

function buildEvidenceItem(
  chunk: Chunk,
  front: TraversalActiveFront,
  scout: TraversalScoutResult,
): TraversalEvidenceItem {
  const value = numericValue(chunk.text);
  const roleMetric = scout.metric ?? chunk.headingPath ?? "source fact";
  return {
    chunkId: chunk.id,
    ...(value !== undefined ? { value } : {}),
    ...(unitFromText(chunk.text) ?? scout.unit ? { unit: unitFromText(chunk.text) ?? scout.unit } : {}),
    metric: roleMetric,
    status: "continue",
    direction: front.direction,
    pathChunkIds: front.pathChunkIds,
    reason: truncateText(chunk.text, 160),
  };
}

function rowBoundaryChecked(evidence: TraversalEvidenceItem[]): boolean {
  return evidence.length >= 2 && new Set(evidence.map((item) => item.direction)).size >= 1;
}

function evidencePath(input: {
  subTask: TraversalSubTask;
  chunksById: Map<string, Chunk>;
  pathChunkIds: string[];
  log: TraversalEvidencePath["traversalLog"];
  closure: TraversalClosureVerdict;
}): TraversalEvidencePath {
  const roleAdapter = new TableRoleAdapter();
  return {
    subTaskId: input.subTask.id,
    question: input.subTask.question,
    pattern: input.subTask.pattern,
    path: input.pathChunkIds.flatMap((chunkId) => {
      const chunk = input.chunksById.get(chunkId);
      if (!chunk) return [];
      return [{
        chunkId,
        role: roleAdapter.classify(chunk).role,
        direction: input.log.find((entry) => entry.to === chunkId)?.direction ?? "seed",
        content: chunk.text,
      }];
    }),
    traversalLog: input.log,
    closure: input.closure,
    conflicts: [],
  };
}

function hitsFromChunks(chunks: Chunk[], paths: TraversalEvidencePath[]): PendingPulseHit[] {
  const pathByChunkId = new Map(paths.flatMap((path) => path.path.map((item) => [item.chunkId, path] as const)));
  return chunks.map((chunk, index) => {
    const path = pathByChunkId.get(chunk.id);
    return {
      targetType: "chunk",
      targetId: chunk.id,
      score: Math.max(0.42, Math.min(0.88, 0.68 + (paths[0]?.closure.status === "closed" ? 0.08 : 0))),
      reason: path?.closure.summary ?? "Traversal retrieval v2 selected this chunk.",
      pathRole: "direct",
      stepIndex: index + 1,
      observation: "Traversal retrieval v2 visited this source chunk through legal graph moves.",
      rationale: path?.traversalLog.map((entry) => entry.reason).join(" -> ") || "seed chunk selected by traversal arbitration",
      label: chunkLabel(chunk),
      excerpt: chunk.text.slice(0, 220),
    };
  });
}

function evidenceRowsFromChunks(chunks: Chunk[], paths: TraversalEvidencePath[]): PulseEvidenceRow[] {
  const pathByChunkId = new Map(paths.flatMap((path) => path.path.map((item) => [item.chunkId, path] as const)));
  return chunks.map((chunk, index): PulseEvidenceRow => {
    const path = pathByChunkId.get(chunk.id);
    return {
      rowId: `traversal-v2-row-${index + 1}`,
      evidenceType: hasNumericSignal(chunk.text) ? "amount" : "fact",
      claimText: truncateText(chunk.text, 500),
      evidenceChunkId: chunk.id,
      treeNodeId: chunk.documentTreeNodeId ?? null,
      evidenceQuote: truncateText(chunk.text, 700),
      role: hasNumericSignal(chunk.text) ? "itemized_value" : "direct_fact",
      authority: "documentary_record",
      usage: "answer_core",
      classificationRationale: path?.closure.summary ?? "Traversal retrieval v2 collected this chunk through bounded graph traversal.",
      confidence: path?.closure.confidence === "high" ? 0.82 : path?.closure.confidence === "medium" ? 0.68 : 0.5,
      countedInAnswer: true,
      ...(chunk.versionId ? { versionId: chunk.versionId } : {}),
      ...(chunk.headingPath ? { headingPath: [chunk.headingPath] } : {}),
    };
  });
}

function citationsFromRows(rows: PulseEvidenceRow[], chunksById: Map<string, Chunk>): EvidenceCitation[] {
  return rows.map((row) => {
    const chunk = chunksById.get(row.evidenceChunkId);
    return {
      chunkId: row.evidenceChunkId,
      treeNodeId: row.treeNodeId ?? chunk?.documentTreeNodeId ?? null,
      quote: row.evidenceQuote,
      headingPath: chunk?.headingPath ?? null,
      pageNumber: chunk?.pageNumber ?? null,
    };
  });
}

function retrievalTrace(result: TraversalRetrievalResult, rows: PulseEvidenceRow[]): RetrievalTrace[] {
  return [{
    stepIndex: 1,
    tool: "buildEvidencePack",
    purpose: "Traversal retrieval v2 selected seed chunks, expanded legal graph moves, and verified typed closure.",
    inputIds: result.seedClusters.map((cluster) => cluster.anchorChunkId),
    outputIds: uniqueStrings(result.evidencePaths.flatMap((path) => path.path.map((entry) => entry.chunkId))),
    newEvidenceRowCount: rows.length,
    status: rows.length > 0 ? "success" : "empty",
  }];
}

function gapsFromResult(result: TraversalRetrievalResult): PulseEvidenceGap[] {
  if (result.stoppedReason === "closed") return [];
  if (result.stoppedReason === "partial") {
    return [{
      type: "other",
      description: "Traversal retrieval v2 reached only partial closure.",
      suggestedQueries: [result.question],
      severity: "medium",
    }];
  }
  return [{
    type: "missing_itemized_evidence",
    description: `Traversal retrieval v2 stopped before closed evidence coverage: ${result.stoppedReason}.`,
    suggestedQueries: [result.question],
    severity: "medium",
  }];
}

function answerFromRows(question: string, rows: PulseEvidenceRow[], result: TraversalRetrievalResult): PulseAnswerOutput {
  const relevant = rows.slice(0, 8);
  const answer = relevant.length === 0
    ? "未找到足够证据回答该问题。"
    : [
      `基于 traversal retrieval v2 找到 ${relevant.length} 条证据：`,
      ...relevant.map((row, index) => `${index + 1}. ${row.claimText}`),
    ].join("\n");
  return {
    answer,
    summary: relevant.length === 0
      ? "Traversal retrieval v2 did not collect answerable evidence."
      : truncateText(relevant.map((row) => row.claimText).join("；"), 300),
    diagnostics: {
      answerPipeline: "aori_traversal",
      fallbackTraversalUsed: true,
      structuredResult: result,
      sourceChunkIds: rows.map((row) => row.evidenceChunkId),
      warnings: result.stoppedReason === "closed" ? [] : [`Traversal stopped with ${result.stoppedReason}.`],
    },
    evidenceRows: rows,
  };
}

function chunkEvidencePack(question: string, mode: PulseInputMode, chunks: Chunk[], result: TraversalRetrievalResult): ChunkEvidencePack {
  const pathByChunkId = new Map(result.evidencePaths.flatMap((path) => path.path.map((item) => [item.chunkId, path] as const)));
  return {
    question,
    mode: mode === "progressive" ? "dfs_pulse" : "bfs_full",
    selectedChunks: chunks.map((chunk) => {
      const path = pathByChunkId.get(chunk.id);
      return {
        chunkId: chunk.id,
        ...(chunk.documentTreeNodeId ? { sourceNodeId: chunk.documentTreeNodeId } : {}),
        ...(chunk.versionId ? { versionId: chunk.versionId } : {}),
        path: path?.traversalLog.map((entry) => ({
          nodeId: entry.from,
          title: entry.direction,
          summary: entry.reason,
          decision: "selected" as const,
          reason: entry.reason,
        })) ?? [],
        retrievalSummary: "Traversal retrieval v2 selected this chunk through bounded graph traversal.",
        relevanceReason: path?.closure.summary ?? "Selected by traversal retrieval v2.",
        confidence: path?.closure.confidence === "high" ? 0.82 : path?.closure.confidence === "medium" ? 0.68 : 0.5,
      };
    }),
    skippedNodes: [],
    unresolvedQuestions: result.stoppedReason === "closed" ? [] : [`Traversal retrieval v2 stopped with ${result.stoppedReason}.`],
    diagnostics: {
      visitedNodeCount: Number(result.diagnostics.visitedNodeCount ?? chunks.length),
      selectedChunkCount: chunks.length,
      stoppedReason: result.stoppedReason,
    },
  };
}

function storageEvidencePack(input: {
  question: string;
  rows: PulseEvidenceRow[];
  chunksById: Map<string, Chunk>;
  result: TraversalRetrievalResult;
  chunkPack: ChunkEvidencePack;
}): EvidencePack {
  return {
    id: `traversal-v2-pack-${Date.now()}`,
    question: input.question,
    evidencePackSchemaVersion: 1,
    pipeline: {
      indexProfile: "v1",
      packBuilder: "aori_traversal",
      model: "traversal-v2-deterministic-policy",
      promptVersion: "traversal-retrieval-v2",
    },
    pipelineVersion: {
      indexerVersion: "aori-document-v1",
      contextUnitBuilderVersion: "not_used",
      retrievalUnitBuilderVersion: "not_used",
      packBuilderVersion: "traversal-retrieval-v2",
      evidenceExtractorVersion: "traversal-retrieval-v2",
      validatorVersion: "typed-closure-verifier-v2",
      promptVersion: "traversal-retrieval-v2",
    },
    answerMode: "citation_supported",
    answerModeReason: "Feature-flagged traversal retrieval v2 collected source chunks through graph traversal and typed closure verification.",
    chunkEvidencePack: input.chunkPack,
    chunkSummaries: [],
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows: input.rows,
    citations: citationsFromRows(input.rows, input.chunksById),
    gaps: gapsFromResult(input.result),
    retrievalTrace: retrievalTrace(input.result, input.rows),
    diagnostics: {
      answerPipeline: "aori_traversal",
      traversalRetrievalV2: input.result,
      sourceChunkIds: input.rows.map((row) => row.evidenceChunkId),
      fallbackTraversalUsed: true,
    },
  };
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
    private readonly vectors: VectorStore,
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
    const candidates = this.collectSeedCandidates(input.libraryId, input.question);
    const candidateChunks = uniqueChunks(this.db.getChunksByIds(candidates.map((candidate) => candidate.chunkId)));
    const allRelevantChunks = uniqueChunks([
      ...candidateChunks,
      ...this.db.getNeighborChunks(candidateChunks.map((chunk) => chunk.id), this.limits.neighborWindow),
    ]);
    const seedClusters = this.seeds.arbitrate({
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
    let fronts = this.graphOps.createInitialFronts(seedClusters);
    const chunksById = new Map(allRelevantChunks.map((chunk) => [chunk.id, chunk]));
    const visited = new Set<string>();
    const evidence = new Map<string, TraversalEvidenceItem>();
    const traversalLog: TraversalEvidencePath["traversalLog"] = [];
    let finalClosure = subTask.completenessType === "none" ? defaultClosedVerdict : this.verifier.verify({
      completenessType: subTask.completenessType,
      evidence: [],
      scout,
      rowBoundaryChecked: false,
      exhaustedDirections: [],
    });
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
      visited.add(chunk.id);
      evidence.set(chunk.id, buildEvidenceItem(chunk, front, scout));
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
        const decision = this.policy.choose({
          subTask,
          front,
          moves,
          scout,
          evidence: [...evidence.values()],
        });
        if (decision.stopProposal || decision.selected.move === "stop_current_front") {
          finalClosure = this.verifier.verify({
            completenessType: subTask.completenessType,
            evidence: [...evidence.values()],
            scout,
            rowBoundaryChecked: rowBoundaryChecked([...evidence.values()]),
            exhaustedDirections: ["summary_candidate_stop_proposal"],
          });
          traversalLog.push({
            round: state.round,
            from: front.anchorChunkId,
            direction: "stop",
            reason: `ClosureVerifier on stop proposal: ${finalClosure.status}. ${finalClosure.summary}`,
          });
          nextFronts.push(
            closedEnough(finalClosure.status)
              ? { ...front, direction: "stop", confidence: "dead_end" }
              : front,
          );
          if (finalClosure.status === "closed") {
            stoppedReason = "closed";
            break;
          }
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
        visited.add(chunk.id);
        evidence.set(chunk.id, buildEvidenceItem(chunk, next, scout));
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

    if (!closedEnough(finalClosure.status)) {
      finalClosure = this.verifier.verify({
        completenessType: subTask.completenessType,
        evidence: [...evidence.values()],
        scout,
        rowBoundaryChecked: rowBoundaryChecked([...evidence.values()]),
        exhaustedDirections: [stoppedReason ?? "unknown_stop"],
      });
    }
    const evidenceChunkIds = uniqueStrings([...evidence.keys()]);
    const evidencePaths = evidenceChunkIds.length > 0 ? [evidencePath({
      subTask,
      chunksById,
      pathChunkIds: evidenceChunkIds,
      log: traversalLog,
      closure: finalClosure,
    })] : [];
    return {
      question: input.question,
      subTasks: [subTask],
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

  private collectSeedCandidates(libraryId: string, question: string): TraversalSeedCandidate[] {
    const candidates: TraversalSeedCandidate[] = [];
    const seen = new Set<string>();
    const add = (candidate: TraversalSeedCandidate): void => {
      const key = `${candidate.source}:${candidate.chunkId}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };
    const map = buildAoriTraversalMap(this.db, libraryId);
    for (const node of Object.values(map.nodesById)) {
      const score = Math.max(termOverlap(question, `${node.title} ${node.summary}`), node.confidence * 0.65);
      if (score < 0.08 && !node.chunkIds.length) continue;
      for (const chunkId of node.chunkIds.slice(0, 3)) {
        add({
          chunkId,
          source: "AORI",
          score,
          reliability: 0.95,
          reason: `AORI node ${node.title} matched traversal seed collection.`,
        });
      }
    }
    void this.vectors.usesSqliteVec;
    // VectorStore search needs an embedding from a model. Traversal v2 seed collection keeps
    // this deterministic and relies on keyword plus AORI seeds until model policy is wired.
    for (const result of this.db.searchText(libraryId, question, 8)) {
      add({
        chunkId: result.chunk.id,
        source: "keyword",
        score: Math.max(0.35, Math.min(1, result.score)),
        reliability: 0.6,
        reason: "keyword seed from chunk FTS",
      });
    }
    for (const chunk of this.keywordFallbackChunks(libraryId, question)) {
      add({
        chunkId: chunk.id,
        source: "vector",
        score: Math.max(0.2, termOverlap(question, `${chunk.headingPath ?? ""} ${chunk.text}`)),
        reliability: 0.8,
        reason: "deterministic vector-slot fallback seed from text overlap",
      });
    }
    return candidates;
  }

  private keywordFallbackChunks(libraryId: string, question: string): Chunk[] {
    const indexes = this.db.listAoriDocumentIndexes(libraryId);
    const indexedChunkIds = uniqueStrings(indexes.flatMap((index) => [
      ...index.understanding.evidenceChunkIds,
      ...index.aspects.flatMap((aspect) => [
        ...aspect.items.flatMap((item) => item.evidenceChunkIds),
        ...aspect.relations.flatMap((relation) => relation.evidenceChunkIds),
      ]),
      ...index.selfQuestions.flatMap((entry) => entry.evidenceChunkIds),
    ]));
    return this.db.getChunksByIds(indexedChunkIds)
      .map((chunk) => ({ chunk, score: termOverlap(question, `${chunk.headingPath ?? ""} ${previewText(chunk.text, 120)}`) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal)
      .slice(0, 5)
      .map((entry) => entry.chunk);
  }
}
