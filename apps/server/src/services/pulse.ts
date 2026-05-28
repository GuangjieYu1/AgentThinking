import type { AbstractNode, Chunk, PulseHit, PulseResponse, Relation } from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../db.js";
import type { ModelProvider } from "./models.js";
import type { VectorStore } from "./vector-store.js";

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

function addHit(hits: Map<string, PendingPulseHit>, hit: PendingPulseHit): void {
  const key = `${hit.targetType}:${hit.targetId}`;
  const previous = hits.get(key);
  if (!previous || hit.score > previous.score) hits.set(key, hit);
}

export class PulseEngine {
  constructor(
    private readonly db: AgentDatabase,
    private readonly vectors: VectorStore,
    private readonly model: ModelProvider,
  ) {}

  async create(libraryId: string, question: string): Promise<PulseResponse> {
    if (!this.model.configured) throw new Error("脉冲问答需要配置模型服务");
    const hits = new Map<string, PendingPulseHit>();
    const chunks = new Map<string, Chunk>();
    const nodes = new Map<string, AbstractNode>();
    const relations = new Map<string, Relation>();

    const [embedding] = await this.model.embed([question]);
    const semanticChunks = embedding ? this.vectors.search(libraryId, embedding, 8) : [];
    for (const result of semanticChunks) {
      const score = clampScore(0.58 + result.score * 0.34);
      chunks.set(result.chunk.id, result.chunk);
      addHit(hits, {
        targetType: "chunk",
        targetId: result.chunk.id,
        score,
        reason: "语义召回证据 chunk",
        pathRole: "direct",
        label: chunkLabel(result.chunk),
        excerpt: result.chunk.text.slice(0, 220),
      });
    }

    for (const result of this.db.searchText(libraryId, question, 8)) {
      const score = Math.max(0.72, clampScore(0.82 + result.score * 0.01));
      chunks.set(result.chunk.id, result.chunk);
      addHit(hits, {
        targetType: "chunk",
        targetId: result.chunk.id,
        score,
        reason: "关键词匹配证据 chunk",
        pathRole: "direct",
        label: chunkLabel(result.chunk),
        excerpt: result.chunk.text.slice(0, 220),
      });
    }

    const chunkNodeMap = this.db.getNodesForChunks(libraryId, [...chunks.keys()]);
    for (const [chunkId, linkedNodes] of chunkNodeMap) {
      const chunkHit = hits.get(`chunk:${chunkId}`);
      for (const node of linkedNodes) {
        nodes.set(node.id, node);
        addHit(hits, {
          targetType: "node",
          targetId: node.id,
          score: Math.min(1, (chunkHit?.score ?? 0.66) + 0.08),
          reason: "节点引用了命中的证据 chunk",
          pathRole: "direct",
          label: node.title,
          excerpt: node.summary.slice(0, 220) || null,
        });
      }
    }

    for (const result of this.db.searchAbstractNodes(libraryId, question, 10)) {
      nodes.set(result.node.id, result.node);
      addHit(hits, {
        targetType: "node",
        targetId: result.node.id,
        score: result.score,
        reason: result.reason,
        pathRole: "direct",
        label: result.node.title,
        excerpt: result.node.summary.slice(0, 220) || null,
      });
    }

    const directNodeIds = new Set(
      [...hits.values()].filter((hit) => hit.targetType === "node" && hit.pathRole === "direct").map((hit) => hit.targetId),
    );
    const adjacentDirects = new Map<string, Set<string>>();
    for (const relation of this.db.getIncidentRelations(libraryId, [...directNodeIds])) {
      relations.set(relation.id, relation);
      const source = this.db.getAbstractNode(relation.sourceNodeId);
      const target = this.db.getAbstractNode(relation.targetNodeId);
      if (source) nodes.set(source.id, source);
      if (target) nodes.set(target.id, target);
      const sourceDirect = directNodeIds.has(relation.sourceNodeId);
      const targetDirect = directNodeIds.has(relation.targetNodeId);
      const role = sourceDirect && targetDirect ? "bridge" : "expanded";
      const relationScore = role === "bridge" ? 0.72 : 0.42;
      addHit(hits, {
        targetType: "relation",
        targetId: relation.id,
        score: relationScore,
        reason: role === "bridge" ? "连接两个直接激活节点" : "由直接激活节点扩展的一跳关系",
        pathRole: role,
        label: relationLabel(relation, nodes),
        excerpt: relation.reason,
      });
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

    for (const [nodeId, directNeighbors] of adjacentDirects) {
      const node = nodes.get(nodeId) ?? this.db.getAbstractNode(nodeId);
      if (!node || directNodeIds.has(node.id)) continue;
      nodes.set(node.id, node);
      const role = directNeighbors.size > 1 ? "bridge" : "expanded";
      addHit(hits, {
        targetType: "node",
        targetId: node.id,
        score: role === "bridge" ? 0.62 : 0.36,
        reason: role === "bridge" ? "位于多个直接激活节点之间的桥接路径" : "由直接激活节点扩展的一跳上下文",
        pathRole: role,
        label: node.title,
        excerpt: node.summary.slice(0, 220) || null,
      });
    }

    const orderedHits = [...hits.values()].sort((left, right) => right.score - left.score).slice(0, 80);
    const answer = await this.model.answerPulse(question, {
      chunks: orderedHits
        .filter((hit) => hit.targetType === "chunk")
        .flatMap((hit) => {
          const chunk = chunks.get(hit.targetId) ?? this.db.getChunk(hit.targetId);
          return chunk ? [{
            id: chunk.id,
            text: chunk.text.slice(0, 1200),
            score: hit.score,
            headingPath: chunk.headingPath,
            pageNumber: chunk.pageNumber,
          }] : [];
        }),
      nodes: orderedHits
        .filter((hit) => hit.targetType === "node")
        .flatMap((hit) => {
          const node = nodes.get(hit.targetId) ?? this.db.getAbstractNode(hit.targetId);
          return node ? [{ id: node.id, title: node.title, summary: node.summary, score: hit.score }] : [];
        }),
      relations: orderedHits
        .filter((hit) => hit.targetType === "relation")
        .flatMap((hit) => {
          const relation = relations.get(hit.targetId) ?? this.db.getRelation(hit.targetId);
          if (!relation) return [];
          const source = nodes.get(relation.sourceNodeId) ?? this.db.getAbstractNode(relation.sourceNodeId);
          const target = nodes.get(relation.targetNodeId) ?? this.db.getAbstractNode(relation.targetNodeId);
          return [{
            id: relation.id,
            type: relation.type,
            sourceTitle: source?.title ?? relation.sourceNodeId,
            targetTitle: target?.title ?? relation.targetNodeId,
            reason: relation.reason,
            score: hit.score,
          }];
        }),
    });
    const pulse = this.db.createPulse(libraryId, question, answer.answer, answer.summary, orderedHits);
    const response = this.db.getPulseResponse(libraryId, pulse.id);
    if (!response) throw new Error("脉冲创建后读取失败");
    return response;
  }
}
