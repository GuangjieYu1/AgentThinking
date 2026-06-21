import type {
  Chunk,
  ChunkEvidencePack,
  EvidenceCitation,
  EvidencePack,
  PulseAnswerOutput,
  PulseEvidenceGap,
  PulseEvidenceRow,
  PulseInputMode,
  RetrievalTrace,
  TraversalActiveFront,
  TraversalClosureVerdict,
  TraversalEvidenceItem,
  TraversalEvidencePath,
  TraversalRetrievalResult,
  TraversalSubTask,
} from "@agent-thinking/contracts";
import type { PendingPulseHit } from "../../db.js";
import { type ClosureRoleInfo } from "./closure-verifier.js";
import { TableRoleAdapter } from "./table-role-adapter.js";
import { byOrdinal, chunkLabel, hasNumericSignal, normalizeText, uniqueStrings } from "./utils.js";

export const defaultClosedVerdict: TraversalClosureVerdict = {
  status: "closed",
  verifierType: "none",
  confidence: "high",
  summary: "No typed closure required.",
  checks: { notApplicable: true },
};

export function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, Math.max(0, max - 1)).trimEnd() : normalized;
}

export function numericValue(text: string): number | undefined {
  const match = text.match(/[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[-+]?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function unitFromText(text: string): string | undefined {
  return text.match(/亿元|万元|千元|元|亿|万|%/)?.[0];
}

export function metricFromChunkText(text: string): string | undefined {
  const normalized = normalizeText(text);
  const metricKeyword = normalized.match(/募集金额|募集资金|金额|余额|总额|规模|数量|比例|占比|收入|成本|利润|支出|费用/u)?.[0];
  if (metricKeyword) return metricKeyword;
  const numeric = normalized.match(/[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[-+]?\d+(?:\.\d+)?/);
  if (!numeric || numeric.index === undefined) return undefined;
  const before = normalized.slice(Math.max(0, numeric.index - 36), numeric.index).replace(/[|,，:：;；]/g, " ").trim();
  const phrase = before.match(/[\p{Script=Han}A-Za-z0-9（）()]{2,24}$/u)?.[0];
  return phrase || undefined;
}

export function buildEvidenceItem(
  chunk: Chunk,
  front: TraversalActiveFront,
): TraversalEvidenceItem {
  const value = numericValue(chunk.text);
  const unit = unitFromText(chunk.text);
  const metric = chunk.headingPath ?? metricFromChunkText(chunk.text);
  return {
    chunkId: chunk.id,
    ...(value !== undefined ? { value } : {}),
    ...(unit ? { unit } : {}),
    ...(metric ? { metric } : {}),
    status: "continue",
    direction: front.direction,
    pathChunkIds: front.pathChunkIds,
    reason: truncateText(chunk.text, 160),
  };
}

export function roleInfoForChunk(
  chunk: Chunk,
  roleMap: Map<string, ClosureRoleInfo>,
  roleAdapter: TableRoleAdapter,
): ClosureRoleInfo {
  const existing = roleMap.get(chunk.id);
  if (existing) return existing;
  const classified = roleAdapter.classify(chunk);
  const info = { role: classified.role, confidence: classified.confidence };
  roleMap.set(chunk.id, info);
  return info;
}

export function addRoleInfos(
  chunks: Chunk[],
  roleMap: Map<string, ClosureRoleInfo>,
  roleAdapter: TableRoleAdapter,
): void {
  for (const chunk of chunks) roleInfoForChunk(chunk, roleMap, roleAdapter);
}

export function sameHeading(left: string | null, right: string | null): boolean {
  return normalizeText(left) === normalizeText(right);
}

export interface RowBoundaryResult {
  checked: boolean;
  evidence: Record<string, unknown>;
}

export function rowBoundaryChecked(input: {
  evidence: TraversalEvidenceItem[];
  chunksById: Map<string, Chunk>;
  roleMap: Map<string, ClosureRoleInfo>;
  headingPath?: string | null | undefined;
  sectionChunks: Chunk[];
}): RowBoundaryResult {
  const evidenceChunkIds = new Set(input.evidence.map((item) => item.chunkId));
  const dataRowChunks = input.evidence
    .flatMap((item) => {
      const chunk = input.chunksById.get(item.chunkId);
      const role = input.roleMap.get(item.chunkId);
      return chunk && role?.role === "data_row" && role.confidence >= 0.6 ? [chunk] : [];
    })
    .sort(byOrdinal);
  if (dataRowChunks.length === 0) {
    return {
      checked: false,
      evidence: {
        reason: "no_data_row_evidence",
        dataRowChunkIds: [],
      },
    };
  }

  const headingPath = input.headingPath ?? dataRowChunks[0]?.headingPath ?? null;
  const sectionChunks = input.sectionChunks
    .filter((chunk) => sameHeading(chunk.headingPath, headingPath))
    .sort(byOrdinal);
  const expectedDataRows = sectionChunks.filter((chunk) => {
    const role = input.roleMap.get(chunk.id);
    return role?.role === "data_row" && role.confidence >= 0.6;
  });
  const missingDataRows = expectedDataRows.filter((chunk) => !evidenceChunkIds.has(chunk.id));
  const ordinals = dataRowChunks.map((chunk) => chunk.ordinal);
  const minOrdinal = Math.min(...ordinals);
  const maxOrdinal = Math.max(...ordinals);
  const allDataRowsVisited = expectedDataRows.length > 0 && missingDataRows.length === 0;
  const lastDataRow = dataRowChunks.at(-1);
  const nextSibling = [...input.sectionChunks]
    .filter((chunk) =>
      lastDataRow &&
      chunk.libraryId === lastDataRow.libraryId &&
      chunk.versionId === lastDataRow.versionId &&
      chunk.ordinal > lastDataRow.ordinal
    )
    .sort(byOrdinal)[0];
  const nextSiblingRole = nextSibling ? input.roleMap.get(nextSibling.id) : undefined;
  const terminalSibling = nextSibling
    ? nextSiblingRole?.role === "summary" || !sameHeading(nextSibling.headingPath, headingPath)
    : false;

  return {
    checked: allDataRowsVisited && terminalSibling,
    evidence: {
      headingPath,
      ordinalRange: [minOrdinal, maxOrdinal],
      dataRowChunkIds: dataRowChunks.map((chunk) => chunk.id),
      expectedDataRowChunkIds: expectedDataRows.map((chunk) => chunk.id),
      missingDataRowChunkIds: missingDataRows.map((chunk) => chunk.id),
      nextSiblingChunkId: nextSibling?.id,
      nextSiblingRole: nextSiblingRole?.role,
      nextSiblingHeadingPath: nextSibling?.headingPath ?? null,
      allDataRowsVisited,
      terminalSibling,
    },
  };
}

export function evidencePath(input: {
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

export function hitsFromChunks(chunks: Chunk[], paths: TraversalEvidencePath[]): PendingPulseHit[] {
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

export function evidenceRowsFromChunks(chunks: Chunk[], paths: TraversalEvidencePath[]): PulseEvidenceRow[] {
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

export function citationsFromRows(rows: PulseEvidenceRow[], chunksById: Map<string, Chunk>): EvidenceCitation[] {
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

export function retrievalTrace(result: TraversalRetrievalResult, rows: PulseEvidenceRow[]): RetrievalTrace[] {
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

export function gapsFromResult(result: TraversalRetrievalResult): PulseEvidenceGap[] {
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

export function answerFromRows(question: string, rows: PulseEvidenceRow[], result: TraversalRetrievalResult): PulseAnswerOutput {
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

export function chunkEvidencePack(question: string, mode: PulseInputMode, chunks: Chunk[], result: TraversalRetrievalResult): ChunkEvidencePack {
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

export function storageEvidencePack(input: {
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
