import { randomUUID } from "node:crypto";
import type {
  AoriDocumentDraft,
  AoriDocumentIndex,
  AoriGraphDiagnostics,
  AoriGraphEdge,
  AoriGraphNode,
  AoriGraphViewMode,
  AoriGraphView,
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
  LibraryAoriProfile,
  ReflectiveFinding,
  ReflectiveIndexReport,
  SemanticUnit,
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
  return (relation.domainRelation?.trim() || relation.normalizedRelation?.trim() || relation.relationTextInSource?.trim() || "").slice(0, 240);
}

function quoteForChunk(chunk: Chunk | undefined): string {
  return truncateText((chunk?.text ?? "").replace(/\s+/g, " ").trim(), 260);
}

function semanticUnitSourceChunks(unit: { sourceChunkIds: string[] }, chunkById: Map<string, Chunk>): string[] {
  return uniqueStrings(unit.sourceChunkIds).filter((chunkId) => chunkById.has(chunkId));
}

function normalizeSemanticUnit(
  unit: NonNullable<AoriDocumentDraft["semanticUnits"]>[number],
  input: BuildAoriDocumentIndexInput,
  chunkById: Map<string, Chunk>,
): SemanticUnit | undefined {
  const sourceChunkIds = semanticUnitSourceChunks(unit, chunkById);
  if (sourceChunkIds.length === 0) return undefined;
  const base = {
    ...unit,
    id: unit.id || `aori-semantic-${randomUUID()}`,
    libraryId: input.libraryId,
    documentId: input.documentId,
    versionId: input.versionId,
    title: unit.title ? truncateText(unit.title, 240) : undefined,
    summary: truncateText(unit.summary || unit.title || unit.kind, 3000),
    sourceChunkIds,
    sourceNodeIds: uniqueStrings(unit.sourceNodeIds ?? []),
    confidence: Math.max(0, Math.min(1, unit.confidence ?? 0.3)),
    reflectionStatus: unit.reflectionStatus ?? "needs_review",
    reflectionNotes: uniqueStrings(unit.reflectionNotes ?? []).map((note) => truncateText(note, 500)),
  };
  return base as SemanticUnit;
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

function aspectEvidenceStatus(items: AspectItem[], relations: AspectRelation[]): Aspect["evidenceStatus"] {
  const statuses = [...items.map((item) => item.evidenceStatus), ...relations.map((relation) => relation.evidenceStatus)];
  if (statuses.length === 0 || statuses.every((status) => status === "unsupported")) return "unsupported";
  if (statuses.some((status) => status === "disputed")) return "disputed";
  if (statuses.every((status) => status === "supported")) return "supported";
  return "partially_supported";
}

function aspectClosureStatus(report: ClosureReport): Aspect["closureStatus"] {
  return report.status;
}

function supportedStatus(evidenceChunkIds: string[]): AspectItem["evidenceStatus"] {
  return evidenceChunkIds.length > 0 ? "supported" : "unsupported";
}

function closureStatus(evidenceChunkIds: string[]): AspectItem["closureStatus"] {
  return evidenceChunkIds.length > 0 ? "partial" : "open";
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
  const semanticUnits: SemanticUnit[] = [];
  const reflectiveFindings: ReflectiveFinding[] = [];

  for (const [draftIndex, group] of input.drafts.entries()) {
    for (const draftUnit of group.draft.semanticUnits ?? []) {
      const unit = normalizeSemanticUnit(draftUnit, input, chunkById);
      if (unit) semanticUnits.push(unit);
    }
    for (const finding of group.draft.reflectiveFindings ?? []) {
      reflectiveFindings.push({
        id: finding.id ?? `aori-finding-${randomUUID()}`,
        semanticUnitId: finding.semanticUnitId,
        findingType: finding.findingType,
        severity: finding.severity,
        message: truncateText(finding.message, 1000),
      });
    }
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
            description: `Aspect item "${draftItem.title}" has no source evidence and remains unsupported/open.`,
            severity: "high",
          }));
        }
        const item: AspectItem = {
          id: `aori-item-${randomUUID()}`,
          versionId: input.versionId,
          aspectId,
          title: truncateText(draftItem.title || `Aspect item ${itemIndex + 1}`, 240),
          summary: truncateText(draftItem.summary || "", 2000),
          sourceNodeIds: uniqueStrings(draftItem.sourceNodeIds ?? []),
          evidenceChunkIds,
          evidenceStatus: draftItem.evidenceStatus ?? supportedStatus(evidenceChunkIds),
          closureStatus: draftItem.closureStatus ?? closureStatus(evidenceChunkIds),
          fallbackOnly: draftItem.fallbackOnly === true,
          classificationRationale: truncateText(
            draftItem.classificationRationale || (
              evidenceChunkIds.length > 0
                ? "Model supplied source evidence for this AORI item."
                : "Model did not supply valid evidenceChunkIds; no fallback evidence was bound."
            ),
            1000,
          ),
          confidence: Math.max(0, Math.min(1, draftItem.confidence ?? (evidenceChunkIds.length > 0 ? 0.5 : 0.3))),
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
        if (evidenceChunkIds.length === 0) {
          warnings.push(`Relation "${relationName || "unknown"}" has no source evidence and remains unsupported/open.`);
        }
        if (!relationName) {
          warnings.push(`Relation ${draftRelation.sourceKey} -> ${draftRelation.targetKey} has no document relation name and remains unsupported/open.`);
        }
        const relation: AspectRelation = {
          id: `aori-relation-${randomUUID()}`,
          versionId: input.versionId,
          aspectId,
          sourceItemId,
          targetItemId,
          relationName: relationName || "unknown",
          domainRelation: truncateText(draftRelation.domainRelation || relationName || "unknown", 240),
          baseRelation: draftRelation.baseRelation,
          ...(draftRelation.relationTextInSource ? { relationTextInSource: truncateText(draftRelation.relationTextInSource, 240) } : {}),
          ...(draftRelation.normalizedRelation ? { normalizedRelation: truncateText(draftRelation.normalizedRelation, 240) } : {}),
          reason: truncateText(draftRelation.reason || "AORI relation extracted from source evidence.", 1000),
          confidence: Math.max(0, Math.min(1, draftRelation.confidence)),
          evidenceChunkIds,
          evidenceStatus: draftRelation.evidenceStatus ?? supportedStatus(evidenceChunkIds),
          closureStatus: draftRelation.closureStatus ?? closureStatus(evidenceChunkIds),
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
        warnings.push("Aspect central question coverage is incomplete because some items are unsupported/open.");
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
        kind: draftAspect.kind,
        domainKind: truncateText(draftAspect.domainKind || "unknown", 120),
        title: truncateText(draftAspect.title || `AORI aspect ${draftIndex + 1}.${aspectIndex + 1}`, 240),
        summary: truncateText(draftAspect.summary || "", 3000),
        centralQuestion: truncateText(draftAspect.centralQuestion || "该切面需要回答什么？", 1000),
        classificationRationale: truncateText(draftAspect.classificationRationale || "Model did not provide an aspect classification rationale.", 1000),
        confidence: Math.max(0, Math.min(1, draftAspect.confidence)),
        evidenceStatus: aspectEvidenceStatus(items, relations),
        closureStatus: aspectClosureStatus(closureReport),
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
      domainRelation: relation.domainRelation,
      normalizedMeaning: relation.normalizedRelation ?? relation.relationName,
      baseRelation: relation.baseRelation,
      confidence: relation.confidence,
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
    semanticUnits,
    reflectiveFindings,
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
    rationaleDebug: {
      rationaleRequested: input.rationaleTrace.length > 0,
      rationaleGenerated: input.rationaleTrace.length > 0,
      rationaleSaved: input.rationaleTrace.length > 0,
      rationaleCount: input.rationaleTrace.length,
      rationaleMissingReason: input.rationaleTrace.length > 0 ? null : "rationaleTrace was not supplied to the AORI index builder",
    },
  };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topK(map: Map<string, number>, limit = 10): Array<{ label: string; count: number }> {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

export function buildAoriGraphDiagnostics(index: AoriDocumentIndex): AoriGraphDiagnostics {
  const kindCounts = new Map<string, number>();
  const domainKindCounts = new Map<string, number>();
  const domainRelationCounts = new Map<string, number>();
  const closureCounts = new Map<string, number>();
  let unsupportedItemCount = 0;
  let fallbackOnlyItemCount = 0;
  let isolatedItemCount = 0;
  const relatedItemIds = new Set(index.aspects.flatMap((aspect) => aspect.relations.flatMap((relation) => [relation.sourceItemId, relation.targetItemId])));
  for (const aspect of index.aspects) {
    increment(kindCounts, aspect.kind);
    increment(domainKindCounts, aspect.domainKind || "unknown");
    increment(closureCounts, aspect.closureStatus);
    for (const item of aspect.items) {
      if (item.evidenceStatus === "unsupported") unsupportedItemCount += 1;
      if (item.fallbackOnly) fallbackOnlyItemCount += 1;
      if (!relatedItemIds.has(item.id)) isolatedItemCount += 1;
    }
    for (const relation of aspect.relations) increment(domainRelationCounts, relation.domainRelation || relation.relationName);
  }
  const projectable = aoriIndexToExtraction(index);
  const projectedAspectCount = projectable.nodes.reduce((count, node) => count + (node.aspects.includes("other") ? 1 : 0), 0);
  const legacyProjectionOtherRatio = projectable.nodes.length === 0 ? 0 : projectedAspectCount / projectable.nodes.length;
  const warnings = [
    ...index.reflectiveReport.warnings,
    ...index.closureReports.flatMap((report) => report.warnings),
  ];
  if (unsupportedItemCount > 0) warnings.push(`${unsupportedItemCount} AORI items are unsupported/open.`);
  if (fallbackOnlyItemCount > 0) warnings.push(`${fallbackOnlyItemCount} AORI items are fallback-only diagnostics.`);
  return {
    hasAori: true,
    aspectCount: index.aspects.length,
    itemCount: index.aspects.reduce((sum, aspect) => sum + aspect.items.length, 0),
    relationCount: index.aspects.reduce((sum, aspect) => sum + aspect.relations.length, 0),
    aspectKindDistribution: Object.fromEntries(kindCounts),
    domainKindTopK: topK(domainKindCounts),
    domainRelationTopK: topK(domainRelationCounts),
    closureDistribution: Object.fromEntries(closureCounts),
    unsupportedItemCount,
    fallbackOnlyItemCount,
    isolatedItemCount,
    legacyProjectionOtherRatio,
    warnings: uniqueStrings(warnings),
  };
}

export function buildAoriGraphView(index: AoriDocumentIndex, mode: "overview" | "detail" | "hybrid" = "overview"): AoriGraphView {
  const centerNode: AoriGraphNode = {
    id: `aori-document-${index.versionId}`,
    type: "document_center",
    label: index.understanding.centralNodeTitle || index.documentName,
    summary: index.understanding.summary,
    evidenceStatus: index.understanding.evidenceStatus,
    closureStatus: index.understanding.closureStatus,
    confidence: index.understanding.confidence,
  };
  const nodes = new Map<string, AoriGraphNode>([[centerNode.id, centerNode]]);
  const edges = new Map<string, AoriGraphEdge>();
  const groups: AoriGraphView["groups"] = [];
  const layers: Record<string, number> = { [centerNode.id]: 0 };
  const collapsedNodeIds = new Set<string>();

  const addNode = (node: AoriGraphNode, layer: number) => {
    nodes.set(node.id, node);
    layers[node.id] = layer;
  };
  const addEdge = (edge: AoriGraphEdge) => edges.set(edge.id, edge);

  for (const aspect of index.aspects) {
    const aspectNodeId = `aori-aspect-node-${aspect.id}`;
    const aspectNode: AoriGraphNode = {
      id: aspectNodeId,
      type: "aspect",
      label: aspect.title,
      summary: aspect.summary,
      aspectId: aspect.id,
      kind: aspect.kind,
      domainKind: aspect.domainKind,
      evidenceStatus: aspect.evidenceStatus,
      closureStatus: aspect.closureStatus,
      confidence: aspect.confidence,
    };
    addNode(aspectNode, 1);
    addEdge({
      id: `aori-edge-document-${aspect.id}`,
      source: centerNode.id,
      target: aspectNodeId,
      type: "contains",
      label: aspect.domainKind || aspect.kind,
      evidenceStatus: aspect.evidenceStatus,
      closureStatus: aspect.closureStatus,
      confidence: aspect.confidence,
    });
    const groupNodeIds = [aspectNodeId];
    if (mode !== "overview") {
      for (const item of aspect.items) {
        const itemNodeId = `aori-item-node-${item.id}`;
        addNode({
          id: itemNodeId,
          type: "aspect_item",
          label: item.title,
          summary: item.summary,
          aspectId: aspect.id,
          itemId: item.id,
          evidenceStatus: item.evidenceStatus,
          closureStatus: item.closureStatus,
          fallbackOnly: item.fallbackOnly,
          confidence: item.confidence,
        }, item.evidenceStatus === "unsupported" || item.fallbackOnly ? 3 : 2);
        if (item.evidenceStatus === "unsupported" || item.fallbackOnly) collapsedNodeIds.add(itemNodeId);
        groupNodeIds.push(itemNodeId);
        addEdge({
          id: `aori-edge-aspect-item-${item.id}`,
          source: aspectNodeId,
          target: itemNodeId,
          type: item.evidenceStatus === "unsupported" || item.fallbackOnly ? "warning" : "contains",
          label: item.evidenceStatus,
          evidenceStatus: item.evidenceStatus,
          closureStatus: item.closureStatus,
          confidence: item.confidence,
        });
        for (const chunkId of item.evidenceChunkIds) {
          const chunkNodeId = `aori-chunk-node-${chunkId}`;
          if (!nodes.has(chunkNodeId)) {
            addNode({ id: chunkNodeId, type: "source_chunk", label: chunkId, chunkId, evidenceStatus: "supported", closureStatus: "closed" }, 4);
            collapsedNodeIds.add(chunkNodeId);
          }
          addEdge({
            id: `aori-edge-item-evidence-${item.id}-${chunkId}`,
            source: itemNodeId,
            target: chunkNodeId,
            type: "evidence",
            label: "evidence",
            evidenceStatus: "supported",
            closureStatus: "closed",
          });
        }
      }
      for (const relation of aspect.relations) {
        const sourceNodeId = `aori-item-node-${relation.sourceItemId}`;
        const targetNodeId = `aori-item-node-${relation.targetItemId}`;
        if (!nodes.has(sourceNodeId) || !nodes.has(targetNodeId)) continue;
        addEdge({
          id: `aori-edge-relation-${relation.id}`,
          source: sourceNodeId,
          target: targetNodeId,
          type: "relates",
          label: relation.domainRelation || relation.relationName,
          baseRelation: relation.baseRelation,
          domainRelation: relation.domainRelation,
          evidenceStatus: relation.evidenceStatus,
          closureStatus: relation.closureStatus,
          confidence: relation.confidence,
        });
      }
      for (const gap of aspect.closureReport.gaps) {
        const gapNodeId = `aori-gap-node-${gap.id}`;
        addNode({ id: gapNodeId, type: "gap", label: gap.description, aspectId: aspect.id, closureStatus: "open", evidenceStatus: "unsupported" }, 3);
        groupNodeIds.push(gapNodeId);
        addEdge({
          id: `aori-edge-aspect-gap-${gap.id}`,
          source: aspectNodeId,
          target: gapNodeId,
          type: "has_gap",
          label: gap.severity,
          evidenceStatus: "unsupported",
          closureStatus: "open",
        });
      }
    }
    groups.push({
      id: `aori-group-${aspect.id}`,
      label: aspect.title,
      aspectId: aspect.id,
      kind: aspect.kind,
      domainKind: aspect.domainKind,
      nodeIds: groupNodeIds,
      evidenceStatus: aspect.evidenceStatus,
      closureStatus: aspect.closureStatus,
    });
  }

  if (mode !== "overview") {
    for (const question of index.selfQuestions) {
      const nodeId = `aori-self-question-node-${question.id}`;
      addNode({
        id: nodeId,
        type: "self_question",
        label: question.question,
        summary: question.answer,
        evidenceStatus: question.status === "answered" ? "supported" : "unsupported",
        closureStatus: question.status === "answered" ? "partial" : "open",
      }, 2);
      addEdge({
        id: `aori-edge-document-question-${question.id}`,
        source: centerNode.id,
        target: nodeId,
        type: "asks",
        label: question.status,
      });
    }
  }

  return {
    versionId: index.versionId,
    documentId: index.documentId,
    centerNode,
    groups,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    layoutHints: {
      mode,
      centerNodeId: centerNode.id,
      layers,
      collapsedNodeIds: [...collapsedNodeIds],
    },
    diagnostics: buildAoriGraphDiagnostics(index),
  };
}

export function buildLibraryAoriGraphView(profile: LibraryAoriProfile, viewMode: AoriGraphViewMode = "layer"): AoriGraphView {
  const centerNode: AoriGraphNode = {
    id: `library-aori-${profile.libraryId}`,
    type: "library_center",
    label: "Library AORI",
    summary: profile.summary,
    evidenceStatus: profile.assertions.length > 0 ? "supported" : "unsupported",
    closureStatus: profile.assertions.length > 0 ? "partial" : "open",
    confidence: profile.assertions.length > 0 ? 0.7 : 0.2,
  };
  const nodes = new Map<string, AoriGraphNode>([[centerNode.id, centerNode]]);
  const edges = new Map<string, AoriGraphEdge>();
  const layers: Record<string, number> = { [centerNode.id]: 0 };
  const collapsedNodeIds = new Set<string>();

  const addNode = (node: AoriGraphNode, layer: number) => {
    nodes.set(node.id, node);
    layers[node.id] = layer;
  };
  const addEdge = (edge: AoriGraphEdge) => edges.set(edge.id, edge);

  const documentNodeIds = new Map<string, string>();
  for (const doc of profile.documentRelations) {
    const nodeId = `library-document-${doc.documentId}`;
    documentNodeIds.set(doc.documentId, nodeId);
    addNode({
      id: nodeId,
      type: "document",
      label: doc.domainRelation || doc.relationType,
      summary: doc.explanation,
      documentId: doc.documentId,
      evidenceStatus: "supported",
      closureStatus: "partial",
      confidence: doc.confidence,
    }, 1);
    addEdge({
      id: `library-edge-document-${doc.id}`,
      source: centerNode.id,
      target: nodeId,
      type: doc.relationType.includes("challenge") ? "challenges" : doc.relationType.includes("response") ? "responds_to" : "contains",
      label: doc.domainRelation || doc.relationType,
      confidence: doc.confidence,
    });
  }

  for (const aspect of profile.aspects) {
    const nodeId = `library-aspect-${aspect.id}`;
    addNode({
      id: nodeId,
      type: "library_aspect",
      label: aspect.title,
      summary: aspect.summary,
      aspectId: aspect.id,
      kind: aspect.kind,
      domainKind: aspect.domainKind,
      evidenceStatus: aspect.evidenceRefs.length > 0 ? "supported" : "unsupported",
      closureStatus: "partial",
      confidence: aspect.confidence,
    }, viewMode === "network" ? 1 : 2);
    addEdge({
      id: `library-edge-aspect-${aspect.id}`,
      source: centerNode.id,
      target: nodeId,
      type: "has_aspect",
      label: aspect.domainKind || aspect.kind,
      evidenceStatus: aspect.evidenceRefs.length > 0 ? "supported" : "unsupported",
      closureStatus: "partial",
      confidence: aspect.confidence,
    });
  }

  for (const entity of profile.entities) {
    const nodeId = `library-entity-${entity.id}`;
    addNode({
      id: nodeId,
      type: "entity",
      label: entity.canonicalName,
      summary: entity.summary,
      entityId: entity.id,
      evidenceStatus: entity.evidenceRefs.length > 0 ? "supported" : "unsupported",
      closureStatus: "partial",
      confidence: entity.confidence,
    }, viewMode === "network" ? 1 : 2);
    addEdge({
      id: `library-edge-entity-${entity.id}`,
      source: centerNode.id,
      target: nodeId,
      type: "contains",
      label: entity.entityType,
      confidence: entity.confidence,
    });
  }

  const assertionById = new Map(profile.assertions.map((assertion) => [assertion.id, assertion]));
  for (const relation of profile.relations) {
    const sourceNodeId = `library-entity-${relation.sourceId}`;
    const targetNodeId = `library-entity-${relation.targetId}`;
    if (nodes.has(sourceNodeId) && nodes.has(targetNodeId)) {
      addEdge({
        id: `library-edge-aggregate-${relation.id}`,
        source: sourceNodeId,
        target: targetNodeId,
        type: "aggregate_relation",
        label: relation.aggregateRelation,
        domainRelation: relation.aggregateRelation,
        assertionIds: relation.assertionIds,
        confidence: relation.confidence,
        evidenceStatus: "supported",
        closureStatus: "partial",
      });
    }
    if (viewMode !== "network") {
      const relationNodeId = `library-aggregate-node-${relation.id}`;
      addNode({
        id: relationNodeId,
        type: "aggregate_relation",
        label: relation.aggregateRelation,
        summary: relation.summary,
        relationId: relation.id,
        evidenceStatus: "supported",
        closureStatus: "partial",
        confidence: relation.confidence,
      }, 3);
      addEdge({
        id: `library-edge-center-aggregate-${relation.id}`,
        source: centerNode.id,
        target: relationNodeId,
        type: "aggregate_relation",
        label: relation.relationFamily,
        assertionIds: relation.assertionIds,
      });
      for (const assertionId of relation.assertionIds.slice(0, 12)) {
        const assertion = assertionById.get(assertionId);
        if (!assertion) continue;
        const assertionNodeId = `library-assertion-node-${assertion.id}`;
        addNode({
          id: assertionNodeId,
          type: "relation_assertion",
          label: assertion.domainRelation,
          summary: assertion.assertionText,
          assertionId: assertion.id,
          relationId: relation.id,
          evidenceStatus: assertion.status === "uncertain" ? "unsupported" : "supported",
          closureStatus: assertion.status === "uncertain" ? "open" : "partial",
          confidence: assertion.confidence,
        }, 4);
        collapsedNodeIds.add(assertionNodeId);
        addEdge({
          id: `library-edge-aggregate-assertion-${assertion.id}`,
          source: relationNodeId,
          target: assertionNodeId,
          type: "asserts_relation",
          label: assertion.domainRelation,
          domainRelation: assertion.domainRelation,
          confidence: assertion.confidence,
        });
        const docNodeId = documentNodeIds.get(assertion.documentId);
        if (docNodeId) {
          addEdge({
            id: `library-edge-document-assertion-${assertion.id}`,
            source: docNodeId,
            target: assertionNodeId,
            type: "evidence_for",
            label: assertion.status,
          });
        }
      }
    }
  }

  return {
    versionId: profile.libraryId,
    documentId: profile.libraryId,
    centerNode,
    groups: profile.aspects.map((aspect) => ({
      id: `library-group-${aspect.id}`,
      label: aspect.title,
      aspectId: aspect.id,
      kind: aspect.kind,
      domainKind: aspect.domainKind,
      nodeIds: [`library-aspect-${aspect.id}`],
      evidenceStatus: aspect.evidenceRefs.length > 0 ? "supported" : "unsupported",
      closureStatus: "partial",
    })),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    layoutHints: {
      mode: viewMode === "layer" ? "overview" : "detail",
      scope: "library",
      viewMode,
      centerNodeId: centerNode.id,
      layers,
      collapsedNodeIds: [...collapsedNodeIds],
    },
    diagnostics: {
      hasAori: true,
      aspectCount: profile.aspects.length,
      itemCount: profile.entities.length,
      relationCount: profile.relations.length,
      aspectKindDistribution: Object.fromEntries(profile.aspects.reduce((map, aspect) => {
        map.set(aspect.kind, (map.get(aspect.kind) ?? 0) + 1);
        return map;
      }, new Map<string, number>())),
      domainKindTopK: topK(profile.aspects.reduce((map, aspect) => {
        increment(map, aspect.domainKind || "unknown");
        return map;
      }, new Map<string, number>())),
      domainRelationTopK: topK(profile.assertions.reduce((map, assertion) => {
        increment(map, assertion.domainRelation || assertion.relationFamily);
        return map;
      }, new Map<string, number>())),
      closureDistribution: { partial: profile.assertions.length },
      unsupportedItemCount: profile.assertions.filter((assertion) => assertion.status === "uncertain").length,
      fallbackOnlyItemCount: 0,
      isolatedItemCount: profile.entities.filter((entity) =>
        !profile.relations.some((relation) => relation.sourceId === entity.id || relation.targetId === entity.id),
      ).length,
      legacyProjectionOtherRatio: 0,
      warnings: [],
    },
  };
}

export function aoriIndexToExtraction(index: AoriDocumentIndex): ExtractionOutput {
  const nodeKeyByItemId = new Map<string, string>();
  const projectableItems = index.aspects.flatMap((aspect) => aspect.items
    .filter((item) => item.evidenceChunkIds.length > 0 && item.evidenceStatus !== "unsupported" && !item.fallbackOnly)
    .map((item) => ({ item, aspect })));
  const nodes = projectableItems.map(({ item, aspect }, index) => {
    const key = `aori_${index + 1}`;
    nodeKeyByItemId.set(item.id, key);
    return {
      key,
      kind: aspect.kind === "claim" ? "claim" as const : "concept" as const,
      title: truncateText(item.title, 180),
      summary: truncateText(item.summary, 2000),
      evidenceChunkIds: item.evidenceChunkIds,
      aspects: [aspect.kind],
    };
  });
  const relations = index.aspects.flatMap((aspect) => aspect.relations).flatMap((relation) => {
    const sourceKey = nodeKeyByItemId.get(relation.sourceItemId);
    const targetKey = nodeKeyByItemId.get(relation.targetItemId);
    if (!sourceKey || !targetKey || relation.evidenceStatus === "unsupported" || relation.evidenceChunkIds.length === 0) return [];
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
      aspects: [aspect.kind],
    }];
  });
  return { nodes, relations, themes };
}
