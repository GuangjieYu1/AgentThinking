import type {
  AbstractNode,
  Chunk,
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
} from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../db.js";
import type { ModelProvider } from "./models.js";
import type { VectorStore } from "./vector-store.js";

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
}

const allowedTools: PulseEvidenceTool[] = [
  "semanticSearch",
  "fullTextSearch",
  "graphExpand",
  "readChunks",
  "readNeighborChunks",
  "readSameSectionChunks",
  "getDocumentOutline",
  "getChunkEvidenceAround",
  "getGraphContext",
];

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
    text: chunk.text.slice(0, 1600),
    headingPath: chunk.headingPath,
    pageNumber: chunk.pageNumber,
    ordinal: chunk.ordinal,
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
  if (value.isDeclaredTotal === true) return true;
  const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
  const kind = typeof value.kind === "string" ? value.kind.toLowerCase() : "";
  return role.includes("declared") || role.includes("total") || kind.includes("declared") || kind.includes("total");
}

export function computePulseReconciliation(rows: PulseEvidenceRow[]): PulseEvidenceReconciliation | undefined {
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
    const maxIterations = Math.min(
      mode === "progressive" ? 4 : 2,
      Math.max(1, initialPlan.maxIterations || (mode === "progressive" ? 4 : 2)),
    );
    let plan: PulseEvidencePlan = initialPlan;
    let status: PulseEvidenceStatus | undefined;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      await eventSink?.({ type: "stage", message: `正在执行证据检索第 ${iteration + 1} 轮` });
      const steps = this.validSteps(plan).slice(0, mode === "progressive" ? 4 : 8);
      for (const step of steps) {
        const chunks = await this.executeStep(libraryId, question, step, memory, hitMap, mode, iteration + 1);
        if (chunks.length > 0) await this.extractRowsForChunks(question, memory, step.purpose, chunks);
      }
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
      const gapQueries = status.gaps.flatMap((gap) => gap.suggestedQueries).filter(Boolean);
      if (mode === "full" && iteration >= 0 && gapQueries.length === 0) break;
      if (gapQueries.length === 0) continue;
      plan = {
        objective: "Retrieve evidence for sufficiency gaps.",
        steps: gapQueries.slice(0, mode === "progressive" ? 4 : 6).flatMap((query) => [
          { tool: "semanticSearch", query, purpose: "Gap retrieval from sufficiency judge.", expectedResult: "Additional source chunks for the gap." },
          { tool: "fullTextSearch", query, purpose: "Literal gap retrieval from sufficiency judge.", expectedResult: "Exact source matches for the gap." },
        ]),
        stopCondition: "Stop when gaps are closed or must be exposed.",
        expectedEvidenceShape: "Additional cited chunks and EvidenceRows for gaps.",
        maxIterations,
      };
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
    return { ...output, hits: [...hitMap.values()] };
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
      evidenceRows: [],
      citedChunkIds: [],
      retrievalHistory: [],
      currentFindings: [],
      gaps: [],
      sufficiencyHistory: [],
    };
  }

  private validSteps(plan: PulseEvidencePlan): PulseEvidenceStep[] {
    const allowed = new Set<PulseEvidenceTool>(allowedTools);
    return plan.steps.filter((step) => allowed.has(step.tool));
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
    const limit = mode === "progressive" ? 6 : 12;
    const query = step.query?.trim() || question;
    let chunks: Chunk[] = [];
    if (step.tool === "semanticSearch") {
      const [embedding] = await this.model.embed([query]);
      chunks = embedding ? this.vectors.search(libraryId, embedding, limit).map((result) => result.chunk) : [];
    } else if (step.tool === "fullTextSearch") {
      chunks = this.mergeResults([
        ...this.db.searchText(libraryId, query, limit),
        ...this.db.searchChunksFuzzy(libraryId, query, limit),
      ], limit).map((result) => result.chunk);
    } else if (step.tool === "readChunks") {
      chunks = this.db.getChunksByIds(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id));
    } else if (step.tool === "readNeighborChunks") {
      chunks = this.db.getNeighborChunks(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id), mode === "progressive" ? 1 : 2).slice(0, mode === "progressive" ? 8 : 30);
    } else if (step.tool === "readSameSectionChunks") {
      chunks = this.db.getSameSectionChunks(step.basedOnChunkIds ?? memory.collectedChunks.slice(0, limit).map((chunk) => chunk.id), mode === "progressive" ? 8 : 30);
    } else if (step.tool === "graphExpand") {
      chunks = this.graphExpand(libraryId, step.basedOnNodeIds ?? memory.graphNodes.map((node) => node.id).slice(0, 12), memory, hitMap, iteration);
    } else if (step.tool === "getChunkEvidenceAround") {
      chunks = this.mergeResults([
        ...this.db.searchText(libraryId, query, limit),
        ...this.db.searchChunksFuzzy(libraryId, query, limit),
      ], limit).map((result) => result.chunk);
      chunks = this.db.getNeighborChunks(chunks.map((chunk) => chunk.id), 1).slice(0, mode === "progressive" ? 8 : 24);
    } else if (step.tool === "getGraphContext") {
      chunks = this.getGraphContext(libraryId, query, memory, hitMap, iteration);
    } else if (step.tool === "getDocumentOutline") {
      const outline = this.db.getDocumentOutlineForLibrary(libraryId);
      memory.currentFindings.push(`Document outline entries: ${outline.slice(0, 20).map((entry) => `${entry.documentName}/${entry.headingPath ?? "untitled"}(${entry.chunkCount})`).join("; ")}`);
    }
    this.addChunks(memory, chunks);
    memory.retrievalHistory.push({ tool: step.tool, ...(step.query ? { query: step.query } : {}), chunkIds: chunks.map((chunk) => chunk.id), purpose: step.purpose });
    for (const chunk of chunks) this.addChunkHit(hitMap, chunk, step, iteration);
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
  ): Promise<void> {
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
    for (const row of rows) {
      const key = rowDedupeKey(row);
      if (existing.has(key)) continue;
      existing.add(key);
      memory.evidenceRows.push(row);
      if (!memory.citedChunkIds.includes(row.evidenceChunkId)) memory.citedChunkIds.push(row.evidenceChunkId);
    }
  }

  private addChunks(memory: PulseEvidenceMemory, chunks: Chunk[]): void {
    const existing = new Set(memory.collectedChunks.map((chunk) => chunk.id));
    for (const chunk of chunks) {
      if (existing.has(chunk.id)) continue;
      existing.add(chunk.id);
      memory.collectedChunks.push(compactChunk(chunk));
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
