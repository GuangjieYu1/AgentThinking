import { createHash, randomUUID } from "node:crypto";
import type {
  Chunk,
  ContextBlock,
  ContextUnit,
  ContextUnitQualityReport,
  DocumentTreeNode,
  IndexingPerformanceReport,
  RetrievalUnit,
} from "@agent-thinking/contracts";

export interface BuiltContextIndex {
  contextUnits: ContextUnit[];
  retrievalUnits: RetrievalUnit[];
  qualityReport: ContextUnitQualityReport;
  performanceReport: IndexingPerformanceReport;
}

export interface BuildContextIndexOptions {
  buildId: string;
  versionId: string;
  chunks: Chunk[];
  treeNodes: DocumentTreeNode[];
  contextTokenBudget?: number | undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((percentileValue / 100) * (sorted.length - 1)));
  return sorted[index] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function blockTypeFor(chunk: Chunk): ContextBlock["type"] {
  if (chunk.nodeType === "table") return "table";
  if (chunk.nodeType === "section" || chunk.nodeType === "document") return "heading";
  if (chunk.text.trim().match(/^[-*]\s+|\n[-*]\s+/)) return "list_item";
  return chunk.nodeType === "paragraph" || chunk.nodeType === "sentence" ? "paragraph" : "unknown";
}

function sourceRangeFor(nodes: DocumentTreeNode[], chunks: Chunk[]): ContextUnit["sourceRange"] {
  const firstChunk = chunks[0];
  const lastChunk = chunks.at(-1) ?? firstChunk;
  const sourceNodeIds = nodes.length > 0 ? nodes.map((node) => node.id) : chunks.flatMap((chunk) => chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : []);
  const fallbackNodeId = firstChunk?.documentTreeNodeId ?? firstChunk?.id ?? "unknown";
  return {
    startSourceNodeId: sourceNodeIds[0] ?? fallbackNodeId,
    endSourceNodeId: sourceNodeIds.at(-1) ?? lastChunk?.documentTreeNodeId ?? fallbackNodeId,
    startChar: firstChunk?.startChar ?? 0,
    endChar: lastChunk?.endChar ?? firstChunk?.endChar ?? 0,
  };
}

function buildBlocks(chunks: Chunk[]): { text: string; blocks: ContextBlock[] } {
  const parts: string[] = [];
  const blocks: ContextBlock[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const prefix = parts.length === 0 ? "" : "\n\n";
    const startChar = parts.join("").length + prefix.length;
    parts.push(prefix, chunk.text);
    const endChar = startChar + chunk.text.length;
    blocks.push({
      blockId: chunk.blockId ?? `${chunk.id}:block`,
      type: blockTypeFor(chunk),
      startChar,
      endChar,
      ...(chunk.documentTreeNodeId ? { sourceNodeId: chunk.documentTreeNodeId } : {}),
      ordinal: index,
      textPreview: chunk.text.slice(0, 180),
    });
  }
  return { text: parts.join(""), blocks };
}

function retrievalWindows(text: string, targetChars = 1200, overlapChars = 160): Array<{ text: string; startChar: number; endChar: number }> {
  const windows: Array<{ text: string; startChar: number; endChar: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + targetChars, text.length);
    if (end < text.length) {
      const natural = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf("。", end), text.lastIndexOf(". ", end));
      if (natural > start + Math.floor(targetChars * 0.45)) end = natural + 1;
    }
    const value = text.slice(start, end).trim();
    if (value) windows.push({ text: value, startChar: start, endChar: end });
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return windows;
}

export function buildContextIndex(options: BuildContextIndexOptions): BuiltContextIndex {
  const started = Date.now();
  const chunksByNode = new Map<string, Chunk[]>();
  for (const chunk of options.chunks.filter((chunk) => chunk.text.trim() && chunk.nodeType !== "sentence")) {
    const key = chunk.documentTreeNodeId ?? chunk.id;
    const group = chunksByNode.get(key) ?? [];
    group.push(chunk);
    chunksByNode.set(key, group);
  }
  const nodeById = new Map(options.treeNodes.map((node) => [node.id, node]));
  const contextUnits: ContextUnit[] = [];
  const retrievalUnits: RetrievalUnit[] = [];

  for (const [ordinal, [sourceKey, sourceChunks]] of [...chunksByNode.entries()].entries()) {
    sourceChunks.sort((left, right) => left.ordinal - right.ordinal);
    const nodes = [...new Set(sourceChunks.flatMap((chunk) => chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : []))]
      .flatMap((id) => nodeById.get(id) ? [nodeById.get(id)!] : []);
    const primaryNode = nodes[0] ?? nodeById.get(sourceKey);
    const { text, blocks } = buildBlocks(sourceChunks);
    const headingPath = primaryNode?.headingPath ?? (sourceChunks[0]?.headingPath?.split("/").map((part) => part.trim()).filter(Boolean) ?? []);
    const stableKey = hash([
      options.versionId,
      primaryNode?.id ?? sourceKey,
      sourceChunks[0]?.ordinal ?? ordinal,
      headingPath.join("/"),
      "document_tree_boundary",
    ].join("|"));
    const contextUnitId = `cu-${randomUUID()}`;
    const contextUnit: ContextUnit = {
      id: contextUnitId,
      stableKey,
      buildId: options.buildId,
      versionId: options.versionId,
      sourceNodeIds: nodes.length > 0 ? nodes.map((node) => node.id) : sourceChunks.flatMap((chunk) => chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : []),
      primarySourceNodeId: primaryNode?.id ?? sourceChunks[0]?.documentTreeNodeId ?? null,
      sourceRange: sourceRangeFor(nodes, sourceChunks),
      headingPath,
      displayHeadingPath: headingPath,
      ordinal,
      ordinalInPrimarySource: ordinal,
      text,
      blocks,
      retrievalUnitIds: [],
      estimatedTokens: estimateTokens(text),
      boundaryReason: "document_tree_boundary",
    };
    for (const [windowIndex, window] of retrievalWindows(text).entries()) {
      const retrievalUnit: RetrievalUnit = {
        id: `ru-${randomUUID()}`,
        stableKey: hash([stableKey, windowIndex, window.startChar, window.endChar, window.text.slice(0, 80)].join("|")),
        buildId: options.buildId,
        versionId: options.versionId,
        contextUnitId,
        text: window.text,
        headingPath,
        ordinal: retrievalUnits.length,
        startChar: window.startChar,
        endChar: window.endChar,
        startLine: sourceChunks[0]?.startLine ?? null,
        endLine: sourceChunks.at(-1)?.endLine ?? null,
        pageNumber: sourceChunks[0]?.pageNumber ?? null,
        estimatedTokens: estimateTokens(window.text),
      };
      contextUnit.retrievalUnitIds.push(retrievalUnit.id);
      retrievalUnits.push(retrievalUnit);
    }
    contextUnits.push(contextUnit);
  }

  const contextChars = contextUnits.map((unit) => unit.text.length);
  const retrievalChars = retrievalUnits.map((unit) => unit.text.length);
  const retrievalPerContext = contextUnits.map((unit) => unit.retrievalUnitIds.length);
  const boundaryReasonDistribution = contextUnits.reduce<Record<string, number>>((accumulator, unit) => {
    accumulator[unit.boundaryReason] = (accumulator[unit.boundaryReason] ?? 0) + 1;
    return accumulator;
  }, {});
  const budget = options.contextTokenBudget ?? 6000;
  const qualityReport: ContextUnitQualityReport = {
    contextUnitCount: contextUnits.length,
    retrievalUnitCount: retrievalUnits.length,
    avgContextChars: average(contextChars),
    avgRetrievalChars: average(retrievalChars),
    p50ContextChars: percentile(contextChars, 50),
    p90ContextChars: percentile(contextChars, 90),
    maxContextChars: Math.max(0, ...contextChars),
    avgRetrievalPerContext: average(retrievalPerContext),
    p90RetrievalPerContext: percentile(retrievalPerContext, 90),
    boundaryReasonDistribution,
    strongBoundaryViolations: [],
    overBudgetContextUnits: contextUnits.flatMap((unit) => (unit.estimatedTokens ?? 0) > budget
      ? [{ contextUnitId: unit.id, estimatedTokens: unit.estimatedTokens ?? 0, budget }]
      : []),
    suspiciousTinyContextUnits: contextUnits.filter((unit) => unit.text.length < 80).map((unit) => unit.id),
    suspiciousHugeRetrievalUnits: retrievalUnits.filter((unit) => unit.text.length > 2400).map((unit) => unit.id),
    generatedAt: new Date().toISOString(),
  };
  return {
    contextUnits,
    retrievalUnits,
    qualityReport,
    performanceReport: {
      v2ContextBuildTimeMs: Date.now() - started,
      v2RetrievalBuildTimeMs: 0,
      contextUnitCount: contextUnits.length,
      retrievalUnitCount: retrievalUnits.length,
      vectorCount: 0,
    },
  };
}
