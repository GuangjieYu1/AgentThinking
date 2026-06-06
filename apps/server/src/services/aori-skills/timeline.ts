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

interface TimelineEvent {
  eventId: string;
  rowId: string;
  itemTitle: string;
  event: string;
  timeRange: string;
  sortYear: number | null;
  sourceName: string;
  evidenceChunkIds: string[];
  quote: string;
  filterMatch: "include" | "exclude" | "uncertain";
  filterReason: string;
  confidence: number;
}

interface TimelineResult {
  events: TimelineEvent[];
  excluded: TimelineEvent[];
  uncertain: TimelineEvent[];
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

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => valueText(entry)).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function fieldText(row: FacetFactRow, field: string): string {
  return valueText(row.fields[field]?.value);
}

function quoteForRow(row: FacetFactRow): string {
  return Object.values(row.fields).find((field) => field.quote?.trim())?.quote?.trim() ?? row.itemSummary;
}

function yearsFromText(value: string): number[] {
  return [...value.normalize("NFKC").matchAll(/\b(19|20)\d{2}\b/gu)].map((match) => Number(match[0]));
}

function requestedYear(question: string): number | undefined {
  return yearsFromText(question)[0];
}

function timeFilter(question: string, timeRange: string, rowText: string): Pick<TimelineEvent, "filterMatch" | "filterReason"> {
  const year = requestedYear(question);
  if (!year) return { filterMatch: "include", filterReason: "No explicit year filter was requested." };
  const years = yearsFromText(`${timeRange} ${rowText}`);
  if (years.length === 0) return { filterMatch: "uncertain", filterReason: "No clear year was extracted for this timeline row." };
  const min = Math.min(...years);
  const max = Math.max(...years);
  if (year >= min && year <= max) return { filterMatch: "include", filterReason: `${year} overlaps ${min === max ? String(min) : `${min}-${max}`}.` };
  return { filterMatch: "exclude", filterReason: `${year} does not overlap ${min === max ? String(min) : `${min}-${max}`}.` };
}

function timelineEventFromRow(row: FacetFactRow, question: string, index: number): TimelineEvent {
  const event = fieldText(row, "event") || fieldText(row, "evidence") || row.itemSummary;
  const timeRange = fieldText(row, "time_range");
  const sourceName = fieldText(row, "source_name") || row.itemTitle;
  const quote = quoteForRow(row);
  const years = yearsFromText(`${timeRange} ${event} ${quote}`);
  const filter = timeFilter(question, timeRange, `${event} ${quote}`);
  return {
    eventId: `timeline-event-${index + 1}`,
    rowId: row.rowId,
    itemTitle: row.itemTitle,
    event: event || "unknown",
    timeRange: timeRange || "unknown",
    sortYear: years.length > 0 ? Math.min(...years) : null,
    sourceName,
    evidenceChunkIds: row.evidenceChunkIds,
    quote,
    ...filter,
    confidence: Math.max(row.fields.event?.confidence ?? 0, row.fields.time_range?.confidence ?? 0) || 0.45,
  };
}

function buildTimelineResult(table: FacetFactTable, question: string): TimelineResult {
  const all = table.rows.map((row, index) => timelineEventFromRow(row, question, index));
  const included = all
    .filter((event) => event.filterMatch === "include")
    .sort((left, right) => (left.sortYear ?? Number.MAX_SAFE_INTEGER) - (right.sortYear ?? Number.MAX_SAFE_INTEGER));
  return {
    events: included,
    excluded: all.filter((event) => event.filterMatch === "exclude"),
    uncertain: all.filter((event) => event.filterMatch === "uncertain"),
  };
}

function evidenceRowsFromEvents(result: TimelineResult, chunksById: Map<string, Chunk>): PulseEvidenceRow[] {
  return result.events.flatMap((event, index): PulseEvidenceRow[] => {
    const chunkId = event.evidenceChunkIds.find((id) => chunksById.has(id));
    if (!chunkId) return [];
    const chunk = chunksById.get(chunkId);
    return [{
      rowId: `aori-skill-timeline-${index + 1}`,
      evidenceType: "timeline_event",
      claimText: truncateText(`${event.timeRange}: ${event.event}`, 500),
      structuredValue: event,
      evidenceChunkId: chunkId,
      treeNodeId: chunk?.documentTreeNodeId ?? null,
      evidenceQuote: truncateText(event.quote, 500),
      role: "event_candidate",
      authority: "documentary_record",
      usage: "answer_core",
      classificationRationale: "AORI timeline included this event after source-bound extraction and time filtering.",
      confidence: event.confidence,
      countedInAnswer: true,
      dedupeKey: event.eventId,
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
      observation: "AORI timeline selected this source chunk through its target aspect item.",
      rationale: row.classificationRationale ?? "AORI skill source evidence.",
      label: chunk?.headingPath ?? row.evidenceChunkId,
      excerpt: chunk?.text.slice(0, 220) ?? null,
    };
  });
}

export async function executeTimelineSkill(input: AoriSkillExecutionInput): Promise<AoriSkillExecutionResult> {
  await emitSkillEvent(input.eventSink, "skill_execution_started", "AORI timeline execution started.", {
    skill: input.route.skill,
    targetAspects: input.route.targetAspects,
  });
  const aspects = targetAspectNodes(input);
  const rows: FacetFactRow[] = [];
  const sourceChunkIds: string[] = [];
  await emitSkillEvent(input.eventSink, "facet_table_build_started", "Building timeline table.", {
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
      await emitSkillEvent(input.eventSink, "facet_row_extracted", `Extracted timeline row for ${item.title}`, {
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
  const timelineResult = buildTimelineResult(table, input.question);
  await emitSkillEvent(input.eventSink, "facet_table_build_finished", "Timeline table built.", {
    rowCount: rows.length,
    includedEventCount: timelineResult.events.length,
  });
  for (const event of [...timelineResult.excluded, ...timelineResult.uncertain]) {
    await emitSkillEvent(input.eventSink, "facet_filter_applied", `Timeline filter ${event.filterMatch}: ${event.itemTitle}`, {
      eventId: event.eventId,
      match: event.filterMatch,
      reason: event.filterReason,
    });
  }
  await emitSkillEvent(input.eventSink, "skill_answer_synthesized", "AORI timeline answer synthesized.", {
    eventCount: timelineResult.events.length,
  });
  const diagnostics = {
    answerPipeline: "aori_skill" as const,
    selectedSkill: "timeline" as const,
    targetAspects: input.route.targetAspects,
    facetFactTable: table,
    timelineResult,
    structuredResult: timelineResult,
    sourceChunkIds: uniqueStrings(sourceChunkIds),
    fallbackTraversalUsed: false,
    skillRouteFallback: input.model.name === "fake",
  };
  const answer = {
    answer: [
      "Timeline:",
      ...timelineResult.events.map((event, index) =>
        `${index + 1}. ${event.timeRange}: ${event.event} [${event.evidenceChunkIds.join(", ")}]`,
      ),
      timelineResult.excluded.length > 0 ? `Excluded: ${timelineResult.excluded.map((event) => `${event.itemTitle}: ${event.filterReason}`).join("; ")}` : "Excluded: none",
      timelineResult.uncertain.length > 0 ? `Uncertain: ${timelineResult.uncertain.map((event) => `${event.itemTitle}: ${event.filterReason}`).join("; ")}` : "Uncertain: none",
    ].join("\n"),
    summary: `timeline produced ${timelineResult.events.length} included event(s) from ${table.rows.length} source-bound row(s).`,
    diagnostics,
  };
  const evidenceRows = evidenceRowsFromEvents(timelineResult, input.chunksById);
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
    purpose: "Read target aspect item evidence chunks and extract event/time fields.",
    inputIds: uniqueStrings(sourceChunkIds),
    outputIds: table.rows.map((row) => row.rowId),
    newEvidenceRowCount: table.rows.length,
    status: table.rows.length > 0 ? "success" : "empty",
  }];
  const evidencePack = {
    id: `aori-skill-timeline-pack-${Date.now()}`,
    question: input.question,
    evidencePackSchemaVersion: 1 as const,
    pipeline: {
      indexProfile: "v1" as const,
      packBuilder: "aori_skill" as const,
      model: input.model.name,
      promptVersion: "aori-skill-timeline-v1",
    },
    pipelineVersion: {
      indexerVersion: "aori-document-v1",
      contextUnitBuilderVersion: "not_used",
      retrievalUnitBuilderVersion: "not_used",
      packBuilderVersion: "aori-skill-v1",
      evidenceExtractorVersion: "facet-fact-row-v1",
      validatorVersion: "timeline-sort-filter-v1",
      promptVersion: "aori-skill-timeline-v1",
    },
    answerMode: "citation_supported" as const,
    answerModeReason: "AORI skill extracted source-bound event/time rows, filtered them, and sorted the timeline in code.",
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows,
    citations: citationsFromRows(evidenceRows, input.chunksById),
    gaps: timelineResult.uncertain.map((event) => ({
      type: "other" as const,
      description: `Uncertain timeline row: ${event.itemTitle}. ${event.filterReason}`,
      suggestedQueries: [input.question],
      severity: "medium" as const,
    })),
    retrievalTrace,
    diagnostics,
  };
  return {
    skill: "timeline",
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
