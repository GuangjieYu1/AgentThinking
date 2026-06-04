import type {
  AbstractNode,
  AnswerScope,
  Aspect,
  AspectItem,
  AspectRelation,
  Chunk,
  PulseEvidenceGap,
  PulseQuestionPlan,
  Relation,
  ScopeClosureReport,
  SummaryTreeNode,
} from "@agent-thinking/contracts";
import type { AgentDatabase } from "../db.js";

export interface ScopeClosureResult {
  answerScope: AnswerScope;
  report: ScopeClosureReport;
  chunks: Chunk[];
  graphNodes: AbstractNode[];
  graphRelations: Relation[];
  summaryNodes: SummaryTreeNode[];
  aoriAspects: Aspect[];
  aoriAspectItems: AspectItem[];
  aoriAspectRelations: AspectRelation[];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function queryTerms(value: string): string[] {
  const normalized = normalizeText(value);
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const hanRuns = normalized.match(/\p{Script=Han}+/gu) ?? [];
  const han = hanRuns.flatMap((run) => {
    const chars = [...run];
    const grams = chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`);
    return [...chars.filter((char) => !/[的是了和与及在把给我你他她它其该这那总共多少每一笔明细]/.test(char)), ...grams];
  });
  return uniqueStrings([...latin, ...han]).slice(0, 32);
}

function textScore(text: string, labels: string[], question: string): number {
  const normalized = normalizeText(text);
  const terms = uniqueStrings([...labels.flatMap(queryTerms), ...queryTerms(question)]).slice(0, 40);
  let score = normalized.includes(normalizeText(question)) ? 0.35 : 0;
  for (const label of labels) {
    const value = normalizeText(label);
    if (value && normalized.includes(value)) score += 0.28;
  }
  for (const term of terms) {
    if (term.length > 0 && normalized.includes(term)) score += term.length > 1 ? 0.08 : 0.025;
  }
  return Math.min(1, score);
}

function answerShape(questionPlan: PulseQuestionPlan): AnswerScope["answerShape"] {
  if (questionPlan.requiresNumericalReconciliation || questionPlan.questionType === "numerical_aggregation") return "numeric";
  if (questionPlan.requiresTimelineCompleteness || questionPlan.questionType === "timeline") return "timeline";
  if (questionPlan.questionType === "exhaustive_list") return "list";
  if (questionPlan.questionType === "comparison") return "comparison";
  if (questionPlan.questionType === "entity_relation" || questionPlan.questionType === "causal_explanation") return "relation";
  if (questionPlan.requiresSourceQuotes || questionPlan.questionType === "claim_support") return "evidence";
  if (questionPlan.questionType === "summary") return "summary";
  return questionPlan.questionType === "mixed" ? "mixed" : "summary";
}

function genericNumericSignal(text: string): boolean {
  return /[0-9０-９一二三四五六七八九十百千万亿%％￥$€£元圆块万亿]/.test(text);
}

export class ScopeClosureRetriever {
  constructor(private readonly db: AgentDatabase) {}

  close(libraryId: string, question: string, questionPlan: PulseQuestionPlan): ScopeClosureResult {
    const shape = answerShape(questionPlan);
    const targetLabels = uniqueStrings([
      ...questionPlan.keyEntities,
      ...questionPlan.evidenceTargets,
      ...questionPlan.expectedEvidenceTypes,
      question,
    ]).slice(0, 24);

    const aoriIndexes = this.db.listAoriDocumentIndexes(libraryId);
    const scoredAspects = aoriIndexes.flatMap((index) => index.aspects.map((aspect) => {
      const aspectText = [aspect.title, aspect.summary, aspect.centralQuestion, index.understanding.summary, index.understanding.centralQuestion].join("\n");
      const itemScore = Math.max(0, ...aspect.items.map((item) => textScore([item.title, item.summary].join("\n"), targetLabels, question)
        + (shape === "numeric" && genericNumericSignal(`${item.title} ${item.summary}`) ? 0.12 : 0)));
      const relationScore = Math.max(0, ...aspect.relations.map((relation) => textScore([relation.relationName, relation.reason].join("\n"), targetLabels, question)));
      return {
        index,
        aspect,
        score: Math.max(textScore(aspectText, targetLabels, question), itemScore, relationScore),
      };
    })).filter((entry) => entry.score > 0.08)
      .sort((left, right) => right.score - left.score)
      .slice(0, shape === "list" || shape === "numeric" ? 5 : 3);

    const selectedAspects = scoredAspects.map((entry) => entry.aspect);
    const selectedItems = selectedAspects.flatMap((aspect) => aspect.items);
    const selectedAspectRelations = selectedAspects.flatMap((aspect) => aspect.relations);

    const nodeMatches = new Map<string, AbstractNode>();
    for (const query of uniqueStrings([question, ...targetLabels]).slice(0, 8)) {
      for (const match of this.db.searchAbstractNodes(libraryId, query, 8)) nodeMatches.set(match.node.id, match.node);
    }
    const themeNodes = [...nodeMatches.values()].filter((node) => node.level === 2).slice(0, 6);
    const children = this.db.getAbstractionChildren(themeNodes.map((node) => node.id));
    for (const childList of children.values()) for (const child of childList) nodeMatches.set(child.id, child);

    const summaryMatches = new Map<string, SummaryTreeNode>();
    for (const query of uniqueStrings([question, ...targetLabels]).slice(0, 6)) {
      for (const summary of this.db.searchSummaryTree(libraryId, query, 8)) summaryMatches.set(summary.id, summary);
    }

    const relations = this.db.getIncidentRelations(libraryId, [...nodeMatches.keys()]);
    for (const relation of relations) {
      const source = this.db.getAbstractNode(relation.sourceNodeId);
      const target = this.db.getAbstractNode(relation.targetNodeId);
      if (source) nodeMatches.set(source.id, source);
      if (target) nodeMatches.set(target.id, target);
    }

    const chunkIds = uniqueStrings([
      ...selectedItems.flatMap((item) => item.evidenceChunkIds),
      ...selectedAspectRelations.flatMap((relation) => relation.evidenceChunkIds),
      ...[...nodeMatches.values()].flatMap((node) => node.citations.map((citation) => citation.chunkId)),
      ...relations.flatMap((relation) => relation.evidenceChunkIds),
    ]);
    const chunks = this.db.getChunksByIds(chunkIds);
    const gaps: PulseEvidenceGap[] = [];
    const warnings: string[] = [];
    if (chunks.length === 0) {
      gaps.push({
        type: "unsupported_claim",
        description: "Scope Closure did not find source-bound chunks for the requested answer scope.",
        suggestedQueries: targetLabels.slice(0, 4),
        severity: "high",
      });
    }
    if ((shape === "list" || shape === "numeric") && selectedAspects.length === 0 && nodeMatches.size < 2) {
      gaps.push({
        type: "missing_itemized_evidence",
        description: "The requested list-like scope has no closed AORI aspect and too few graph nodes to claim exhaustive coverage.",
        suggestedQueries: targetLabels.slice(0, 5),
        severity: "medium",
      });
    }
    if (shape === "timeline" && selectedItems.length === 0 && summaryMatches.size === 0) {
      gaps.push({
        type: "timeline_gap",
        description: "The requested timeline scope did not match a time-oriented AORI aspect or summary tree range.",
        suggestedQueries: targetLabels.slice(0, 5),
        severity: "medium",
      });
    }
    if (shape === "relation" && selectedAspectRelations.length === 0 && relations.length === 0) {
      gaps.push({
        type: "other",
        description: "The requested relation scope did not yield evidence-bound relation edges.",
        suggestedQueries: targetLabels.slice(0, 5),
        severity: "medium",
      });
    }
    for (const aspect of selectedAspects) {
      if (aspect.closureReport.status !== "closed") {
        warnings.push(`AORI aspect "${aspect.title}" is ${aspect.closureReport.status}; answer should expose closure gaps when relevant.`);
      }
    }

    const answerScope: AnswerScope = {
      question,
      answerShape: shape,
      targetLabels,
      aspectIds: selectedAspects.map((aspect) => aspect.id),
      aspectItemIds: selectedItems.map((item) => item.id),
      themeNodeIds: themeNodes.map((node) => node.id),
      centerNodeIds: [...nodeMatches.keys()],
      summaryNodeIds: [...summaryMatches.keys()],
      versionIds: uniqueStrings([
        ...selectedAspects.map((aspect) => aspect.versionId),
        ...chunks.map((chunk) => chunk.versionId),
        ...[...summaryMatches.values()].map((summary) => summary.versionId),
      ]),
      reasoning: "Question scope was closed by matching AORI aspects/items first, then legacy theme members, one-hop graph relations, summary nodes, and evidence-bound chunks.",
    };
    const status: ScopeClosureReport["status"] = gaps.length === 0 && warnings.length === 0
      ? "closed"
      : chunks.length > 0 || selectedAspects.length > 0 || nodeMatches.size > 0
        ? "partial"
        : "open";
    const report: ScopeClosureReport = {
      status,
      answerScope,
      nodeIds: [...nodeMatches.keys()],
      relationIds: relations.map((relation) => relation.id),
      chunkIds: chunks.map((chunk) => chunk.id),
      aspectIds: selectedAspects.map((aspect) => aspect.id),
      aspectItemIds: selectedItems.map((item) => item.id),
      aspectRelationIds: selectedAspectRelations.map((relation) => relation.id),
      gaps,
      warnings,
      generatedAt: new Date().toISOString(),
    };

    return {
      answerScope,
      report,
      chunks,
      graphNodes: [...nodeMatches.values()],
      graphRelations: relations,
      summaryNodes: [...summaryMatches.values()],
      aoriAspects: selectedAspects,
      aoriAspectItems: selectedItems,
      aoriAspectRelations: selectedAspectRelations,
    };
  }
}
