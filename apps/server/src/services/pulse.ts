import type {
  AbstractNode,
  Chunk,
  PulseInputMode,
  PulseNavigationCandidate,
  PulseResponse,
  PulseStreamEvent,
  Relation,
} from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../db.js";
import { AoriDemandAnswerEngine } from "./aori-demand-answer.js";
import type { ModelProvider } from "./models.js";
import { PulseEvidenceController } from "./pulse-evidence-controller.js";
import type { VectorStore } from "./vector-store.js";

type PulseEventSink = (event: PulseStreamEvent) => void | Promise<void>;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
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

async function emitPulse(eventSink: PulseEventSink | undefined, event: PulseStreamEvent): Promise<void> {
  if (eventSink) await eventSink(event);
}

function addHit(hits: Map<string, PendingPulseHit>, hit: PendingPulseHit): PendingPulseHit | undefined {
  const key = `${hit.targetType}:${hit.targetId}`;
  const previous = hits.get(key);
  if (!previous || hit.score > previous.score) {
    hits.set(key, hit);
    return hit;
  }
  return undefined;
}

async function recordHit(
  hits: Map<string, PendingPulseHit>,
  hit: PendingPulseHit,
  eventSink?: PulseEventSink,
): Promise<void> {
  const accepted = addHit(hits, hit);
  if (accepted) await emitPulse(eventSink, { type: "hit", hit: accepted });
}

function relationTouchesBridge(relation: Relation, directNodeIds: Set<string>, bridgeNodeIds: Set<string>): boolean {
  return (directNodeIds.has(relation.sourceNodeId) && bridgeNodeIds.has(relation.targetNodeId)) ||
    (directNodeIds.has(relation.targetNodeId) && bridgeNodeIds.has(relation.sourceNodeId));
}

function summarizeCandidates(candidates: PulseNavigationCandidate[], limit = 12): PulseNavigationCandidate[] {
  return candidates.slice(0, limit).map((candidate) => ({
    ...candidate,
    summary: candidate.summary.slice(0, 220),
    ...(candidate.relationReason ? { relationReason: candidate.relationReason.slice(0, 220) } : {}),
  }));
}

function rejectedCandidatesFor(
  decision: { rejectedCandidates?: Array<{ id: string; reason: string }> },
  candidates: PulseNavigationCandidate[],
  selectedIds: Set<string>,
): Array<{ id: string; label: string; reason: string }> {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const explicit = (decision.rejectedCandidates ?? [])
    .filter((candidate) => !selectedIds.has(candidate.id) && byId.has(candidate.id))
    .slice(0, 4)
    .map((candidate) => ({
      id: candidate.id,
      label: byId.get(candidate.id)!.label,
      reason: candidate.reason,
    }));
  if (explicit.length > 0) return explicit;
  return candidates
    .filter((candidate) => !selectedIds.has(candidate.id))
    .slice(0, 4)
    .map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      reason: "模型没有选择该候选；它在当前问题下的直接相关性低于已选路径。",
    }));
}

export class PulseEngine {
  constructor(
    private readonly db: AgentDatabase,
    private readonly vectors: VectorStore,
    private readonly model: ModelProvider,
    private readonly options: { aoriAnswerMode?: "demand" | "traversal" | "legacy" | "strict_evidence_table" } = {},
  ) {}

  async create(
    libraryId: string,
    question: string,
    mode: PulseInputMode = "full",
    eventSink?: PulseEventSink,
  ): Promise<PulseResponse> {
    await emitPulse(eventSink, { type: "start", mode, question });
    const aoriAnswerMode = this.options.aoriAnswerMode ?? "demand";
    if (aoriAnswerMode !== "legacy" && this.db.listAoriDocumentIndexes(libraryId).length > 0) {
      const engine = new AoriDemandAnswerEngine(this.db, this.model);
      const result = await engine.answer({
        libraryId,
        question,
        mode,
        ...(eventSink ? { eventSink } : {}),
      });
      await emitPulse(eventSink, { type: "answer", answer: result.answer.answer, summary: result.answer.summary });
      await emitPulse(eventSink, { type: "stage", message: "正在保存 AORI answer 脉冲结果" });
      const pulse = this.db.createPulse(
        libraryId,
        question,
        result.answer.answer,
        result.answer.summary,
        mode,
        result.hits,
        result.storageEvidencePack,
      );
      const response = this.db.getPulseResponse(libraryId, pulse.id);
      if (!response) throw new Error("脉冲创建后读取失败");
      await emitPulse(eventSink, { type: "done", response });
      return response;
    }
    const response = mode === "progressive"
      ? await this.createProgressive(libraryId, question, eventSink)
      : await this.createFull(libraryId, question, eventSink);
    await emitPulse(eventSink, { type: "done", response });
    return response;
  }

  private async createFull(libraryId: string, question: string, eventSink?: PulseEventSink): Promise<PulseResponse> {
    if (!this.model.configured) throw new Error("脉冲问答需要配置模型服务");
    if (this.db.listAoriDocumentIndexes(libraryId).length > 0) {
      return this.finishPulse(libraryId, question, "full", new Map(), new Map(), new Map(), new Map(), eventSink);
    }
    const hits = new Map<string, PendingPulseHit>();
    const chunks = new Map<string, Chunk>();
    const nodes = new Map<string, AbstractNode>();
    const relations = new Map<string, Relation>();

    await emitPulse(eventSink, { type: "stage", message: "正在召回语义证据" });
    const [embedding] = await this.model.embed([question]);
    const semanticChunks = embedding ? this.vectors.search(libraryId, embedding, 8) : [];
    for (const result of semanticChunks) {
      if (result.score < 0.16) continue;
      const score = clampScore(0.58 + result.score * 0.34);
      chunks.set(result.chunk.id, result.chunk);
      await recordHit(hits, {
        targetType: "chunk",
        targetId: result.chunk.id,
        score,
        reason: "语义召回证据 chunk",
        pathRole: "direct",
        stepIndex: 1,
        observation: "全量模式先同时查看与问题语义接近的原文片段。",
        rationale: "该片段的向量相似度超过阈值，因此进入本次回答的证据集合。",
        label: chunkLabel(result.chunk),
        excerpt: result.chunk.text.slice(0, 220),
      }, eventSink);
    }

    for (const result of this.db.searchText(libraryId, question, 8)) {
      const score = Math.max(0.72, clampScore(0.82 + result.score * 0.01));
      chunks.set(result.chunk.id, result.chunk);
      await recordHit(hits, {
        targetType: "chunk",
        targetId: result.chunk.id,
        score,
        reason: "关键词匹配证据 chunk",
        pathRole: "direct",
        stepIndex: 1,
        observation: "全量模式同时补充标题、原文中的关键词命中片段。",
        rationale: "该片段包含问题中的显式词，因此用于补足语义召回可能漏掉的证据。",
        label: chunkLabel(result.chunk),
        excerpt: result.chunk.text.slice(0, 220),
      }, eventSink);
    }

    const chunkNodeMap = this.db.getNodesForChunks(libraryId, [...chunks.keys()]);
    for (const [chunkId, linkedNodes] of chunkNodeMap) {
      const chunkHit = hits.get(`chunk:${chunkId}`);
      for (const node of linkedNodes) {
        nodes.set(node.id, node);
        await recordHit(hits, {
          targetType: "node",
          targetId: node.id,
          score: Math.min(1, (chunkHit?.score ?? 0.66) + 0.08),
          reason: "节点引用了命中的证据 chunk",
          pathRole: "direct",
          stepIndex: 2,
          observation: "系统从已命中的原文证据回溯到引用它的抽象节点。",
          rationale: "这个节点直接引用了已命中的 chunk，因此它是回答路径中的可追溯概念或命题。",
          label: node.title,
          excerpt: node.summary.slice(0, 220) || null,
        }, eventSink);
      }
    }

    for (const result of this.db.searchAbstractNodes(libraryId, question, 10)) {
      nodes.set(result.node.id, result.node);
      await recordHit(hits, {
        targetType: "node",
        targetId: result.node.id,
        score: result.score,
        reason: result.reason,
        pathRole: "direct",
        stepIndex: 2,
        observation: "系统额外检查节点标题和摘要是否直接匹配问题。",
        rationale: "该节点的标题或摘要命中了问题词，因此加入直接激活集合。",
        label: result.node.title,
        excerpt: result.node.summary.slice(0, 220) || null,
      }, eventSink);
    }

    const directNodeIds = new Set(
      [...hits.values()].filter((hit) => hit.targetType === "node" && hit.pathRole === "direct").map((hit) => hit.targetId),
    );
    const adjacentDirects = new Map<string, Set<string>>();
    const incidentRelations = this.db.getIncidentRelations(libraryId, [...directNodeIds]);
    for (const relation of incidentRelations) {
      const sourceDirect = directNodeIds.has(relation.sourceNodeId);
      const targetDirect = directNodeIds.has(relation.targetNodeId);
      if (!sourceDirect && !targetDirect) continue;
      const source = this.db.getAbstractNode(relation.sourceNodeId);
      const target = this.db.getAbstractNode(relation.targetNodeId);
      if (source) nodes.set(source.id, source);
      if (target) nodes.set(target.id, target);
      for (const [nodeId, oppositeId] of [
        [relation.sourceNodeId, relation.targetNodeId],
        [relation.targetNodeId, relation.sourceNodeId],
      ] as const) {
        if (!directNodeIds.has(nodeId) && directNodeIds.has(oppositeId)) {
          const linked = adjacentDirects.get(nodeId) ?? new Set<string>();
          linked.add(oppositeId);
          adjacentDirects.set(nodeId, linked);
        }
      }
    }
    const bridgeNodeIds = new Set(
      [...adjacentDirects.entries()].filter(([, directNeighbors]) => directNeighbors.size > 1).map(([nodeId]) => nodeId),
    );
    for (const relation of incidentRelations) {
      const sourceDirect = directNodeIds.has(relation.sourceNodeId);
      const targetDirect = directNodeIds.has(relation.targetNodeId);
      const connectsDirects = sourceDirect && targetDirect;
      const connectsBridge = relationTouchesBridge(relation, directNodeIds, bridgeNodeIds);
      if (!connectsDirects && !connectsBridge) continue;
      relations.set(relation.id, relation);
      const source = this.db.getAbstractNode(relation.sourceNodeId);
      const target = this.db.getAbstractNode(relation.targetNodeId);
      if (source) nodes.set(source.id, source);
      if (target) nodes.set(target.id, target);
      await recordHit(hits, {
        targetType: "relation",
        targetId: relation.id,
        score: connectsDirects ? 0.72 : 0.58,
        reason: connectsDirects ? "连接两个直接激活节点" : "连接直接激活节点与桥接路径",
        pathRole: "bridge",
        stepIndex: 3,
        observation: "系统检查直接激活节点之间是否存在可见关系或必要桥接路径。",
        rationale: connectsDirects
          ? "这条关系直接连接两个已激活节点，能解释它们为什么被同一次脉冲连在一起。"
          : "这条关系连接直接节点和桥接节点，能把分散命中收束成一条路径。",
        label: relationLabel(relation, nodes),
        excerpt: relation.reason,
      }, eventSink);
    }

    for (const nodeId of bridgeNodeIds) {
      const node = nodes.get(nodeId) ?? this.db.getAbstractNode(nodeId);
      if (!node || directNodeIds.has(node.id)) continue;
      nodes.set(node.id, node);
      await recordHit(hits, {
        targetType: "node",
        targetId: node.id,
        score: 0.62,
        reason: "位于多个直接激活节点之间的桥接路径",
        pathRole: "bridge",
        stepIndex: 3,
        observation: "系统寻找能把多个直接激活节点连起来的中间节点。",
        rationale: "该节点同时邻接多个直接激活节点，因此被保留为桥接路径，而不是普通邻居。",
        label: node.title,
        excerpt: node.summary.slice(0, 220) || null,
      }, eventSink);
    }

    return this.finishPulse(libraryId, question, "full", hits, chunks, nodes, relations, eventSink);
  }

  private async createProgressive(libraryId: string, question: string, eventSink?: PulseEventSink): Promise<PulseResponse> {
    if (!this.model.configured) throw new Error("脉冲问答需要配置模型服务");
    if (this.db.listAoriDocumentIndexes(libraryId).length > 0) {
      return this.finishPulse(libraryId, question, "progressive", new Map(), new Map(), new Map(), new Map(), eventSink);
    }
    const hits = new Map<string, PendingPulseHit>();
    const chunks = new Map<string, Chunk>();
    const nodes = new Map<string, AbstractNode>();
    const relations = new Map<string, Relation>();
    const visitedNodeIds = new Set<string>();
    const expandedNodeIds = new Set<string>();
    const pendingBranches: AbstractNode[] = [];

    await emitPulse(eventSink, { type: "stage", message: "正在选择脉冲入口节点" });
    const rootNodes = this.db.listPulseRootNodes(libraryId, 24);
    if (rootNodes.length === 0) return this.createFull(libraryId, question, eventSink);

    const rootCandidates = rootNodes.map((node) => this.nodeCandidate(node, 0.72));
    await emitPulse(eventSink, {
      type: "candidates",
      stepIndex: 1,
      fromNodeIds: [],
      fromLabels: ["图谱入口"],
      candidates: summarizeCandidates(rootCandidates),
    });
    const rootDecision = await this.model.selectPulseNavigation(
      question,
      "第 1 步：从可见根节点中选择入口",
      rootCandidates,
    );
    const selectedRoots = rootDecision.selectedIds
      .flatMap((id) => rootNodes.find((node) => node.id === id) ?? [])
      .slice(0, 3);
    const rootSelectedIds = new Set(selectedRoots.map((node) => node.id));
    await emitPulse(eventSink, {
      type: "decision",
      stepIndex: 1,
      selected: summarizeCandidates(rootCandidates.filter((candidate) => rootSelectedIds.has(candidate.id)), 3),
      rejected: rejectedCandidatesFor(rootDecision, rootCandidates, rootSelectedIds),
      observation: rootDecision.observation,
      rationale: rootDecision.rationale,
    });
    const firstFrontier = selectedRoots.length > 0 ? selectedRoots : rootNodes.slice(0, 1);
    for (const node of firstFrontier) {
      nodes.set(node.id, node);
      visitedNodeIds.add(node.id);
      await recordHit(hits, {
        targetType: "node",
        targetId: node.id,
        score: 0.84,
        reason: "渐进式根节点选择",
        pathRole: "direct",
        stepIndex: 1,
        observation: rootDecision.observation,
        rationale: rootDecision.rationale,
        label: node.title,
        excerpt: node.summary.slice(0, 220) || null,
      }, eventSink);
    }

    pendingBranches.push(...firstFrontier.slice(1));
    let frontier = firstFrontier.slice(0, 1);
    let stepIndex = 2;
    for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
      await emitPulse(eventSink, { type: "stage", message: `正在展开第 ${depth + 1} 层脉冲路径` });
      for (const node of frontier) {
        if (expandedNodeIds.has(node.id)) continue;
        expandedNodeIds.add(node.id);
        for (const chunk of this.db.getNodeEvidenceChunks(node.id, 2)) {
          chunks.set(chunk.id, chunk);
          await recordHit(hits, {
            targetType: "chunk",
            targetId: chunk.id,
            score: Math.max(0.48, 0.74 - depth * 0.08),
            reason: "当前节点的原文证据",
            pathRole: "direct",
            stepIndex,
            observation: `展开「${node.title}」后，系统查看这个节点引用的原文证据。`,
            rationale: "该 chunk 是当前节点的来源证据，用来判断节点是否真的能支撑回答。",
            label: chunkLabel(chunk),
            excerpt: chunk.text.slice(0, 220),
          }, eventSink);
        }
      }

      const childCandidates = this.childCandidates(frontier, visitedNodeIds);
      const relationCandidates = this.relationCandidates(libraryId, frontier, visitedNodeIds, nodes, relations);
      const candidates = [...childCandidates, ...relationCandidates]
        .sort((left, right) => right.candidate.score - left.candidate.score)
        .slice(0, 24);
      if (candidates.length === 0) {
        const from = frontier[0];
        const retry = pendingBranches.shift();
        if (from) {
          await emitPulse(eventSink, {
            type: "backtrack",
            stepIndex,
            fromNodeId: from.id,
            fromLabel: from.title,
            ...(retry ? { toNodeId: retry.id, toLabel: retry.title } : {}),
            reason: retry
              ? "当前节点没有新的可见候选，回到之前保留的备选分支继续探索。"
              : "当前节点没有新的可见候选，也没有剩余备选分支。",
          });
        }
        if (retry) {
          frontier = [retry];
          depth -= 1;
          continue;
        }
        break;
      }
      await emitPulse(eventSink, {
        type: "candidates",
        stepIndex: stepIndex + 1,
        fromNodeIds: frontier.map((node) => node.id),
        fromLabels: frontier.map((node) => node.title),
        candidates: summarizeCandidates(candidates.map((entry) => entry.candidate)),
      });

      const decision = await this.model.selectPulseNavigation(
        question,
        `第 ${stepIndex + 1} 步：展开 ${frontier.map((node) => node.title).join("、")} 的相邻信息`,
        candidates.map((entry) => entry.candidate),
      );
      const selected = decision.selectedIds
        .flatMap((id) => candidates.find((entry) => entry.node.id === id) ?? [])
        .slice(0, 3);
      const selectedIds = new Set(selected.map((entry) => entry.node.id));
      const visibleCandidates = candidates.map((entry) => entry.candidate);
      await emitPulse(eventSink, {
        type: "decision",
        stepIndex: stepIndex + 1,
        selected: summarizeCandidates(selected.map((entry) => entry.candidate), 3),
        rejected: rejectedCandidatesFor(decision, visibleCandidates, selectedIds),
        observation: decision.observation,
        rationale: decision.rationale,
      });
      if (selected.length === 0) {
        const from = frontier[0];
        const retry = pendingBranches.shift();
        if (from) {
          await emitPulse(eventSink, {
            type: "backtrack",
            stepIndex,
            fromNodeId: from.id,
            fromLabel: from.title,
            ...(retry ? { toNodeId: retry.id, toLabel: retry.title } : {}),
            reason: retry
              ? "模型没有选择当前候选中的有效节点，回到之前保留的备选分支。"
              : "模型没有选择当前候选中的有效节点，也没有剩余备选分支。",
          });
        }
        if (retry) {
          frontier = [retry];
          depth -= 1;
          continue;
        }
        break;
      }
      stepIndex += 1;
      const nextFrontier: AbstractNode[] = [];
      for (const entry of selected) {
        const node = entry.node;
        nodes.set(node.id, node);
        visitedNodeIds.add(node.id);
        if (entry.relation) {
          relations.set(entry.relation.id, entry.relation);
          const source = nodes.get(entry.relation.sourceNodeId) ?? this.db.getAbstractNode(entry.relation.sourceNodeId);
          const target = nodes.get(entry.relation.targetNodeId) ?? this.db.getAbstractNode(entry.relation.targetNodeId);
          if (source) nodes.set(source.id, source);
          if (target) nodes.set(target.id, target);
          await recordHit(hits, {
            targetType: "relation",
            targetId: entry.relation.id,
            score: Math.max(0.46, 0.68 - depth * 0.08),
            reason: "渐进式展开关系",
            pathRole: "bridge",
            stepIndex,
            observation: decision.observation,
            rationale: `沿关系「${relationLabel(entry.relation, nodes)}」展开：${decision.rationale}`,
            label: relationLabel(entry.relation, nodes),
            excerpt: entry.relation.reason,
          }, eventSink);
        }
        await recordHit(hits, {
          targetType: "node",
          targetId: node.id,
          score: Math.max(0.5, 0.78 - depth * 0.08),
          reason: entry.relation ? "渐进式邻接节点选择" : "主题下钻成员选择",
          pathRole: "direct",
          stepIndex,
          observation: decision.observation,
          rationale: decision.rationale,
          label: node.title,
          excerpt: node.summary.slice(0, 220) || null,
        }, eventSink);
        nextFrontier.push(node);
      }
      pendingBranches.push(...nextFrontier.slice(1).filter((node) => !expandedNodeIds.has(node.id)));
      frontier = nextFrontier.slice(0, 1);
      stepIndex += 1;
    }

    return this.finishPulse(libraryId, question, "progressive", hits, chunks, nodes, relations, eventSink);
  }

  private nodeCandidate(node: AbstractNode, score: number, relation?: Relation): PulseNavigationCandidate {
    return {
      id: node.id,
      label: node.title,
      summary: node.summary.slice(0, 500),
      score,
      ...(relation ? {
        relationLabel: relationLabel(relation, new Map([[node.id, node]])),
        relationReason: relation.reason,
      } : {}),
    };
  }

  private childCandidates(
    frontier: AbstractNode[],
    visitedNodeIds: Set<string>,
  ): Array<{ candidate: PulseNavigationCandidate; node: AbstractNode; relation?: Relation }> {
    const childrenByParent = this.db.getAbstractionChildren(frontier.filter((node) => node.level === 2).map((node) => node.id));
    const candidates: Array<{ candidate: PulseNavigationCandidate; node: AbstractNode; relation?: Relation }> = [];
    for (const parent of frontier) {
      for (const child of childrenByParent.get(parent.id) ?? []) {
        if (visitedNodeIds.has(child.id)) continue;
        candidates.push({
          node: child,
          candidate: {
            id: child.id,
            label: child.title,
            summary: child.summary.slice(0, 500),
            score: 0.7,
            relationLabel: `主题「${parent.title}」包含该节点`,
            relationReason: "该节点是当前主题的成员，可作为下一层细节展开。",
          },
        });
      }
    }
    return candidates;
  }

  private relationCandidates(
    libraryId: string,
    frontier: AbstractNode[],
    visitedNodeIds: Set<string>,
    nodes: Map<string, AbstractNode>,
    relations: Map<string, Relation>,
  ): Array<{ candidate: PulseNavigationCandidate; node: AbstractNode; relation: Relation }> {
    const candidates: Array<{ candidate: PulseNavigationCandidate; node: AbstractNode; relation: Relation }> = [];
    for (const relation of this.db.getIncidentRelations(libraryId, frontier.map((node) => node.id))) {
      const frontierIds = new Set(frontier.map((node) => node.id));
      const nextId = frontierIds.has(relation.sourceNodeId) ? relation.targetNodeId
        : frontierIds.has(relation.targetNodeId) ? relation.sourceNodeId
          : undefined;
      if (!nextId || visitedNodeIds.has(nextId)) continue;
      const node = this.db.getAbstractNode(nextId);
      if (!node || node.libraryId !== libraryId) continue;
      nodes.set(node.id, node);
      relations.set(relation.id, relation);
      candidates.push({
        node,
        relation,
        candidate: {
          id: node.id,
          label: node.title,
          summary: node.summary.slice(0, 500),
          score: Math.max(0.45, relation.confidence ?? 0.6),
          relationLabel: relationLabel(relation, nodes),
          relationReason: relation.reason,
        },
      });
    }
    return candidates;
  }

  private async finishPulse(
    libraryId: string,
    question: string,
    mode: PulseInputMode,
    hits: Map<string, PendingPulseHit>,
    chunks: Map<string, Chunk>,
    nodes: Map<string, AbstractNode>,
    relations: Map<string, Relation>,
    eventSink?: PulseEventSink,
  ): Promise<PulseResponse> {
    const orderedHits = [...hits.values()]
      .sort((left, right) =>
        (left.stepIndex ?? 999) - (right.stepIndex ?? 999) ||
        right.score - left.score ||
        left.label.localeCompare(right.label, "zh-CN"),
      )
      .slice(0, 80);
    await emitPulse(eventSink, { type: "stage", message: "正在构建 EvidenceMemory" });
    const controller = new PulseEvidenceController(this.db, this.vectors, this.model);
    const answer = await controller.answer(libraryId, question, mode, {
      hits: orderedHits,
      navigationTrace: orderedHits.map((hit, index) => ({
        stepIndex: hit.stepIndex ?? index + 1,
        targetType: hit.targetType,
        label: hit.label,
        observation: hit.observation ?? hit.reason,
        rationale: hit.rationale ?? hit.reason,
      })),
      chunks: orderedHits
        .filter((hit) => hit.targetType === "chunk")
        .flatMap((hit) => {
          const chunk = chunks.get(hit.targetId) ?? this.db.getChunk(hit.targetId);
          return chunk ? [chunk] : [];
        }),
      nodes: orderedHits
        .filter((hit) => hit.targetType === "node")
        .flatMap((hit) => {
          const node = nodes.get(hit.targetId) ?? this.db.getAbstractNode(hit.targetId);
          return node ? [node] : [];
        }),
      relations: orderedHits
        .filter((hit) => hit.targetType === "relation")
        .flatMap((hit) => {
          const relation = relations.get(hit.targetId) ?? this.db.getRelation(hit.targetId);
          return relation ? [relation] : [];
        }),
    }, eventSink);
    await emitPulse(eventSink, { type: "answer", answer: answer.answer, summary: answer.summary });
    await emitPulse(eventSink, { type: "stage", message: "正在保存脉冲结果" });
    const finalHits = orderedHits.length > 0 ? orderedHits : answer.hits;
    const pulse = this.db.createPulse(libraryId, question, answer.answer, answer.summary, mode, finalHits, answer.evidencePack);
    const response = this.db.getPulseResponse(libraryId, pulse.id);
    if (!response) throw new Error("脉冲创建后读取失败");
    return response;
  }
}
