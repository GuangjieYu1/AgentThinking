import type {
  AoriTraversalNode,
  Chunk,
  EvidenceCitation,
  FacetFactRow,
  FacetFactTable,
  PulseEvidenceRow,
  RetrievalTrace,
} from "@agent-thinking/contracts";
import type { PendingPulseHit } from "../../db.js";
import { emitSkillEvent, type AoriSkillExecutionInput, type AoriSkillExecutionResult } from "./types.js";

interface FacetSumRow {
  rowId: string;
  displayName: string;
  amount: number;
  unit: string;
  evidenceChunkIds: string[];
  quote: string;
}

interface FacetSumResult {
  total: number;
  unit: string;
  rows: FacetSumRow[];
  warnings: string[];
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, Math.max(0, max - 1)).trimEnd() : normalized;
}

function targetAspectNodes(input: AoriSkillExecutionInput): AoriTraversalNode[] {
  const targetIds = new Set(input.route.targetAspects.map((aspect) => aspect.aspectId));
  const nodes = Object.values(input.map.nodesById)
    .filter((node) => node.type === "aspect" && node.aspectId && targetIds.has(node.aspectId));
  if (nodes.length > 0) return nodes;
  return Object.values(input.map.nodesById)
    .filter((node) => node.type === "aspect" && node.childIds.some((childId) => input.map.nodesById[childId]?.type === "aspect_item"))
    .sort((left, right) => right.childIds.length - left.childIds.length)
    .slice(0, 1);
}

function itemNodesForAspect(input: AoriSkillExecutionInput, aspect: AoriTraversalNode): AoriTraversalNode[] {
  return aspect.childIds
    .map((childId) => input.map.nodesById[childId])
    .filter((node): node is AoriTraversalNode => node?.type === "aspect_item");
}

function valuesFromUnknown(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(valuesFromUnknown);
  if (value && typeof value === "object") return Object.values(value).flatMap(valuesFromUnknown);
  return [value];
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.match(/(-?\d+(?:\.\d+)?)\s*([A-Za-z\u4e07\u5143\u6d93]*)?/u);
  if (!match?.[1]) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? "";
  return /wan|\u4e07|\u6d93/i.test(unit) ? amount * 10000 : amount;
}

function rowAmount(row: FacetFactRow): number | undefined {
  for (const field of ["converted_amount_rmb", "amount", "component_amounts"]) {
    const value = row.fields[field]?.value;
    const amounts = valuesFromUnknown(value).flatMap((entry) => {
      const parsed = parseAmount(entry);
      return parsed === undefined ? [] : [parsed];
    });
    if (amounts.length > 0) return amounts.reduce((sum, amount) => sum + amount, 0);
  }
  return undefined;
}

function quoteForRow(row: FacetFactRow): string {
  return Object.values(row.fields).find((field) => field.quote?.trim())?.quote?.trim() ?? row.itemSummary;
}

function displayName(row: FacetFactRow): string {
  const sourceName = row.fields.source_name?.value;
  return typeof sourceName === "string" && sourceName.trim() ? sourceName.trim() : row.itemTitle;
}

function executeFacetSumOperation(table: FacetFactTable): FacetSumResult {
  const rows: FacetSumRow[] = [];
  const warnings: string[] = [];
  for (const row of table.rows) {
    const amount = rowAmount(row);
    if (amount === undefined) {
      warnings.push(`No numeric amount extracted for ${row.itemTitle}.`);
      continue;
    }
    rows.push({
      rowId: row.rowId,
      displayName: displayName(row),
      amount,
      unit: "RMB",
      evidenceChunkIds: row.evidenceChunkIds,
      quote: quoteForRow(row),
    });
  }
  return {
    total: rows.reduce((sum, row) => sum + row.amount, 0),
    unit: "RMB",
    rows,
    warnings,
  };
}

function evidenceRowsFromSum(result: FacetSumResult, chunksById: Map<string, Chunk>): PulseEvidenceRow[] {
  return result.rows.flatMap((entry, index): PulseEvidenceRow[] => {
    const chunkId = entry.evidenceChunkIds.find((id) => chunksById.has(id));
    if (!chunkId) return [];
    const chunk = chunksById.get(chunkId);
    return [{
      rowId: `aori-skill-facet-sum-${index + 1}`,
      evidenceType: "amount",
      claimText: `${entry.displayName}: ${entry.amount} ${entry.unit}`,
      structuredValue: { amount: entry.amount, unit: entry.unit },
      evidenceChunkId: chunkId,
      treeNodeId: chunk?.documentTreeNodeId ?? null,
      evidenceQuote: truncateText(entry.quote, 500),
      role: "itemized_value",
      authority: "documentary_record",
      usage: "answer_core",
      classificationRationale: "AORI facet_sum included this numeric amount after source-bound extraction; arithmetic was computed in code.",
      confidence: 0.8,
      countedInAnswer: true,
      countedInAggregation: true,
      dedupeKey: entry.rowId,
      ...(chunk?.versionId ? { versionId: chunk.versionId } : {}),
      ...(chunk?.headingPath ? { headingPath: [chunk.headingPath] } : {}),
    }];
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

function hitsFromEvidenceRows(rows: PulseEvidenceRow[], chunksById: Map<string, Chunk>): PendingPulseHit[] {
  return rows.map((row, index) => {
    const chunk = chunksById.get(row.evidenceChunkId);
    return {
      targetType: "chunk",
      targetId: row.evidenceChunkId,
      score: row.confidence,
      reason: row.claimText,
      pathRole: "direct",
      stepIndex: index + 1,
      observation: "AORI facet_sum selected this source chunk through its target aspect item.",
      rationale: row.classificationRationale ?? "AORI skill source evidence.",
      label: chunk?.headingPath ?? row.evidenceChunkId,
      excerpt: chunk?.text.slice(0, 220) ?? null,
    };
  });
}

export async function executeFacetSumSkill(input: AoriSkillExecutionInput): Promise<AoriSkillExecutionResult> {
  await emitSkillEvent(input.eventSink, "skill_execution_started", "AORI facet_sum execution started.", {
    skill: input.route.skill,
    targetAspects: input.route.targetAspects,
  });
  const aspects = targetAspectNodes(input);
  const rows: FacetFactRow[] = [];
  const sourceChunkIds: string[] = [];
  await emitSkillEvent(input.eventSink, "facet_table_build_started", "Building amount fact table.", {
    aspectIds: aspects.flatMap((aspect) => aspect.aspectId ?? []),
  });
  for (const aspect of aspects) {
    for (const item of itemNodesForAspect(input, aspect)) {
      const chunks = uniqueStrings(item.chunkIds).flatMap((chunkId) => {
        const chunk = input.chunksById.get(chunkId);
        return chunk ? [chunk] : [];
      });
      sourceChunkIds.push(...chunks.map((chunk) => chunk.id));
      const row = await input.model.extractFacetFactRow({
        question: input.question,
        aspectTitle: aspect.title,
        requiredFields: input.route.requiredFields,
        item: {
          id: item.itemId ?? item.id,
          title: item.title,
          summary: item.summary,
        },
        chunks: chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
      });
      rows.push(row);
      await emitSkillEvent(input.eventSink, "facet_row_extracted", `Extracted amount row for ${item.title}`, {
        rowId: row.rowId,
        itemId: row.itemId,
        chunkIds: row.evidenceChunkIds,
      });
    }
  }
  const table: FacetFactTable = {
    aspectId: aspects.map((aspect) => aspect.aspectId ?? aspect.id).join(",") || "unknown",
    aspectTitle: aspects.map((aspect) => aspect.title).join(" / ") || "AORI aspect",
    rows,
  };
  const sumResult = executeFacetSumOperation(table);
  await emitSkillEvent(input.eventSink, "facet_table_build_finished", "Amount fact table built.", {
    rowCount: rows.length,
    amountRowCount: sumResult.rows.length,
  });
  await emitSkillEvent(input.eventSink, "skill_answer_synthesized", "AORI facet_sum answer synthesized.", {
    total: sumResult.total,
    unit: sumResult.unit,
  });
  const diagnostics = {
    answerPipeline: "aori_skill" as const,
    selectedSkill: "facet_sum" as const,
    targetAspects: input.route.targetAspects,
    facetFactTable: table,
    facetOperation: { operation: "sum", field: "amount", arithmetic: "program" },
    facetResult: sumResult,
    sourceChunkIds: uniqueStrings(sourceChunkIds),
    fallbackTraversalUsed: false,
    skillRouteFallback: input.model.name === "fake",
  };
  const answer = {
    answer: [
      `Sum policy: program arithmetic over source-bound amount rows.`,
      `Total: ${sumResult.total} ${sumResult.unit}`,
      `Included: ${sumResult.rows.map((row) => `${row.displayName}=${row.amount}`).join("; ") || "none"}`,
      `Warnings: ${sumResult.warnings.join("; ") || "none"}`,
    ].join("\n"),
    summary: `facet_sum computed ${sumResult.total} ${sumResult.unit} from ${sumResult.rows.length} amount row(s).`,
    diagnostics,
  };
  const evidenceRows = evidenceRowsFromSum(sumResult, input.chunksById);
  const retrievalTrace: RetrievalTrace[] = [{
    stepIndex: 1,
    tool: "routeAoriSkill",
    purpose: "Choose an AORI answering skill before traversal.",
    inputIds: input.map.rootNodes.map((node) => node.id),
    outputIds: input.route.targetAspects.map((aspect) => aspect.aspectId),
    newEvidenceRowCount: 0,
    status: input.route.targetAspects.length > 0 ? "success" : "empty",
  }, {
    stepIndex: 2,
    tool: "extractFacetFactRows",
    purpose: "Read every target aspect item evidence chunk and extract source-bound amount fields.",
    inputIds: uniqueStrings(sourceChunkIds),
    outputIds: table.rows.map((row) => row.rowId),
    newEvidenceRowCount: table.rows.length,
    status: table.rows.length > 0 ? "success" : "empty",
  }];
  const evidencePack = {
    id: `aori-skill-sum-pack-${Date.now()}`,
    question: input.question,
    evidencePackSchemaVersion: 1 as const,
    pipeline: {
      indexProfile: "v1" as const,
      packBuilder: "aori_skill" as const,
      model: input.model.name,
      promptVersion: "aori-skill-facet-sum-v1",
    },
    pipelineVersion: {
      indexerVersion: "aori-document-v1",
      contextUnitBuilderVersion: "not_used",
      retrievalUnitBuilderVersion: "not_used",
      packBuilderVersion: "aori-skill-v1",
      evidenceExtractorVersion: "facet-fact-row-v1",
      validatorVersion: "program-arithmetic-v1",
      promptVersion: "aori-skill-facet-sum-v1",
    },
    answerMode: "citation_supported" as const,
    answerModeReason: "AORI skill extracted source-bound amount rows and summed them in code.",
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows,
    citations: citationsFromRows(evidenceRows, input.chunksById),
    gaps: sumResult.warnings.map((warning) => ({
      type: "other" as const,
      description: warning,
      suggestedQueries: [input.question],
      severity: "medium" as const,
    })),
    retrievalTrace,
    diagnostics,
  };
  return {
    skill: "facet_sum",
    answer,
    evidencePack,
    diagnostics,
    chunks: uniqueStrings(sourceChunkIds).flatMap((chunkId) => {
      const chunk = input.chunksById.get(chunkId);
      return chunk ? [chunk] : [];
    }),
    hits: hitsFromEvidenceRows(evidenceRows, input.chunksById),
  };
}
