import type {
  AbstractNode,
  Chunk,
  ContextUnit,
  EvidenceCitation,
  EvidencePack,
  PulseAnswerOutput,
  PulseEvidenceMemory,
  PulseEvidencePlan,
  PulseEvidenceReconciliation,
  PulseEvidenceRow,
  PulseEvidenceStatus,
  PulseEvidenceStep,
  PulseEvidenceTool,
  PulseInputMode,
  PulseQuestionPlan,
  PulseVerificationResult,
  Relation,
  RetrievalUnit,
  SearchResult,
  SummaryTreeNode,
} from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../db.js";
import type { ModelProvider } from "./models.js";
import type { VectorStore } from "./vector-store.js";
import { computeGenericReconciliation, normalizeAnswerMode, overclaimErrors, validateEvidenceRow } from "./evidence-v2.js";
import { ScopeClosureRetriever, type ScopeClosureResult } from "./scope-closure.js";

type PulseEventSink = (event: { type: "stage"; message: string }) => void | Promise<void>;

export interface PulseSeedContext {
  hits: PendingPulseHit[];
  chunks: Chunk[];
  nodes: AbstractNode[];
  relations: Relation[];
  navigationTrace?: Array<{
    stepIndex: number;
    targetType: PendingPulseHit["targetType"];
    label: string;
    observation: string;
    rationale: string;
  }>;
}

export interface PulseEvidenceControllerResult extends PulseAnswerOutput {
  hits: PendingPulseHit[];
  evidencePack: EvidencePack;
}

const allowedTools: PulseEvidenceTool[] = [
  "semanticSearchChildChunks",
  "fullTextSearchChildChunks",
  "retrieveParentChunks",
  "retrieveDocumentTreeNodes",
  "retrieveSectionSubtree",
  "retrieveSiblingNodes",
  "retrieveRemainingNodesAfter",
  "retrieveSummaryTree",
  "graphSearch",
  "graphExpand",
  "retrieveEvidenceForGraphNodes",
  "buildEvidencePack",
  "semanticSearch",
  "fullTextSearch",
  "readChunks",
  "readNeighborChunks",
  "readSameSectionChunks",
  "readRemainingChunksAfter",
  "getDocumentOutline",
  "getChunkEvidenceAround",
  "getGraphContext",
  "semanticSearchRetrievalUnits",
  "fullTextSearchRetrievalUnits",
  "retrieveContextUnits",
  "readContextUnits",
  "retrieveNeighborContextUnits",
  "retrieveSameSectionContextUnits",
  "retrieveRemainingContextUnitsAfter",
  "getContextUnitOutline",
];

const toolAliases = new Map<PulseEvidenceTool, PulseEvidenceTool>([
  ["semanticSearch", "semanticSearchChildChunks"],
  ["fullTextSearch", "fullTextSearchChildChunks"],
  ["semanticSearchRetrievalUnits", "semanticSearchChildChunks"],
  ["fullTextSearchRetrievalUnits", "fullTextSearchChildChunks"],
  ["retrieveContextUnits", "retrieveParentChunks"],
  ["readContextUnits", "retrieveParentChunks"],
  ["readNeighborChunks", "retrieveSiblingNodes"],
  ["retrieveNeighborContextUnits", "retrieveSiblingNodes"],
  ["readSameSectionChunks", "retrieveSectionSubtree"],
  ["retrieveSameSectionContextUnits", "retrieveSectionSubtree"],
  ["readRemainingChunksAfter", "retrieveRemainingNodesAfter"],
  ["retrieveRemainingContextUnitsAfter", "retrieveRemainingNodesAfter"],
  ["getDocumentOutline", "retrieveDocumentTreeNodes"],
  ["getContextUnitOutline", "retrieveDocumentTreeNodes"],
  ["getChunkEvidenceAround", "retrieveParentChunks"],
  ["getGraphContext", "graphSearch"],
  ["readChunks", "retrieveParentChunks"],
]);

const continuationGapTypes = new Set<PulseEvidenceStatus["gaps"][number]["type"]>([
  "missing_itemized_evidence",
  "declared_total_without_breakdown",
  "sum_mismatch",
  "missing_entity_coverage",
]);

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function chunkLabel(chunk: Chunk): string {
  return chunk.headingPath ?? (chunk.pageNumber ? `PDF page ${chunk.pageNumber}` : `Chunk ${chunk.ordinal + 1}`);
}

function relationLabel(relation: Relation, nodes: Map<string, AbstractNode>): string {
  const source = nodes.get(relation.sourceNodeId)?.title ?? relation.sourceNodeId;
  const target = nodes.get(relation.targetNodeId)?.title ?? relation.targetNodeId;
  return `${source} ${relation.type} ${target}`;
}

function compactChunk(chunk: Chunk): PulseEvidenceMemory["collectedChunks"][number] {
  return {
    id: chunk.id,
    versionId: chunk.versionId,
    text: chunk.text.slice(0, 1600),
    headingPath: chunk.headingPath,
    pageNumber: chunk.pageNumber,
    ordinal: chunk.ordinal,
    parentChunkId: chunk.parentChunkId ?? null,
    documentTreeNodeId: chunk.documentTreeNodeId ?? null,
    nodeType: chunk.nodeType ?? null,
  };
}

function contextUnitAsChunk(libraryId: string, unit: ContextUnit): Chunk {
  return {
    id: unit.id,
    libraryId,
    versionId: unit.versionId,
    parentChunkId: null,
    documentTreeNodeId: unit.primarySourceNodeId ?? null,
    childOrdinal: null,
    parentOrdinal: unit.ordinal,
    nodeType: "section",
    ordinal: unit.ordinal,
    headingPath: unit.displayHeadingPath.join(" / ") || null,
    pageNumber: null,
    startLine: null,
    endLine: null,
    blockId: null,
    startChar: unit.sourceRange.startChar,
    endChar: unit.sourceRange.endChar,
    text: unit.text,
    aspects: [],
  };
}

function rowDedupeKey(row: PulseEvidenceRow): string {
  return row.dedupeKey?.trim() || `${row.evidenceType}:${row.evidenceChunkId}:${row.evidenceQuote.trim()}`;
}

function estimatedContextUnitTokens(unit: ContextUnit): number {
  return unit.estimatedTokens ?? Math.max(1, Math.ceil(unit.text.length / 4));
}

export function computePulseReconciliation(rows: PulseEvidenceRow[]): PulseEvidenceReconciliation | undefined {
  return computeGenericReconciliation(rows);
}

export function verifyPulseAnswer(
  output: PulseAnswerOutput,
  questionPlan: PulseQuestionPlan,
  memory: PulseEvidenceMemory,
  evidenceStatus: PulseEvidenceStatus,
): PulseVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const answer = output.answer;
  if (questionPlan.requiresSourceQuotes && memory.evidenceRows.length > 0) {
    const quotes = memory.evidenceRows.map((row) => row.evidenceQuote.trim()).filter(Boolean);
    if (!quotes.some((quote) => answer.includes(quote.slice(0, Math.min(24, quote.length))))) {
      errors.push("Answer is missing a verifiable source quote / 原文引用 / 完整.");
    }
  }
  if (!evidenceStatus.sufficient && /鍏ㄩ儴|姣忎竴绗攟瀹屾暣|绌峰敖|鎵€鏈墊鏃犻仐婕弢complete|all|every/i.test(answer)) {
    errors.push("Insufficient evidence cannot support complete or exhaustive wording / 完整.");
  }
  errors.push(...overclaimErrors(answer, questionPlan, evidenceStatus.sufficient));
  const reconciliation = evidenceStatus.reconciliation;
  if (questionPlan.requiresNumericalReconciliation && reconciliation && !reconciliation.closed) {
    const diff = reconciliation.difference;
    if (diff === undefined || !answer.includes(String(diff))) {
      errors.push("Unclosed numeric evidence must expose declared total, itemized sum, and difference / 差额.");
    }
  }
  if (questionPlan.answerMustExposeGaps && evidenceStatus.gaps.length > 0) {
    const exposesGap = evidenceStatus.gaps.some((gap) => answer.includes(gap.description.slice(0, Math.min(18, gap.description.length))));
    if (!exposesGap && !/缂哄彛|涓嶈冻|鏃犳硶纭|浠嶉渶|gap|insufficient/i.test(answer)) {
      errors.push("Evidence gaps must be explicitly exposed in the answer / 缺口.");
    }
  }
  if (memory.evidenceRows.length === 0) warnings.push("No structured EvidenceRows were extracted; answer must stay guarded.");
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    ...(errors.length > 0 ? { rewriteInstructions: errors.join(" ") } : {}),
  };
}

export class PulseEvidenceController {
  constructor(
    private readonly db: AgentDatabase,
    private readonly vectors: VectorStore,
    private readonly model: ModelProvider,
  ) {}

  async answer(
    libraryId: string,
    question: string,
    mode: PulseInputMode,
    seedContext: PulseSeedContext,
    eventSink?: PulseEventSink,
  ): Promise<PulseEvidenceControllerResult> {
    await eventSink?.({ type: "stage", message: "姝ｅ湪鍒嗘瀽闂鎵€闇€璇佹嵁" });
    const analyzedQuestionPlan = await this.model.analyzePulseQuestion(question, mode);
    const scopeClosure = new ScopeClosureRetriever(this.db).close(libraryId, question, analyzedQuestionPlan);
    const questionPlan: PulseQuestionPlan = { ...analyzedQuestionPlan, answerScope: scopeClosure.answerScope };
    const memory = this.createMemory(question, questionPlan, seedContext);
    const hitMap = new Map<string, PendingPulseHit>();
    for (const hit of seedContext.hits) hitMap.set(`${hit.targetType}:${hit.targetId}`, hit);

    this.applyScopeClosure(memory, scopeClosure, hitMap);
    await this.extractRowsForChunks(question, memory, "Seed evidence from the existing pulse graph.");
    const planned = await this.model.planPulseEvidence({
      question,
      mode,
      questionPlan,
      memorySummary: this.memorySummary(memory),
      tools: allowedTools,
    });
    const initialPlan = this.withEvidenceHeavySteps(planned, questionPlan);
    const defaultMaxIterations = mode === "progressive"
      ? questionPlan.riskLevel === "high" && questionPlan.requiresExhaustiveEvidence ? 6 : 5
      : 2;
    const maxIterations = Math.min(
      defaultMaxIterations,
      Math.max(mode === "progressive" ? defaultMaxIterations : 1, initialPlan.maxIterations || defaultMaxIterations),
    );
    let plan: PulseEvidencePlan = initialPlan;
    let status: PulseEvidenceStatus | undefined;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      await eventSink?.({ type: "stage", message: `Running evidence retrieval iteration ${iteration + 1}` });
      const chunkIdsBeforeIteration = new Set(memory.collectedChunks.map((chunk) => chunk.id));
      const rowsBeforeIteration = memory.evidenceRows.length;
      const steps = this.validSteps(plan).slice(0, mode === "progressive" ? 5 : 8);
      for (const step of steps) {
        const chunks = await this.executeStep(libraryId, question, step, memory, hitMap, mode, iteration + 1);
        if (chunks.length > 0) {
          const addedRows = await this.extractRowsForChunks(question, memory, step.purpose, chunks);
          const latestTrace = memory.retrievalTrace?.at(-1);
          if (latestTrace && latestTrace.tool === step.tool) latestTrace.newEvidenceRowCount = addedRows;
        }
      }
      const newChunkCount = memory.collectedChunks.filter((chunk) => !chunkIdsBeforeIteration.has(chunk.id)).length;
      const newRowCount = memory.evidenceRows.length - rowsBeforeIteration;
      const reconciliation = computePulseReconciliation(memory.evidenceRows);
      status = await this.model.judgePulseEvidenceSufficiency({
        question,
        questionPlan,
        memory: this.memorySummary(memory),
        computedReconciliation: reconciliation,
      });
      memory.sufficiencyHistory.push(status);
      memory.gaps = status.gaps;
      if (status.sufficient) break;
      if (iteration + 1 >= maxIterations) break;
      if (iteration > 0 && (newChunkCount === 0 || newRowCount === 0)) break;
      const nextPlan = this.buildGapContinuationPlan(question, mode, memory, status, maxIterations);
      if (nextPlan.steps.length === 0) break;
      plan = nextPlan;
    }

    const finalStatus = status ?? {
      sufficient: false,
      status: "partial_answer_only" as const,
      gaps: [],
      reasoning: "No sufficiency judgment was produced; answer must stay guarded.",
      ...(computePulseReconciliation(memory.evidenceRows) ? { reconciliation: computePulseReconciliation(memory.evidenceRows) } : {}),
    };
    await eventSink?.({ type: "stage", message: "Synthesizing answer from EvidenceMemory" });
    let output = await this.model.synthesizePulseAnswer({
      question,
      questionPlan,
      memory: this.memorySummary(memory),
      evidenceStatus: finalStatus,
    });
    output = this.attachDiagnostics(output, memory, finalStatus);
    let verification = verifyPulseAnswer(output, questionPlan, memory, finalStatus);
    if (!verification.passed && verification.rewriteInstructions) {
      await eventSink?.({ type: "stage", message: "Verifying and tightening the answer" });
      const rewritten = await this.model.rewritePulseAnswer({
        question,
        draft: output,
        rewriteInstructions: verification.rewriteInstructions,
        memory: this.memorySummary(memory),
        evidenceStatus: finalStatus,
      });
      output = this.attachDiagnostics(rewritten, memory, finalStatus, verification.warnings);
      verification = verifyPulseAnswer(output, questionPlan, memory, finalStatus);
    }
    if (!verification.passed) {
      output = this.guardedAnswer(question, memory, finalStatus, verification);
    }
    return { ...output, hits: [...hitMap.values()], evidencePack: this.buildEvidencePack(question, memory, finalStatus) };
  }

  private createMemory(question: string, questionPlan: PulseQuestionPlan, seed: PulseSeedContext): PulseEvidenceMemory {
    const chunkMap = new Map(seed.chunks.map((chunk) => [chunk.id, compactChunk(chunk)]));
    const nodeMap = new Map(seed.nodes.map((node) => [node.id, { id: node.id, title: node.title, summary: node.summary }]));
    const nodeLookup = new Map(seed.nodes.map((node) => [node.id, node]));
    const relationMap = new Map(seed.relations.map((relation) => [relation.id, {
      id: relation.id,
      type: relation.type,
      sourceTitle: nodeLookup.get(relation.sourceNodeId)?.title ?? relation.sourceNodeId,
      targetTitle: nodeLookup.get(relation.targetNodeId)?.title ?? relation.targetNodeId,
      reason: relation.reason,
    }]));
    return {
      question,
      questionPlan,
      collectedChunks: [...chunkMap.values()],
      legacyChunks: [...chunkMap.values()],
      contextUnits: [],
      retrievalUnits: [],
      contextBlocks: [],
      usedIndexProfile: "v1",
      graphNodes: [...nodeMap.values()],
      graphRelations: [...relationMap.values()],
      treeNodes: [],
      parentChunks: [],
      summaryNodes: [],
      evidenceRows: [],
      citedChunkIds: [],
      retrievalHistory: [],
      retrievalTrace: [],
      currentFindings: [],
      warnings: [],
      gaps: [],
      sufficiencyHistory: [],
    };
  }

  private addWarning(memory: PulseEvidenceMemory, warning: string): void {
    memory.warnings ??= [];
    if (!memory.warnings.includes(warning)) memory.warnings.push(warning);
  }

  private applyScopeClosure(
    memory: PulseEvidenceMemory,
    closure: ScopeClosureResult,
    hitMap: Map<string, PendingPulseHit>,
  ): void {
    memory.answerScope = closure.answerScope;
    memory.scopeClosureReport = closure.report;
    memory.questionPlan = { ...memory.questionPlan, answerScope: closure.answerScope };
    this.addChunks(memory, closure.chunks);
    this.addSummaryNodes(memory, closure.summaryNodes);

    const graphNodeMap = new Map(memory.graphNodes.map((node) => [node.id, node]));
    for (const node of closure.graphNodes) graphNodeMap.set(node.id, { id: node.id, title: node.title, summary: node.summary });
    memory.graphNodes = [...graphNodeMap.values()];

    const fullNodeMap = new Map(closure.graphNodes.map((node) => [node.id, node]));
    const graphRelationMap = new Map(memory.graphRelations.map((relation) => [relation.id, relation]));
    for (const relation of closure.graphRelations) {
      const source = fullNodeMap.get(relation.sourceNodeId) ?? this.db.getAbstractNode(relation.sourceNodeId);
      const target = fullNodeMap.get(relation.targetNodeId) ?? this.db.getAbstractNode(relation.targetNodeId);
      graphRelationMap.set(relation.id, {
        id: relation.id,
        type: relation.type,
        sourceTitle: source?.title ?? relation.sourceNodeId,
        targetTitle: target?.title ?? relation.targetNodeId,
        reason: relation.reason,
      });
      hitMap.set(`relation:${relation.id}`, {
        targetType: "relation",
        targetId: relation.id,
        score: clampScore(relation.confidence ?? 0.58),
        reason: "Scope Closure Retrieval",
        pathRole: "expanded",
        stepIndex: 0,
        observation: "Scope Closure selected this relation inside the answer range.",
        rationale: "The relation is part of the closed V/E scope and contributes evidence-bound edges.",
        label: source && target ? `${source.title} ${relation.type} ${target.title}` : relation.type,
        excerpt: relation.reason,
      });
    }
    memory.graphRelations = [...graphRelationMap.values()];

    const mergeById = <T extends { id: string }>(current: T[] | undefined, next: T[]): T[] => {
      const values = new Map((current ?? []).map((item) => [item.id, item]));
      for (const item of next) values.set(item.id, item);
      return [...values.values()];
    };
    memory.aoriAspects = mergeById(memory.aoriAspects, closure.aoriAspects);
    memory.aoriAspectItems = mergeById(memory.aoriAspectItems, closure.aoriAspectItems);
    memory.aoriAspectRelations = mergeById(memory.aoriAspectRelations, closure.aoriAspectRelations);

    const closureStep: PulseEvidenceStep = {
      tool: "graphSearch",
      query: memory.question,
      purpose: "Scope Closure Retrieval",
      expectedResult: "Question-scoped V/E graph and evidence-bound chunks.",
    };
    for (const chunk of closure.chunks) {
      this.addChunkHit(hitMap, chunk, closureStep, -20);
    }
    memory.retrievalHistory.push({
      tool: "graphSearch",
      query: memory.question,
      chunkIds: closure.chunks.map((chunk) => chunk.id),
      purpose: "Scope Closure Retrieval",
    });
    memory.retrievalTrace?.push({
      stepIndex: 0,
      tool: "graphSearch",
      purpose: "Scope Closure Retrieval",
      query: memory.question,
      inputIds: closure.answerScope.targetLabels,
      outputIds: closure.chunks.map((chunk) => chunk.id),
      targetType: "legacy_chunk",
      newEvidenceRowCount: 0,
      status: closure.chunks.length > 0 ? "success" : "empty",
    });
    if (closure.report.gaps.length > 0) memory.gaps = closure.report.gaps;
    memory.currentFindings.push(`Scope Closure ${closure.report.status}: ${closure.report.chunkIds.length} chunks, ${closure.report.nodeIds.length} nodes, ${closure.report.aspectIds.length} AORI aspects.`);
  }

  private validSteps(plan: PulseEvidencePlan): PulseEvidenceStep[] {
    const allowed = new Set<PulseEvidenceTool>(allowedTools);
    return plan.steps.flatMap((step) => {
      const tool = toolAliases.get(step.tool) ?? step.tool;
      return allowed.has(tool) ? [{ ...step, tool }] : [];
    });
  }

  private withEvidenceHeavySteps(plan: PulseEvidencePlan, questionPlan: PulseQuestionPlan): PulseEvidencePlan {
    const answerMode = normalizeAnswerMode(questionPlan);
    if (answerMode.answerMode !== "evidence_heavy") return plan;
    const hasTool = (tool: PulseEvidenceTool) => plan.steps.some((step) => (toolAliases.get(step.tool) ?? step.tool) === tool);
    const required: PulseEvidenceStep[] = [];
    if (!hasTool("retrieveParentChunks")) {
      required.push({
        tool: "retrieveParentChunks",
        purpose: "Evidence-heavy mode requires source context for extracted evidence.",
        expectedResult: "Context units or parent chunks around current evidence anchors.",
      });
    }
    if (!hasTool("retrieveSectionSubtree")) {
      required.push({
        tool: "retrieveSectionSubtree",
        purpose: "Evidence-heavy mode requires same-section coverage for exhaustive or numerical questions.",
        expectedResult: "Same-section context units or chunks for structured evidence extraction.",
      });
    }
    return {
      ...plan,
      steps: [...plan.steps, ...required],
      maxIterations: Math.max(plan.maxIterations, questionPlan.requiresExhaustiveEvidence ? 4 : 2),
    };
  }

  private evidenceChunkLimit(mode: PulseInputMode, memory: PulseEvidenceMemory): number {
    if (mode !== "progressive") return 12;
    return memory.questionPlan.riskLevel === "high" && memory.questionPlan.requiresExhaustiveEvidence ? 12 : 10;
  }

  private readyV2Context(libraryId: string): {
    buildId: string;
    contextUnits: ContextUnit[];
    retrievalUnits: RetrievalUnit[];
    contextById: Map<string, ContextUnit>;
    retrievalById: Map<string, RetrievalUnit>;
  } | undefined {
    const retrievalUnits = this.db.getReadyRetrievalUnitsForLibrary(libraryId);
    if (retrievalUnits.length === 0) return undefined;
    const contextUnits = this.db.getContextUnitsByIds([...new Set(retrievalUnits.map((unit) => unit.contextUnitId))]);
    const buildId = retrievalUnits[0]?.buildId;
    if (!buildId) return undefined;
    return {
      buildId,
      contextUnits,
      retrievalUnits,
      contextById: new Map(contextUnits.map((unit) => [unit.id, unit])),
      retrievalById: new Map(retrievalUnits.map((unit) => [unit.id, unit])),
    };
  }

  private addContextUnits(memory: PulseEvidenceMemory, units: ContextUnit[]): void {
    memory.contextUnits ??= [];
    memory.contextBlocks ??= [];
    const existing = new Set(memory.contextUnits.map((unit) => unit.id));
    for (const unit of units) {
      if (existing.has(unit.id)) continue;
      existing.add(unit.id);
      memory.contextUnits.push(unit);
      memory.contextBlocks.push(...unit.blocks);
    }
  }

  private addRetrievalUnits(memory: PulseEvidenceMemory, units: RetrievalUnit[]): void {
    memory.retrievalUnits ??= [];
    const existing = new Set(memory.retrievalUnits.map((unit) => unit.id));
    for (const unit of units) {
      if (existing.has(unit.id)) continue;
      existing.add(unit.id);
      memory.retrievalUnits.push(unit);
    }
  }

  private v2ChunksFromUnits(libraryId: string, memory: PulseEvidenceMemory, units: ContextUnit[], retrievalUnits: RetrievalUnit[] = []): Chunk[] {
    this.addContextUnits(memory, units);
    const resolvedRetrievalUnits = retrievalUnits.length > 0
      ? retrievalUnits
      : this.db.getRetrievalUnitsByIds([...new Set(units.flatMap((unit) => unit.retrievalUnitIds))]);
    this.addRetrievalUnits(memory, resolvedRetrievalUnits);
    memory.usedIndexProfile = "v2";
    return units.map((unit) => contextUnitAsChunk(libraryId, unit));
  }

  private selectedContextUnitTrace(
    units: ContextUnit[],
    retrievalUnits: RetrievalUnit[],
    reason: string,
  ): Array<{ contextUnitId: string; retrievalUnitIds: string[]; estimatedTokens: number; reason: string }> {
    const retrievalIdsByContext = new Map<string, string[]>();
    for (const unit of retrievalUnits) {
      const ids = retrievalIdsByContext.get(unit.contextUnitId) ?? [];
      ids.push(unit.id);
      retrievalIdsByContext.set(unit.contextUnitId, ids);
    }
    return units.map((unit) => ({
      contextUnitId: unit.id,
      retrievalUnitIds: retrievalIdsByContext.get(unit.id) ?? unit.retrievalUnitIds,
      estimatedTokens: estimatedContextUnitTokens(unit),
      reason,
    }));
  }

  private estimatedTokensAfterStep(memory: PulseEvidenceMemory): number {
    const contextTokens = new Map((memory.contextUnits ?? []).map((unit) => [unit.id, estimatedContextUnitTokens(unit)]));
    const chunkTokens = memory.collectedChunks
      .filter((chunk) => !contextTokens.has(chunk.id))
      .reduce((sum, chunk) => sum + Math.max(1, Math.ceil(chunk.text.length / 4)), 0);
    return [...contextTokens.values()].reduce((sum, value) => sum + value, chunkTokens);
  }

  private backfillContextUnitsForRetrievalHits(
    v2: {
      contextById: Map<string, ContextUnit>;
    },
    retrievalUnits: RetrievalUnit[],
    limit: number,
  ): {
    contextUnits: ContextUnit[];
    retrievalUnits: RetrievalUnit[];
    missingContextUnitIds: string[];
  } {
    const contextUnitIds = [...new Set(retrievalUnits.map((unit) => unit.contextUnitId))];
    const missingBeforeFetch = contextUnitIds.filter((id) => !v2.contextById.has(id));
    for (const unit of this.db.getContextUnitsByIds(missingBeforeFetch)) {
      v2.contextById.set(unit.id, unit);
    }
    const missingContextUnitIds = contextUnitIds.filter((id) => !v2.contextById.has(id));
    const validRetrievalUnits = retrievalUnits.filter((unit) => v2.contextById.has(unit.contextUnitId));
    return {
      contextUnits: this.mergeContextUnits(validRetrievalUnits.flatMap((unit) => v2.contextById.get(unit.contextUnitId) ?? []), limit),
      retrievalUnits: validRetrievalUnits,
      missingContextUnitIds,
    };
  }

  private mergeContextUnits(units: ContextUnit[], limit: number): ContextUnit[] {
    const byId = new Map<string, ContextUnit>();
    for (const unit of units) if (!byId.has(unit.id)) byId.set(unit.id, unit);
    return [...byId.values()].sort((left, right) => left.ordinal - right.ordinal).slice(0, limit);
  }

  private contextAnchors(memory: PulseEvidenceMemory, limit: number): ContextUnit[] {
    const byId = new Map((memory.contextUnits ?? []).map((unit) => [unit.id, unit]));
    for (const row of memory.evidenceRows) {
      if (row.contextUnitId && !byId.has(row.contextUnitId)) {
        const unit = this.db.getContextUnitsByIds([row.contextUnitId])[0];
        if (unit) byId.set(unit.id, unit);
      }
      if (byId.has(row.evidenceChunkId)) continue;
      const unit = this.db.getContextUnitsByIds([row.evidenceChunkId])[0];
      if (unit) byId.set(unit.id, unit);
    }
    return [...byId.values()].sort((left, right) => right.ordinal - left.ordinal).slice(0, limit);
  }

  private async executeStep(
    libraryId: string,
    question: string,
    step: PulseEvidenceStep,
    memory: PulseEvidenceMemory,
    hitMap: Map<string, PendingPulseHit>,
    mode: PulseInputMode,
    iteration: number,
  ): Promise<Chunk[]> {
    const limit = this.evidenceChunkLimit(mode, memory);
    const query = step.query?.trim() || question;
    let chunks: Chunk[] = [];
    const rowCountBefore = memory.evidenceRows.length;
    const inputIds = [...(step.basedOnChunkIds ?? []), ...(step.basedOnNodeIds ?? [])];
    const v2 = this.readyV2Context(libraryId);
    let actualIndexProfile: "v1" | "v2" = "v1";
    let targetType: "legacy_chunk" | "retrieval_unit" = "legacy_chunk";
    let buildId: string | undefined;
    let outputRetrievalUnitIds: string[] = [];
    let outputContextUnitIds: string[] = [];
    let selectedContextUnits: NonNullable<NonNullable<PulseEvidenceMemory["retrievalTrace"]>[number]["selectedContextUnits"]> = [];
    let fallbackReason: string | undefined;
    if (v2 && step.tool === "semanticSearchChildChunks") {
      const [embedding] = await this.model.embed([query]);
      const retrievalByBuild = new Map<string, RetrievalUnit[]>();
      for (const unit of v2.retrievalUnits) {
        const group = retrievalByBuild.get(unit.buildId) ?? [];
        group.push(unit);
        retrievalByBuild.set(unit.buildId, group);
      }
      const results = embedding
        ? [...retrievalByBuild.entries()]
          .flatMap(([groupBuildId, units]) => this.vectors.searchRetrievalUnits(
            libraryId,
            groupBuildId,
            embedding,
            new Map(units.map((unit) => [unit.id, unit])),
            limit,
          ))
          .sort((left, right) => right.score - left.score)
          .slice(0, limit)
        : [];
      outputRetrievalUnitIds = results.map((result) => result.unit.id);
      const backfilled = this.backfillContextUnitsForRetrievalHits(v2, results.map((result) => result.unit), limit);
      if (results.length > 0 && backfilled.contextUnits.length === 0) {
        fallbackReason = `v2 retrieval units matched but ContextUnit backfill failed (${backfilled.missingContextUnitIds.join(", ")}); legacy retrieval was used.`;
        this.addWarning(memory, fallbackReason);
        memory.currentFindings.push(fallbackReason);
        chunks = embedding ? this.vectors.search(libraryId, embedding, limit).map((result) => result.chunk) : [];
      } else {
        outputContextUnitIds = backfilled.contextUnits.map((unit) => unit.id);
        selectedContextUnits = this.selectedContextUnitTrace(backfilled.contextUnits, backfilled.retrievalUnits, "semantic retrieval unit hit");
        chunks = this.v2ChunksFromUnits(libraryId, memory, backfilled.contextUnits, backfilled.retrievalUnits);
        actualIndexProfile = "v2";
        targetType = "retrieval_unit";
        buildId = v2.buildId;
      }
    } else if (v2 && step.tool === "fullTextSearchChildChunks") {
      const results = this.db.searchRetrievalUnitsText(libraryId, query, limit);
      outputRetrievalUnitIds = results.map((result) => result.unit.id);
      const backfilled = this.backfillContextUnitsForRetrievalHits(v2, results.map((result) => result.unit), limit);
      if (results.length > 0 && backfilled.contextUnits.length === 0) {
        fallbackReason = `v2 retrieval units matched but ContextUnit backfill failed (${backfilled.missingContextUnitIds.join(", ")}); legacy retrieval was used.`;
        this.addWarning(memory, fallbackReason);
        memory.currentFindings.push(fallbackReason);
        chunks = this.mergeResults([
          ...this.db.searchText(libraryId, query, limit),
          ...this.db.searchChunksFuzzy(libraryId, query, limit),
        ], limit).map((result) => result.chunk);
      } else {
        outputContextUnitIds = backfilled.contextUnits.map((unit) => unit.id);
        selectedContextUnits = this.selectedContextUnitTrace(backfilled.contextUnits, backfilled.retrievalUnits, "literal retrieval unit hit");
        chunks = this.v2ChunksFromUnits(libraryId, memory, backfilled.contextUnits, backfilled.retrievalUnits);
        actualIndexProfile = "v2";
        targetType = "retrieval_unit";
        buildId = v2.buildId;
      }
    } else if (v2 && step.tool === "retrieveParentChunks") {
      const ids = step.basedOnChunkIds ?? this.contextAnchors(memory, limit).map((unit) => unit.id);
      const direct = this.db.getContextUnitsByIds(ids);
      const fromRetrieval = this.db.getRetrievalUnitsByIds(ids).flatMap((unit) => v2.contextById.get(unit.contextUnitId) ?? []);
      const anchors = this.mergeContextUnits([...direct, ...fromRetrieval, ...this.contextAnchors(memory, limit)], mode === "progressive" ? limit : 30);
      outputContextUnitIds = anchors.map((unit) => unit.id);
      selectedContextUnits = this.selectedContextUnitTrace(anchors, this.db.getRetrievalUnitsByIds([...new Set(anchors.flatMap((unit) => unit.retrievalUnitIds))]), "direct context unit retrieval");
      chunks = this.v2ChunksFromUnits(libraryId, memory, anchors);
      actualIndexProfile = "v2";
      targetType = "retrieval_unit";
      buildId = v2.buildId;
    } else if (v2 && step.tool === "retrieveSiblingNodes") {
      const anchors = this.contextAnchors(memory, Math.max(1, Math.min(limit, 6)));
      const anchorKeys = new Set(anchors.map((unit) => `${unit.versionId}:${unit.ordinal}`));
      const siblings = this.mergeContextUnits(v2.contextUnits.filter((unit) => {
        for (const anchor of anchors) {
          if (unit.versionId === anchor.versionId && Math.abs(unit.ordinal - anchor.ordinal) <= (mode === "progressive" ? 1 : 2)) return true;
        }
        return anchorKeys.has(`${unit.versionId}:${unit.ordinal}`);
      }), mode === "progressive" ? limit : 30);
      outputContextUnitIds = siblings.map((unit) => unit.id);
      selectedContextUnits = this.selectedContextUnitTrace(siblings, this.db.getRetrievalUnitsByIds([...new Set(siblings.flatMap((unit) => unit.retrievalUnitIds))]), "neighbor context unit");
      chunks = this.v2ChunksFromUnits(libraryId, memory, siblings);
      actualIndexProfile = "v2";
      targetType = "retrieval_unit";
      buildId = v2.buildId;
    } else if (v2 && step.tool === "retrieveSectionSubtree") {
      const anchors = this.contextAnchors(memory, Math.max(1, Math.min(limit, 6)));
      const headings = new Set(anchors.map((unit) => `${unit.versionId}:${unit.headingPath.join(" / ")}`));
      const sameSection = this.mergeContextUnits(v2.contextUnits.filter((unit) => headings.has(`${unit.versionId}:${unit.headingPath.join(" / ")}`)), mode === "progressive" ? limit : 30);
      outputContextUnitIds = sameSection.map((unit) => unit.id);
      selectedContextUnits = this.selectedContextUnitTrace(sameSection, this.db.getRetrievalUnitsByIds([...new Set(sameSection.flatMap((unit) => unit.retrievalUnitIds))]), "same-section context unit");
      chunks = this.v2ChunksFromUnits(libraryId, memory, sameSection);
      actualIndexProfile = "v2";
      targetType = "retrieval_unit";
      buildId = v2.buildId;
    } else if (v2 && step.tool === "retrieveRemainingNodesAfter") {
      const anchors = this.contextAnchors(memory, Math.max(1, Math.min(limit, 6)));
      const remaining = this.mergeContextUnits(v2.contextUnits.filter((unit) => anchors.some((anchor) => (
        unit.versionId === anchor.versionId && unit.ordinal > anchor.ordinal
      ))), limit);
      outputContextUnitIds = remaining.map((unit) => unit.id);
      selectedContextUnits = this.selectedContextUnitTrace(remaining, this.db.getRetrievalUnitsByIds([...new Set(remaining.flatMap((unit) => unit.retrievalUnitIds))]), "remaining context unit after anchor");
      chunks = this.v2ChunksFromUnits(libraryId, memory, remaining);
      actualIndexProfile = "v2";
      targetType = "retrieval_unit";
      buildId = v2.buildId;
    } else if (step.tool === "semanticSearchChildChunks") {
      fallbackReason = "v2 retrieval units unavailable";
      const [embedding] = await this.model.embed([query]);
      chunks = embedding ? this.vectors.search(libraryId, embedding, limit).map((result) => result.chunk) : [];
    } else if (step.tool === "fullTextSearchChildChunks") {
      fallbackReason = "v2 retrieval units unavailable";
      chunks = this.mergeResults([
        ...this.db.searchText(libraryId, query, limit),
        ...this.db.searchChunksFuzzy(libraryId, query, limit),
      ], limit).map((result) => result.chunk);
    } else if (step.tool === "retrieveParentChunks") {
      fallbackReason = "v2 context units unavailable";
      chunks = this.db.getChunksByIds(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id));
      const parentLinks = this.db.getParentChildChunks(chunks.map((chunk) => chunk.id));
      this.addParentChunks(memory, parentLinks);
      chunks = this.mergeChunkList([
        ...chunks,
        ...this.db.getChunksByIds(parentLinks.map((link) => link.parentChunkId)),
      ], mode === "progressive" ? limit : 30);
    } else if (step.tool === "retrieveSiblingNodes") {
      fallbackReason = "v2 context units unavailable";
      chunks = this.db.getNeighborChunks(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id), mode === "progressive" ? 1 : 2).slice(0, mode === "progressive" ? limit : 30);
      const siblingNodeIds = [...new Set(chunks.flatMap((chunk) => chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : []))];
      this.addTreeNodes(memory, siblingNodeIds.flatMap((id) => this.db.getSiblingTreeNodes(id, 3)));
    } else if (step.tool === "retrieveSectionSubtree") {
      fallbackReason = "v2 context units unavailable";
      chunks = this.db.getSameSectionChunks(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id), mode === "progressive" ? limit : 30);
      const sectionIds = [...new Set(chunks.flatMap((chunk) => chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : []))];
      this.addTreeNodes(memory, sectionIds.flatMap((id) => {
        const node = this.db.getDocumentTreeNodesByIds([id])[0];
        const sectionId = node?.nodeType === "section" ? node.id : node?.parentId;
        return sectionId ? this.db.getSectionSubtree(sectionId) : [];
      }));
    } else if (step.tool === "retrieveRemainingNodesAfter") {
      fallbackReason = "v2 context units unavailable";
      const anchors = this.db.getChunksByIds(step.basedOnChunkIds ?? this.continuationAnchorIds(memory, mode));
      const byId = new Map<string, Chunk>();
      for (const anchor of anchors) {
        for (const chunk of this.db.getRemainingChunksAfter(anchor.versionId, anchor.id, limit)) {
          if (!byId.has(chunk.id)) byId.set(chunk.id, chunk);
        }
        if (anchor.documentTreeNodeId) this.addTreeNodes(memory, this.db.getRemainingTreeNodesAfter(anchor.documentTreeNodeId, limit));
      }
      chunks = [...byId.values()].sort((left, right) => left.ordinal - right.ordinal).slice(0, limit);
    } else if (step.tool === "graphExpand") {
      chunks = this.graphExpand(libraryId, step.basedOnNodeIds ?? memory.graphNodes.map((node) => node.id).slice(0, 12), memory, hitMap, iteration);
    } else if (step.tool === "graphSearch") {
      chunks = this.getGraphContext(libraryId, query, memory, hitMap, iteration);
    } else if (step.tool === "retrieveEvidenceForGraphNodes") {
      chunks = (step.basedOnNodeIds ?? memory.graphNodes.map((node) => node.id).slice(0, 12))
        .flatMap((nodeId) => this.db.getNodeEvidenceChunks(nodeId, 4));
    } else if (step.tool === "retrieveDocumentTreeNodes") {
      const treeNodes = this.db.searchDocumentTreeNodes(libraryId, query, limit);
      this.addTreeNodes(memory, treeNodes);
      chunks = this.db.getChunksByIds(treeNodes.flatMap((node) => node.sourceChunkIds)).slice(0, limit);
      const outline = this.db.getDocumentOutlineForLibrary(libraryId);
      memory.currentFindings.push(`Document tree entries: ${outline.slice(0, 20).map((entry) => `${entry.documentName}/${entry.headingPath ?? "untitled"}(${entry.chunkCount})`).join("; ")}`);
    } else if (step.tool === "retrieveSummaryTree") {
      let summaries: SummaryTreeNode[] = [];
      const [embedding] = await this.model.embed([query]);
      if (embedding) summaries = this.vectors.searchSummaries(libraryId, embedding, limit).map((result) => result.summary);
      summaries = this.mergeSummaries([...summaries, ...this.db.searchSummaryTree(libraryId, query, limit)], limit);
      this.addSummaryNodes(memory, summaries);
      const sourceNodeIds = [...new Set(summaries.flatMap((summary) => summary.sourceNodeIds))];
      const treeNodes = this.db.getDocumentTreeNodesByIds(sourceNodeIds);
      this.addTreeNodes(memory, treeNodes);
      chunks = this.db.getChunksByIds(treeNodes.flatMap((node) => node.sourceChunkIds)).slice(0, limit);
    } else if (step.tool === "buildEvidencePack") {
      chunks = [];
    }
    const parentLinks = this.db.getParentChildChunks(chunks.map((chunk) => chunk.id));
    this.addParentChunks(memory, parentLinks);
    this.addTreeNodes(memory, this.db.getDocumentTreeNodesByIds([
      ...chunks.flatMap((chunk) => chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : []),
      ...parentLinks.map((link) => link.documentTreeNodeId),
    ]));
    this.addChunks(memory, chunks);
    memory.retrievalHistory.push({ tool: step.tool, ...(step.query ? { query: step.query } : {}), chunkIds: chunks.map((chunk) => chunk.id), purpose: step.purpose });
    for (const chunk of chunks) this.addChunkHit(hitMap, chunk, step, iteration);
    memory.retrievalTrace ??= [];
    memory.retrievalTrace.push({
      stepIndex: 20 + iteration,
      tool: step.tool,
      purpose: step.purpose,
      ...(step.query ? { query: step.query } : {}),
      inputIds,
      outputIds: [
        ...chunks.map((chunk) => chunk.id),
        ...(memory.summaryNodes ?? []).slice(-limit).map((summary) => summary.id),
      ],
      actualIndexProfile,
      targetType,
      ...(buildId ? { buildId } : {}),
      ...(outputRetrievalUnitIds.length > 0 ? { outputRetrievalUnitIds } : {}),
      ...(outputContextUnitIds.length > 0 ? { outputContextUnitIds } : {}),
      ...(selectedContextUnits.length > 0 ? { selectedContextUnits } : {}),
      estimatedTokensAfterStep: this.estimatedTokensAfterStep(memory),
      ...(fallbackReason && actualIndexProfile === "v1" ? { fallbackReason } : {}),
      newEvidenceRowCount: Math.max(0, memory.evidenceRows.length - rowCountBefore),
      status: chunks.length > 0 || (memory.summaryNodes ?? []).length > 0 ? "success" : "empty",
    });
    return chunks;
  }

  private graphExpand(
    libraryId: string,
    nodeIds: string[],
    memory: PulseEvidenceMemory,
    hitMap: Map<string, PendingPulseHit>,
    iteration: number,
  ): Chunk[] {
    const nodes = new Map(memory.graphNodes.map((node) => [node.id, node]));
    const realNodes = new Map<string, AbstractNode>();
    for (const nodeId of nodeIds) {
      const node = this.db.getAbstractNode(nodeId);
      if (node) realNodes.set(node.id, node);
    }
    const chunks: Chunk[] = [];
    for (const relation of this.db.getIncidentRelations(libraryId, nodeIds)) {
      const source = realNodes.get(relation.sourceNodeId) ?? this.db.getAbstractNode(relation.sourceNodeId);
      const target = realNodes.get(relation.targetNodeId) ?? this.db.getAbstractNode(relation.targetNodeId);
      if (source) {
        realNodes.set(source.id, source);
        nodes.set(source.id, { id: source.id, title: source.title, summary: source.summary });
      }
      if (target) {
        realNodes.set(target.id, target);
        nodes.set(target.id, { id: target.id, title: target.title, summary: target.summary });
      }
      if (!memory.graphRelations.some((entry) => entry.id === relation.id)) {
        memory.graphRelations.push({
          id: relation.id,
          type: relation.type,
          sourceTitle: source?.title ?? relation.sourceNodeId,
          targetTitle: target?.title ?? relation.targetNodeId,
          reason: relation.reason,
        });
      }
      hitMap.set(`relation:${relation.id}`, {
        targetType: "relation",
        targetId: relation.id,
        score: clampScore(relation.confidence ?? 0.55),
        reason: "Evidence controller graph expansion",
        pathRole: "expanded",
        stepIndex: 20 + iteration,
        observation: "Evidence controller expanded neighboring relations from known nodes.",
        rationale: "Neighbor relations can locate source chunks but do not automatically become strong evidence.",
        label: relationLabel(relation, realNodes),
        excerpt: relation.reason,
      });
      chunks.push(...this.db.getChunksByIds(relation.evidenceChunkIds));
    }
    memory.graphNodes = [...nodes.values()];
    chunks.push(...nodeIds.flatMap((nodeId) => this.db.getNodeEvidenceChunks(nodeId, 4)));
    return chunks;
  }

  private getGraphContext(
    libraryId: string,
    query: string,
    memory: PulseEvidenceMemory,
    hitMap: Map<string, PendingPulseHit>,
    iteration: number,
  ): Chunk[] {
    const nodes = this.db.searchAbstractNodes(libraryId, query, 10).map((result) => result.node);
    for (const node of nodes) {
      if (!memory.graphNodes.some((entry) => entry.id === node.id)) {
        memory.graphNodes.push({ id: node.id, title: node.title, summary: node.summary });
      }
      hitMap.set(`node:${node.id}`, {
        targetType: "node",
        targetId: node.id,
        score: 0.62,
        reason: "Evidence controller graph context",
        pathRole: "expanded",
        stepIndex: 20 + iteration,
        observation: "Evidence controller found graph nodes matching the query.",
        rationale: "Graph nodes are retrieval entries; source chunks and EvidenceRows remain authoritative.",
        label: node.title,
        excerpt: node.summary.slice(0, 220) || null,
      });
    }
    return nodes.flatMap((node) => this.db.getNodeEvidenceChunks(node.id, 4));
  }

  private async extractRowsForChunks(
    question: string,
    memory: PulseEvidenceMemory,
    purpose: string,
    chunks = memory.collectedChunks,
  ): Promise<number> {
    const supplied = chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text.slice(0, 1800),
      headingPath: chunk.headingPath,
      pageNumber: chunk.pageNumber,
    }));
    const rows = await this.model.extractPulseEvidenceRows({
      question,
      questionPlan: memory.questionPlan,
      purpose,
      chunks: supplied,
      existingRows: memory.evidenceRows,
    });
    const existing = new Set(memory.evidenceRows.map(rowDedupeKey));
    const contextById = new Map((memory.contextUnits ?? []).map((unit) => [unit.id, unit]));
    const retrievalByContextId = new Map<string, RetrievalUnit>();
    for (const unit of memory.retrievalUnits ?? []) {
      if (!retrievalByContextId.has(unit.contextUnitId)) retrievalByContextId.set(unit.contextUnitId, unit);
    }
    let added = 0;
    for (const row of rows) {
      const contextUnit = row.contextUnitId
        ? contextById.get(row.contextUnitId)
        : contextById.get(row.evidenceChunkId);
      const validated = contextUnit
        ? validateEvidenceRow(row, contextUnit, retrievalByContextId.get(contextUnit.id))
        : row;
      const key = rowDedupeKey(validated);
      if (existing.has(key)) continue;
      existing.add(key);
      memory.evidenceRows.push(validated);
      added += 1;
      if (!memory.citedChunkIds.includes(validated.evidenceChunkId)) memory.citedChunkIds.push(validated.evidenceChunkId);
    }
    return added;
  }

  private continuationAnchorIds(memory: PulseEvidenceMemory, mode: PulseInputMode): string[] {
    if (memory.usedIndexProfile === "v2" && (memory.contextUnits ?? []).length > 0) {
      return this.contextAnchors(memory, mode === "progressive" ? 4 : 2).map((unit) => unit.id);
    }
    const evidenceIds = new Set(memory.evidenceRows.map((row) => row.evidenceChunkId));
    const candidateIds = [...new Set([
      ...memory.evidenceRows.map((row) => row.evidenceChunkId),
      ...memory.citedChunkIds,
      ...memory.collectedChunks.map((chunk) => chunk.id),
    ])];
    const chunks = this.db.getChunksByIds(candidateIds);
    const limit = mode === "progressive" ? 4 : 2;
    return chunks
      .sort((left, right) => {
        const evidenceWeight = Number(evidenceIds.has(right.id)) - Number(evidenceIds.has(left.id));
        if (evidenceWeight !== 0) return evidenceWeight;
        return right.ordinal - left.ordinal;
      })
      .slice(0, limit)
      .map((chunk) => chunk.id);
  }

  private buildGapContinuationPlan(
    question: string,
    mode: PulseInputMode,
    memory: PulseEvidenceMemory,
    status: PulseEvidenceStatus,
    maxIterations: number,
  ): PulseEvidencePlan {
    const gapQueries = [...new Set(status.gaps.flatMap((gap) => gap.suggestedQueries).map((query) => query.trim()).filter(Boolean))];
    const hasContinuationGap = status.gaps.some((gap) => continuationGapTypes.has(gap.type));
    const anchors = this.continuationAnchorIds(memory, mode);
    const steps: PulseEvidenceStep[] = [];
    if (hasContinuationGap && anchors.length > 0) {
      steps.push(
        {
          tool: "retrieveRemainingNodesAfter",
          basedOnChunkIds: anchors,
          purpose: "Continue reading after the latest covered source chunks for unresolved exhaustive evidence gaps.",
          expectedResult: "Later chunks from the same document version that may contain remaining itemized evidence.",
        },
        {
          tool: "retrieveSectionSubtree",
          basedOnChunkIds: anchors,
          purpose: "Read the same source section to recover omitted list items or adjacent facts.",
          expectedResult: "All available chunks in the same section as already cited evidence.",
        },
        {
          tool: "retrieveSiblingNodes",
          basedOnChunkIds: anchors,
          purpose: "Read neighboring chunks around cited evidence for continuation context.",
          expectedResult: "Immediate neighboring source chunks around the gap anchors.",
        },
      );
    }
    if (anchors.length > 0 && steps.length === 0 && status.status !== "partial_answer_only") {
      steps.push({
        tool: "retrieveSiblingNodes",
        basedOnChunkIds: anchors,
        purpose: "Read nearby chunks for unresolved sufficiency gaps.",
        expectedResult: "Adjacent chunks that may close remaining evidence gaps.",
      });
    }
    for (const query of gapQueries.slice(0, mode === "progressive" ? 3 : 4)) {
      steps.push(
        { tool: "semanticSearchChildChunks", query, purpose: "Secondary gap retrieval from sufficiency judge.", expectedResult: "Additional source chunks for the gap." },
        { tool: "fullTextSearchChildChunks", query, purpose: "Secondary literal gap retrieval from sufficiency judge.", expectedResult: "Exact source matches for the gap." },
      );
    }
    if (steps.length === 0 && status.status === "needs_gap_retrieval" && anchors.length > 0) {
      steps.push({
        tool: "retrieveParentChunks",
        basedOnChunkIds: anchors,
        purpose: "Re-read anchored chunks before deciding the gap cannot continue.",
        expectedResult: "Previously anchored source chunks for final extraction pass.",
      });
    }
    return {
      objective: "Continue generic retrieval for unresolved sufficiency gaps.",
      steps,
      stopCondition: "Stop when gaps are closed, retrieval returns no new chunks, no new EvidenceRows are extracted, or budget is exhausted.",
      expectedEvidenceShape: "Additional cited chunks and EvidenceRows for unresolved gaps.",
      maxIterations,
    };
  }

  private addChunks(memory: PulseEvidenceMemory, chunks: Chunk[]): void {
    const existing = new Set(memory.collectedChunks.map((chunk) => chunk.id));
    for (const chunk of chunks) {
      if (existing.has(chunk.id)) continue;
      existing.add(chunk.id);
      memory.collectedChunks.push(compactChunk(chunk));
    }
  }

  private addTreeNodes(memory: PulseEvidenceMemory, nodes: NonNullable<PulseEvidenceMemory["treeNodes"]>): void {
    memory.treeNodes ??= [];
    const existing = new Set(memory.treeNodes.map((node) => node.id));
    for (const node of nodes) {
      if (existing.has(node.id)) continue;
      existing.add(node.id);
      memory.treeNodes.push(node);
    }
  }

  private addParentChunks(memory: PulseEvidenceMemory, links: NonNullable<PulseEvidenceMemory["parentChunks"]>): void {
    memory.parentChunks ??= [];
    const existing = new Set(memory.parentChunks.map((link) => link.childChunkId));
    for (const link of links) {
      if (existing.has(link.childChunkId)) continue;
      existing.add(link.childChunkId);
      memory.parentChunks.push(link);
    }
  }

  private addSummaryNodes(memory: PulseEvidenceMemory, summaries: NonNullable<PulseEvidenceMemory["summaryNodes"]>): void {
    memory.summaryNodes ??= [];
    const existing = new Set(memory.summaryNodes.map((summary) => summary.id));
    for (const summary of summaries) {
      if (existing.has(summary.id)) continue;
      existing.add(summary.id);
      memory.summaryNodes.push(summary);
    }
  }

  private addChunkHit(hitMap: Map<string, PendingPulseHit>, chunk: Chunk, step: PulseEvidenceStep, iteration: number): void {
    const key = `chunk:${chunk.id}`;
    if (hitMap.has(key)) return;
    hitMap.set(key, {
      targetType: "chunk",
      targetId: chunk.id,
      score: 0.52,
      reason: `Evidence controller ${step.tool}`,
      pathRole: "expanded",
      stepIndex: 20 + iteration,
      observation: `Evidence controller executed ${step.tool}: ${step.purpose}`,
      rationale: "This chunk entered EvidenceMemory for EvidenceRow extraction and sufficiency judgment.",
      label: chunkLabel(chunk),
      excerpt: chunk.text.slice(0, 220),
    });
  }

  private mergeResults(results: SearchResult[], limit: number): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const result of results) {
      const previous = byId.get(result.chunk.id);
      if (!previous || result.score > previous.score) byId.set(result.chunk.id, result);
    }
    return [...byId.values()].sort((left, right) => right.score - left.score).slice(0, limit);
  }

  private mergeChunkList(chunks: Chunk[], limit: number): Chunk[] {
    const byId = new Map<string, Chunk>();
    for (const chunk of chunks) if (!byId.has(chunk.id)) byId.set(chunk.id, chunk);
    return [...byId.values()].sort((left, right) => left.ordinal - right.ordinal).slice(0, limit);
  }

  private mergeSummaries(summaries: SummaryTreeNode[], limit: number): SummaryTreeNode[] {
    const byId = new Map<string, SummaryTreeNode>();
    for (const summary of summaries) if (!byId.has(summary.id)) byId.set(summary.id, summary);
    return [...byId.values()].slice(0, limit);
  }

  private memorySummary(memory: PulseEvidenceMemory): PulseEvidenceMemory {
    return {
      ...memory,
      collectedChunks: memory.collectedChunks.slice(0, 80),
      graphNodes: memory.graphNodes.slice(0, 60),
      graphRelations: memory.graphRelations.slice(0, 80),
      contextUnits: (memory.contextUnits ?? []).slice(0, 40),
      retrievalUnits: (memory.retrievalUnits ?? []).slice(0, 80),
      contextBlocks: (memory.contextBlocks ?? []).slice(0, 120),
      aoriAspects: (memory.aoriAspects ?? []).slice(0, 12),
      aoriAspectItems: (memory.aoriAspectItems ?? []).slice(0, 80),
      aoriAspectRelations: (memory.aoriAspectRelations ?? []).slice(0, 80),
      evidenceRows: memory.evidenceRows.slice(0, 120),
      currentFindings: memory.currentFindings.slice(-20),
      warnings: (memory.warnings ?? []).slice(-20),
      retrievalHistory: memory.retrievalHistory.slice(-30),
    };
  }

  private attachDiagnostics(
    output: PulseAnswerOutput,
    memory: PulseEvidenceMemory,
    evidenceStatus: PulseEvidenceStatus,
    warnings: string[] = [],
  ): PulseAnswerOutput {
    return {
      ...output,
      evidenceStatus,
      evidenceRows: memory.evidenceRows,
      diagnostics: {
        ...output.diagnostics,
        questionPlan: memory.questionPlan,
        retrievalSteps: memory.retrievalHistory.map((history) => ({
          tool: history.tool,
          ...(history.query ? { query: history.query } : {}),
          basedOnChunkIds: history.chunkIds,
          purpose: history.purpose,
          expectedResult: "Retrieved source chunks for EvidenceMemory.",
        })),
        citedChunkIds: memory.citedChunkIds,
        answerScope: memory.answerScope,
        scopeClosureReport: memory.scopeClosureReport,
        warnings: [...(output.diagnostics?.warnings ?? []), ...(memory.warnings ?? []), ...warnings],
      },
    };
  }

  private buildEvidencePack(
    question: string,
    memory: PulseEvidenceMemory,
    evidenceStatus: PulseEvidenceStatus,
  ): EvidencePack {
    const treeNodes = memory.treeNodes ?? [];
    const nodeById = new Map(treeNodes.map((node) => [node.id, node]));
    const chunkById = new Map(memory.collectedChunks.map((chunk) => [chunk.id, chunk]));
    const citations: EvidenceCitation[] = memory.evidenceRows.flatMap((row) => {
      const chunk = chunkById.get(row.evidenceChunkId);
      const treeNodeId = row.treeNodeId ?? chunk?.documentTreeNodeId ?? null;
      const treeNode = treeNodeId ? nodeById.get(treeNodeId) : undefined;
      return [{
        chunkId: row.evidenceChunkId,
        treeNodeId,
        quote: row.evidenceQuote,
        headingPath: treeNode?.headingPath ?? chunk?.headingPath ?? null,
        pageNumber: chunk?.pageNumber ?? null,
      }];
    });
    const answerMode = normalizeAnswerMode(memory.questionPlan);
    return {
      id: `evidence-pack-${Date.now()}`,
      question,
      evidencePackSchemaVersion: memory.usedIndexProfile === "v2" ? 2 : 1,
      pipeline: {
        kind: memory.usedIndexProfile === "v2"
          ? answerMode.answerMode === "evidence_heavy" ? "v2 evidence-heavy" : "v2 compact"
          : "v1 legacy",
        indexProfile: memory.usedIndexProfile ?? "v1",
        packBuilder: memory.usedIndexProfile === "v2" ? "v2" : "legacy",
        model: this.model.name,
        promptVersion: memory.usedIndexProfile === "v2" ? "pulse-evidence-v2-generic" : "pulse-evidence-v1-generic",
      },
      pipelineVersion: {
        indexerVersion: "legacy-v1",
        contextUnitBuilderVersion: "not_used",
        retrievalUnitBuilderVersion: "not_used",
        packBuilderVersion: memory.usedIndexProfile === "v2" ? "context-pack-v2" : "legacy-v1",
        evidenceExtractorVersion: memory.usedIndexProfile === "v2" ? "pulse-evidence-v2-generic" : "pulse-evidence-v1-generic",
        validatorVersion: "evidence-row-validator-v2",
        promptVersion: memory.usedIndexProfile === "v2" ? "pulse-evidence-v2-generic" : "pulse-evidence-v1-generic",
      },
      answerMode: answerMode.answerMode,
      answerModeReason: answerMode.reason,
      answerModeOverridden: answerMode.overridden,
      questionPlan: memory.questionPlan,
      answerScope: memory.answerScope,
      scopeClosureReport: memory.scopeClosureReport,
      usedIndexProfile: memory.usedIndexProfile ?? "v1",
      sufficiencyHistory: memory.sufficiencyHistory,
      contextUnits: memory.contextUnits ?? [],
      retrievalUnits: memory.retrievalUnits ?? [],
      treeNodes,
      parentChunks: memory.parentChunks ?? [],
      semanticNodes: memory.graphNodes.flatMap((node) => {
        const full = this.db.getAbstractNode(node.id);
        return full ? [full] : [];
      }),
      semanticRelations: memory.graphRelations.flatMap((relation) => {
        const full = this.db.getRelation(relation.id);
        return full ? [full] : [];
      }),
      summaryNodes: memory.summaryNodes ?? [],
      evidenceRows: memory.evidenceRows,
      citations,
      gaps: evidenceStatus.gaps,
      retrievalTrace: memory.retrievalTrace ?? [],
      ...((memory.warnings ?? []).length > 0 ? { warnings: memory.warnings } : {}),
      ...(evidenceStatus.reconciliation ? { reconciliation: evidenceStatus.reconciliation } : {}),
    };
  }

  private guardedAnswer(
    question: string,
    memory: PulseEvidenceMemory,
    evidenceStatus: PulseEvidenceStatus,
    verification: PulseVerificationResult,
  ): PulseAnswerOutput {
    const facts = memory.evidenceRows.slice(0, 6).map((row) => `- ${row.claimText}: ${row.evidenceQuote}`).join("\n");
    const gaps = evidenceStatus.gaps.map((gap) => `- ${gap.description}`).join("\n");
    return this.attachDiagnostics({
      answer: [
        `Current evidence is insufficient to answer completely: ${question}`,
        facts ? `Confirmed partial facts:\n${facts}` : "No citeable structured facts were extracted.",
        gaps ? `Remaining evidence gaps:\n${gaps}` : "More citeable sources are needed before drawing a conclusion.",
      ].join("\n\n"),
      summary: "Evidence verification did not pass; returned a guarded answer.",
    }, memory, evidenceStatus, verification.errors);
  }
}
