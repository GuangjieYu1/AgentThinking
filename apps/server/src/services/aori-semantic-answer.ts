import type {
  Chunk,
  EvidencePack,
  NumericAnswerVerification,
  PulseAnswerOutput,
  PulseEvidenceGap,
  PulseEvidenceRow,
  PulseInputMode,
  PulseStreamEvent,
  QuestionAspectPlan,
  SemanticUnit,
} from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../db.js";
import { type AoriTraversalAnswerResult } from "./aori-traversal-answer.js";
import { executeQuestionAspectPlan } from "./aori-aspect-plan-executor.js";
import { buildQuestionAspectPlan, SEMANTIC_SELECTION_THRESHOLD } from "./aori-question-routing.js";

type PulseEventSink = (event: PulseStreamEvent) => void | Promise<void>;

interface SemanticAnswerSuccess extends AoriTraversalAnswerResult {
  usedSemanticPath: true;
}

interface SemanticAnswerFallback {
  usedSemanticPath: false;
  fallbackReason: string;
}

type SemanticAnswerAttempt = SemanticAnswerSuccess | SemanticAnswerFallback;

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function truncateText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() : text;
}

function evidenceRowsFromUnits(units: SemanticUnit[], chunksById: Map<string, Chunk>): PulseEvidenceRow[] {
  return units.flatMap((unit, index): PulseEvidenceRow[] => {
    const chunkId = unit.sourceChunkIds.find((id) => chunksById.has(id));
    if (!chunkId) return [];
    const chunk = chunksById.get(chunkId)!;
    if (unit.kind === "reconciliation") {
      return [{
        rowId: `semantic-row-${index + 1}`,
        evidenceType: "amount",
        claimText: `${unit.name}: computed total ${unit.computedTotal}`,
        structuredValue: { normalizedValue: unit.computedTotal, exactForAggregation: true },
        evidenceChunkId: chunkId,
        treeNodeId: chunk.documentTreeNodeId ?? null,
        evidenceQuote: truncateText(chunk.text, 500),
        role: unit.reportedTotal === undefined ? "itemized_value" : "declared_total",
        authority: "documentary_record",
        usage: "answer_core",
        classificationRationale: "Semantic reconciliation unit was computed deterministically from indexed source rows.",
        confidence: unit.confidence,
        countedInAnswer: true,
        countedInAggregation: unit.reportedTotal === undefined ? true : false,
        versionId: chunk.versionId,
        ...(chunk.headingPath ? { headingPath: [chunk.headingPath] } : {}),
      }];
    }
    return [{
      rowId: `semantic-row-${index + 1}`,
      evidenceType: unit.kind === "negative_fact" ? "fact" : unit.kind === "table" ? "table_value" : "fact",
      claimText: unit.title ? `${unit.title}: ${unit.summary}` : unit.summary,
      evidenceChunkId: chunkId,
      treeNodeId: chunk.documentTreeNodeId ?? null,
      evidenceQuote: truncateText(chunk.text, 500),
      role: unit.kind === "negative_fact" ? "direct_fact" : "direct_fact",
      authority: "documentary_record",
      usage: "answer_core",
      classificationRationale: "Semantic answer path selected a persisted semantic unit and rebound it to source chunks.",
      confidence: unit.confidence,
      countedInAnswer: true,
      versionId: chunk.versionId,
      ...(chunk.headingPath ? { headingPath: [chunk.headingPath] } : {}),
    }];
  });
}

function citationsFromRows(rows: PulseEvidenceRow[], chunksById: Map<string, Chunk>): EvidencePack["citations"] {
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

function hitsFromRows(rows: PulseEvidenceRow[], chunksById: Map<string, Chunk>): PendingPulseHit[] {
  return rows.map((row, index) => {
    const chunk = chunksById.get(row.evidenceChunkId);
    return {
      targetType: "chunk",
      targetId: row.evidenceChunkId,
      score: row.confidence,
      reason: row.claimText,
      pathRole: "direct",
      stepIndex: index + 1,
      observation: "Semantic answer path selected this source chunk through a persisted semantic unit.",
      rationale: row.classificationRationale ?? "semantic answer source evidence",
      label: chunk?.headingPath ?? row.evidenceChunkId,
      excerpt: chunk?.text.slice(0, 220) ?? null,
    };
  });
}

function buildSemanticEvidencePack(input: {
  question: string;
  plan: QuestionAspectPlan;
  units: SemanticUnit[];
  chunksById: Map<string, Chunk>;
  answer: PulseAnswerOutput;
  verification?: NumericAnswerVerification | undefined;
}): EvidencePack {
  const rows = evidenceRowsFromUnits(input.units, input.chunksById);
  const gaps: PulseEvidenceGap[] = input.units.length === 0 ? [{
    type: "missing_itemized_evidence",
    description: "Semantic routing did not find enough persisted semantic units to answer confidently.",
    suggestedQueries: [input.question],
    severity: "medium",
  }] : [];
  return {
    id: `aori-semantic-pack-${Date.now()}`,
    question: input.question,
    evidencePackSchemaVersion: 1,
    pipeline: {
      indexProfile: "v1",
      packBuilder: "aori_semantic",
      model: "semantic-deterministic",
      promptVersion: "aori-semantic-v1",
    },
    answerMode: "citation_supported",
    answerModeReason: "Question was answered from persisted semantic units with deterministic execution before demand fallback.",
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows: rows,
    citations: citationsFromRows(rows, input.chunksById),
    gaps,
    retrievalTrace: [{
      stepIndex: 1,
      tool: "buildEvidencePack",
      purpose: "Answer from persisted semantic units.",
      inputIds: input.units.map((unit) => unit.id),
      outputIds: rows.map((row) => row.rowId),
      newEvidenceRowCount: rows.length,
      status: rows.length > 0 ? "success" : "empty",
    }],
    diagnostics: {
      answerPipeline: "aori_semantic",
      questionAspectPlan: input.plan,
      semanticUnitsUsed: input.units,
      answerVerification: input.verification,
      calculatorResult: input.units.find((unit) => unit.kind === "reconciliation"),
    },
  };
}

export class AoriSemanticAnswerEngine {
  constructor(private readonly db: AgentDatabase) {}

  async answer(input: {
    libraryId: string;
    question: string;
    mode: PulseInputMode;
    eventSink?: PulseEventSink;
  }): Promise<SemanticAnswerAttempt> {
    const indexes = this.db.listAoriDocumentIndexes(input.libraryId);
    const candidates = indexes.flatMap((index) => index.semanticUnits);
    if (candidates.length === 0) {
      return { usedSemanticPath: false, fallbackReason: "No persisted semantic units are available for this library." };
    }
    const plan = buildQuestionAspectPlan(input.question, candidates);
    if (plan.selectedAspects.length === 0 || plan.confidence < SEMANTIC_SELECTION_THRESHOLD || plan.execution.strategy === "fallback_demand") {
      return {
        usedSemanticPath: false,
        fallbackReason: plan.selectedAspects.length === 0
          ? "Semantic routing did not select any candidates above threshold."
          : `Semantic routing confidence ${plan.confidence.toFixed(2)} is below ${SEMANTIC_SELECTION_THRESHOLD}.`,
      };
    }
    const selectedIds = new Set(plan.selectedAspects.map((entry) => entry.aspectId));
    const units = candidates.filter((unit) => selectedIds.has(unit.id));
    const chunkIds = uniqueStrings(units.flatMap((unit) => unit.sourceChunkIds));
    const chunks = this.db.getChunksByIds(chunkIds);
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const built = executeQuestionAspectPlan(plan, units);
    if (!built.answer.trim()) {
      return {
        usedSemanticPath: false,
        fallbackReason: `Semantic units were selected, but strategy ${plan.execution.strategy} could not produce a guarded answer.`,
      };
    }
    const answer: PulseAnswerOutput = {
      answer: built.answer,
      summary: built.summary,
      diagnostics: {
        answerPipeline: "aori_semantic",
        questionAspectPlan: plan,
        semanticUnitsUsed: units,
        answerVerification: built.verification,
        calculatorResult: built.structuredResult,
      },
    };
    const storageEvidencePack = buildSemanticEvidencePack({
      question: input.question,
      plan,
      units,
      chunksById,
      answer,
      verification: built.verification,
    });
    const hits = hitsFromRows(storageEvidencePack.evidenceRows, chunksById);
    if (input.eventSink) {
      await input.eventSink({ type: "question_task_generated", message: "Semantic question aspect plan generated.", payload: plan });
      await input.eventSink({ type: "answer", answer: answer.answer, summary: answer.summary });
    }
    return {
      usedSemanticPath: true,
      answer,
      chunks,
      chunkSummaries: [],
      evidencePack: {
        question: input.question,
        mode: input.mode === "progressive" ? "dfs_pulse" : "bfs_full",
        selectedChunks: chunkIds.map((chunkId) => {
          const chunk = chunksById.get(chunkId);
          const unit = units.find((candidate) => candidate.sourceChunkIds.includes(chunkId));
          return {
            chunkId,
            ...(chunk?.documentTreeNodeId ? { sourceNodeId: chunk.documentTreeNodeId } : {}),
            ...(unit?.documentId ? { documentId: unit.documentId } : {}),
            ...(chunk?.versionId ? { versionId: chunk.versionId } : {}),
            confidence: 0.75,
            path: [],
            retrievalSummary: "Selected through semantic answer execution.",
            relevanceReason: "Persisted semantic unit bound to this chunk.",
          };
        }),
        skippedNodes: [],
        unresolvedQuestions: [],
        diagnostics: {
          visitedNodeCount: units.length,
          selectedChunkCount: chunkIds.length,
          stoppedReason: "aori_semantic_pipeline",
        },
      },
      hits,
      storageEvidencePack,
    };
  }
}
