import type {
  AoriTraversalMap,
  AoriTraversalNode,
  AoriTraversalRelation,
  BfsExpansionInput,
  Chunk,
  ChunkAnswerSummary,
  ChunkEvidencePack,
  ChunkSummaryInput,
  DfsStepInput,
  EvidenceCitation,
  EvidencePack,
  FinalAnswerFromChunksInput,
  PulseAnswerOutput,
  PulseEvidenceRow,
  PulseInputMode,
  PulseStreamEvent,
  RetrievalTrace,
} from "@agent-thinking/contracts";
import type { AgentDatabase, PendingPulseHit } from "../db.js";
import { buildAoriSkillRouterInput } from "./aori-skill-router.js";
import { executeAoriSkill } from "./aori-skills/index.js";
import type { ModelProvider } from "./models.js";

type PulseEventSink = (event: PulseStreamEvent) => void | Promise<void>;
type ChunkPath = ChunkEvidencePack["selectedChunks"][number]["path"];
type ChunkPathDecision = ChunkPath[number]["decision"];
type TraversalEventType =
  | "aori_traversal_started"
  | "bfs_layer_started"
  | "bfs_node_decision"
  | "bfs_node_expanded"
  | "bfs_chunk_collected"
  | "bfs_layer_finished"
  | "dfs_node_entered"
  | "dfs_candidate_selected"
  | "dfs_chunk_found"
  | "dfs_backtrack"
  | "chunk_summary_started"
  | "chunk_summary_finished"
  | "final_answer_started"
  | "final_answer_finished"
  | "skill_route_generated"
  | "skill_execution_started"
  | "facet_table_build_started"
  | "facet_row_extracted"
  | "facet_table_build_finished"
  | "facet_operation_planned"
  | "facet_filter_applied"
  | "facet_dedupe_finished"
  | "skill_answer_synthesized";

interface QueueEntry {
  node: AoriTraversalNode;
  depth: number;
  path: ChunkPath;
}

export interface AoriTraversalAnswerResult {
  evidencePack: ChunkEvidencePack;
  chunkSummaries: ChunkAnswerSummary[];
  answer: PulseAnswerOutput;
  chunks: Chunk[];
  hits: PendingPulseHit[];
  storageEvidencePack: EvidencePack;
}

const traversalLimits = {
  layerLimit: 8,
  maxDepth: 6,
  maxVisitedNodes: 120,
  maxSelectedChunks: 16,
  maxDfsBranching: 3,
};

function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}` : normalized;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function clampConfidence(value: number | undefined, fallback = 0.55): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value ?? fallback));
}

async function emitPulse(eventSink: PulseEventSink | undefined, event: PulseStreamEvent): Promise<void> {
  if (eventSink) await eventSink(event);
}

async function emitTraversal(
  eventSink: PulseEventSink | undefined,
  type: TraversalEventType,
  message: string,
  payload?: unknown,
): Promise<void> {
  await emitPulse(eventSink, (payload === undefined ? { type, message } : { type, message, payload }) as PulseStreamEvent);
}

function chunkLabel(chunk: Chunk): string {
  return chunk.headingPath ?? (chunk.pageNumber ? `PDF 第 ${chunk.pageNumber} 页` : `片段 ${chunk.ordinal + 1}`);
}

function nodeSummary(node: AoriTraversalNode): BfsExpansionInput["currentLayer"][number] {
  return {
    nodeId: node.id,
    title: node.title,
    type: node.type,
    summary: truncateText(node.summary, 700),
    ...(node.closureStatus ? { closureStatus: node.closureStatus } : {}),
    ...(node.evidenceStatus ? { evidenceStatus: node.evidenceStatus } : {}),
    childCount: node.childIds.length,
    chunkCount: node.chunkIds.length,
  };
}

function dfsNodeSummary(node: AoriTraversalNode): DfsStepInput["currentNode"] {
  return {
    nodeId: node.id,
    title: node.title,
    type: node.type,
    summary: truncateText(node.summary, 700),
    childCount: node.childIds.length,
    chunkCount: node.chunkIds.length,
  };
}

function relationBetween(map: AoriTraversalMap, sourceNodeId: string, targetNodeId: string): string | undefined {
  return map.relations.find((relation) =>
    relation.sourceNodeId === sourceNodeId && relation.targetNodeId === targetNodeId ||
    relation.sourceNodeId === targetNodeId && relation.targetNodeId === sourceNodeId
  )?.label;
}

function pathStep(
  node: AoriTraversalNode,
  decision: ChunkPathDecision,
  reason: string,
  relation?: string,
): ChunkPath[number] {
  return {
    nodeId: node.id,
    title: node.title,
    ...(relation ? { relation } : {}),
    summary: truncateText(node.summary, 500),
    decision,
    reason: truncateText(reason, 500),
  };
}

function relationsAmong(map: AoriTraversalMap, nodes: AoriTraversalNode[]): BfsExpansionInput["relationsAmongCurrentLayer"] {
  const ids = new Set(nodes.map((node) => node.id));
  return map.relations
    .filter((relation) => ids.has(relation.sourceNodeId) && ids.has(relation.targetNodeId))
    .slice(0, 24)
    .map((relation) => ({
      sourceNodeId: relation.sourceNodeId,
      targetNodeId: relation.targetNodeId,
      label: relation.label,
      ...(relation.summary ? { summary: truncateText(relation.summary, 500) } : {}),
    }));
}

function addNode(nodes: Map<string, AoriTraversalNode>, node: AoriTraversalNode): AoriTraversalNode {
  const existing = nodes.get(node.id);
  if (!existing) {
    nodes.set(node.id, node);
    return node;
  }
  existing.parentIds = uniqueStrings([...existing.parentIds, ...node.parentIds]);
  existing.childIds = uniqueStrings([...existing.childIds, ...node.childIds]);
  existing.relationIds = uniqueStrings([...existing.relationIds, ...node.relationIds]);
  existing.chunkIds = uniqueStrings([...existing.chunkIds, ...node.chunkIds]);
  return existing;
}

function linkParentChild(nodes: Map<string, AoriTraversalNode>, parentId: string, childId: string): void {
  const parent = nodes.get(parentId);
  const child = nodes.get(childId);
  if (!parent || !child) return;
  parent.childIds = uniqueStrings([...parent.childIds, childId]);
  child.parentIds = uniqueStrings([...child.parentIds, parentId]);
}

export function buildAoriTraversalMap(db: AgentDatabase, libraryId: string): AoriTraversalMap {
  const documentIndexes = db.listAoriDocumentIndexes(libraryId);
  const libraryAori = db.getLibraryAoriProfile(libraryId);
  const nodes = new Map<string, AoriTraversalNode>();
  const relations: AoriTraversalRelation[] = [];
  const documentCards: AoriTraversalMap["documentCards"] = [];
  const rootId = `library_root:${libraryId}`;
  const globalSummary = libraryAori.available
    ? libraryAori.summary
    : documentIndexes.map((index) => `${index.documentName}: ${index.understanding.summary}`).join("\n\n");
  const root = addNode(nodes, {
    id: rootId,
    type: "library_root",
    title: "Library AORI",
    summary: truncateText(globalSummary || "AORI library map assembled from document AORI indexes.", 3000),
    parentIds: [],
    childIds: [],
    relationIds: [],
    chunkIds: [],
    confidence: libraryAori.available ? 0.75 : 0.55,
  });

  for (const index of documentIndexes) {
    documentCards.push({
      documentId: index.documentId,
      versionId: index.versionId,
      documentName: index.documentName,
      summary: index.understanding.summary,
      centralQuestion: index.understanding.centralQuestion,
    });
    const documentNode = addNode(nodes, {
      id: `document:${index.versionId}`,
      type: "document",
      title: index.documentName,
      summary: index.understanding.summary,
      documentId: index.documentId,
      versionId: index.versionId,
      parentIds: [],
      childIds: [],
      relationIds: [],
      chunkIds: uniqueStrings(index.understanding.evidenceChunkIds),
      closureStatus: index.understanding.closureStatus,
      evidenceStatus: index.understanding.evidenceStatus,
      confidence: index.understanding.confidence,
    });
    linkParentChild(nodes, root.id, documentNode.id);

    const itemNodeIdByItemId = new Map<string, string>();
    for (const aspect of index.aspects) {
      const aspectChunkIds = uniqueStrings([
        ...aspect.items.flatMap((item) => item.evidenceChunkIds),
        ...aspect.relations.flatMap((relation) => relation.evidenceChunkIds),
      ]);
      const aspectNode = addNode(nodes, {
        id: `aspect:${aspect.id}`,
        type: "aspect",
        title: aspect.title,
        summary: `${aspect.summary}\n\nCentral question: ${aspect.centralQuestion}`,
        documentId: index.documentId,
        versionId: index.versionId,
        aspectId: aspect.id,
        aspectKind: aspect.kind,
        domainKind: aspect.domainKind,
        parentIds: [],
        childIds: [],
        relationIds: [],
        chunkIds: aspectChunkIds,
        closureStatus: aspect.closureStatus,
        evidenceStatus: aspect.evidenceStatus,
        confidence: aspect.confidence,
      });
      linkParentChild(nodes, documentNode.id, aspectNode.id);

      for (const item of aspect.items) {
        const itemNode = addNode(nodes, {
          id: `item:${item.id}`,
          type: "aspect_item",
          title: item.title,
          summary: item.summary,
          documentId: index.documentId,
          versionId: index.versionId,
          aspectId: aspect.id,
          itemId: item.id,
          parentIds: [],
          childIds: [],
          relationIds: [],
          chunkIds: uniqueStrings(item.evidenceChunkIds),
          closureStatus: item.closureStatus,
          evidenceStatus: item.evidenceStatus,
          confidence: item.confidence,
        });
        itemNodeIdByItemId.set(item.id, itemNode.id);
        linkParentChild(nodes, aspectNode.id, itemNode.id);
      }
    }

    for (const aspect of index.aspects) {
      const aspectNodeId = `aspect:${aspect.id}`;
      for (const relation of aspect.relations) {
        const sourceNodeId = itemNodeIdByItemId.get(relation.sourceItemId);
        const targetNodeId = itemNodeIdByItemId.get(relation.targetItemId);
        const relationNode = addNode(nodes, {
          id: `relation:${relation.id}`,
          type: "relation",
          title: relation.domainRelation || relation.relationName,
          summary: relation.reason,
          documentId: index.documentId,
          versionId: index.versionId,
          aspectId: aspect.id,
          parentIds: [],
          childIds: [],
          relationIds: [],
          chunkIds: uniqueStrings(relation.evidenceChunkIds),
          closureStatus: relation.closureStatus,
          evidenceStatus: relation.evidenceStatus,
          confidence: relation.confidence,
        });
        linkParentChild(nodes, aspectNodeId, relationNode.id);
        if (sourceNodeId && targetNodeId) {
          relations.push({
            id: `edge:${relation.id}`,
            sourceNodeId,
            targetNodeId,
            label: relation.domainRelation || relation.relationName,
            summary: relation.reason,
            chunkIds: uniqueStrings(relation.evidenceChunkIds),
            confidence: relation.confidence,
          });
          const source = nodes.get(sourceNodeId);
          const target = nodes.get(targetNodeId);
          if (source) source.relationIds = uniqueStrings([...source.relationIds, `edge:${relation.id}`]);
          if (target) target.relationIds = uniqueStrings([...target.relationIds, `edge:${relation.id}`]);
          relationNode.relationIds = uniqueStrings([...relationNode.relationIds, `edge:${relation.id}`]);
        }
      }

      for (const gap of aspect.closureReport.gaps) {
        const gapNode = addNode(nodes, {
          id: `gap:${gap.id}`,
          type: "gap",
          title: gap.description,
          summary: gap.description,
          documentId: index.documentId,
          versionId: index.versionId,
          aspectId: aspect.id,
          parentIds: [],
          childIds: [],
          relationIds: [],
          chunkIds: uniqueStrings(gap.evidenceChunkIds),
          closureStatus: "open",
          evidenceStatus: "unsupported",
          confidence: gap.severity === "high" ? 0.8 : 0.5,
        });
        linkParentChild(nodes, aspectNodeId, gapNode.id);
      }
    }

    for (const question of index.selfQuestions) {
      const questionNode = addNode(nodes, {
        id: `self_question:${question.id}`,
        type: "self_question",
        title: question.question,
        summary: question.answer ?? question.question,
        documentId: index.documentId,
        versionId: index.versionId,
        parentIds: [],
        childIds: [],
        relationIds: [],
        chunkIds: uniqueStrings(question.evidenceChunkIds),
        closureStatus: question.status === "answered" ? "partial" : "open",
        evidenceStatus: question.status === "answered" ? "supported" : "unsupported",
        confidence: question.status === "answered" ? 0.6 : 0.3,
      });
      linkParentChild(nodes, documentNode.id, questionNode.id);
    }
  }

  const nodesById = Object.fromEntries([...nodes.entries()]);
  return {
    libraryId,
    globalSummary: root.summary,
    centralQuestion: documentIndexes[0]?.understanding.centralQuestion,
    rootNodes: [nodesById[rootId]].filter((node): node is AoriTraversalNode => Boolean(node)),
    nodesById,
    relations,
    documentCards,
  };
}

function collectChunks(
  selected: Map<string, ChunkEvidencePack["selectedChunks"][number]>,
  node: AoriTraversalNode,
  path: ChunkPath,
  decision: ChunkPathDecision,
  reason: string,
  confidence?: number,
): ChunkEvidencePack["selectedChunks"][number][] {
  const collected: ChunkEvidencePack["selectedChunks"][number][] = [];
  for (const chunkId of node.chunkIds) {
    if (selected.size >= traversalLimits.maxSelectedChunks) break;
    if (selected.has(chunkId)) continue;
    const entry = {
      chunkId,
      sourceNodeId: node.id,
      ...(node.documentId ? { documentId: node.documentId } : {}),
      ...(node.versionId ? { versionId: node.versionId } : {}),
      path: [...path, pathStep(node, decision, reason)],
      retrievalSummary: `AORI traversal selected source chunks from ${node.title}.`,
      relevanceReason: truncateText(reason, 700),
      confidence: clampConfidence(confidence ?? node.confidence, decision === "need" || decision === "selected" ? 0.7 : 0.52),
    };
    selected.set(chunkId, entry);
    collected.push(entry);
  }
  return collected;
}

async function emitCollectedChunks(
  eventSink: PulseEventSink | undefined,
  collected: ChunkEvidencePack["selectedChunks"],
  node: AoriTraversalNode,
  chunksById: Map<string, Chunk>,
  mode: "bfs" | "dfs",
  stepIndex: number,
): Promise<void> {
  for (const selected of collected) {
    const chunk = chunksById.get(selected.chunkId);
    const label = chunk ? chunkLabel(chunk) : selected.chunkId;
    const hit: PendingPulseHit = {
      targetType: "chunk",
      targetId: selected.chunkId,
      score: selected.confidence,
      reason: selected.relevanceReason,
      pathRole: "direct",
      stepIndex,
      observation: selected.retrievalSummary,
      rationale: selected.path.map((step) => step.reason).join(" -> "),
      label,
      excerpt: chunk?.text.slice(0, 220) ?? null,
    };
    await emitTraversal(
      eventSink,
      mode === "bfs" ? "bfs_chunk_collected" : "dfs_chunk_found",
      `${mode === "bfs" ? "BFS" : "DFS"} hit chunk ${label}`,
      { node, selected },
    );
    await emitPulse(eventSink, { type: "hit", hit });
  }
}

function ensureAoriChunkCoverage(
  pack: ChunkEvidencePack,
  map: AoriTraversalMap,
): ChunkEvidencePack {
  if (pack.selectedChunks.length > 0) return pack;
  const selected = new Map<string, ChunkEvidencePack["selectedChunks"][number]>();
  const nodes = Object.values(map.nodesById).filter((node) => node.chunkIds.length > 0);
  for (const node of nodes) {
    collectChunks(
      selected,
      node,
      node.parentIds.flatMap((parentId) => {
        const parent = map.nodesById[parentId];
        return parent ? [pathStep(parent, "maybe", "Fallback walked from AORI parent because traversal collected no chunks.")] : [];
      }),
      "maybe",
      "Traversal did not collect chunks; conservatively reading AORI-bound source chunks for evidence verification.",
      0.35,
    );
    if (selected.size >= Math.min(4, traversalLimits.maxSelectedChunks)) break;
  }
  return {
    ...pack,
    selectedChunks: [...selected.values()],
    unresolvedQuestions: [
      ...pack.unresolvedQuestions,
      "Traversal did not select a chunk before fallback coverage; final answer must be guarded.",
    ],
    diagnostics: {
      ...pack.diagnostics,
      selectedChunkCount: selected.size,
      stoppedReason: pack.diagnostics.stoppedReason ?? "no_chunks_selected_aori_coverage_fallback",
    },
  };
}

async function bfsFullTraversal(
  question: string,
  map: AoriTraversalMap,
  model: ModelProvider,
  chunksById: Map<string, Chunk>,
  eventSink?: PulseEventSink,
): Promise<ChunkEvidencePack> {
  const queue: QueueEntry[] = map.rootNodes.map((node) => ({ node, depth: 0, path: [] }));
  const selected = new Map<string, ChunkEvidencePack["selectedChunks"][number]>();
  const skippedNodes: ChunkEvidencePack["skippedNodes"] = [];
  const visited = new Set<string>();
  let stoppedReason: string | undefined;
  let stepIndex = 1;

  while (queue.length > 0 && visited.size < traversalLimits.maxVisitedNodes && selected.size < traversalLimits.maxSelectedChunks) {
    const currentDepth = queue[0]?.depth ?? 0;
    if (currentDepth > traversalLimits.maxDepth) {
      stoppedReason = "max_depth_reached";
      break;
    }
    const currentLayer = queue.splice(0, traversalLimits.layerLimit).filter((entry) => !visited.has(entry.node.id));
    if (currentLayer.length === 0) continue;
    await emitTraversal(eventSink, "bfs_layer_started", `BFS layer ${currentDepth} started`, {
      depth: currentDepth,
      nodeIds: currentLayer.map((entry) => entry.node.id),
    });
    const decision = await model.decideAoriBfsExpansion({
      question,
      globalSummary: map.globalSummary,
      currentDepth,
      currentLayer: currentLayer.map((entry) => nodeSummary(entry.node)),
      relationsAmongCurrentLayer: relationsAmong(map, currentLayer.map((entry) => entry.node)),
    });
    const entryByNodeId = new Map(currentLayer.map((entry) => [entry.node.id, entry]));
    for (const item of decision.decisions) {
      const entry = entryByNodeId.get(item.nodeId);
      if (!entry) continue;
      const node = entry.node;
      visited.add(node.id);
      await emitTraversal(eventSink, "bfs_node_decision", `BFS ${item.decision}: ${node.title}`, { node, decision: item });
      if (item.decision === "skip") {
        skippedNodes.push({ nodeId: node.id, title: node.title, reason: item.reason });
        continue;
      }
      if (item.shouldCollectChunks && node.chunkIds.length > 0) {
        const collected = collectChunks(selected, node, entry.path, item.decision, item.reason, node.confidence);
        await emitCollectedChunks(eventSink, collected, node, chunksById, "bfs", stepIndex);
      }
      if (node.childIds.length > 0 && entry.depth < traversalLimits.maxDepth) {
        const nextPath = [...entry.path, pathStep(node, item.decision, item.reason)];
        for (const childId of node.childIds) {
          const child = map.nodesById[childId];
          if (!child || visited.has(child.id)) continue;
          queue.push({ node: child, depth: entry.depth + 1, path: nextPath });
        }
        await emitTraversal(eventSink, "bfs_node_expanded", `Expanded ${node.title}`, {
          nodeId: node.id,
          childIds: node.childIds,
        });
      }
    }
    stepIndex += 1;
    await emitTraversal(eventSink, "bfs_layer_finished", `BFS layer ${currentDepth} finished`, {
      depth: currentDepth,
      selectedChunkCount: selected.size,
    });
    if (decision.stopTraversal) {
      stoppedReason = decision.stopReason ?? "model_stop";
      break;
    }
  }
  if (!stoppedReason && selected.size >= traversalLimits.maxSelectedChunks) stoppedReason = "chunk_budget_reached";
  return ensureAoriChunkCoverage({
    question,
    mode: "bfs_full",
    selectedChunks: [...selected.values()],
    skippedNodes,
    unresolvedQuestions: [],
    diagnostics: {
      visitedNodeCount: visited.size,
      selectedChunkCount: selected.size,
      ...(stoppedReason ? { stoppedReason } : {}),
    },
  }, map);
}

async function dfsPulseTraversal(
  question: string,
  map: AoriTraversalMap,
  model: ModelProvider,
  chunksById: Map<string, Chunk>,
  eventSink?: PulseEventSink,
): Promise<ChunkEvidencePack> {
  const selected = new Map<string, ChunkEvidencePack["selectedChunks"][number]>();
  const skippedNodes: ChunkEvidencePack["skippedNodes"] = [];
  const visited = new Set<string>();
  let stoppedReason: string | undefined;
  let stepIndex = 1;

  const visit = async (node: AoriTraversalNode, path: ChunkPath, depth: number): Promise<void> => {
    if (visited.has(node.id) || stoppedReason) return;
    if (visited.size >= traversalLimits.maxVisitedNodes) {
      stoppedReason = "max_visited_nodes_reached";
      return;
    }
    if (selected.size >= traversalLimits.maxSelectedChunks) {
      stoppedReason = "chunk_budget_reached";
      return;
    }
    if (depth > traversalLimits.maxDepth) {
      stoppedReason = "max_depth_reached";
      return;
    }
    visited.add(node.id);
    await emitTraversal(eventSink, "dfs_node_entered", `DFS entered ${node.title}`, { node, path });
    const candidates = node.childIds
      .flatMap((childId) => {
        const child = map.nodesById[childId];
        if (!child || visited.has(child.id)) return [];
        return [{
          nodeId: child.id,
          title: child.title,
          type: child.type,
          summary: truncateText(child.summary, 700),
          ...(relationBetween(map, node.id, child.id) ? { relationFromCurrent: relationBetween(map, node.id, child.id) } : {}),
          childCount: child.childIds.length,
          chunkCount: child.chunkIds.length,
        }];
      })
      .slice(0, 12);
    const decision = await model.chooseAoriDfsNext({
      question,
      globalSummary: map.globalSummary,
      currentNode: dfsNodeSummary(node),
      path: path.map((step) => ({
        nodeId: step.nodeId,
        title: step.title,
        ...(step.relation ? { relation: step.relation } : {}),
        summary: step.summary,
        reason: step.reason,
      })),
      candidates,
    });
    if (decision.recordCurrentChunks && node.chunkIds.length > 0) {
      const collected = collectChunks(selected, node, path, "selected", decision.reason, node.confidence);
      await emitCollectedChunks(eventSink, collected, node, chunksById, "dfs", stepIndex);
    }
    if (decision.stopTraversal) {
      stoppedReason = decision.reason || "model_stop";
      return;
    }
    if (decision.backtrack || candidates.length === 0) {
      skippedNodes.push({ nodeId: node.id, title: node.title, reason: decision.reason });
      return;
    }
    const nextIds = decision.selectedNextNodeIds.slice(0, traversalLimits.maxDfsBranching);
    for (const nextId of nextIds) {
      const child = map.nodesById[nextId];
      if (!child || visited.has(child.id)) continue;
      await emitTraversal(eventSink, "dfs_candidate_selected", `DFS selected ${child.title}`, {
        fromNodeId: node.id,
        nextNodeId: child.id,
        reason: decision.reason,
      });
      const relation = relationBetween(map, node.id, child.id);
      await visit(child, [...path, pathStep(node, "selected", decision.reason, relation)], depth + 1);
      await emitTraversal(eventSink, "dfs_backtrack", `DFS backtracked to ${node.title}`, {
        fromNodeId: child.id,
        toNodeId: node.id,
        reason: "DFS returns to the previous AORI node after checking a branch.",
      });
      await emitPulse(eventSink, {
        type: "backtrack",
        stepIndex,
        fromNodeId: child.id,
        fromLabel: child.title,
        toNodeId: node.id,
        toLabel: node.title,
        reason: "DFS 回溯到上一层继续探索其他 AORI 路径。",
      });
      stepIndex += 1;
      if (stoppedReason || selected.size >= traversalLimits.maxSelectedChunks) break;
    }
  };

  for (const root of map.rootNodes) {
    await visit(root, [], 0);
    if (stoppedReason || selected.size >= traversalLimits.maxSelectedChunks) break;
  }
  if (!stoppedReason && selected.size >= traversalLimits.maxSelectedChunks) stoppedReason = "chunk_budget_reached";
  return ensureAoriChunkCoverage({
    question,
    mode: "dfs_pulse",
    selectedChunks: [...selected.values()],
    skippedNodes,
    unresolvedQuestions: [],
    diagnostics: {
      visitedNodeCount: visited.size,
      selectedChunkCount: selected.size,
      ...(stoppedReason ? { stoppedReason } : {}),
    },
  }, map);
}

function selectedChunksToHits(pack: ChunkEvidencePack, chunks: Chunk[]): PendingPulseHit[] {
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return pack.selectedChunks.map((selected, index): PendingPulseHit => {
    const chunk = chunkById.get(selected.chunkId);
    return {
      targetType: "chunk",
      targetId: selected.chunkId,
      score: selected.confidence,
      reason: selected.relevanceReason,
      pathRole: "direct",
      stepIndex: index + 1,
      observation: selected.retrievalSummary,
      rationale: selected.path.map((step) => `${step.title}: ${step.reason}`).join(" -> "),
      label: chunk ? chunkLabel(chunk) : selected.chunkId,
      excerpt: chunk?.text.slice(0, 220) ?? null,
    };
  });
}

function buildEvidenceRows(
  summaries: ChunkAnswerSummary[],
  chunks: Chunk[],
  pack: ChunkEvidencePack,
): PulseEvidenceRow[] {
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const selectedByChunkId = new Map(pack.selectedChunks.map((selected) => [selected.chunkId, selected]));
  return summaries
    .filter((summary) => summary.relevant && summary.usage !== "background_only" && summary.usage !== "irrelevant")
    .flatMap((summary, summaryIndex) => {
      const chunk = chunkById.get(summary.chunkId);
      const selected = selectedByChunkId.get(summary.chunkId);
      const facts = summary.supportedFacts.length > 0 ? summary.supportedFacts : [summary.shortSummary];
      const usage = summary.usage === "supporting_detail" ? "supporting_detail" : "answer_core";
      return facts.slice(0, 4).map((fact, factIndex): PulseEvidenceRow => ({
        rowId: `aori-traversal-row-${summaryIndex + 1}-${factIndex + 1}`,
        evidenceType: "fact",
        claimText: truncateText(fact, 500),
        evidenceChunkId: summary.chunkId,
        treeNodeId: chunk?.documentTreeNodeId ?? null,
        evidenceQuote: summary.keyQuotes[factIndex] ?? chunk?.text.slice(0, 220) ?? fact,
        role: "direct_fact",
        authority: "documentary_record",
        usage,
        classificationRationale: "Per-chunk AORI traversal summary extracted this fact from the source chunk.",
        confidence: summary.confidence,
        ...(selected?.documentId ? { documentId: selected.documentId } : {}),
        ...(chunk?.versionId ? { versionId: chunk.versionId } : selected?.versionId ? { versionId: selected.versionId } : {}),
        ...(chunk?.headingPath ? { headingPath: [chunk.headingPath] } : {}),
      }));
    });
}

function buildCitations(rows: PulseEvidenceRow[], chunks: Chunk[]): EvidenceCitation[] {
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return rows.map((row) => {
    const chunk = chunkById.get(row.evidenceChunkId);
    return {
      chunkId: row.evidenceChunkId,
      treeNodeId: row.treeNodeId ?? chunk?.documentTreeNodeId ?? null,
      quote: row.evidenceQuote,
      headingPath: chunk?.headingPath ?? null,
      pageNumber: chunk?.pageNumber ?? null,
    };
  });
}

function retrievalTrace(pack: ChunkEvidencePack, summaries: ChunkAnswerSummary[]): RetrievalTrace[] {
  return [{
    stepIndex: 1,
    tool: "buildEvidencePack",
    purpose: pack.mode === "bfs_full" ? "AORI BFS traversal collected source chunks." : "AORI DFS traversal collected source chunks.",
    inputIds: pack.selectedChunks.flatMap((selected) => selected.sourceNodeId ?? []),
    outputIds: pack.selectedChunks.map((selected) => selected.chunkId),
    newEvidenceRowCount: summaries.reduce((sum, summary) => sum + summary.supportedFacts.length, 0),
    status: pack.selectedChunks.length > 0 ? "success" : "empty",
  }, {
    stepIndex: 2,
    tool: "readChunks",
    purpose: "Read selected raw chunks and summarize each chunk against the question.",
    inputIds: pack.selectedChunks.map((selected) => selected.chunkId),
    outputIds: summaries.map((summary) => summary.chunkId),
    newEvidenceRowCount: summaries.filter((summary) => summary.relevant).length,
    status: summaries.length > 0 ? "success" : "empty",
  }];
}

function buildStorageEvidencePack(input: {
  question: string;
  modelName: string;
  chunkEvidencePack: ChunkEvidencePack;
  chunkSummaries: ChunkAnswerSummary[];
  chunks: Chunk[];
}): EvidencePack {
  const evidenceRows = buildEvidenceRows(input.chunkSummaries, input.chunks, input.chunkEvidencePack);
  return {
    id: `aori-traversal-pack-${Date.now()}`,
    question: input.question,
    evidencePackSchemaVersion: 1,
    pipeline: {
      indexProfile: "v1",
      packBuilder: "aori_traversal",
      model: input.modelName,
      promptVersion: "aori-traversal-v1",
    },
    pipelineVersion: {
      indexerVersion: "aori-document-v1",
      contextUnitBuilderVersion: "not_used",
      retrievalUnitBuilderVersion: "not_used",
      packBuilderVersion: "aori-traversal-v1",
      evidenceExtractorVersion: "chunk-summary-v1",
      validatorVersion: "chunk-source-only-v1",
      promptVersion: "aori-traversal-v1",
    },
    answerMode: "citation_supported",
    answerModeReason: "AORI traversal selected source chunks, then final answer was synthesized from per-chunk summaries.",
    chunkEvidencePack: input.chunkEvidencePack,
    chunkSummaries: input.chunkSummaries,
    treeNodes: [],
    parentChunks: [],
    semanticNodes: [],
    semanticRelations: [],
    summaryNodes: [],
    evidenceRows,
    citations: buildCitations(evidenceRows, input.chunks),
    gaps: input.chunkEvidencePack.unresolvedQuestions.map((question) => ({
      type: "other",
      description: question,
      suggestedQueries: [input.question],
      severity: "medium",
    })),
    retrievalTrace: retrievalTrace(input.chunkEvidencePack, input.chunkSummaries),
  };
}

export class AoriTraversalAnswerEngine {
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
    if (!this.model.configured) throw new Error("AORI traversal answering requires a configured model service.");
    const map = buildAoriTraversalMap(this.db, input.libraryId);
    const allChunkIds = uniqueStrings(Object.values(map.nodesById).flatMap((node) => node.chunkIds));
    const allChunks = this.db.getChunksByIds(allChunkIds);
    const chunksById = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
    const skillRouteInput = buildAoriSkillRouterInput(input.question, map);
    const skillRoute = await this.model.routeAoriSkill(skillRouteInput);
    await emitTraversal(input.eventSink, "skill_route_generated", `AORI skill route selected ${skillRoute.skill}.`, {
      route: skillRoute,
      skillRouteFallback: this.model.name === "fake",
    });
    await emitPulse(input.eventSink, { type: "stage", message: `AORI skill route: ${skillRoute.skill}` });
    if (skillRoute.skill !== "normal_traversal") {
      const skillResult = await executeAoriSkill({
        libraryId: input.libraryId,
        question: input.question,
        map,
        route: skillRoute,
        chunksById,
        model: this.model,
        ...(input.eventSink ? { eventSink: input.eventSink } : {}),
      });
      const evidencePack: ChunkEvidencePack = {
        question: input.question,
        mode: input.mode === "progressive" ? "dfs_pulse" : "bfs_full",
        selectedChunks: [],
        skippedNodes: [],
        unresolvedQuestions: [],
        diagnostics: {
          visitedNodeCount: 0,
          selectedChunkCount: 0,
          stoppedReason: "aori_skill_pipeline",
        },
      };
      return {
        evidencePack,
        chunkSummaries: [],
        answer: skillResult.answer,
        chunks: skillResult.chunks,
        hits: skillResult.hits,
        storageEvidencePack: skillResult.evidencePack,
      };
    }
    await emitTraversal(input.eventSink, "aori_traversal_started", "AORI traversal started.", {
      mode: input.mode,
      documentCount: map.documentCards.length,
      nodeCount: Object.keys(map.nodesById).length,
      reason: "Skill router selected normal_traversal",
    });
    await emitPulse(input.eventSink, { type: "stage", message: input.mode === "progressive" ? "正在 DFS 探索 AORI 路径" : "正在 BFS 遍历 AORI 地图" });
    const evidencePack = input.mode === "progressive"
      ? await dfsPulseTraversal(input.question, map, this.model, chunksById, input.eventSink)
      : await bfsFullTraversal(input.question, map, this.model, chunksById, input.eventSink);
    const selectedChunks = this.db.getChunksByIds(evidencePack.selectedChunks.map((selected) => selected.chunkId));
    const selectedByChunkId = new Map(evidencePack.selectedChunks.map((selected) => [selected.chunkId, selected]));
    const chunkSummaries: ChunkAnswerSummary[] = [];
    for (const chunk of selectedChunks) {
      const selected = selectedByChunkId.get(chunk.id);
      if (!selected) continue;
      await emitTraversal(input.eventSink, "chunk_summary_started", `Summarizing chunk ${chunk.id}`, {
        chunkId: chunk.id,
      });
      const summaryInput: ChunkSummaryInput = {
        question: input.question,
        chunkId: chunk.id,
        chunkText: chunk.text,
        retrievalTrace: {
          ...(selected.sourceNodeId ? { sourceNodeId: selected.sourceNodeId } : {}),
          path: selected.path,
          retrievalSummary: selected.retrievalSummary,
          relevanceReason: selected.relevanceReason,
        },
      };
      const summary = await this.model.summarizeChunkForQuestion(summaryInput);
      chunkSummaries.push(summary);
      await emitTraversal(input.eventSink, "chunk_summary_finished", `Chunk ${chunk.id} summary finished`, {
        chunkId: chunk.id,
        relevant: summary.relevant,
      });
    }
    await emitTraversal(input.eventSink, "final_answer_started", "Synthesizing final answer from chunk summaries.", {
      relevantChunkCount: chunkSummaries.filter((summary) => summary.relevant).length,
    });
    const answerInput: FinalAnswerFromChunksInput = {
      question: input.question,
      evidencePack,
      chunkSummaries,
      chunks: selectedChunks.map((chunk) => {
        const source = this.db.getVersionSource(chunk.versionId);
        return {
          id: chunk.id,
          text: chunk.text,
          documentId: source?.documentId ?? "",
          versionId: chunk.versionId,
        };
      }),
    };
    const answerDraft = await this.model.synthesizeAnswerFromChunks(answerInput);
    const answer = {
      ...answerDraft,
      diagnostics: {
        ...answerDraft.diagnostics,
        answerPipeline: "aori_traversal",
        selectedSkill: "normal_traversal",
        skillRoute,
        targetAspects: skillRoute.targetAspects,
        fallbackTraversalUsed: true,
        skillRouteFallback: this.model.name === "fake",
      },
    } satisfies PulseAnswerOutput;
    await emitTraversal(input.eventSink, "final_answer_finished", answer.summary, {
      answer,
    });
    const storageEvidencePack = buildStorageEvidencePack({
      question: input.question,
      modelName: this.model.name,
      chunkEvidencePack: evidencePack,
      chunkSummaries,
      chunks: selectedChunks,
    });
    storageEvidencePack.diagnostics = {
      answerPipeline: "aori_traversal",
      selectedSkill: "normal_traversal",
      skillRoute,
      reason: "Skill router selected normal_traversal",
      fallbackTraversalUsed: true,
      skillRouteFallback: this.model.name === "fake",
    };
    return {
      evidencePack,
      chunkSummaries,
      answer,
      chunks: selectedChunks,
      hits: selectedChunksToHits(evidencePack, selectedChunks),
      storageEvidencePack,
    };
  }
}
