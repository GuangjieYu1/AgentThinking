import type {
  AoriTraversalMap,
  AoriTraversalNode,
  Chunk,
  ChunkAnswerSummary,
  ChunkEvidencePack,
  DemandAnswerPlan,
  DemandAnswerPlanInput,
  DemandOperationExecutionInput,
  DemandOperationResult,
  EvidenceCitation,
  EvidencePack,
  EvidenceRecord,
  EvidenceRecordField,
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
  | "demand_operations_finished"
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

interface OperationOutcome {
  result: DemandOperationResult["operationResults"][number];
  outputRecords: EvidenceRecord[];
  answerFacts: DemandOperationResult["answerFacts"];
  status: DemandOperationResult["status"];
}

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

function candidateScore(question: string, item: DemandSourceItem): number {
  const haystack = `${item.title} ${item.summary}`.normalize("NFKC").toLowerCase();
  const normalizedQuestion = question.normalize("NFKC").toLowerCase();
  const wordTerms = normalizedQuestion.match(/[a-z0-9]+/g) ?? [];
  const charTerms = [...normalizedQuestion]
    .filter((char) => /[\p{Script=Han}]/u.test(char))
    .filter((char) => !"的了和与及或是多少什么哪些所有总共".includes(char));
  return [
    ...wordTerms.map((term) => haystack.includes(term) ? 4 : 0),
    ...charTerms.map((term) => haystack.includes(term) ? 1 : 0),
  ].reduce<number>((sum, value) => sum + value, 0);
}

function applyCoverage(question: string, coverage: DemandAnswerPlan["requiredRecords"][number]["coverage"], items: DemandSourceItem[]): DemandSourceItem[] {
  if (coverage === "all") return items;
  const ranked = items
    .map((item, index) => ({ item, index, score: candidateScore(question, item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (coverage === "single") return ranked.slice(0, 1).map((entry) => entry.item);
  const relevant = ranked.filter((entry) => entry.score > 0).map((entry) => entry.item);
  return (relevant.length > 0 ? relevant : ranked.map((entry) => entry.item)).slice(0, 8);
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
  question: string,
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
  return applyCoverage(question, recordSpec.coverage, sourceBound);
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

function fieldEntries(record: EvidenceRecord, requestedField?: string): Array<[string, EvidenceRecordField]> {
  const entries = Object.entries(record.fields);
  if (!requestedField?.trim()) return entries;
  const normalized = requestedField.normalize("NFKC").toLowerCase();
  const exact = entries.filter(([name]) => name.normalize("NFKC").toLowerCase() === normalized);
  if (exact.length > 0) return exact;
  return entries.filter(([name]) => name.normalize("NFKC").toLowerCase().includes(normalized) || normalized.includes(name.normalize("NFKC").toLowerCase()));
}

function stringValues(record: EvidenceRecord, requestedField?: string): string[] {
  return uniqueStrings(fieldEntries(record, requestedField).flatMap(([, field]) => {
    if (Array.isArray(field.value)) return field.value.map(fieldValueText);
    const text = fieldValueText(field.value);
    if (!text) return [];
    return text.split(/[、,;；/]/).map((value) => value.trim()).filter(Boolean);
  }));
}

function firstFieldByNames(record: EvidenceRecord, patterns: RegExp[]): [string, EvidenceRecordField] | undefined {
  return Object.entries(record.fields).find(([name, field]) =>
    field.value !== null && field.value !== undefined && patterns.some((pattern) => pattern.test(name))
  );
}

function fieldQuote(record: EvidenceRecord | undefined, chunkId?: string): string | undefined {
  if (!record) return undefined;
  const fields = Object.values(record.fields);
  const field = chunkId
    ? fields.find((entry) => entry.evidenceChunkIds.includes(chunkId) && entry.quote)
    : fields.find((entry) => entry.quote);
  return field?.quote;
}

function yearsFromText(text: string): number[] {
  return uniqueStrings((text.match(/(?:19|20)\d{2}/g) ?? [])).map((year) => Number(year)).filter(Number.isFinite);
}

function requestedYear(question: string, condition?: string): number | undefined {
  const source = `${condition ?? ""} ${question}`;
  const [year] = yearsFromText(source);
  return year;
}

function timeTextForRecord(record: EvidenceRecord, requestedField?: string): string {
  const requested = stringValues(record, requestedField).join(" ");
  if (requested.trim()) return requested;
  const timeField = firstFieldByNames(record, [/time/i, /date/i, /year/i, /时间/u, /日期/u, /年份/u]);
  return timeField ? fieldValueText(timeField[1].value) : "";
}

function evaluateFilter(record: EvidenceRecord, question: string, condition?: string, field?: string): "include" | "exclude" | "uncertain" {
  const targetYear = requestedYear(question, condition);
  if (targetYear) {
    const text = timeTextForRecord(record, field);
    const years = yearsFromText(text);
    if (years.length === 0) return "uncertain";
    if (years.length >= 2) {
      const min = Math.min(...years);
      const max = Math.max(...years);
      if (targetYear >= min && targetYear <= max) return min === max ? "include" : "uncertain";
      return "exclude";
    }
    return years[0] === targetYear ? "include" : "exclude";
  }
  const conditionText = condition?.normalize("NFKC").toLowerCase().trim();
  if (!conditionText) return "include";
  const recordText = Object.entries(record.fields)
    .map(([name, value]) => `${name}: ${fieldValueText(value.value)}`)
    .join("\n")
    .normalize("NFKC")
    .toLowerCase();
  return recordText.includes(conditionText) ? "include" : "uncertain";
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = fieldValueText(value).replace(/,/g, "");
  if (!text) return undefined;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const numeric = Number(match[0]);
  if (!Number.isFinite(numeric)) return undefined;
  const multiplier = /亿/u.test(text)
    ? 100_000_000
    : /万|wan/i.test(text)
      ? 10_000
      : 1;
  return numeric * multiplier;
}

function amountField(record: EvidenceRecord, requestedField?: string): [string, EvidenceRecordField] | undefined {
  if (requestedField) {
    const [entry] = fieldEntries(record, requestedField);
    if (entry) return entry;
  }
  return firstFieldByNames(record, [/amount/i, /money/i, /value/i, /金额/u, /钱/u, /总额/u, /数额/u]);
}

function preferredListField(record: EvidenceRecord, requestedField?: string): string[] {
  if (requestedField) return stringValues(record, requestedField);
  const preferred = Object.entries(record.fields)
    .filter(([name, field]) =>
      field.value !== null &&
      field.value !== undefined &&
      (/source/i.test(name) || /person/i.test(name) || /organization/i.test(name) || /name/i.test(name) || /来源/u.test(name) || /人名/u.test(name) || /单位/u.test(name) || /姓名/u.test(name))
    )
    .flatMap(([name]) => stringValues(record, name));
  return preferred.length > 0 ? uniqueStrings(preferred) : stringValues(record, "answer_value");
}

function emptyOutcome(operation: DemandAnswerPlan["operations"][number]): OperationOutcome {
  const warning = "No source-bound records extracted.";
  return {
    result: {
      outputName: operation.outputName,
      type: operation.type,
      result: null,
      includedRecordIds: [],
      excludedRecordIds: [],
      uncertainRecordIds: [],
      warnings: [warning],
    },
    outputRecords: [],
    answerFacts: [],
    status: "insufficient",
  };
}

function runFilter(
  question: string,
  operation: DemandAnswerPlan["operations"][number],
  records: EvidenceRecord[],
): OperationOutcome {
  if (records.length === 0) return emptyOutcome(operation);
  const included: EvidenceRecord[] = [];
  const excluded: Array<{ recordId: string; reason: string }> = [];
  const uncertain: Array<{ recordId: string; reason: string }> = [];
  for (const record of records) {
    const decision = evaluateFilter(record, question, operation.condition, operation.field);
    if (decision === "include") included.push(record);
    if (decision === "exclude") excluded.push({ recordId: record.recordId, reason: operation.condition ?? "Filter condition did not match." });
    if (decision === "uncertain") uncertain.push({ recordId: record.recordId, reason: "Filter condition could not be decided from extracted fields." });
  }
  const warnings = included.length === 0 ? ["No records clearly satisfied the filter."] : [];
  return {
    result: {
      outputName: operation.outputName,
      type: operation.type,
      result: {
        recordIds: included.map((record) => record.recordId),
        condition: operation.condition ?? null,
      },
      includedRecordIds: included.map((record) => record.recordId),
      excludedRecordIds: excluded,
      uncertainRecordIds: uncertain,
      warnings,
    },
    outputRecords: included,
    answerFacts: [],
    status: included.length > 0 && uncertain.length === 0 ? "complete" : included.length > 0 || uncertain.length > 0 ? "partial" : "insufficient",
  };
}

function runSum(operation: DemandAnswerPlan["operations"][number], records: EvidenceRecord[]): OperationOutcome {
  if (records.length === 0) return emptyOutcome(operation);
  const includedRows: Array<{ recordId: string; amount: number; field: string; evidenceChunkIds: string[] }> = [];
  const uncertain: Array<{ recordId: string; reason: string }> = [];
  for (const record of records) {
    const entry = amountField(record, operation.field);
    const amount = entry ? parseAmount(entry[1].value) : undefined;
    if (entry && amount !== undefined) {
      includedRows.push({
        recordId: record.recordId,
        amount,
        field: entry[0],
        evidenceChunkIds: entry[1].evidenceChunkIds,
      });
    } else {
      uncertain.push({ recordId: record.recordId, reason: "No source-bound numeric amount field was extracted." });
    }
  }
  if (includedRows.length === 0) {
    const warnings = ["No included amount rows; total is null, not zero."];
    return {
      result: {
        outputName: operation.outputName,
        type: operation.type,
        result: {
          total: null,
          unit: "RMB",
          includedRows: [],
          uncertainRows: uncertain,
          status: uncertain.length > 0 ? "partial" : "insufficient",
        },
        includedRecordIds: [],
        excludedRecordIds: [],
        uncertainRecordIds: uncertain,
        warnings,
      },
      outputRecords: [],
      answerFacts: [],
      status: uncertain.length > 0 ? "partial" : "insufficient",
    };
  }
  const total = includedRows.reduce((sum, row) => sum + row.amount, 0);
  const evidenceChunkIds = uniqueStrings(includedRows.flatMap((row) => row.evidenceChunkIds));
  const totalWan = total / 10_000;
  return {
    result: {
      outputName: operation.outputName,
      type: operation.type,
      result: {
        total,
        unit: "RMB",
        totalWan,
        displayTotal: `${Number(totalWan.toFixed(6))} 万元`,
        includedRows,
        uncertainRows: uncertain,
        status: uncertain.length > 0 ? "partial" : "complete",
      },
      includedRecordIds: includedRows.map((row) => row.recordId),
      excludedRecordIds: [],
      uncertainRecordIds: uncertain,
      warnings: uncertain.length > 0 ? ["Some records had no extractable amount and were not summed."] : [],
    },
    outputRecords: records.filter((record) => includedRows.some((row) => row.recordId === record.recordId)),
    answerFacts: [{
      text: `${operation.outputName}: ${total} RMB across ${includedRows.length} included record(s).`,
      recordIds: includedRows.map((row) => row.recordId),
      evidenceChunkIds,
    }],
    status: uncertain.length > 0 ? "partial" : "complete",
  };
}

function runList(operation: DemandAnswerPlan["operations"][number], records: EvidenceRecord[]): OperationOutcome {
  if (records.length === 0) return emptyOutcome(operation);
  const values = new Map<string, { displayName: string; recordIds: string[]; evidenceChunkIds: string[] }>();
  const uncertain: Array<{ recordId: string; reason: string }> = [];
  for (const record of records) {
    const names = preferredListField(record, operation.field);
    if (names.length === 0) {
      uncertain.push({ recordId: record.recordId, reason: "No listable field value was extracted." });
      continue;
    }
    for (const name of names) {
      const key = name.normalize("NFKC").toLowerCase();
      const current = values.get(key) ?? { displayName: name, recordIds: [], evidenceChunkIds: [] };
      current.recordIds = uniqueStrings([...current.recordIds, record.recordId]);
      current.evidenceChunkIds = uniqueStrings([...current.evidenceChunkIds, ...record.evidenceChunkIds]);
      values.set(key, current);
    }
  }
  const listed = [...values.values()];
  const warnings = listed.length === 0 ? ["No list values were extracted."] : [];
  return {
    result: {
      outputName: operation.outputName,
      type: operation.type,
      result: {
        values: listed,
        status: listed.length > 0 ? uncertain.length > 0 ? "partial" : "complete" : "insufficient",
      },
      includedRecordIds: uniqueStrings(listed.flatMap((entry) => entry.recordIds)),
      excludedRecordIds: [],
      uncertainRecordIds: uncertain,
      warnings,
    },
    outputRecords: records,
    answerFacts: listed.length > 0 ? [{
      text: `${operation.outputName}: ${listed.map((entry) => entry.displayName).join(", ")}`,
      recordIds: uniqueStrings(listed.flatMap((entry) => entry.recordIds)),
      evidenceChunkIds: uniqueStrings(listed.flatMap((entry) => entry.evidenceChunkIds)),
    }] : [],
    status: listed.length > 0 ? uncertain.length > 0 ? "partial" : "complete" : "insufficient",
  };
}

function runCount(operation: DemandAnswerPlan["operations"][number], records: EvidenceRecord[]): OperationOutcome {
  if (records.length === 0) return emptyOutcome(operation);
  const listOutcome = runList({ ...operation, type: "list" }, records);
  const listed = (listOutcome.result.result as { values?: Array<{ displayName: string; recordIds: string[]; evidenceChunkIds: string[] }> } | null)?.values ?? [];
  if (listed.length === 0) {
    return {
      ...listOutcome,
      result: {
        ...listOutcome.result,
        type: operation.type,
        result: {
          count: null,
          values: [],
          status: listOutcome.status,
        },
        warnings: uniqueStrings([...listOutcome.result.warnings, "No included rows to count; count is null, not zero."]),
      },
      answerFacts: [],
    };
  }
  return {
    ...listOutcome,
    result: {
      ...listOutcome.result,
      type: operation.type,
      result: {
        count: listed.length,
        values: listed,
        status: listOutcome.status,
      },
    },
    answerFacts: [{
      text: `${operation.outputName}: ${listed.length} distinct value(s): ${listed.map((entry) => entry.displayName).join(", ")}`,
      recordIds: uniqueStrings(listed.flatMap((entry) => entry.recordIds)),
      evidenceChunkIds: uniqueStrings(listed.flatMap((entry) => entry.evidenceChunkIds)),
    }],
  };
}

function runDirect(operation: DemandAnswerPlan["operations"][number], records: EvidenceRecord[]): OperationOutcome {
  if (records.length === 0) return emptyOutcome(operation);
  const facts = records.flatMap((record) => {
    const values = stringValues(record, operation.field);
    const fallback = values.length > 0 ? values : Object.entries(record.fields)
      .filter(([, field]) => field.value !== null && field.value !== undefined)
      .map(([name, field]) => `${name}: ${fieldValueText(field.value)}`);
    if (fallback.length === 0) return [];
    return [{
      text: `${record.recordName}: ${fallback.join("; ")}`,
      recordIds: [record.recordId],
      evidenceChunkIds: record.evidenceChunkIds,
    }];
  });
  const warnings = facts.length === 0 ? ["Records were extracted but no source-bound field values were available."] : [];
  return {
    result: {
      outputName: operation.outputName,
      type: operation.type,
      result: facts.map((fact) => fact.text),
      includedRecordIds: facts.flatMap((fact) => fact.recordIds),
      excludedRecordIds: [],
      uncertainRecordIds: facts.length === 0 ? records.map((record) => ({ recordId: record.recordId, reason: "No extracted field value." })) : [],
      warnings,
    },
    outputRecords: records,
    answerFacts: facts,
    status: facts.length > 0 ? "complete" : "insufficient",
  };
}

function runTimeline(operation: DemandAnswerPlan["operations"][number], records: EvidenceRecord[]): OperationOutcome {
  if (records.length === 0) return emptyOutcome(operation);
  const timeline = records.map((record) => {
    const time = timeTextForRecord(record, operation.field);
    const event = stringValues(record, "event")[0] ?? stringValues(record, "answer_value")[0] ?? record.recordId;
    return {
      recordId: record.recordId,
      time: time || null,
      event,
      evidenceChunkIds: record.evidenceChunkIds,
      year: yearsFromText(time)[0] ?? null,
    };
  }).sort((left, right) => (left.year ?? 9999) - (right.year ?? 9999));
  const uncertain = timeline.filter((entry) => !entry.time).map((entry) => ({ recordId: entry.recordId, reason: "No time field was extracted." }));
  return {
    result: {
      outputName: operation.outputName,
      type: operation.type,
      result: { events: timeline, status: uncertain.length > 0 ? "partial" : "complete" },
      includedRecordIds: timeline.filter((entry) => entry.time).map((entry) => entry.recordId),
      excludedRecordIds: [],
      uncertainRecordIds: uncertain,
      warnings: uncertain.length > 0 ? ["Some events have no extracted time field."] : [],
    },
    outputRecords: records,
    answerFacts: timeline.length > 0 ? [{
      text: `${operation.outputName}: ${timeline.map((entry) => `${entry.time ?? "unknown"} ${entry.event}`).join("; ")}`,
      recordIds: timeline.map((entry) => entry.recordId),
      evidenceChunkIds: uniqueStrings(timeline.flatMap((entry) => entry.evidenceChunkIds)),
    }] : [],
    status: uncertain.length > 0 ? "partial" : "complete",
  };
}

export async function executeDemandOperations(input: DemandOperationExecutionInput): Promise<DemandOperationResult> {
  const recordSets = new Map<string, EvidenceRecord[]>();
  for (const record of input.records) {
    recordSets.set(record.recordName, [...(recordSets.get(record.recordName) ?? []), record]);
  }
  const operationResults: DemandOperationResult["operationResults"] = [];
  const answerFacts: DemandOperationResult["answerFacts"] = [];
  const statuses: DemandOperationResult["status"][] = [];
  for (const operation of input.plan.operations) {
    const records = recordSets.get(operation.inputRecord) ?? [];
    const outcome = operation.type === "filter"
      ? runFilter(input.question, operation, records)
      : operation.type === "sum"
        ? runSum(operation, records)
        : operation.type === "count"
          ? runCount(operation, records)
          : operation.type === "list" || operation.type === "group_by" || operation.type === "compare"
            ? runList(operation, records)
            : operation.type === "timeline"
              ? runTimeline(operation, records)
              : runDirect(operation, records);
    operationResults.push(outcome.result);
    answerFacts.push(...outcome.answerFacts);
    statuses.push(outcome.status);
    recordSets.set(operation.outputName, outcome.outputRecords);
  }
  if (operationResults.length === 0) {
    const operation = {
      type: "direct_answer",
      inputRecord: input.records[0]?.recordName ?? "records",
      outputName: "answer",
      reason: "No operations were supplied.",
    } satisfies DemandAnswerPlan["operations"][number];
    const outcome = runDirect(operation, input.records);
    operationResults.push(outcome.result);
    answerFacts.push(...outcome.answerFacts);
    statuses.push(outcome.status);
  }
  const warnings = uniqueStrings(operationResults.flatMap((result) => result.warnings));
  const status = statuses.length === 0 || statuses.every((entry) => entry === "insufficient")
    ? "insufficient"
    : statuses.some((entry) => entry !== "complete") || warnings.length > 0
      ? "partial"
      : "complete";
  return {
    operationResults,
    answerFacts,
    status,
    warnings,
  };
}

function buildEvidenceRows(records: EvidenceRecord[], facts: DemandOperationResult["answerFacts"], chunks: Chunk[]): PulseEvidenceRow[] {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return facts.flatMap((fact, factIndex) => {
    const chunkIds = uniqueStrings(fact.evidenceChunkIds);
    return chunkIds.slice(0, 4).flatMap((chunkId, chunkIndex): PulseEvidenceRow[] => {
      const chunk = chunksById.get(chunkId);
      if (!chunk) return [];
      const record = records.find((candidate) => candidate.evidenceChunkIds.includes(chunkId));
      const quote = fieldQuote(record!, chunkId) ?? chunk.text.slice(0, 220);
      return [{
        rowId: `aori-demand-row-${factIndex + 1}-${chunkIndex + 1}`,
        evidenceType: "fact",
        claimText: truncateText(fact.text, 900),
        evidenceChunkId: chunkId,
        treeNodeId: chunk.documentTreeNodeId ?? null,
        evidenceQuote: truncateText(quote, 900),
        role: "direct_fact",
        authority: "documentary_record",
        usage: "answer_core",
        classificationRationale: "AORI Demand Answer Engine used source-bound EvidenceRecord fields and operation results.",
        confidence: 0.78,
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
  eventSink?: PulseEventSink;
}): Promise<EvidenceRecord[]> {
  const records: EvidenceRecord[] = [];
  let emittedHitCount = 0;
  await emitDemand(input.eventSink, "demand_records_started", "Extracting evidence records from demand plan fields.", {
    requiredRecordCount: input.plan.requiredRecords.length,
  });
  for (const recordSpec of input.plan.requiredRecords) {
    const sourceItems = sourceItemsForRecord(input.question, input.map, input.plan, recordSpec);
    for (const sourceItem of sourceItems) {
      const chunks = sourceItem.chunkIds.flatMap((chunkId) => input.chunksById.get(chunkId) ?? []);
      if (chunks.length === 0) continue;
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
      const normalized: EvidenceRecord = {
        ...record,
        ...(sourceItem.sourceNodeId ? { sourceNodeId: sourceItem.sourceNodeId } : {}),
        ...(sourceItem.sourceAspectId ? { sourceAspectId: sourceItem.sourceAspectId } : {}),
        ...(sourceItem.sourceItemId ? { sourceItemId: sourceItem.sourceItemId } : {}),
        evidenceChunkIds: uniqueStrings(record.evidenceChunkIds.filter((chunkId) => input.chunksById.has(chunkId))),
      };
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

function retrievalTrace(plan: DemandAnswerPlan, records: EvidenceRecord[], operationResult: DemandOperationResult): RetrievalTrace[] {
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
    inputIds: allRecordChunkIds(records),
    outputIds: records.map((record) => record.recordId),
    newEvidenceRowCount: records.length,
    status: records.length > 0 ? "success" : "empty",
  }, {
    stepIndex: 3,
    tool: "executeDemandOperations",
    purpose: "Run generic filter/list/count/sum/timeline/direct operations with program logic.",
    inputIds: records.map((record) => record.recordId),
    outputIds: operationResult.operationResults.map((result) => result.outputName),
    newEvidenceRowCount: operationResult.answerFacts.length,
    status: operationResult.status === "insufficient" ? "empty" : "success",
  }, {
    stepIndex: 4,
    tool: "synthesizeDemandAnswer",
    purpose: "Synthesize final answer from EvidenceRecords and operation results only.",
    inputIds: operationResult.operationResults.map((result) => result.outputName),
    outputIds: ["final_answer"],
    newEvidenceRowCount: operationResult.answerFacts.length,
    status: operationResult.status === "insufficient" ? "empty" : "success",
  }];
}

function buildStorageEvidencePack(input: {
  question: string;
  modelName: string;
  chunkEvidencePack: ChunkEvidencePack;
  records: EvidenceRecord[];
  operationResult: DemandOperationResult;
  chunks: Chunk[];
  plan: DemandAnswerPlan;
}): EvidencePack {
  const evidenceRows = buildEvidenceRows(input.records, input.operationResult.answerFacts, input.chunks);
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
    answerModeReason: "AORI Demand Answer Engine planned source-bound records, extracted fields from raw chunks, executed operations, then synthesized the answer.",
    chunkEvidencePack: input.chunkEvidencePack,
    chunkSummaries: [],
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows,
    citations: buildCitations(evidenceRows, input.chunks),
    gaps: input.operationResult.status === "insufficient" ? [{
      type: "missing_itemized_evidence",
      description: input.operationResult.warnings.join("; ") || input.plan.answerPolicy.whatCountsAsInsufficient,
      suggestedQueries: [input.question],
      severity: "medium",
    }] : [],
    retrievalTrace: retrievalTrace(input.plan, input.records, input.operationResult),
    diagnostics: {
      answerPipeline: "aori_demand",
      demandPlan: input.plan,
      evidenceRecords: input.records,
      demandOperationResult: input.operationResult,
      fallbackTraversalUsed: false,
    },
  };
}

export class AoriDemandAnswerEngine {
  constructor(
    private readonly db: AgentDatabase,
    private readonly model: ModelProvider,
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
      ...(input.eventSink ? { eventSink: input.eventSink } : {}),
    });
    const operationResult = await executeDemandOperations({
      question: input.question,
      plan,
      records,
    });
    await emitDemand(input.eventSink, "demand_operations_finished", `Demand operations finished with ${operationResult.status}.`, {
      operationResult,
    });
    await emitPulse(input.eventSink, { type: "stage", message: "正在合成 AORI Demand Answer" });
    const answerDraft = await this.model.synthesizeDemandAnswer({
      question: input.question,
      plan,
      records,
      operationResult,
    });
    const answer = {
      ...answerDraft,
      diagnostics: {
        ...answerDraft.diagnostics,
        answerPipeline: "aori_demand",
        demandPlan: plan,
        evidenceRecords: records,
        demandOperationResult: operationResult,
        sourceChunkIds: allRecordChunkIds(records),
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
      operationResult,
      chunks: usedChunks,
      plan,
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
