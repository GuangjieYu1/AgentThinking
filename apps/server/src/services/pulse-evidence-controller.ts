import type {
  AbstractNode,
  Chunk,
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
  SearchResult,
  SummaryTreeNode,
} from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../db.js";
import type { ModelProvider } from "./models.js";
import type { VectorStore } from "./vector-store.js";
import { computeGenericReconciliation, normalizeAnswerMode, overclaimErrors } from "./evidence-v2.js";

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
];

const toolAliases = new Map<PulseEvidenceTool, PulseEvidenceTool>([
  ["semanticSearch", "semanticSearchChildChunks"],
  ["fullTextSearch", "fullTextSearchChildChunks"],
  ["readNeighborChunks", "retrieveSiblingNodes"],
  ["readSameSectionChunks", "retrieveSectionSubtree"],
  ["readRemainingChunksAfter", "retrieveRemainingNodesAfter"],
  ["getDocumentOutline", "retrieveDocumentTreeNodes"],
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
  return chunk.headingPath ?? (chunk.pageNumber ? `PDF 第 ${chunk.pageNumber} 页` : `片段 ${chunk.ordinal + 1}`);
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

function rowDedupeKey(row: PulseEvidenceRow): string {
  return row.dedupeKey?.trim() || `${row.evidenceType}:${row.evidenceChunkId}:${row.evidenceQuote.trim()}`;
}

function structuredRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numericValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function amountWan(row: PulseEvidenceRow): number | undefined {
  if (row.evidenceType !== "amount") return undefined;
  const value = structuredRecord(row.structuredValue);
  return numericValue(value.normalizedAmountWan)
    ?? numericValue(value.amountWan)
    ?? numericValue(value.amount)
    ?? numericValue(value.value);
}

function isDeclaredTotal(row: PulseEvidenceRow): boolean {
  const value = structuredRecord(row.structuredValue);
  if (row.role === "declared_total" || row.role === "stated_total") return true;
  if (value.isDeclaredTotal === true) return true;
  const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
  const kind = typeof value.kind === "string" ? value.kind.toLowerCase() : "";
  return role.includes("declared") || role.includes("total") || kind.includes("declared") || kind.includes("total");
}

export function computePulseReconciliation(rows: PulseEvidenceRow[]): PulseEvidenceReconciliation | undefined {
  const generic = computeGenericReconciliation(rows);
  if (generic) return generic;
  const amountRows = rows.filter((row) => amountWan(row) !== undefined);
  if (amountRows.length === 0) return undefined;
  const declaredTotals = amountRows.filter(isDeclaredTotal).map((row) => amountWan(row)!).filter(Number.isFinite);
  const itemized = amountRows
    .filter((row) => !isDeclaredTotal(row) && row.countedInAnswer !== false)
    .map((row) => amountWan(row)!)
    .filter(Number.isFinite);
  if (declaredTotals.length === 0 && itemized.length === 0) return undefined;
  const declaredTotal = declaredTotals.length > 0 ? declaredTotals[0] : undefined;
  const itemizedSum = itemized.length > 0 ? itemized.reduce((sum, value) => sum + value, 0) : undefined;
  const difference = declaredTotal !== undefined && itemizedSum !== undefined
    ? Number((declaredTotal - itemizedSum).toFixed(6))
    : undefined;
  const closed = difference !== undefined ? Math.abs(difference) <= 0.0001 : false;
  return {
    ...(declaredTotal !== undefined ? { declaredTotal } : {}),
    ...(itemizedSum !== undefined ? { itemizedSum: Number(itemizedSum.toFixed(6)) } : {}),
    ...(difference !== undefined ? { difference } : {}),
    unit: "万",
    closed,
    explanation: difference === undefined
      ? "金额证据不足以同时得到声明总额和分项合计。"
      : closed
        ? "声明总额与分项合计在容差内闭合。"
        : `声明总额与分项合计不一致，差额为 ${difference} 万。`,
  };
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
      errors.push("回答缺少可核对的原文引用。");
    }
  }
  if (!evidenceStatus.sufficient && /全部|每一笔|完整|穷尽|所有|无遗漏|complete|all|every/i.test(answer)) {
    errors.push("证据不足时不能声称完整、全部或无遗漏。");
  }
  errors.push(...overclaimErrors(answer, questionPlan, evidenceStatus.sufficient));
  const reconciliation = evidenceStatus.reconciliation;
  if (questionPlan.requiresNumericalReconciliation && reconciliation && !reconciliation.closed) {
    const diff = reconciliation.difference;
    if (diff === undefined || !answer.includes(String(diff))) {
      errors.push("数值未闭合时必须披露声明总额、分项合计和差额。");
    }
  }
  if (questionPlan.answerMustExposeGaps && evidenceStatus.gaps.length > 0) {
    const exposesGap = evidenceStatus.gaps.some((gap) => answer.includes(gap.description.slice(0, Math.min(18, gap.description.length))));
    if (!exposesGap && !/缺口|不足|无法确认|仍需|gap|insufficient/i.test(answer)) {
      errors.push("存在证据缺口时回答必须明确暴露缺口。");
    }
  }
  if (memory.evidenceRows.length === 0) warnings.push("没有结构化 EvidenceRow，回答只能作为保守摘要。");
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
    await eventSink?.({ type: "stage", message: "正在分析问题所需证据" });
    const questionPlan = await this.model.analyzePulseQuestion(question, mode);
    const memory = this.createMemory(question, questionPlan, seedContext);
    const hitMap = new Map<string, PendingPulseHit>();
    for (const hit of seedContext.hits) hitMap.set(`${hit.targetType}:${hit.targetId}`, hit);

    await this.extractRowsForChunks(question, memory, "Seed evidence from the existing pulse graph.");
    const initialPlan = await this.model.planPulseEvidence({
      question,
      mode,
      questionPlan,
      memorySummary: this.memorySummary(memory),
      tools: allowedTools,
    });
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
      await eventSink?.({ type: "stage", message: `正在执行证据检索第 ${iteration + 1} 轮` });
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
    await eventSink?.({ type: "stage", message: "正在基于 EvidenceMemory 合成回答" });
    let output = await this.model.synthesizePulseAnswer({
      question,
      questionPlan,
      memory: this.memorySummary(memory),
      evidenceStatus: finalStatus,
    });
    output = this.attachDiagnostics(output, memory, finalStatus);
    let verification = verifyPulseAnswer(output, questionPlan, memory, finalStatus);
    if (!verification.passed && verification.rewriteInstructions) {
      await eventSink?.({ type: "stage", message: "正在校验并收敛回答" });
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
      gaps: [],
      sufficiencyHistory: [],
    };
  }

  private validSteps(plan: PulseEvidencePlan): PulseEvidenceStep[] {
    const allowed = new Set<PulseEvidenceTool>(allowedTools);
    return plan.steps.flatMap((step) => {
      const tool = toolAliases.get(step.tool) ?? step.tool;
      return allowed.has(tool) ? [{ ...step, tool }] : [];
    });
  }

  private evidenceChunkLimit(mode: PulseInputMode, memory: PulseEvidenceMemory): number {
    if (mode !== "progressive") return 12;
    return memory.questionPlan.riskLevel === "high" && memory.questionPlan.requiresExhaustiveEvidence ? 12 : 10;
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
    if (step.tool === "semanticSearchChildChunks") {
      const [embedding] = await this.model.embed([query]);
      chunks = embedding ? this.vectors.search(libraryId, embedding, limit).map((result) => result.chunk) : [];
    } else if (step.tool === "fullTextSearchChildChunks") {
      chunks = this.mergeResults([
        ...this.db.searchText(libraryId, query, limit),
        ...this.db.searchChunksFuzzy(libraryId, query, limit),
      ], limit).map((result) => result.chunk);
    } else if (step.tool === "retrieveParentChunks") {
      chunks = this.db.getChunksByIds(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id));
      const parentLinks = this.db.getParentChildChunks(chunks.map((chunk) => chunk.id));
      this.addParentChunks(memory, parentLinks);
      chunks = this.mergeChunkList([
        ...chunks,
        ...this.db.getChunksByIds(parentLinks.map((link) => link.parentChunkId)),
      ], mode === "progressive" ? limit : 30);
    } else if (step.tool === "retrieveSiblingNodes") {
      chunks = this.db.getNeighborChunks(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id), mode === "progressive" ? 1 : 2).slice(0, mode === "progressive" ? limit : 30);
      const siblingNodeIds = [...new Set(chunks.flatMap((chunk) => chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : []))];
      this.addTreeNodes(memory, siblingNodeIds.flatMap((id) => this.db.getSiblingTreeNodes(id, 3)));
    } else if (step.tool === "retrieveSectionSubtree") {
      chunks = this.db.getSameSectionChunks(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id), mode === "progressive" ? limit : 30);
      const sectionIds = [...new Set(chunks.flatMap((chunk) => chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : []))];
      this.addTreeNodes(memory, sectionIds.flatMap((id) => {
        const node = this.db.getDocumentTreeNodesByIds([id])[0];
        const sectionId = node?.nodeType === "section" ? node.id : node?.parentId;
        return sectionId ? this.db.getSectionSubtree(sectionId) : [];
      }));
    } else if (step.tool === "retrieveRemainingNodesAfter") {
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
        observation: "证据控制器沿已知节点展开相邻关系。",
        rationale: "相邻关系可帮助定位更多来源 chunk，但不会自动变成强证据。",
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
        observation: "证据控制器从图谱标题与摘要寻找相关节点。",
        rationale: "节点本身只是检索入口，回答仍以来源 chunk 和 EvidenceRow 为准。",
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
    let added = 0;
    for (const row of rows) {
      const key = rowDedupeKey(row);
      if (existing.has(key)) continue;
      existing.add(key);
      memory.evidenceRows.push(row);
      added += 1;
      if (!memory.citedChunkIds.includes(row.evidenceChunkId)) memory.citedChunkIds.push(row.evidenceChunkId);
    }
    return added;
  }

  private continuationAnchorIds(memory: PulseEvidenceMemory, mode: PulseInputMode): string[] {
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
      observation: `证据控制器执行 ${step.tool}：${step.purpose}`,
      rationale: "该 chunk 进入 EvidenceMemory，后续抽取 EvidenceRow 并接受充分性判断。",
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
      evidenceRows: memory.evidenceRows.slice(0, 120),
      currentFindings: memory.currentFindings.slice(-20),
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
        warnings: [...(output.diagnostics?.warnings ?? []), ...warnings],
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
      evidencePackSchemaVersion: 1,
      pipeline: {
        indexProfile: "v1",
        packBuilder: "legacy",
        model: this.model.name,
        promptVersion: "pulse-evidence-v1-generic",
      },
      pipelineVersion: {
        indexerVersion: "legacy-v1",
        contextUnitBuilderVersion: "not_used",
        retrievalUnitBuilderVersion: "not_used",
        packBuilderVersion: "legacy-v1",
        evidenceExtractorVersion: "pulse-evidence-v1-generic",
        validatorVersion: "pulse-evidence-v2-foundation",
        promptVersion: "pulse-evidence-v1-generic",
      },
      answerMode: answerMode.answerMode,
      answerModeReason: answerMode.reason,
      answerModeOverridden: answerMode.overridden,
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
      ...(evidenceStatus.reconciliation ? { reconciliation: evidenceStatus.reconciliation } : {}),
    };
  }

  private guardedAnswer(
    question: string,
    memory: PulseEvidenceMemory,
    evidenceStatus: PulseEvidenceStatus,
    verification: PulseVerificationResult,
  ): PulseAnswerOutput {
    const facts = memory.evidenceRows.slice(0, 6).map((row) => `- ${row.claimText}（${row.evidenceQuote}）`).join("\n");
    const gaps = evidenceStatus.gaps.map((gap) => `- ${gap.description}`).join("\n");
    return this.attachDiagnostics({
      answer: [
        `当前证据不足以完整回答“${question}”。`,
        facts ? `可确认的部分事实：\n${facts}` : "尚未抽取到可引用的结构化事实。",
        gaps ? `仍存在的证据缺口：\n${gaps}` : "仍需补充更多可引用来源后再作结论。",
      ].join("\n\n"),
      summary: "证据校验未通过，已返回保守回答。",
    }, memory, evidenceStatus, verification.errors);
  }
}
