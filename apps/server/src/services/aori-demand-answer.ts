import type {
  AoriTraversalMap,
  AoriTraversalNode,
  Chunk,
  ChunkAnswerSummary,
  ChunkEvidencePack,
  DemandAnswerPlan,
  DemandAnswerPlanInput,
  EvidenceCitation,
  EvidencePack,
  EvidenceRecord,
  PulseEvidenceGap,
  PulseAnswerOutput,
  PulseEvidenceRow,
  PulseInputMode,
  PulseStreamEvent,
  RetrievalTrace,
} from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../db.js";
import { buildAoriTraversalMap, type AoriTraversalAnswerResult } from "./aori-traversal-answer.js";
import type { ModelProvider } from "./models.js";

type PulseEventSink = (event: PulseStreamEvent) => void | Promise<void>;
type DemandEventType =
  | "demand_plan_generated"
  | "demand_records_started"
  | "demand_record_extracted"
  | "demand_answer_synthesized";

interface DemandSourceItem {
  id: string;
  title: string;
  summary: string;
  sourceNodeId?: string | undefined;
  sourceAspectId?: string | undefined;
  sourceItemId?: string | undefined;
  chunkIds: string[];
}

export interface DemandFallbackBudget {
  maxModelCalls: number;
  maxTotalTokens: number;
  maxSourceItems: number;
  maxEvidenceRecords: number;
}

export const defaultDemandFallbackBudget: DemandFallbackBudget = {
  maxModelCalls: 18,
  maxTotalTokens: 120_000,
  maxSourceItems: 24,
  maxEvidenceRecords: 16,
};

function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, Math.max(0, max - 1)).trimEnd() : normalized;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

async function emitPulse(eventSink: PulseEventSink | undefined, event: PulseStreamEvent): Promise<void> {
  if (eventSink) await eventSink(event);
}

async function emitDemand(
  eventSink: PulseEventSink | undefined,
  type: DemandEventType,
  message: string,
  payload?: unknown,
): Promise<void> {
  await emitPulse(eventSink, (payload === undefined ? { type, message } : { type, message, payload }) as PulseStreamEvent);
}

function chunkLabel(chunk: Chunk): string {
  return chunk.headingPath ?? (chunk.pageNumber ? `PDF page ${chunk.pageNumber}` : `chunk ${chunk.ordinal + 1}`);
}

function buildDemandPlanInput(question: string, map: AoriTraversalMap): DemandAnswerPlanInput {
  const nodes = Object.values(map.nodesById);
  return {
    question,
    globalSummary: map.globalSummary,
    documentCards: map.documentCards,
    aspects: nodes
      .filter((node) => node.type === "aspect")
      .map((node) => ({
        aspectId: node.aspectId ?? node.id.replace(/^aspect:/, ""),
        title: node.title,
        kind: node.aspectKind ?? "other",
        domainKind: node.domainKind ?? "unknown",
        summary: truncateText(node.summary, 900),
        itemCount: node.childIds
          .map((childId) => map.nodesById[childId])
          .filter((child) => child?.type === "aspect_item").length,
        items: node.childIds.flatMap((childId) => {
          const child = map.nodesById[childId];
          if (!child || child.type !== "aspect_item") return [];
          return [{
            nodeId: child.id,
            ...(child.itemId ? { itemId: child.itemId } : {}),
            title: child.title,
            summary: truncateText(child.summary, 500),
            chunkCount: child.chunkIds.length,
          }];
        }).slice(0, 80),
      })),
    relationLexicon: [...new Map(map.relations.map((relation) => [
      relation.label,
      {
        domainRelation: relation.label,
        ...(relation.summary ? { summary: truncateText(relation.summary, 500) } : {}),
      },
    ])).values()].slice(0, 80),
  };
}

function nodeChunkIds(node: AoriTraversalNode): string[] {
  return uniqueStrings(node.chunkIds);
}

function aspectNodesForRecord(map: AoriTraversalMap, plan: DemandAnswerPlan, recordSpec: DemandAnswerPlan["requiredRecords"][number]): AoriTraversalNode[] {
  const nodes = Object.values(map.nodesById);
  const targetAspectIds = uniqueStrings([
    recordSpec.aspectId,
    ...(plan.targetScope.aspectIds ?? []),
  ]);
  const targetDocuments = new Set(plan.targetScope.documentIds ?? []);
  const aspects = nodes.filter((node) => {
    if (node.type !== "aspect") return false;
    if (targetAspectIds.length > 0 && !targetAspectIds.includes(node.aspectId ?? node.id.replace(/^aspect:/, ""))) return false;
    if (targetDocuments.size > 0 && (!node.documentId || !targetDocuments.has(node.documentId))) return false;
    return true;
  });
  return aspects.length > 0 ? aspects : nodes.filter((node) => node.type === "aspect");
}

function sourceItemsForRecord(
  map: AoriTraversalMap,
  plan: DemandAnswerPlan,
  recordSpec: DemandAnswerPlan["requiredRecords"][number],
): DemandSourceItem[] {
  const targetNodeIds = new Set(plan.targetScope.nodeIds ?? []);
  const nodes = Object.values(map.nodesById);
  let items: DemandSourceItem[] = [];
  if (recordSpec.source === "aspect_items") {
    const aspects = aspectNodesForRecord(map, plan, recordSpec);
    items = aspects.flatMap((aspect) =>
      aspect.childIds.flatMap((childId) => {
        const child = map.nodesById[childId];
        if (!child || child.type !== "aspect_item") return [];
        if (targetNodeIds.size > 0 && !targetNodeIds.has(child.id) && !targetNodeIds.has(child.itemId ?? "")) return [];
        return [{
          id: child.itemId ?? child.id,
          title: child.title,
          summary: child.summary,
          sourceNodeId: child.id,
          sourceAspectId: child.aspectId,
          sourceItemId: child.itemId ?? child.id,
          chunkIds: nodeChunkIds(child),
        }];
      })
    );
  } else if (recordSpec.source === "relations") {
    items = nodes
      .filter((node) => node.type === "relation")
      .filter((node) => targetNodeIds.size === 0 || targetNodeIds.has(node.id))
      .map((node) => ({
        id: node.id,
        title: node.title,
        summary: node.summary,
        sourceNodeId: node.id,
        sourceAspectId: node.aspectId,
        chunkIds: nodeChunkIds(node),
      }));
  } else if (recordSpec.source === "document_summary") {
    items = nodes
      .filter((node) => node.type === "document")
      .filter((node) => !plan.targetScope.documentIds?.length || (node.documentId && plan.targetScope.documentIds.includes(node.documentId)))
      .map((node) => ({
        id: node.id,
        title: node.title,
        summary: node.summary,
        sourceNodeId: node.id,
        chunkIds: nodeChunkIds(node),
      }));
  } else {
    items = uniqueStrings(nodes.flatMap((node) => nodeChunkIds(node))).map((chunkId) => ({
      id: chunkId,
      title: `Source chunk ${chunkId}`,
      summary: "Raw source chunk selected by the demand plan.",
      chunkIds: [chunkId],
    }));
  }
  const sourceBound = items.filter((item) => item.chunkIds.length > 0);
  return sourceBound;
}

function allRecordChunkIds(records: EvidenceRecord[]): string[] {
  return uniqueStrings(records.flatMap((record) => record.evidenceChunkIds));
}

function fieldValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(fieldValueText).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function fieldChunkIds(field: EvidenceRecord["fields"][string]): string[] {
  return uniqueStrings([field.chunkId, ...field.evidenceChunkIds]);
}

function fieldQuote(record: EvidenceRecord | undefined, chunkId?: string): string | undefined {
  if (!record) return undefined;
  const fields = Object.values(record.fields);
  const field = chunkId
    ? fields.find((entry) => fieldChunkIds(entry).includes(chunkId) && entry.quote)
    : fields.find((entry) => entry.quote);
  return field?.quote;
}

function normalizedQuoteText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoteAppearsInChunk(quote: string, chunk: Chunk): boolean {
  const normalizedQuote = normalizedQuoteText(quote);
  if (!normalizedQuote) return false;
  return normalizedQuoteText(chunk.text).includes(normalizedQuote);
}

function appendUncertainty(existing: string | undefined, addition: string): string {
  return existing?.trim() ? `${existing.trim()} ${addition}` : addition;
}

function validateEvidenceRecordCitations(record: EvidenceRecord, chunksById: Map<string, Chunk>): EvidenceRecord {
  const sourceChunkIds = uniqueStrings(record.evidenceChunkIds.filter((chunkId) => chunksById.has(chunkId)));
  const fields = Object.fromEntries(Object.entries(record.fields).map(([name, field]) => {
    const candidateChunkIds = uniqueStrings([...fieldChunkIds(field), ...sourceChunkIds]).filter((chunkId) => chunksById.has(chunkId));
    const quote = field.quote.trim();
    const matchingChunkId = quote
      ? candidateChunkIds.find((chunkId) => {
        const chunk = chunksById.get(chunkId);
        return chunk ? quoteAppearsInChunk(quote, chunk) : false;
      })
      : undefined;
    const chunkId = matchingChunkId ?? candidateChunkIds[0] ?? sourceChunkIds[0] ?? "";
    const chunk = chunkId ? chunksById.get(chunkId) : undefined;
    const quoteVerified = Boolean(matchingChunkId);
    const finalQuote = quoteVerified ? quote : truncateText(chunk?.text ?? quote, 500);
    return [name, {
      ...field,
      chunkId,
      evidenceChunkIds: chunkId ? uniqueStrings([chunkId, ...candidateChunkIds]) : [],
      quote: finalQuote,
      confidence: quoteVerified ? field.confidence : Math.min(field.confidence, 0.45),
      ...(!quoteVerified
        ? { uncertainty: appendUncertainty(field.uncertainty, "Field quote was not found verbatim in the cited chunk; citation was pinned to a source chunk excerpt.") }
        : {}),
    }];
  }));
  return {
    ...record,
    fields,
    evidenceChunkIds: uniqueStrings([
      ...sourceChunkIds,
      ...Object.values(fields).flatMap((field) => fieldChunkIds(field)),
    ]).filter((chunkId) => chunksById.has(chunkId)),
  };
}

function buildEvidenceRows(records: EvidenceRecord[], chunks: Chunk[]): PulseEvidenceRow[] {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return records.flatMap((record, recordIndex) => {
    const fieldRows = Object.entries(record.fields).flatMap(([fieldName, field], fieldIndex): PulseEvidenceRow[] => {
      const chunkId = field.chunkId || field.evidenceChunkIds.find((id) => chunksById.has(id));
      if (!chunkId) return [];
      const chunk = chunksById.get(chunkId);
      if (!chunk) return [];
      const value = fieldValueText(field.value);
      const claimText = value
        ? `${record.recordName}.${fieldName}: ${value}`
        : `${record.recordName}.${fieldName}: no extracted value`;
      return [{
        rowId: `aori-demand-row-${recordIndex + 1}-${fieldIndex + 1}`,
        evidenceType: "fact",
        claimText: truncateText(claimText, 900),
        evidenceChunkId: chunkId,
        treeNodeId: chunk.documentTreeNodeId ?? null,
        evidenceQuote: truncateText(field.quote || chunk.text.slice(0, 220), 900),
        role: "direct_fact",
        authority: "documentary_record",
        usage: "answer_core",
        classificationRationale: "AORI Demand Answer Engine stored a source-bound EvidenceRecord field with a validated chunk citation.",
        confidence: field.confidence,
        ...(chunk.versionId ? { versionId: chunk.versionId } : {}),
        ...(chunk.headingPath ? { headingPath: [chunk.headingPath] } : {}),
        countedInAnswer: true,
      }];
    });
    if (fieldRows.length > 0) return fieldRows;
    return record.evidenceChunkIds.slice(0, 2).flatMap((chunkId, chunkIndex): PulseEvidenceRow[] => {
      const chunk = chunksById.get(chunkId);
      if (!chunk) return [];
      return [{
        rowId: `aori-demand-row-${recordIndex + 1}-fallback-${chunkIndex + 1}`,
        evidenceType: "quote",
        claimText: truncateText(`${record.recordName}: source chunk selected for evidence extraction`, 900),
        evidenceChunkId: chunkId,
        treeNodeId: chunk.documentTreeNodeId ?? null,
        evidenceQuote: truncateText(chunk.text.slice(0, 220), 900),
        role: "direct_fact",
        authority: "documentary_record",
        usage: "answer_core",
        classificationRationale: "AORI Demand Answer Engine selected this source chunk, but the model did not return field-level values.",
        confidence: 0.35,
        ...(chunk.versionId ? { versionId: chunk.versionId } : {}),
        ...(chunk.headingPath ? { headingPath: [chunk.headingPath] } : {}),
        countedInAnswer: true,
      }];
    });
  });
}

function buildCitations(rows: PulseEvidenceRow[], chunks: Chunk[]): EvidenceCitation[] {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
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

function buildDemandChunkEvidencePack(question: string, records: EvidenceRecord[], chunks: Chunk[]): ChunkEvidencePack {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const selectedChunks = allRecordChunkIds(records).flatMap((chunkId) => {
    const chunk = chunksById.get(chunkId);
    if (!chunk) return [];
    const record = records.find((candidate) => candidate.evidenceChunkIds.includes(chunkId));
    return [{
      chunkId,
      ...(record?.sourceNodeId ? { sourceNodeId: record.sourceNodeId } : {}),
      ...(chunk.versionId ? { versionId: chunk.versionId } : {}),
      path: record?.sourceNodeId ? [{
        nodeId: record.sourceNodeId,
        title: record.sourceItemId ?? record.recordName,
        summary: record.recordName,
        decision: "selected" as const,
        reason: "Demand plan selected this source item for field extraction.",
      }] : [],
      retrievalSummary: "AORI demand plan selected this source chunk through EvidenceRecord extraction.",
      relevanceReason: "The chunk supports one or more extracted EvidenceRecord fields.",
      confidence: 0.75,
    }];
  });
  return {
    question,
    mode: "bfs_full",
    selectedChunks,
    skippedNodes: [],
    unresolvedQuestions: [],
    diagnostics: {
      visitedNodeCount: records.length,
      selectedChunkCount: selectedChunks.length,
      stoppedReason: "aori_demand_pipeline",
    },
  };
}

function recordLabel(record: EvidenceRecord): string {
  return record.sourceItemId ?? record.sourceNodeId ?? record.recordName;
}

function buildHitsForRecord(
  record: EvidenceRecord,
  chunksById: Map<string, Chunk>,
  startStepIndex: number,
): PendingPulseHit[] {
  const hits: PendingPulseHit[] = [];
  if (record.sourceNodeId) {
    hits.push({
      targetType: "node",
      targetId: record.sourceNodeId,
      score: record.evidenceChunkIds.length > 0 ? 0.74 : 0.42,
      reason: "Demand answer source record",
      pathRole: "direct",
      stepIndex: startStepIndex + hits.length,
      observation: `Demand extraction selected ${record.recordName} from this AORI node.`,
      rationale: "The demand plan selected this source item for EvidenceRecord extraction before raw chunk verification.",
      label: recordLabel(record),
      excerpt: fieldQuote(record) ?? null,
    });
  }
  for (const chunkId of uniqueStrings(record.evidenceChunkIds)) {
    const chunk = chunksById.get(chunkId);
    if (!chunk) continue;
    hits.push({
      targetType: "chunk",
      targetId: chunkId,
      score: 0.78,
      reason: "Demand answer evidence chunk",
      pathRole: "direct",
      stepIndex: startStepIndex + hits.length,
      observation: `Demand extraction produced ${record.recordName} from this source chunk.`,
      rationale: "The chunk was selected through AORI aspect/item coverage, then fields were extracted from raw source text.",
      label: chunkLabel(chunk),
      excerpt: fieldQuote(record, chunkId) ?? chunk.text.slice(0, 220),
    });
  }
  return hits;
}

function buildHits(records: EvidenceRecord[], chunks: Chunk[]): PendingPulseHit[] {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const hits: PendingPulseHit[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const recordHits = buildHitsForRecord(record, chunksById, hits.length + 1);
    for (const hit of recordHits) {
      const key = `${hit.targetType}:${hit.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ ...hit, stepIndex: hits.length + 1 });
    }
  }
  return hits;
}

export async function extractEvidenceRecords(input: {
  question: string;
  plan: DemandAnswerPlan;
  map: AoriTraversalMap;
  chunksById: Map<string, Chunk>;
  model: ModelProvider;
  budget: DemandFallbackBudget;
  eventSink?: PulseEventSink;
}): Promise<EvidenceRecord[]> {
  const records: EvidenceRecord[] = [];
  let emittedHitCount = 0;
  let sourceItemCount = 0;
  let modelCallCount = 0;
  let estimatedTokenCount = 0;
  await emitDemand(input.eventSink, "demand_records_started", "Extracting evidence records from demand plan fields.", {
    requiredRecordCount: input.plan.requiredRecords.length,
    budget: input.budget,
  });
  for (const recordSpec of input.plan.requiredRecords) {
    if (records.length >= input.budget.maxEvidenceRecords || modelCallCount >= input.budget.maxModelCalls || sourceItemCount >= input.budget.maxSourceItems) break;
    const sourceItems = sourceItemsForRecord(input.map, input.plan, recordSpec);
    for (const sourceItem of sourceItems) {
      if (records.length >= input.budget.maxEvidenceRecords || modelCallCount >= input.budget.maxModelCalls || sourceItemCount >= input.budget.maxSourceItems) break;
      const chunks = sourceItem.chunkIds.flatMap((chunkId) => input.chunksById.get(chunkId) ?? []);
      if (chunks.length === 0) continue;
      const estimatedSourceTokens = Math.ceil(chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) / 4);
      if (estimatedTokenCount + estimatedSourceTokens > input.budget.maxTotalTokens) break;
      sourceItemCount += 1;
      modelCallCount += 1;
      estimatedTokenCount += estimatedSourceTokens;
      const record = await input.model.extractDemandEvidenceRecord({
        question: input.question,
        recordSpec,
        sourceItem: {
          id: sourceItem.id,
          title: sourceItem.title,
          summary: sourceItem.summary,
        },
        chunks: chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
      });
      const normalized = validateEvidenceRecordCitations({
        ...record,
        ...(sourceItem.sourceNodeId ? { sourceNodeId: sourceItem.sourceNodeId } : {}),
        ...(sourceItem.sourceAspectId ? { sourceAspectId: sourceItem.sourceAspectId } : {}),
        ...(sourceItem.sourceItemId ? { sourceItemId: sourceItem.sourceItemId } : {}),
        evidenceChunkIds: uniqueStrings(record.evidenceChunkIds.filter((chunkId) => input.chunksById.has(chunkId))),
      }, input.chunksById);
      records.push(normalized);
      await emitDemand(input.eventSink, "demand_record_extracted", `Extracted ${recordSpec.recordName}.`, {
        record: normalized,
        recordSpec,
        sourceItem: {
          id: sourceItem.id,
          title: sourceItem.title,
          summary: sourceItem.summary,
          ...(sourceItem.sourceNodeId ? { sourceNodeId: sourceItem.sourceNodeId } : {}),
          ...(sourceItem.sourceAspectId ? { sourceAspectId: sourceItem.sourceAspectId } : {}),
          ...(sourceItem.sourceItemId ? { sourceItemId: sourceItem.sourceItemId } : {}),
          chunkIds: sourceItem.chunkIds,
        },
        chunks: chunks.map((chunk) => ({
          id: chunk.id,
          label: chunkLabel(chunk),
          excerpt: truncateText(chunk.text, 220),
        })),
      });
      const hits = buildHitsForRecord(normalized, input.chunksById, emittedHitCount + 1);
      emittedHitCount += hits.length;
      for (const hit of hits) await emitPulse(input.eventSink, { type: "hit", hit });
    }
  }
  return records;
}

function retrievalTrace(plan: DemandAnswerPlan, records: EvidenceRecord[]): RetrievalTrace[] {
  const extractedRecordIds = records.map((record) => record.recordId);
  const extractedChunkIds = allRecordChunkIds(records);
  return [{
    stepIndex: 1,
    tool: "planDemandAnswer",
    purpose: "Generate demand plan from the AORI map without selecting a fixed skill.",
    inputIds: uniqueStrings(plan.targetScope.aspectIds ?? []),
    outputIds: plan.requiredRecords.map((record) => record.recordName),
    newEvidenceRowCount: 0,
    status: plan.requiredRecords.length > 0 ? "success" : "empty",
  }, {
    stepIndex: 2,
    tool: "extractEvidenceRecords",
    purpose: "Extract source-bound fields from AORI item chunks according to the demand plan.",
    inputIds: extractedChunkIds,
    outputIds: extractedRecordIds,
    newEvidenceRowCount: records.length,
    status: extractedRecordIds.length === 0 || extractedChunkIds.length === 0 ? "empty" : "success",
  }, {
    stepIndex: 3,
    tool: "synthesizeDemandAnswer",
    purpose: "Synthesize the final answer from the user question, demand plan, EvidenceRecords, and field-level source quotes.",
    inputIds: extractedRecordIds,
    outputIds: ["final_answer"],
    newEvidenceRowCount: records.length,
    status: extractedRecordIds.length === 0 ? "empty" : "success",
  }];
}

function emptyEvidenceValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function buildDemandGaps(plan: DemandAnswerPlan, records: EvidenceRecord[], evidenceRows: PulseEvidenceRow[], question: string): PulseEvidenceGap[] {
  if (records.length === 0 || evidenceRows.length === 0) {
    return [{
      type: "missing_itemized_evidence",
      description: plan.answerPolicy.whatCountsAsInsufficient,
      suggestedQueries: [question],
      severity: "medium",
    }];
  }
  const requiredFields = plan.requiredRecords.flatMap((recordSpec) =>
    recordSpec.fields.filter((field) => field.required).map((field) => field.name)
  );
  const missing = records.flatMap((record) =>
    requiredFields.filter((fieldName) => emptyEvidenceValue(record.fields[fieldName]?.value)).map((fieldName) => `${record.sourceItemId ?? record.recordId}.${fieldName}`)
  );
  if (missing.length === 0) return [];
  return [{
    type: "missing_itemized_evidence",
    description: `Demand answer is missing required source fields: ${missing.join(", ")}.`,
    suggestedQueries: [question, ...missing.slice(0, 4)],
    severity: "high",
  }];
}

function buildStorageEvidencePack(input: {
  question: string;
  modelName: string;
  chunkEvidencePack: ChunkEvidencePack;
  records: EvidenceRecord[];
  chunks: Chunk[];
  plan: DemandAnswerPlan;
  budget: DemandFallbackBudget;
}): EvidencePack {
  const evidenceRows = buildEvidenceRows(input.records, input.chunks);
  return {
    id: `aori-demand-pack-${Date.now()}`,
    question: input.question,
    evidencePackSchemaVersion: 1,
    pipeline: {
      indexProfile: "v1",
      packBuilder: "aori_demand",
      model: input.modelName,
      promptVersion: "aori-demand-v1",
    },
    pipelineVersion: {
      indexerVersion: "aori-document-v1",
      contextUnitBuilderVersion: "not_used",
      retrievalUnitBuilderVersion: "not_used",
      packBuilderVersion: "aori-demand-v1",
      evidenceExtractorVersion: "demand-evidence-record-v1",
      validatorVersion: "chunk-source-only-v1",
      promptVersion: "aori-demand-v1",
    },
    answerMode: "citation_supported",
    answerModeReason: "AORI Demand Answer Engine planned source-bound records, extracted fields from raw chunks, validated citations, then let the model synthesize the answer.",
    chunkEvidencePack: input.chunkEvidencePack,
    chunkSummaries: [],
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows,
    citations: buildCitations(evidenceRows, input.chunks),
    gaps: buildDemandGaps(input.plan, input.records, evidenceRows, input.question),
    retrievalTrace: retrievalTrace(input.plan, input.records),
    diagnostics: {
      answerPipeline: "aori_demand",
      demandPlan: input.plan,
      evidenceRecords: input.records,
      sourceChunkIds: allRecordChunkIds(input.records),
      fallbackBudget: input.budget,
      fallbackTraversalUsed: false,
      skillRouteFallback: input.modelName === "fake",
    },
  };
}

export class AoriDemandAnswerEngine {
  constructor(
    private readonly db: AgentDatabase,
    private readonly model: ModelProvider,
    private readonly budget: DemandFallbackBudget = defaultDemandFallbackBudget,
  ) {}

  async answer(input: {
    libraryId: string;
    question: string;
    mode: PulseInputMode;
    eventSink?: PulseEventSink;
  }): Promise<AoriTraversalAnswerResult> {
    if (!this.model.configured) throw new Error("AORI demand answering requires a configured model service.");
    const map = buildAoriTraversalMap(this.db, input.libraryId);
    const allChunkIds = uniqueStrings(Object.values(map.nodesById).flatMap((node) => node.chunkIds));
    const allChunks = this.db.getChunksByIds(allChunkIds);
    const chunksById = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
    const extractionBudget = {
      ...this.budget,
      maxModelCalls: Math.max(0, this.budget.maxModelCalls - 2),
    };
    await emitPulse(input.eventSink, { type: "stage", message: "正在生成 AORI Demand Answer Plan" });
    const plan = await this.model.planDemandAnswer(buildDemandPlanInput(input.question, map));
    await emitDemand(input.eventSink, "demand_plan_generated", "AORI demand answer plan generated.", {
      plan,
      planFallback: this.model.name === "fake",
    });
    const records = await extractEvidenceRecords({
      question: input.question,
      plan,
      map,
      chunksById,
      model: this.model,
      budget: extractionBudget,
      ...(input.eventSink ? { eventSink: input.eventSink } : {}),
    });
    await emitPulse(input.eventSink, { type: "stage", message: "正在合成 AORI Demand Answer" });
    const answerDraft = await this.model.synthesizeDemandAnswer({
      question: input.question,
      plan,
      records,
    });
    const answer = {
      ...answerDraft,
      diagnostics: {
        ...answerDraft.diagnostics,
        answerPipeline: "aori_demand",
        demandPlan: plan,
        evidenceRecords: records,
        sourceChunkIds: allRecordChunkIds(records),
        fallbackBudget: this.budget,
        fallbackTraversalUsed: false,
        skillRouteFallback: this.model.name === "fake",
      },
    } satisfies PulseAnswerOutput;
    await emitDemand(input.eventSink, "demand_answer_synthesized", answer.summary, { answer });
    const usedChunks = this.db.getChunksByIds(allRecordChunkIds(records));
    const evidencePack = buildDemandChunkEvidencePack(input.question, records, usedChunks);
    const storageEvidencePack = buildStorageEvidencePack({
      question: input.question,
      modelName: this.model.name,
      chunkEvidencePack: evidencePack,
      records,
      chunks: usedChunks,
      plan,
      budget: this.budget,
    });
    const chunkSummaries: ChunkAnswerSummary[] = [];
    return {
      evidencePack,
      chunkSummaries,
      answer,
      chunks: usedChunks,
      hits: buildHits(records, usedChunks),
      storageEvidencePack,
    };
  }
}
