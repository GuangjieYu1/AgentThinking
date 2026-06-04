import { randomUUID } from "node:crypto";
import type {
  AoriDocumentDraft,
  AoriDocumentIndex,
  AoriGapItem,
  Aspect,
  AspectItem,
  AspectRelation,
  Chunk,
  ClosureReport,
  DocumentRelationLexiconEntry,
  DocumentUnderstanding,
  ExtractionOutput,
  IndexingRationaleTrace,
  ReflectiveIndexReport,
} from "@agent-thinking/contracts";

export interface AoriDraftGroup {
  draft: AoriDocumentDraft;
  groupId: string;
}

export interface BuildAoriDocumentIndexInput {
  libraryId: string;
  documentId: string;
  documentName: string;
  versionId: string;
  chunks: Chunk[];
  drafts: AoriDraftGroup[];
  rationaleTrace: IndexingRationaleTrace[];
  reflectiveReport: ReflectiveIndexReport;
  createdAt?: string;
}

function truncateText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1).trimEnd() : value;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeRisk(left: ReflectiveIndexReport["completenessRisk"], right: ReflectiveIndexReport["completenessRisk"]): ReflectiveIndexReport["completenessRisk"] {
  const rank = new Map<ReflectiveIndexReport["completenessRisk"], number>([
    ["none", 0],
    ["low", 1],
    ["medium", 2],
    ["high", 3],
  ]);
  return (rank.get(right) ?? 0) > (rank.get(left) ?? 0) ? right : left;
}

function relationNameOf(relation: AoriDocumentDraft["aspects"][number]["relations"][number]): string {
  return (relation.normalizedRelation?.trim() || relation.relationTextInSource?.trim() || "").slice(0, 240);
}

function quoteForChunk(chunk: Chunk | undefined): string {
  return truncateText((chunk?.text ?? "").replace(/\s+/g, " ").trim(), 260);
}

function makeGap(input: {
  aspectId?: string | null;
  description: string;
  severity?: "low" | "medium" | "high";
  evidenceChunkIds?: string[];
}): AoriGapItem {
  return {
    id: `aori-gap-${randomUUID()}`,
    aspectId: input.aspectId ?? null,
    description: truncateText(input.description.trim(), 1000),
    severity: input.severity ?? "medium",
    evidenceChunkIds: uniqueStrings(input.evidenceChunkIds ?? []),
  };
}

function makeClosure(input: {
  versionId: string;
  aspectId: string;
  itemCount: number;
  relationCount: number;
  gaps: AoriGapItem[];
  warnings: string[];
  checkedAt: string;
}): ClosureReport {
  const status: ClosureReport["status"] = input.gaps.length === 0 && input.warnings.length === 0
    ? "closed"
    : input.itemCount > 0 || input.relationCount > 0
      ? "partial"
      : "open";
  return {
    id: `aori-closure-${randomUUID()}`,
    versionId: input.versionId,
    aspectId: input.aspectId,
    status,
    itemCount: input.itemCount,
    relationCount: input.relationCount,
    gaps: input.gaps,
    warnings: uniqueStrings(input.warnings),
    checkedAt: input.checkedAt,
  };
}

export function buildAoriDocumentIndex(input: BuildAoriDocumentIndexInput): AoriDocumentIndex {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const chunkById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const draftValues = input.drafts.map((group) => group.draft);
  const firstDraft = draftValues[0];
  const understandingEvidence = uniqueStrings(draftValues.flatMap((draft) => draft.understanding.evidenceChunkIds));
  const understanding: DocumentUnderstanding = {
    versionId: input.versionId,
    summary: truncateText(
      draftValues.map((draft) => draft.understanding.summary).filter(Boolean).join("\n\n")
      || input.chunks.map((chunk) => chunk.text).join("\n\n").slice(0, 1800)
      || "AORI did not receive readable source text.",
      4000,
    ),
    centralQuestion: truncateText(firstDraft?.understanding.centralQuestion || "这份文档要回答什么核心问题？", 1000),
    ...(firstDraft?.understanding.centralNodeTitle ? { centralNodeTitle: truncateText(firstDraft.understanding.centralNodeTitle, 240) } : {}),
    evidenceChunkIds: understandingEvidence.length > 0 ? understandingEvidence : input.chunks.slice(0, 12).map((chunk) => chunk.id),
  };

  const aspects: Aspect[] = [];
  const closureReports: ClosureReport[] = [];
  const allRelations: AspectRelation[] = [];

  for (const [draftIndex, group] of input.drafts.entries()) {
    for (const [aspectIndex, draftAspect] of group.draft.aspects.entries()) {
      const aspectId = `aori-aspect-${randomUUID()}`;
      const gaps: AoriGapItem[] = [];
      const warnings: string[] = [];
      const items: AspectItem[] = [];
      const itemIdByKey = new Map<string, string>();

      for (const [itemIndex, draftItem] of draftAspect.items.entries()) {
        const evidenceChunkIds = uniqueStrings(draftItem.evidenceChunkIds).filter((chunkId) => chunkById.has(chunkId));
        if (evidenceChunkIds.length === 0) {
          gaps.push(makeGap({
            aspectId,
            description: `Aspect item "${draftItem.title}" has no source evidence and was excluded from the closed V_A set.`,
            severity: "high",
          }));
          continue;
        }
        const item: AspectItem = {
          id: `aori-item-${randomUUID()}`,
          versionId: input.versionId,
          aspectId,
          title: truncateText(draftItem.title || `Aspect item ${itemIndex + 1}`, 240),
          summary: truncateText(draftItem.summary || "", 2000),
          sourceNodeIds: uniqueStrings(draftItem.sourceNodeIds ?? []),
          evidenceChunkIds,
        };
        items.push(item);
        itemIdByKey.set(draftItem.key, item.id);
      }

      const relations: AspectRelation[] = [];
      for (const draftRelation of draftAspect.relations) {
        const sourceItemId = itemIdByKey.get(draftRelation.sourceKey);
        const targetItemId = itemIdByKey.get(draftRelation.targetKey);
        const relationName = relationNameOf(draftRelation);
        const evidenceChunkIds = uniqueStrings(draftRelation.evidenceChunkIds).filter((chunkId) => chunkById.has(chunkId));
        if (!sourceItemId || !targetItemId) {
          warnings.push(`Relation "${relationName || draftRelation.baseRelation}" was excluded because source/target is outside V_A.`);
          continue;
        }
        if (!relationName) {
          warnings.push(`Relation ${draftRelation.sourceKey} -> ${draftRelation.targetKey} was excluded because it has no document relation name.`);
          continue;
        }
        if (evidenceChunkIds.length === 0) {
          warnings.push(`Relation "${relationName}" was excluded because it has no source evidence.`);
          continue;
        }
        const relation: AspectRelation = {
          id: `aori-relation-${randomUUID()}`,
          versionId: input.versionId,
          aspectId,
          sourceItemId,
          targetItemId,
          relationName,
          baseRelation: draftRelation.baseRelation,
          ...(draftRelation.relationTextInSource ? { relationTextInSource: truncateText(draftRelation.relationTextInSource, 240) } : {}),
          ...(draftRelation.normalizedRelation ? { normalizedRelation: truncateText(draftRelation.normalizedRelation, 240) } : {}),
          reason: truncateText(draftRelation.reason || "AORI relation extracted from source evidence.", 1000),
          confidence: Math.max(0, Math.min(1, draftRelation.confidence)),
          evidenceChunkIds,
        };
        relations.push(relation);
        allRelations.push(relation);
      }

      for (const gap of draftAspect.gaps ?? []) {
        gaps.push(makeGap({
          aspectId,
          description: gap.description,
          severity: gap.severity,
          ...(gap.evidenceChunkIds ? { evidenceChunkIds: gap.evidenceChunkIds } : {}),
        }));
      }
      if (items.length === 0) warnings.push("Aspect has no evidence-bound items in V_A.");
      if (draftAspect.centralQuestion.trim() && items.length < draftAspect.items.length) {
        warnings.push("Aspect central question coverage is incomplete because some items lacked source evidence.");
      }

      const closureReport = makeClosure({
        versionId: input.versionId,
        aspectId,
        itemCount: items.length,
        relationCount: relations.length,
        gaps,
        warnings,
        checkedAt: createdAt,
      });
      const aspect: Aspect = {
        id: aspectId,
        versionId: input.versionId,
        title: truncateText(draftAspect.title || `AORI aspect ${draftIndex + 1}.${aspectIndex + 1}`, 240),
        summary: truncateText(draftAspect.summary || "", 3000),
        centralQuestion: truncateText(draftAspect.centralQuestion || "该切面需要回答什么？", 1000),
        itemIds: items.map((item) => item.id),
        relationIds: relations.map((relation) => relation.id),
        items,
        relations,
        closureReport,
      };
      aspects.push(aspect);
      closureReports.push(closureReport);
    }
  }

  const lexiconByName = new Map<string, DocumentRelationLexiconEntry>();
  for (const relation of allRelations) {
    const firstEvidenceChunkId = relation.evidenceChunkIds.find((chunkId) => chunkById.has(chunkId));
    if (!firstEvidenceChunkId) continue;
    const entry = lexiconByName.get(relation.relationName) ?? {
      relationName: relation.relationName,
      baseRelation: relation.baseRelation,
      sourceExamples: [],
    };
    if (entry.sourceExamples.length < 5) {
      entry.sourceExamples.push({
        relationId: relation.id,
        evidenceChunkId: firstEvidenceChunkId,
        quote: quoteForChunk(chunkById.get(firstEvidenceChunkId)),
      });
    }
    lexiconByName.set(relation.relationName, entry);
  }

  let reflectiveReport = input.reflectiveReport;
  for (const draft of draftValues) {
    reflectiveReport = {
      summary: uniqueStrings([reflectiveReport.summary, draft.reflectiveReport.summary]).join("\n"),
      completenessRisk: mergeRisk(reflectiveReport.completenessRisk, draft.reflectiveReport.completenessRisk),
      warnings: uniqueStrings([...reflectiveReport.warnings, ...draft.reflectiveReport.warnings]),
      truncationCount: reflectiveReport.truncationCount + draft.reflectiveReport.truncationCount,
    };
  }

  return {
    available: true,
    versionId: input.versionId,
    libraryId: input.libraryId,
    documentId: input.documentId,
    documentName: input.documentName,
    createdAt,
    understanding,
    aspects,
    relationLexicon: {
      versionId: input.versionId,
      entries: [...lexiconByName.values()].sort((left, right) => left.relationName.localeCompare(right.relationName)),
    },
    closureReports,
    selfQuestions: draftValues.flatMap((draft) => draft.selfQuestions).slice(0, 60).map((question) => ({
      id: `aori-self-question-${randomUUID()}`,
      versionId: input.versionId,
      question: truncateText(question.question, 1000),
      ...(question.answer ? { answer: truncateText(question.answer, 2000) } : {}),
      evidenceChunkIds: uniqueStrings(question.evidenceChunkIds).filter((chunkId) => chunkById.has(chunkId)),
      status: question.status,
    })),
    reflectiveReport,
    rationaleTrace: input.rationaleTrace.map((trace) => ({
      ...trace,
      id: trace.id ?? `aori-rationale-${randomUUID()}`,
      versionId: input.versionId,
      createdAt: trace.createdAt ?? createdAt,
    })),
  };
}

export function aoriIndexToExtraction(index: AoriDocumentIndex): ExtractionOutput {
  const nodeKeyByItemId = new Map<string, string>();
  const nodes = index.aspects.flatMap((aspect) => aspect.items).map((item, index) => {
    const key = `aori_${index + 1}`;
    nodeKeyByItemId.set(item.id, key);
    return {
      key,
      kind: "concept" as const,
      title: truncateText(item.title, 180),
      summary: truncateText(item.summary, 2000),
      evidenceChunkIds: item.evidenceChunkIds,
      aspects: ["other" as const],
    };
  });
  const relations = index.aspects.flatMap((aspect) => aspect.relations).flatMap((relation) => {
    const sourceKey = nodeKeyByItemId.get(relation.sourceItemId);
    const targetKey = nodeKeyByItemId.get(relation.targetItemId);
    if (!sourceKey || !targetKey) return [];
    return [{
      sourceKey,
      targetKey,
      type: relation.baseRelation,
      reason: truncateText(`[AORI:${relation.relationName}] ${relation.reason}`, 1000),
      confidence: relation.confidence,
      evidenceChunkIds: relation.evidenceChunkIds,
      originalType: relation.relationName,
      ruleWarnings: [],
      ruleDecision: "kept" as const,
    }];
  });
  const themes = index.aspects.flatMap((aspect) => {
    const memberKeys = aspect.items.flatMap((item) => nodeKeyByItemId.get(item.id) ? [nodeKeyByItemId.get(item.id)!] : []);
    if (memberKeys.length === 0) return [];
    return [{
      title: truncateText(aspect.title, 180),
      summary: truncateText(aspect.summary, 2000),
      memberKeys,
      evidenceChunkIds: uniqueStrings(aspect.items.flatMap((item) => item.evidenceChunkIds)),
      aspects: ["other" as const],
    }];
  });
  return { nodes, relations, themes };
}
