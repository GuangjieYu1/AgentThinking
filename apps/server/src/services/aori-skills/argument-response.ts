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

interface ArgumentResponsePair {
  pairId: string;
  rowId: string;
  itemTitle: string;
  argument: string;
  response: string;
  finding: string;
  status: string;
  evidenceChunkIds: string[];
  quote: string;
  confidence: number;
}

interface ArgumentResponseResult {
  pairs: ArgumentResponsePair[];
  unresolved: Array<{ rowId: string; itemTitle: string; reason: string }>;
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

function statusForRow(row: FacetFactRow): string {
  const explicit = fieldText(row, "status");
  if (explicit) return explicit;
  const response = `${fieldText(row, "response")} ${fieldText(row, "finding")}`;
  if (/not accepted|rejected|dismissed|不予采纳|未采纳|驳回/u.test(response)) return "not_accepted";
  if (/accepted|sustained|采纳|认可/u.test(response)) return "accepted";
  return "unknown";
}

function buildArgumentResponseResult(table: FacetFactTable): ArgumentResponseResult {
  const pairs: ArgumentResponsePair[] = [];
  const unresolved: ArgumentResponseResult["unresolved"] = [];
  for (const row of table.rows) {
    const argument = fieldText(row, "argument") || row.itemSummary;
    const response = fieldText(row, "response");
    const finding = fieldText(row, "finding");
    const quote = quoteForRow(row);
    if (!argument && !response && !finding) {
      unresolved.push({ rowId: row.rowId, itemTitle: row.itemTitle, reason: "No argument/response fields were extracted from source chunks." });
      continue;
    }
    pairs.push({
      pairId: `argument-response-${pairs.length + 1}`,
      rowId: row.rowId,
      itemTitle: row.itemTitle,
      argument: argument || "unknown",
      response: response || "unknown",
      finding: finding || "unknown",
      status: statusForRow(row),
      evidenceChunkIds: row.evidenceChunkIds,
      quote,
      confidence: Math.max(
        row.fields.argument?.confidence ?? 0,
        row.fields.response?.confidence ?? 0,
        row.fields.finding?.confidence ?? 0,
      ) || 0.45,
    });
  }
  return { pairs, unresolved };
}

function evidenceRowsFromPairs(result: ArgumentResponseResult, chunksById: Map<string, Chunk>): PulseEvidenceRow[] {
  return result.pairs.flatMap((pair, index): PulseEvidenceRow[] => {
    const chunkId = pair.evidenceChunkIds.find((id) => chunksById.has(id));
    if (!chunkId) return [];
    const chunk = chunksById.get(chunkId);
    return [{
      rowId: `aori-skill-argument-response-${index + 1}`,
      evidenceType: "claim",
      claimText: truncateText(`Argument: ${pair.argument}; response: ${pair.response}`, 500),
      structuredValue: pair,
      evidenceChunkId: chunkId,
      treeNodeId: chunk?.documentTreeNodeId ?? null,
      evidenceQuote: truncateText(pair.quote, 500),
      role: "court_response",
      authority: "documentary_record",
      usage: "answer_core",
      classificationRationale: "AORI argument_response paired an argument with source-bound response/finding fields.",
      confidence: pair.confidence,
      countedInAnswer: true,
      dedupeKey: pair.pairId,
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
      observation: "AORI argument_response selected this source chunk through its target aspect item.",
      rationale: row.classificationRationale ?? "AORI skill source evidence.",
      label: chunk?.headingPath ?? row.evidenceChunkId,
      excerpt: chunk?.text.slice(0, 220) ?? null,
    };
  });
}

export async function executeArgumentResponseSkill(input: AoriSkillExecutionInput): Promise<AoriSkillExecutionResult> {
  await emitSkillEvent(input.eventSink, "skill_execution_started", "AORI argument_response execution started.", {
    skill: input.route.skill,
    targetAspects: input.route.targetAspects,
  });
  const aspects = targetAspectNodes(input);
  const rows: FacetFactRow[] = [];
  const sourceChunkIds: string[] = [];
  await emitSkillEvent(input.eventSink, "facet_table_build_started", "Building argument-response table.", {
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
      await emitSkillEvent(input.eventSink, "facet_row_extracted", `Extracted argument-response row for ${item.title}`, {
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
  const argumentResult = buildArgumentResponseResult(table);
  await emitSkillEvent(input.eventSink, "facet_table_build_finished", "Argument-response table built.", {
    rowCount: rows.length,
    pairCount: argumentResult.pairs.length,
  });
  await emitSkillEvent(input.eventSink, "skill_answer_synthesized", "AORI argument_response answer synthesized.", {
    pairCount: argumentResult.pairs.length,
  });
  const diagnostics = {
    answerPipeline: "aori_skill" as const,
    selectedSkill: "argument_response" as const,
    targetAspects: input.route.targetAspects,
    facetFactTable: table,
    argumentResult,
    structuredResult: argumentResult,
    sourceChunkIds: uniqueStrings(sourceChunkIds),
    fallbackTraversalUsed: false,
    skillRouteFallback: input.model.name === "fake",
  };
  const answer = {
    answer: [
      "Argument-response pairs:",
      ...argumentResult.pairs.map((pair, index) =>
        `${index + 1}. ${pair.argument} -> ${pair.response}; finding: ${pair.finding}; status: ${pair.status}; evidence: ${pair.evidenceChunkIds.join(", ")}`,
      ),
      argumentResult.unresolved.length > 0 ? `Unresolved: ${argumentResult.unresolved.map((item) => `${item.itemTitle}: ${item.reason}`).join("; ")}` : "Unresolved: none",
    ].join("\n"),
    summary: `argument_response produced ${argumentResult.pairs.length} pair(s) from ${table.rows.length} source-bound row(s).`,
    diagnostics,
  };
  const evidenceRows = evidenceRowsFromPairs(argumentResult, input.chunksById);
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
    purpose: "Read target aspect item evidence chunks and extract argument/response fields.",
    inputIds: uniqueStrings(sourceChunkIds),
    outputIds: table.rows.map((row) => row.rowId),
    newEvidenceRowCount: table.rows.length,
    status: table.rows.length > 0 ? "success" : "empty",
  }];
  const evidencePack = {
    id: `aori-skill-argument-pack-${Date.now()}`,
    question: input.question,
    evidencePackSchemaVersion: 1 as const,
    pipeline: {
      indexProfile: "v1" as const,
      packBuilder: "aori_skill" as const,
      model: input.model.name,
      promptVersion: "aori-skill-argument-response-v1",
    },
    pipelineVersion: {
      indexerVersion: "aori-document-v1",
      contextUnitBuilderVersion: "not_used",
      retrievalUnitBuilderVersion: "not_used",
      packBuilderVersion: "aori-skill-v1",
      evidenceExtractorVersion: "facet-fact-row-v1",
      validatorVersion: "argument-response-pair-v1",
      promptVersion: "aori-skill-argument-response-v1",
    },
    answerMode: "citation_supported" as const,
    answerModeReason: "AORI skill paired source-bound argument fields with response/finding fields.",
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows,
    citations: citationsFromRows(evidenceRows, input.chunksById),
    gaps: argumentResult.unresolved.map((item) => ({
      type: "other" as const,
      description: `Unresolved argument-response row: ${item.itemTitle}. ${item.reason}`,
      suggestedQueries: [input.question],
      severity: "medium" as const,
    })),
    retrievalTrace,
    diagnostics,
  };
  return {
    skill: "argument_response",
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
