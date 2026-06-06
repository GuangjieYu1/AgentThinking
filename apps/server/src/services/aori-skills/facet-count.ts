import type {
  AoriTraversalNode,
  Chunk,
  EvidenceCitation,
  FacetCountResult,
  FacetFactRow,
  FacetFactTable,
  FacetFieldValue,
  FacetTimeFilterResult,
  PulseEvidenceRow,
  RetrievalTrace,
} from "@agent-thinking/contracts";
import type { PendingPulseHit } from "../../db.js";
import { emitSkillEvent, type AoriSkillExecutionInput, type AoriSkillExecutionResult } from "./types.js";

function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, Math.max(0, max - 1)).trimEnd() : normalized;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function fieldQuote(field: FacetFieldValue | undefined): string | undefined {
  return field?.quote?.trim() || undefined;
}

function fieldValueText(field: FacetFieldValue | undefined): string {
  const value = field?.value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

function rowText(row: FacetFactRow): string {
  return [
    row.itemTitle,
    row.itemSummary,
    ...Object.entries(row.fields).map(([field, value]) => `${field}: ${fieldValueText(value)} ${value.quote ?? ""}`),
  ].join("\n");
}

function combineTimeFilters(values: FacetTimeFilterResult[]): FacetTimeFilterResult {
  const excluded = values.find((value) => value.match === "exclude");
  if (excluded) return excluded;
  const uncertain = values.find((value) => value.match === "uncertain");
  if (uncertain) return uncertain;
  return { match: "include", reason: values.map((value) => value.reason).join("; ") || "No time filter excluded the row." };
}

function evidenceRowsFromResult(result: FacetCountResult, table: FacetFactTable, chunksById: Map<string, Chunk>): PulseEvidenceRow[] {
  const rowsById = new Map(table.rows.map((row) => [row.rowId, row]));
  return result.included.flatMap((entry, index): PulseEvidenceRow[] => {
    const sourceRow = entry.rowIds.map((rowId) => rowsById.get(rowId)).find((row): row is FacetFactRow => Boolean(row));
    const chunkId = entry.evidenceChunkIds.find((id) => chunksById.has(id)) ?? sourceRow?.evidenceChunkIds.find((id) => chunksById.has(id));
    if (!chunkId) return [];
    const chunk = chunksById.get(chunkId);
    const quote = entry.quotes[0] ?? Object.values(sourceRow?.fields ?? {}).flatMap((field) => fieldQuote(field) ?? [])[0] ?? chunk?.text.slice(0, 220) ?? entry.displayName;
    return [{
      rowId: `aori-skill-facet-count-${index + 1}`,
      evidenceType: entry.type === "event" ? "timeline_event" : "fact",
      claimText: truncateText(`Counted ${entry.displayName} for ${result.countPolicy}`, 500),
      structuredValue: {
        countKey: entry.key,
        countType: entry.type,
        rowIds: entry.rowIds,
      },
      evidenceChunkId: chunkId,
      treeNodeId: chunk?.documentTreeNodeId ?? null,
      evidenceQuote: truncateText(quote, 500),
      role: entry.type === "event" ? "countable_event" : "direct_fact",
      authority: "documentary_record",
      usage: "answer_core",
      classificationRationale: "AORI facet_count included this entry after source-bound row extraction, filters, and dedupe.",
      confidence: 0.82,
      countedInAnswer: true,
      dedupeKey: entry.key,
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
      observation: "AORI facet_count selected this source chunk through its target aspect item.",
      rationale: row.classificationRationale ?? "AORI skill source evidence.",
      label: chunk?.headingPath ?? row.evidenceChunkId,
      excerpt: chunk?.text.slice(0, 220) ?? null,
    };
  });
}

export async function executeFacetCountSkill(input: AoriSkillExecutionInput): Promise<AoriSkillExecutionResult> {
  await emitSkillEvent(input.eventSink, "skill_execution_started", "AORI skill execution started.", {
    skill: input.route.skill,
    targetAspects: input.route.targetAspects,
  });

  const aspects = targetAspectNodes(input);
  const rows: FacetFactRow[] = [];
  const sourceChunkIds: string[] = [];
  await emitSkillEvent(input.eventSink, "facet_table_build_started", "Building facet fact table.", {
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
      await emitSkillEvent(input.eventSink, "facet_row_extracted", `Extracted row for ${item.title}`, {
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
  await emitSkillEvent(input.eventSink, "facet_table_build_finished", "Facet fact table built.", {
    rowCount: rows.length,
    sourceChunkCount: uniqueStrings(sourceChunkIds).length,
  });

  const operation = await input.model.planFacetCountOperation({
    question: input.question,
    route: input.route,
    tablePreview: table.rows.map((row) => ({
      itemTitle: row.itemTitle,
      itemSummary: row.itemSummary,
    })),
  });
  await emitSkillEvent(input.eventSink, "facet_operation_planned", "Facet count operation planned.", operation);

  const timeFilterResults: Record<string, FacetTimeFilterResult> = {};
  const timeFilters = operation.filters.filter((filter) => filter.operator === "overlaps_time");
  for (const row of table.rows) {
    const results: FacetTimeFilterResult[] = [];
    for (const filter of timeFilters) {
      results.push(await input.model.evaluateTimeFilter({
        question: input.question,
        filterValue: filter.value,
        rowTimeValue: row.fields[filter.field]?.value,
        rowText: rowText(row),
      }));
    }
    if (results.length > 0) {
      timeFilterResults[row.rowId] = combineTimeFilters(results);
      await emitSkillEvent(input.eventSink, "facet_filter_applied", `Applied facet filter to ${row.itemTitle}`, {
        rowId: row.rowId,
        result: timeFilterResults[row.rowId],
      });
    }
  }

  const countResult = await input.model.dedupeFacetCountRows({
    question: input.question,
    operation,
    rows: table.rows,
    ...(Object.keys(timeFilterResults).length > 0 ? { timeFilterResults } : {}),
  });
  await emitSkillEvent(input.eventSink, "facet_dedupe_finished", "Facet count dedupe finished.", {
    finalCount: countResult.finalCount,
    includedCount: countResult.included.length,
    excludedCount: countResult.excluded.length,
    uncertainCount: countResult.uncertain.length,
  });

  const answer = await input.model.synthesizeFacetCountAnswer({
    question: input.question,
    route: input.route,
    table,
    operation,
    result: countResult,
  });
  const diagnostics = {
    answerPipeline: "aori_skill" as const,
    selectedSkill: "facet_count" as const,
    targetAspects: input.route.targetAspects,
    facetFactTable: table,
    facetOperation: operation,
    facetResult: countResult,
    sourceChunkIds: uniqueStrings(sourceChunkIds),
    fallbackTraversalUsed: false,
    skillRouteFallback: input.model.name === "fake",
  };
  const mergedAnswer = {
    ...answer,
    diagnostics: {
      ...answer.diagnostics,
      ...diagnostics,
    },
  };
  await emitSkillEvent(input.eventSink, "skill_answer_synthesized", "AORI skill answer synthesized.", {
    finalCount: countResult.finalCount,
  });

  const evidenceRows = evidenceRowsFromResult(countResult, table, input.chunksById);
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
    purpose: "Read every target aspect item evidence chunk and extract source-bound fields.",
    inputIds: uniqueStrings(sourceChunkIds),
    outputIds: table.rows.map((row) => row.rowId),
    newEvidenceRowCount: table.rows.length,
    status: table.rows.length > 0 ? "success" : "empty",
  }, {
    stepIndex: 3,
    tool: "planFacetCountOperation",
    purpose: "Plan filters and dedupe policy for the count question.",
    inputIds: table.rows.map((row) => row.rowId),
    outputIds: [operation.countTarget],
    newEvidenceRowCount: 0,
    status: "success",
  }, {
    stepIndex: 4,
    tool: "dedupeFacetCountRows",
    purpose: "Apply filters, split/dedupe entities, and compute the final count.",
    inputIds: table.rows.map((row) => row.rowId),
    outputIds: countResult.included.map((entry) => entry.key),
    newEvidenceRowCount: evidenceRows.length,
    status: "success",
  }];
  const evidencePack = {
    id: `aori-skill-pack-${Date.now()}`,
    question: input.question,
    evidencePackSchemaVersion: 1 as const,
    pipeline: {
      indexProfile: "v1" as const,
      packBuilder: "aori_skill" as const,
      model: input.model.name,
      promptVersion: "aori-skill-facet-count-v1",
    },
    pipelineVersion: {
      indexerVersion: "aori-document-v1",
      contextUnitBuilderVersion: "not_used",
      retrievalUnitBuilderVersion: "not_used",
      packBuilderVersion: "aori-skill-v1",
      evidenceExtractorVersion: "facet-fact-row-v1",
      validatorVersion: "source-chunk-quote-v1",
      promptVersion: "aori-skill-facet-count-v1",
    },
    answerMode: "citation_supported" as const,
    answerModeReason: "AORI skill built a source-bound facet table and counted after filters/dedupe.",
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows,
    citations: citationsFromRows(evidenceRows, input.chunksById),
    gaps: [
      ...countResult.uncertain.map((entry) => ({
        type: "other" as const,
        description: `Uncertain count item: ${entry.displayName}. ${entry.reason}`,
        suggestedQueries: [input.question],
        severity: "medium" as const,
      })),
    ],
    retrievalTrace,
    diagnostics,
  };
  return {
    skill: "facet_count",
    answer: mergedAnswer,
    evidencePack,
    diagnostics,
    chunks: uniqueStrings(sourceChunkIds).flatMap((chunkId) => {
      const chunk = input.chunksById.get(chunkId);
      return chunk ? [chunk] : [];
    }),
    hits: hitsFromEvidenceRows(evidenceRows, input.chunksById),
  };
}
