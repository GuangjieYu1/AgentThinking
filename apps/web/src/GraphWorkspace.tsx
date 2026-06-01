import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  BaseEdge,
  Background,
  ControlButton,
  Controls,
  getBezierPath,
  getSmoothStepPath,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from "d3-force";
import {
  aspectKinds,
  relationStatuses,
  relationTypes,
  type AbstractNode,
  type AspectKind,
  type Citation,
  type GraphEdge,
  type GraphNode,
  type GraphResponse,
  type GraphView,
  type Pulse,
  type PulseInputMode,
  type PulseResponse,
  type PulseStreamEvent,
  type PulseStreamHit,
  type Relation,
  type RelationStatus,
  type RelationType,
  type SearchResult,
} from "@agent-thinking/contracts";
import { api } from "./api";

type VisualNode = Node<{ label: ReactNode; entity: GraphNode }>;
type VisualEdge = Edge<{ entity: GraphEdge }>;
type LayoutMode = "layered" | "network" | "tree";
type PulseLayerMode = "normal" | "current" | "stats" | "wrong" | "correct";
type PulseHitRecord = PulseResponse["hits"][number];
type PulseStreamHitRecord = PulseStreamHit;
type PulseNavigationEvent = Extract<PulseStreamEvent, { type: "candidates" | "decision" | "backtrack" }>;
type PulseDecorated = { pulseActive?: boolean; pulseReverse?: boolean; pulseTransitKey?: string };
type PulseVisualHit = Pick<PulseHitRecord, "targetType" | "targetId">;
type SearchFocus = { matchIds: ReadonlySet<string>; activeId?: string };
type PulsePlaybackStep =
  | { kind: "hit"; hit: PulseHitRecord }
  | { kind: "backtrack"; fromNodeId: string; toNodeId: string; edgeId: string; label: string; transitKey: string };
interface LayoutLink {
  source: string;
  target: string;
}
interface PositionedNode extends SimulationNodeDatum {
  id: string;
}

function PulseBezierEdge(props: EdgeProps): ReactNode {
  return <PulseOrbEdge {...props} pathKind="bezier" />;
}

function PulseSmoothStepEdge(props: EdgeProps): ReactNode {
  return <PulseOrbEdge {...props} pathKind="smoothstep" />;
}

function PulseOrbEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  label,
  labelStyle,
  interactionWidth,
  data,
  pathKind,
}: EdgeProps & { pathKind: "bezier" | "smoothstep" }): ReactNode {
  const [edgePath, labelX, labelY] = pathKind === "smoothstep"
    ? getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const pulseMeta = (data as { entity?: PulseDecorated } | undefined)?.entity;
  const reverse = Boolean(pulseMeta?.pulseReverse);
  const transitKey = pulseMeta?.pulseTransitKey ?? id;
  const edgeProps = {
    ...(markerEnd ? { markerEnd } : {}),
    ...(style ? { style } : {}),
    ...(label !== undefined ? { label } : {}),
    labelX,
    labelY,
    ...(labelStyle ? { labelStyle } : {}),
    ...(interactionWidth !== undefined ? { interactionWidth } : {}),
  };
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        {...edgeProps}
      />
      <circle className="flow-pulse-orb" r="5" key={transitKey}>
        <animateMotion
          dur="1.05s"
          fill="freeze"
          repeatCount="1"
          path={edgePath}
          calcMode="linear"
          {...(reverse ? { keyPoints: "1;0", keyTimes: "0;1" } : {})}
        />
      </circle>
    </>
  );
}

const edgeTypes = {
  pulseBezier: PulseBezierEdge,
  pulseSmoothStep: PulseSmoothStepEdge,
} satisfies EdgeTypes;

const aspectLabels: Record<AspectKind, string> = {
  person: "人物",
  operation: "操作",
  system: "系统",
  story: "事件",
  claim: "命题",
  conflict: "冲突",
  time: "时间",
  other: "其他",
};

const pulseInitialRevealDelayMs = 455;
const pulseRevealDelayMs = 1050;

function relationColor(status: RelationStatus): string {
  if (status === "suggested") return "#e7a93c";
  if (status === "accepted") return "#43cca0";
  if (status === "manual") return "#48a9ff";
  return "#64748b";
}

function pulseTraceClass(record: GraphNode | GraphEdge, mode: PulseLayerMode): string {
  if (mode === "normal") return "";
  if (mode === "current") {
    if (!record.pulseRole) return "flow-pulse-muted";
    return `flow-pulse-${record.pulseRole}`;
  }
  const stats = record.pulseStats;
  if (!stats) return "flow-pulse-muted";
  if (mode === "wrong") return stats.wrongCount > 0 ? "flow-pulse-wrong" : "flow-pulse-muted";
  if (mode === "correct") return stats.correctCount > 0 ? "flow-pulse-correct" : "flow-pulse-muted";
  if (stats.wrongCount > stats.correctCount) return "flow-pulse-wrong";
  if (stats.correctCount > stats.wrongCount) return "flow-pulse-correct";
  return "flow-pulse-mixed";
}

function pulseTraceColor(record: GraphEdge, mode: PulseLayerMode, fallback: string): string {
  const className = pulseTraceClass(record, mode);
  if (className === "flow-pulse-direct") return "#f8d26a";
  if (className === "flow-pulse-bridge") return "#c6a2ff";
  if (className === "flow-pulse-expanded") return "#7db8ff";
  if (className === "flow-pulse-wrong") return "#ef5f7a";
  if (className === "flow-pulse-correct") return "#4bd493";
  if (className === "flow-pulse-mixed") return "#e7b84d";
  return fallback;
}

function isPulseActive(record: GraphNode | GraphEdge): boolean {
  return Boolean((record as PulseDecorated).pulseActive);
}

function withPulseActive<T extends GraphNode | GraphEdge>(
  record: T,
  options: { reverse?: boolean; transitKey?: string } = {},
): T {
  return {
    ...record,
    pulseActive: true,
    ...(options.reverse ? { pulseReverse: true } : {}),
    ...(options.transitKey ? { pulseTransitKey: options.transitKey } : {}),
  } as T;
}

const pulseRoleRank = { direct: 0, bridge: 1, expanded: 2 } satisfies Record<NonNullable<GraphNode["pulseRole"]>, number>;

type SortablePulseHit = Pick<PulseHitRecord, "stepIndex" | "pathRole" | "score" | "label">;

function sortPulseHits(left: SortablePulseHit, right: SortablePulseHit): number {
  return (left.stepIndex ?? 999) - (right.stepIndex ?? 999) ||
    pulseRoleRank[left.pathRole] - pulseRoleRank[right.pathRole] ||
    right.score - left.score ||
    left.label.localeCompare(right.label, "zh-CN");
}

function orderedPulseHits(response: PulseResponse | undefined): PulseHitRecord[] {
  if (!response) return [];
  const fallback = [...response.hits].sort(sortPulseHits);
  const byKey = new Map(fallback.map((hit) => [pulseHitKey(hit), hit]));
  const used = new Set<string>();
  const ordered: PulseHitRecord[] = [];
  const evidenceChunksByNode = new Map<string, PulseHitRecord[]>();
  const relationEdges = response.graph.edges
    .filter((edge) => edge.relation && byKey.has(`relation:${edge.relation.id}`))
    .sort((left, right) => sortPulseHits(byKey.get(`relation:${left.relation!.id}`)!, byKey.get(`relation:${right.relation!.id}`)!));

  for (const edge of response.graph.edges) {
    if (edge.edgeType !== "evidence") continue;
    const chunkHit = byKey.get(`chunk:${edge.target}`);
    if (!chunkHit) continue;
    const chunks = evidenceChunksByNode.get(edge.source) ?? [];
    chunks.push(chunkHit);
    evidenceChunksByNode.set(edge.source, chunks.sort(sortPulseHits));
  }

  const append = (hit: PulseHitRecord | undefined) => {
    if (!hit) return false;
    const key = pulseHitKey(hit);
    if (used.has(key)) return false;
    used.add(key);
    ordered.push(hit);
    return true;
  };
  const appendNodeCluster = (nodeId: string) => {
    append(byKey.get(`node:${nodeId}`));
    for (const chunkHit of evidenceChunksByNode.get(nodeId) ?? []) append(chunkHit);
  };
  const revealedNodes = () => new Set(
    ordered.filter((hit) => hit.targetType === "node").map((hit) => hit.targetId),
  );
  const appendReachableRelations = () => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const visible = revealedNodes();
      for (const edge of relationEdges) {
        const relationHit = byKey.get(`relation:${edge.relation!.id}`);
        if (!relationHit || used.has(pulseHitKey(relationHit))) continue;
        const sourceVisible = visible.has(edge.source);
        const targetVisible = visible.has(edge.target);
        if (!sourceVisible && !targetVisible) continue;
        append(relationHit);
        if (!sourceVisible) appendNodeCluster(edge.source);
        if (!targetVisible) appendNodeCluster(edge.target);
        progressed = true;
      }
    }
  };

  for (const hit of fallback.filter((item) => item.targetType === "node" && item.pathRole === "direct")) {
    appendNodeCluster(hit.targetId);
    appendReachableRelations();
  }
  for (const hit of fallback) append(hit);
  return ordered;
}

function pulsePlaybackSteps(hits: PulseHitRecord[], graphEdges: GraphEdge[]): PulsePlaybackStep[] {
  const edgeByRelationKey = new Map<string, GraphEdge>();
  for (const edge of graphEdges) {
    for (const key of graphEdgePulseKeys(edge)) edgeByRelationKey.set(key, edge);
  }
  const traversedEdgeIds = new Set<string>();
  const steps: PulsePlaybackStep[] = [];
  let currentNodeId: string | undefined;

  for (const hit of hits) {
    if (hit.targetType === "relation") {
      const edge = edgeByRelationKey.get(pulseHitKey(hit));
      if (edge && currentNodeId && edge.source !== currentNodeId && edge.target !== currentNodeId) {
        const backtrackPath = shortestRevealedPath(currentNodeId, [edge.source, edge.target], graphEdges, traversedEdgeIds);
        for (const segment of backtrackPath) {
          steps.push({
            kind: "backtrack",
            fromNodeId: segment.from,
            toNodeId: segment.to,
            edgeId: segment.edge.id,
            label: `回溯 ${segment.fromLabel} → ${segment.toLabel}`,
            transitKey: `backtrack:${segment.edge.id}:${segment.from}:${segment.to}:${steps.length}`,
          });
          currentNodeId = segment.to;
        }
      }
      steps.push({ kind: "hit", hit });
      if (edge) traversedEdgeIds.add(edge.id);
      continue;
    }

    steps.push({ kind: "hit", hit });
    if (hit.targetType === "node") currentNodeId = hit.targetId;
  }

  return steps;
}

function shortestRevealedPath(
  fromNodeId: string,
  targetNodeIds: string[],
  graphEdges: GraphEdge[],
  traversedEdgeIds: Set<string>,
): Array<{ edge: GraphEdge; from: string; to: string; fromLabel: string; toLabel: string }> {
  const targets = new Set(targetNodeIds);
  if (targets.has(fromNodeId)) return [];
  const traversedEdges = graphEdges.filter((edge) => traversedEdgeIds.has(edge.id));
  const adjacency = new Map<string, Array<{ edge: GraphEdge; to: string }>>();
  for (const edge of traversedEdges) {
    const fromList = adjacency.get(edge.source) ?? [];
    fromList.push({ edge, to: edge.target });
    adjacency.set(edge.source, fromList);
    const toList = adjacency.get(edge.target) ?? [];
    toList.push({ edge, to: edge.source });
    adjacency.set(edge.target, toList);
  }

  const queue = [fromNodeId];
  const previous = new Map<string, { nodeId: string; edge: GraphEdge }>();
  const visited = new Set([fromNodeId]);
  let found: string | undefined;
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next.to)) continue;
      visited.add(next.to);
      previous.set(next.to, { nodeId: current, edge: next.edge });
      if (targets.has(next.to)) {
        found = next.to;
        queue.length = 0;
        break;
      }
      queue.push(next.to);
    }
  }
  if (!found) return [];

  const reversed: Array<{ edge: GraphEdge; from: string; to: string }> = [];
  for (let cursor = found; cursor !== fromNodeId;) {
    const step = previous.get(cursor);
    if (!step) return [];
    reversed.push({ edge: step.edge, from: step.nodeId, to: cursor });
    cursor = step.nodeId;
  }
  return reversed.reverse().map((segment) => ({
    ...segment,
    fromLabel: segment.from,
    toLabel: segment.to,
  }));
}

function pulseStepExplanation(hit: PulseHitRecord | undefined, total: number): string {
  if (!hit || total === 0) return "等待脉冲路径开始披露。";
  const target = hit.targetType === "chunk" ? "证据" : hit.targetType === "relation" ? "关系" : "节点";
  const observation = hit.observation ?? (
    hit.targetType === "chunk" ? "系统正在查看可追溯原文入口。"
      : hit.targetType === "relation" ? "系统正在查看两个节点之间的可见连边。"
        : "系统正在查看一个可参与回答的概念或命题节点。"
  );
  const rationale = hit.rationale ?? hit.reason;
  return `第 ${hit.stepIndex ?? "?"} 步点亮${target}「${hit.label}」。看到的信息：${observation} 选择理由：${rationale}`;
}

function pulsePlaybackStepExplanation(step: PulsePlaybackStep | undefined, total: number): string {
  if (!step) return pulseStepExplanation(undefined, total);
  if (step.kind === "hit") return pulseStepExplanation(step.hit, total);
  return `${step.label}。下一条脉冲路径不在当前节点上，所以光球先沿已走过的边退回分叉点，再继续前往新的分支。`;
}

function pulseHitReason(hit: { rationale: string | null; reason: string }): string {
  return hit.rationale?.trim() || hit.reason;
}

function pulseHitKey(hit: Pick<PulseHitRecord, "targetType" | "targetId">): string {
  return `${hit.targetType}:${hit.targetId}`;
}

function graphNodePulseKey(record: GraphNode): string {
  return `${record.nodeType === "abstract" ? "node" : "chunk"}:${record.id}`;
}

function graphEdgePulseKeys(record: GraphEdge): string[] {
  if (record.relation) return [`relation:${record.relation.id}`];
  return record.aggregate?.relationIds.map((id) => `relation:${id}`) ?? [];
}

function withoutCurrentPulse<T extends GraphNode | GraphEdge>(record: T): T {
  const {
    pulseActive: _pulseActive,
    pulseReverse: _pulseReverse,
    pulseTransitKey: _pulseTransitKey,
    pulseScore: _pulseScore,
    pulseRole: _pulseRole,
    ...rest
  } = record as T & PulseDecorated;
  return rest as T;
}

function lastNodeBefore(hits: PulseVisualHit[], endIndex: number): string | undefined {
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    if (hits[index]?.targetType === "node") return hits[index]!.targetId;
  }
  return undefined;
}

function activeEdgeState(
  edge: GraphEdge,
  hits: PulseVisualHit[],
  fromNodeOverride?: string,
): { active: boolean; reverse: boolean; transitKey: string } {
  const activeIndex = hits.length - 1;
  const activeHit = hits[activeIndex];
  if (!activeHit) return { active: false, reverse: false, transitKey: "" };
  const activeKey = pulseHitKey(activeHit);
  const edgeKeys = graphEdgePulseKeys(edge);

  if (activeHit.targetType === "relation" && edgeKeys.includes(activeKey)) {
    const fromNodeId = fromNodeOverride ?? lastNodeBefore(hits, activeIndex);
    return {
      active: true,
      reverse: Boolean(fromNodeId && edge.target === fromNodeId && edge.source !== fromNodeId),
      transitKey: `${activeKey}:${fromNodeId ?? "unknown"}`,
    };
  }

  if (activeHit.targetType === "node") {
    for (let index = activeIndex - 1; index >= 0; index -= 1) {
      const previous = hits[index]!;
      if (previous.targetType !== "relation" || !edgeKeys.includes(pulseHitKey(previous))) continue;
      const edgeTouchesActiveNode = edge.source === activeHit.targetId || edge.target === activeHit.targetId;
      if (!edgeTouchesActiveNode) continue;
      return {
        active: true,
        reverse: edge.source === activeHit.targetId,
        transitKey: `${pulseHitKey(previous)}:${activeHit.targetId}`,
      };
    }
  }

  if (activeHit.targetType === "chunk" && edge.edgeType === "evidence" && edge.target === activeHit.targetId) {
    return { active: true, reverse: false, transitKey: activeKey };
  }

  return { active: false, reverse: false, transitKey: "" };
}

function revealPulseGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  mode: PulseLayerMode,
  pulse: PulseResponse | undefined,
  revealCount: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (mode !== "current" || !pulse) return { nodes: graphNodes, edges: graphEdges };
  const ordered = orderedPulseHits(pulse);
  const playback = pulsePlaybackSteps(ordered, pulse.graph.edges);
  const revealedSteps = playback.slice(0, revealCount);
  const revealedHits = revealedSteps.flatMap((step) => step.kind === "hit" ? [step.hit] : []);
  const revealed = new Set(revealedHits.map(pulseHitKey));
  const activeStep = revealedSteps.at(-1);
  const activeHit = activeStep?.kind === "hit" ? activeStep.hit : undefined;
  const activeKey = activeHit ? pulseHitKey(activeHit) : "";
  const relationFromNode = activeHit?.targetType === "relation" && revealedSteps.at(-2)?.kind === "backtrack"
    ? (revealedSteps.at(-2) as Extract<PulsePlaybackStep, { kind: "backtrack" }>).toNodeId
    : undefined;
  const nodes = graphNodes.map((record) => {
    const visible = record.pulseRole && !revealed.has(graphNodePulseKey(record)) ? withoutCurrentPulse(record) : record;
    return activeKey === graphNodePulseKey(record) && visible.pulseRole
      ? withPulseActive(visible, { transitKey: activeKey })
      : visible;
  });
  const edges = graphEdges.map((record) => {
    const keys = graphEdgePulseKeys(record);
    const edgeIsRevealed = keys.some((key) => revealed.has(key));
    if (record.pulseRole && !edgeIsRevealed) return withoutCurrentPulse(record);
    let next = record;
    if (!record.pulseRole && record.edgeType === "evidence" && revealed.has(`node:${record.source}`) && revealed.has(`chunk:${record.target}`)) {
      next = { ...record, pulseRole: "expanded" as const, pulseScore: 0.32 };
    }
    const relationIsActive = graphEdgePulseKeys(next).some((key) => key === activeKey);
    const evidenceIsActive = next.edgeType === "evidence" && activeKey === `chunk:${next.target}` && revealed.has(`node:${next.source}`);
    const travel = activeEdgeState(next, revealedHits, relationFromNode);
    if (activeStep?.kind === "backtrack" && next.id === activeStep.edgeId) {
      const pulseEdge = next.pulseRole ? next : { ...next, pulseRole: "bridge" as const, pulseScore: 0.44 };
      return withPulseActive(pulseEdge, {
        reverse: next.target === activeStep.fromNodeId && next.source === activeStep.toNodeId,
        transitKey: activeStep.transitKey,
      });
    }
    return (travel.active || relationIsActive || evidenceIsActive) && next.pulseRole
      ? withPulseActive(next, { reverse: travel.reverse, transitKey: travel.transitKey || activeKey })
      : next;
  });
  return { nodes, edges };
}

function decoratePulseStreamGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  hits: PulseStreamHitRecord[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const hitByKey = new Map(hits.map((hit) => [pulseHitKey(hit), hit]));
  const activeHit = hits.at(-1);
  const activeKey = activeHit ? pulseHitKey(activeHit) : "";
  const nodes = graphNodes.map((record) => {
    const base = withoutCurrentPulse(record);
    const hit = hitByKey.get(graphNodePulseKey(base));
    if (!hit) return base;
    const next = {
      ...base,
      pulseRole: hit.pathRole,
      pulseScore: hit.score,
    };
    return activeKey === graphNodePulseKey(base) ? withPulseActive(next, { transitKey: activeKey }) : next;
  });
  const edges = graphEdges.map((record) => {
    const base = withoutCurrentPulse(record);
    const relationHit = graphEdgePulseKeys(base).flatMap((key) => hitByKey.get(key) ?? []);
    if (relationHit[0]) {
      const next = {
        ...base,
        pulseRole: relationHit[0].pathRole,
        pulseScore: relationHit[0].score,
      };
      const travel = activeEdgeState(next, hits);
      return travel.active || graphEdgePulseKeys(base).includes(activeKey)
        ? withPulseActive(next, { reverse: travel.reverse, transitKey: travel.transitKey || activeKey })
        : next;
    }
    if (base.edgeType === "evidence" && hitByKey.has(`node:${base.source}`) && hitByKey.has(`chunk:${base.target}`)) {
      const next = { ...base, pulseRole: "expanded" as const, pulseScore: 0.32 };
      const travel = activeEdgeState(next, hits);
      return travel.active || activeKey === `chunk:${base.target}`
        ? withPulseActive(next, { reverse: travel.reverse, transitKey: travel.transitKey || activeKey })
        : next;
    }
    return base;
  });
  return { nodes, edges };
}

function nodeSortKey(record: GraphNode): string {
  if (record.nodeType === "abstract") return `${record.data.level}:${record.data.title}:${record.id}`;
  return `3:${record.data.ordinal}:${record.id}`;
}

function createLayerMap(records: GraphNode[], links: LayoutLink[]): Map<string, number> {
  const layerById = new Map(records.map((record) => [record.id, 0]));
  const remaining = new Set(layerById.keys());
  const outgoing = new Map<string, LayoutLink[]>();
  const indegree = new Map(records.map((record) => [record.id, 0]));

  for (const link of links) {
    if (!layerById.has(link.source) || !layerById.has(link.target) || link.source === link.target) continue;
    const adjacent = outgoing.get(link.source) ?? [];
    adjacent.push(link);
    outgoing.set(link.source, adjacent);
    indegree.set(link.target, (indegree.get(link.target) ?? 0) + 1);
  }

  while (remaining.size > 0) {
    let candidates = [...remaining].filter((id) => (indegree.get(id) ?? 0) === 0);
    if (candidates.length === 0) {
      candidates = [[...remaining].sort((left, right) =>
        (outgoing.get(right)?.length ?? 0) - (outgoing.get(left)?.length ?? 0) || left.localeCompare(right),
      )[0]!];
    }
    candidates.sort();
    for (const id of candidates) {
      if (!remaining.delete(id)) continue;
      for (const link of outgoing.get(id) ?? []) {
        if (remaining.has(link.target)) {
          layerById.set(link.target, Math.max(layerById.get(link.target) ?? 0, (layerById.get(id) ?? 0) + 1));
          indegree.set(link.target, (indegree.get(link.target) ?? 0) - 1);
        }
      }
    }
  }

  return layerById;
}

function orderLayers(records: GraphNode[], links: LayoutLink[], layerById: Map<string, number>): GraphNode[][] {
  const layers: GraphNode[][] = [];
  for (const record of records) {
    const layer = layerById.get(record.id) ?? 0;
    (layers[layer] ??= []).push(record);
  }
  layers.forEach((layer) => layer.sort((left, right) => nodeSortKey(left).localeCompare(nodeSortKey(right), "zh-CN")));

  const neighborRanks = (nodes: GraphNode[], reference: Map<string, number>, direction: "incoming" | "outgoing") => {
    const previousRank = new Map(nodes.map((node, index) => [node.id, index]));
    nodes.sort((left, right) => {
      const barycenter = (id: string) => {
        const neighbors = links.flatMap((link) =>
          direction === "incoming" && link.target === id && reference.has(link.source) ? [reference.get(link.source)!]
            : direction === "outgoing" && link.source === id && reference.has(link.target) ? [reference.get(link.target)!]
              : [],
        );
        return neighbors.length > 0
          ? neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length
          : (previousRank.get(id) ?? 0);
      };
      return barycenter(left.id) - barycenter(right.id) || (previousRank.get(left.id) ?? 0) - (previousRank.get(right.id) ?? 0);
    });
  };

  for (let iteration = 0; iteration < 5; iteration += 1) {
    for (let layer = 1; layer < layers.length; layer += 1) {
      orderLayersByReference(layers[layer]!, layers[layer - 1]!, neighborRanks, "incoming");
    }
    for (let layer = layers.length - 2; layer >= 0; layer -= 1) {
      orderLayersByReference(layers[layer]!, layers[layer + 1]!, neighborRanks, "outgoing");
    }
  }
  return layers;
}

function orderLayersByReference(
  current: GraphNode[],
  referenceNodes: GraphNode[],
  sortNodes: (nodes: GraphNode[], reference: Map<string, number>, direction: "incoming" | "outgoing") => void,
  direction: "incoming" | "outgoing",
): void {
  sortNodes(current, new Map(referenceNodes.map((node, index) => [node.id, index])), direction);
}

function visualNodes(
  records: GraphNode[],
  positions: Map<string, { x: number; y: number }>,
  direction?: "horizontal" | "vertical",
  activeAspect?: AspectKind,
  pulseMode: PulseLayerMode = "normal",
  searchFocus?: SearchFocus,
): VisualNode[] {
  return records.map((record) => {
    const point = positions.get(record.id);
    const title = record.nodeType === "abstract"
      ? record.data.title
      : `${record.data.pageNumber ? `P${record.data.pageNumber} ` : ""}${record.data.text.slice(0, 36)}`;
    const searchMatched = record.nodeType === "chunk" && searchFocus?.matchIds.has(record.id);
    const label = record.nodeType === "abstract" && record.focusRole === "match" && activeAspect
      ? <div className="flow-label"><span>{title}</span><small className="flow-aspect-tag">{aspectLabels[activeAspect]}</small></div>
      : searchMatched
        ? <div className="flow-label"><span>{title}</span><small className="flow-search-tag">{record.id === searchFocus?.activeId ? "已定位" : "搜索命中"}</small></div>
        : title;
    return {
      id: record.id,
      position: { x: point?.x ?? 0, y: point?.y ?? 0 },
      ...(direction === "horizontal" ? { sourcePosition: Position.Right, targetPosition: Position.Left } : {}),
      ...(direction === "vertical" ? { sourcePosition: Position.Bottom, targetPosition: Position.Top } : {}),
      data: { label, entity: record },
      className: [
        record.nodeType === "chunk" ? "flow-chunk" : record.data.level === 2 ? "flow-theme" : `flow-${record.data.kind}`,
        record.focusRole === "match" ? "flow-aspect-match" : record.focusRole ? "flow-context" : "",
        searchMatched ? "flow-search-match" : "",
        record.nodeType === "chunk" && record.id === searchFocus?.activeId ? "flow-search-active" : "",
        pulseTraceClass(record, pulseMode),
        pulseMode === "current" && isPulseActive(record) ? "flow-pulse-active" : "",
      ].filter(Boolean).join(" "),
      style: {
        width: record.nodeType === "chunk" ? 250 : record.data.level === 2 ? 245 : 210,
        border: "none",
        borderRadius: record.nodeType === "chunk" ? 10 : record.data.level === 2 ? 15 : 28,
      },
    };
  });
}

function layeredLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind, pulseMode?: PulseLayerMode, searchFocus?: SearchFocus): VisualNode[] {
  const links: LayoutLink[] = graphEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));
  const layers = orderLayers(records, links, createLayerMap(records, links));
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, layerIndex) => {
    const rowGap = layer.some((record) => record.nodeType === "chunk") ? 148 : 168;
    layer.forEach((record, rowIndex) => {
      positions.set(record.id, {
        x: layerIndex * 330,
        y: 280 + (rowIndex - ((layer.length - 1) / 2)) * rowGap,
      });
    });
  });
  return visualNodes(records, positions, "horizontal", activeAspect, pulseMode, searchFocus);
}

function treeLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind, pulseMode?: PulseLayerMode, searchFocus?: SearchFocus): VisualNode[] {
  const links: LayoutLink[] = graphEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));
  const layers = orderLayers(records, links, createLayerMap(records, links));
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, layerIndex) => {
    const columnGap = layer.some((record) => record.nodeType === "chunk") ? 300 : 270;
    layer.forEach((record, columnIndex) => {
      positions.set(record.id, {
        x: 380 + (columnIndex - ((layer.length - 1) / 2)) * columnGap,
        y: layerIndex * 180,
      });
    });
  });
  return visualNodes(records, positions, "vertical", activeAspect, pulseMode, searchFocus);
}

function networkLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind, pulseMode?: PulseLayerMode, searchFocus?: SearchFocus): VisualNode[] {
  const positions: PositionedNode[] = records.map((record) => ({ id: record.id }));
  const links = graphEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    kind: edge.edgeType,
  }));
  const byId = new Map(records.map((record) => [record.id, record]));
  const simulation = forceSimulation(positions)
    .force("charge", forceManyBody().strength(-1180).distanceMax(980))
    .force("collide", forceCollide<PositionedNode>().radius((position) => {
      const record = byId.get(position.id);
      return record?.nodeType === "chunk" ? 168 : record?.nodeType === "abstract" && record.data.level === 2 ? 175 : 148;
    }).strength(1).iterations(3))
    .force("link", forceLink<PositionedNode, { source: string; target: string; kind: GraphEdge["edgeType"] }>(links)
      .id((record) => record.id)
      .distance((link) => link.kind === "evidence" ? 245 : link.kind === "membership" ? 255 : 310)
      .strength((link) => link.kind === "evidence" ? 0.34 : link.kind === "membership" ? 0.42 : 0.65))
    .force("center", forceCenter(420, 340))
    .stop();
  for (let index = 0; index < 300; index += 1) simulation.tick();
  return visualNodes(records, new Map(positions.map((position) => [position.id, {
    x: position.x ?? 0,
    y: position.y ?? 0,
  }])), undefined, activeAspect, pulseMode, searchFocus);
}

function layoutNodes(
  records: GraphNode[],
  graphEdges: GraphEdge[],
  layout: LayoutMode,
  activeAspect?: AspectKind,
  pulseMode?: PulseLayerMode,
  searchFocus?: SearchFocus,
): VisualNode[] {
  if (layout === "network") return networkLayout(records, graphEdges, activeAspect, pulseMode, searchFocus);
  return layout === "tree"
    ? treeLayout(records, graphEdges, activeAspect, pulseMode, searchFocus)
    : layeredLayout(records, graphEdges, activeAspect, pulseMode, searchFocus);
}

function searchFocusFrom(results: SearchResult[], activeId?: string): SearchFocus {
  const focus: SearchFocus = { matchIds: new Set(results.map((result) => result.chunk.id)) };
  if (activeId) focus.activeId = activeId;
  return focus;
}

function includeSearchChunks(nodes: GraphNode[], results: SearchResult[]): GraphNode[] {
  if (results.length === 0) return nodes;
  const seen = new Set(nodes.map((node) => node.id));
  const extras = results.flatMap((result): GraphNode[] => {
    if (seen.has(result.chunk.id)) return [];
    seen.add(result.chunk.id);
    return [{ id: result.chunk.id, nodeType: "chunk", data: result.chunk }];
  });
  return extras.length === 0 ? nodes : [...nodes, ...extras];
}

function chunkSearchTitle(chunk: SearchResult["chunk"]): string {
  return chunk.headingPath ?? `片段 ${chunk.ordinal + 1}`;
}

function chunkSearchExcerpt(chunk: SearchResult["chunk"]): string {
  return chunk.text.replace(/\s+/g, " ").trim().slice(0, 86);
}

function displayEdges(records: GraphEdge[], layout: LayoutMode, pulseMode: PulseLayerMode = "normal"): VisualEdge[] {
  return records.map((record) => {
    const status = record.relation?.status;
    const baseStroke = record.edgeType === "evidence" ? "#56627c" : record.edgeType === "membership" ? "#557d85" : relationColor(status ?? "manual");
    const pulseClass = pulseTraceClass(record, pulseMode);
    const active = pulseMode === "current" && isPulseActive(record);
    const edge: VisualEdge = {
      id: record.id,
      source: record.source,
      target: record.target,
      type: active ? layout === "network" ? "pulseBezier" : "pulseSmoothStep" : layout === "network" ? "default" : "smoothstep",
      data: { entity: record },
      animated: status === "suggested",
      ...(active ? { className: "flow-pulse-active-edge" } : {}),
      style: {
        stroke: pulseTraceColor(record, pulseMode, baseStroke),
        strokeWidth: active ? 4.8 : record.pulseRole ? 3.5 : record.pulseStats ? 3 : record.aggregate ? 2.8 : record.edgeType === "evidence" ? 1.5 : 2,
        opacity: pulseClass === "flow-pulse-muted" ? 0.22 : 1,
        ...(active ? { filter: "drop-shadow(0 0 7px #f8d26a)" } : {}),
        ...(!active && (status === "suggested" || record.edgeType !== "relation") ? { strokeDasharray: "5 4" } : {}),
      },
      labelStyle: { fill: "#b5c5dd", fontSize: 12, fontWeight: 600 },
    };
    if (record.aggregate) {
      edge.label = `${record.aggregate.type} (${record.aggregate.count})`;
      edge.markerEnd = { type: MarkerType.ArrowClosed };
    } else if (record.edgeType === "relation") {
      edge.label = record.relation?.type ?? "relation";
      edge.markerEnd = { type: MarkerType.ArrowClosed };
    }
    return edge;
  });
}

export function GraphWorkspace({
  libraryId,
  refreshKey,
  onError,
  onOpenCitation,
}: {
  libraryId: string;
  refreshKey: number;
  onError: (message: string) => void;
  onOpenCitation: (citation: Citation) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<VisualNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<VisualEdge>([]);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<VisualNode, VisualEdge>>();
  const [records, setRecords] = useState<GraphNode[]>([]);
  const [edgeRecords, setEdgeRecords] = useState<GraphEdge[]>([]);
  const [aspectFilter, setAspectFilter] = useState<GraphResponse["aspectFilter"]>();
  const [selected, setSelected] = useState<GraphNode>();
  const [selectedRelation, setSelectedRelation] = useState<Relation>();
  const [selectedAggregate, setSelectedAggregate] = useState<GraphEdge["aggregate"]>();
  const [view, setView] = useState<GraphView>("detail");
  const [layout, setLayout] = useState<LayoutMode>("layered");
  const [focusedNodeId, setFocusedNodeId] = useState<string>();
  const [status, setStatus] = useState<RelationStatus | "">("");
  const [type, setType] = useState<RelationType | "">("");
  const [aspect, setAspect] = useState<AspectKind | "">("");
  const [manualType, setManualType] = useState<RelationType>("related_to");
  const [manualReason, setManualReason] = useState("用户手动建立的关联");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeSearchChunkId, setActiveSearchChunkId] = useState<string>();
  const [pulseQuestion, setPulseQuestion] = useState("");
  const [pulseInputMode, setPulseInputMode] = useState<PulseInputMode>("full");
  const [pulseHistory, setPulseHistory] = useState<Pulse[]>([]);
  const [currentPulse, setCurrentPulse] = useState<PulseResponse>();
  const [pulseMode, setPulseMode] = useState<PulseLayerMode>("normal");
  const [pulseRevealCount, setPulseRevealCount] = useState(0);
  const [pulsePlaying, setPulsePlaying] = useState(false);
  const [pulsing, setPulsing] = useState(false);
  const [pulseStreamMessage, setPulseStreamMessage] = useState("");
  const [pulseStreamHits, setPulseStreamHits] = useState<PulseStreamHitRecord[]>([]);
  const [pulseNavigationEvents, setPulseNavigationEvents] = useState<PulseNavigationEvent[]>([]);
  const [pulseDraftAnswer, setPulseDraftAnswer] = useState("");
  const activeLibraryIdRef = useRef(libraryId);
  const graphRequestSeqRef = useRef(0);
  const pendingFocusNodeIdRef = useRef<string | undefined>(undefined);
  activeLibraryIdRef.current = libraryId;
  const visibleCurrentPulse = currentPulse?.pulse.libraryId === libraryId ? currentPulse : undefined;
  const activePulseHistory = useMemo(
    () => pulseHistory.filter((pulse) => pulse.libraryId === libraryId),
    [pulseHistory, libraryId],
  );
  const currentPulseHits = useMemo(() => orderedPulseHits(visibleCurrentPulse), [visibleCurrentPulse]);
  const currentPulsePlaybackSteps = useMemo(
    () => pulsePlaybackSteps(currentPulseHits, visibleCurrentPulse?.graph.edges ?? []),
    [currentPulseHits, visibleCurrentPulse?.graph.edges],
  );
  const currentPulsePlaybackStep = currentPulsePlaybackSteps[Math.max(0, Math.min(pulseRevealCount, currentPulsePlaybackSteps.length) - 1)];
  const currentPulseStep = currentPulsePlaybackStep?.kind === "hit" ? currentPulsePlaybackStep.hit : undefined;
  const revealedPulseTargets = useMemo(
    () => new Set(currentPulsePlaybackSteps.slice(0, pulseRevealCount).flatMap((step) => step.kind === "hit" ? [pulseHitKey(step.hit)] : [])),
    [currentPulsePlaybackSteps, pulseRevealCount],
  );
  const searchFocus = useMemo(() => searchFocusFrom(results, activeSearchChunkId), [results, activeSearchChunkId]);

  const applyGraph = (
    graph: GraphResponse,
    nextLayout = layout,
    nextPulseMode = pulseMode,
    nextRevealCount = pulseRevealCount,
    nextPulse = visibleCurrentPulse,
    nextSearchResults = results,
    nextActiveSearchChunkId = activeSearchChunkId,
  ) => {
    const graphNodes = includeSearchChunks(graph.nodes, nextSearchResults);
    const visibleGraph = revealPulseGraph(graphNodes, graph.edges, nextPulseMode, nextPulse, nextRevealCount);
    const nextSearchFocus = searchFocusFrom(nextSearchResults, nextActiveSearchChunkId);
    setRecords(graphNodes);
    setEdgeRecords(graph.edges);
    setAspectFilter(graph.aspectFilter);
    setSelected((current) => current ? graphNodes.find((node) => node.id === current.id) : undefined);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, nextLayout, aspect || undefined, nextPulseMode, nextSearchFocus));
    setEdges(displayEdges(visibleGraph.edges, nextLayout, nextPulseMode));
  };

  const loadGraph = async (
    centerId?: string,
    includeChunks = false,
    requestedView = view,
    nextSearchResults = results,
    nextActiveSearchChunkId = activeSearchChunkId,
  ) => {
    const requestLibraryId = libraryId;
    const requestSeq = graphRequestSeqRef.current + 1;
    graphRequestSeqRef.current = requestSeq;
    try {
      const graph = await api.graph(requestLibraryId, {
        ...(centerId ? { centerId } : {}),
        includeChunks,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        ...(aspect ? { aspect } : {}),
        ...(pulseMode === "current" && visibleCurrentPulse ? { pulseId: visibleCurrentPulse.pulse.id } : {}),
        pulseStats: pulseMode !== "normal",
        view: requestedView,
      });
      if (activeLibraryIdRef.current !== requestLibraryId || graphRequestSeqRef.current !== requestSeq) return undefined;
      applyGraph(graph, layout, pulseMode, pulseRevealCount, visibleCurrentPulse, nextSearchResults, nextActiveSearchChunkId);
      return graph;
    } catch (cause) {
      if (activeLibraryIdRef.current !== requestLibraryId || graphRequestSeqRef.current !== requestSeq) return undefined;
      onError((cause as Error).message);
      return undefined;
    }
  };

  useEffect(() => {
    if (!flowInstance || records.length === 0) return;
    const focusNodeId = pendingFocusNodeIdRef.current;
    window.requestAnimationFrame(() => {
      if (focusNodeId) {
        pendingFocusNodeIdRef.current = undefined;
        void flowInstance.fitView({
          nodes: [{ id: focusNodeId }],
          padding: 0.34,
          minZoom: 0.55,
          maxZoom: 1.35,
          duration: 420,
        });
        return;
      }
      void flowInstance.fitView({ padding: 0.16, minZoom: 0.35, maxZoom: 1.18 });
    });
  }, [flowInstance, records, layout]);

  useEffect(() => {
    if (pulseMode !== "current" || !visibleCurrentPulse || !pulsePlaying) return;
    if (pulseRevealCount >= currentPulsePlaybackSteps.length) {
      setPulsePlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setPulseRevealCount((count) => Math.min(count + 1, currentPulsePlaybackSteps.length));
    }, pulseRevealCount === 0 ? pulseInitialRevealDelayMs : pulseRevealDelayMs);
    return () => window.clearTimeout(timer);
  }, [pulseMode, visibleCurrentPulse?.pulse.id, pulsePlaying, pulseRevealCount, currentPulsePlaybackSteps.length]);

  useEffect(() => {
    if (records.length === 0) return;
    const visibleGraph = revealPulseGraph(records, edgeRecords, pulseMode, visibleCurrentPulse, pulseRevealCount);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, layout, aspect || undefined, pulseMode, searchFocus));
    setEdges(displayEdges(visibleGraph.edges, layout, pulseMode));
  }, [pulseMode, pulseRevealCount, visibleCurrentPulse?.pulse.id, records, edgeRecords, layout, aspect, searchFocus]);

  useEffect(() => {
    if (!pulsing || visibleCurrentPulse || pulseStreamHits.length === 0 || records.length === 0) return;
    const visibleGraph = decoratePulseStreamGraph(records, edgeRecords, pulseStreamHits);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, layout, aspect || undefined, "current", searchFocus));
    setEdges(displayEdges(visibleGraph.edges, layout, "current"));
  }, [pulsing, visibleCurrentPulse?.pulse.id, pulseStreamHits, records, edgeRecords, layout, aspect, searchFocus]);

  useEffect(() => {
    const requestLibraryId = libraryId;
    let cancelled = false;
    setCurrentPulse(undefined);
    setPulseHistory([]);
    setPulseQuestion("");
    setPulseMode("normal");
    setPulseRevealCount(0);
    setPulsePlaying(false);
    setPulsing(false);
    setPulseStreamMessage("");
    setPulseStreamHits([]);
    setPulseNavigationEvents([]);
    setPulseDraftAnswer("");
    setFocusedNodeId(undefined);
    setSelected(undefined);
    setSelectedRelation(undefined);
    setSelectedAggregate(undefined);
    setResults([]);
    setActiveSearchChunkId(undefined);
    setRecords([]);
    setEdgeRecords([]);
    setAspectFilter(undefined);
    setNodes([]);
    setEdges([]);
    void api.pulses(requestLibraryId)
      .then((history) => {
        if (cancelled || activeLibraryIdRef.current !== requestLibraryId) return;
        setPulseHistory(history.filter((pulse) => pulse.libraryId === requestLibraryId));
      })
      .catch((cause: Error) => {
        if (cancelled || activeLibraryIdRef.current !== requestLibraryId) return;
        onError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, refreshKey]);

  useEffect(() => {
    setSelected(undefined);
    setSelectedRelation(undefined);
    setSelectedAggregate(undefined);
    setResults([]);
    setActiveSearchChunkId(undefined);
    void loadGraph(focusedNodeId, view === "detail" && selected?.nodeType === "abstract" && selected.data.level === 1, view, [], undefined);
  }, [libraryId, refreshKey, status, type, aspect, view, focusedNodeId, pulseMode, visibleCurrentPulse?.pulse.id]);

  const suggested = useMemo(
    () => edges.flatMap((edge) => edge.data?.entity.relation?.status === "suggested" ? [edge.data.entity.relation] : []),
    [edges],
  );
  const titles = useMemo(
    () => new Map(records.flatMap((node) => node.nodeType === "abstract" ? [[node.id, node.data.title]] : [])),
    [records],
  );

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    const requestLibraryId = libraryId;
    try {
      const nextResults = await api.search(requestLibraryId, trimmed);
      if (activeLibraryIdRef.current !== requestLibraryId) return;
      setResults(nextResults);
      setActiveSearchChunkId(undefined);
      await loadGraph(undefined, true, view, nextResults, undefined);
    } catch (cause) {
      if (activeLibraryIdRef.current !== requestLibraryId) return;
      onError((cause as Error).message);
    }
  };

  const openSearchResult = async (result: SearchResult) => {
    const chunkNode: GraphNode = { id: result.chunk.id, nodeType: "chunk", data: result.chunk };
    setActiveSearchChunkId(result.chunk.id);
    setSelected(chunkNode);
    setSelectedRelation(undefined);
    setSelectedAggregate(undefined);
    pendingFocusNodeIdRef.current = result.chunk.id;
    const graph = await loadGraph(result.chunk.id, true, view, results, result.chunk.id);
    if (!graph) pendingFocusNodeIdRef.current = undefined;
  };

  const runPulse = async (event: FormEvent) => {
    event.preventDefault();
    if (!pulseQuestion.trim() || pulsing) return;
    const requestLibraryId = libraryId;
    const question = pulseQuestion.trim();
    setPulsing(true);
    setCurrentPulse(undefined);
    setPulseMode("normal");
    setPulseRevealCount(0);
    setPulsePlaying(false);
    setPulseStreamMessage("正在启动脉冲...");
    setPulseStreamHits([]);
    setPulseNavigationEvents([]);
    setPulseDraftAnswer("");
    try {
      await api.streamPulse(requestLibraryId, question, pulseInputMode, (update) => {
        if (activeLibraryIdRef.current !== requestLibraryId) return;
        if (update.type === "start") {
          setPulseStreamMessage(update.mode === "progressive" ? "正在渐进式点亮图谱..." : "正在全量召回图谱...");
          return;
        }
        if (update.type === "stage") {
          setPulseStreamMessage(update.message);
          return;
        }
        if (update.type === "hit") {
          setPulseStreamHits((hits) => {
            const key = pulseHitKey(update.hit);
            const existing = hits.findIndex((hit) => pulseHitKey(hit) === key);
            const next = existing >= 0 ? [...hits.slice(0, existing), update.hit, ...hits.slice(existing + 1)] : [...hits, update.hit];
            return next;
          });
          return;
        }
        if (update.type === "candidates" || update.type === "decision" || update.type === "backtrack") {
          setPulseNavigationEvents((events) => [...events, update].slice(-18));
          if (update.type === "candidates") {
            setPulseStreamMessage(`模型看到 ${update.candidates.length} 个候选节点，正在选择下一步...`);
          } else if (update.type === "decision") {
            setPulseStreamMessage(`模型选择了 ${update.selected.map((candidate) => candidate.label).join("、") || "无有效节点"}。`);
          } else {
            setPulseStreamMessage(update.toLabel ? `走到死胡同，回退到 ${update.toLabel}` : "当前路径走到死胡同。");
          }
          return;
        }
        if (update.type === "answer") {
          setPulseDraftAnswer(update.answer);
          setPulseStreamMessage("回答已生成，正在写入脉冲记录...");
          return;
        }
        if (update.type === "done") {
          const response = update.response;
          if (response.pulse.libraryId !== requestLibraryId) return;
          setCurrentPulse(response);
          setPulseHistory((history) => [
            response.pulse,
            ...history.filter((pulse) => pulse.libraryId === requestLibraryId && pulse.id !== response.pulse.id),
          ]);
          setPulseMode("current");
          setPulseRevealCount(0);
          setPulsePlaying(true);
          setPulseStreamMessage("");
          setPulseStreamHits([]);
          setPulseNavigationEvents([]);
          setPulseDraftAnswer("");
          applyGraph(response.graph, layout, "current", 0, response);
          return;
        }
        if (update.type === "error") throw new Error(update.message);
      });
    } catch (cause) {
      if (activeLibraryIdRef.current !== requestLibraryId) return;
      onError((cause as Error).message);
    } finally {
      if (activeLibraryIdRef.current === requestLibraryId) setPulsing(false);
    }
  };

  const loadPulse = async (pulseId: string) => {
    if (!pulseId) {
      setCurrentPulse(undefined);
      setPulseMode("normal");
      setPulseStreamMessage("");
      setPulseStreamHits([]);
      setPulseNavigationEvents([]);
      setPulseDraftAnswer("");
      return;
    }
    const requestLibraryId = libraryId;
    try {
      const response = await api.pulse(requestLibraryId, pulseId);
      if (activeLibraryIdRef.current !== requestLibraryId || response.pulse.libraryId !== requestLibraryId) return;
      setCurrentPulse(response);
      setPulseStreamMessage("");
      setPulseStreamHits([]);
      setPulseNavigationEvents([]);
      setPulseDraftAnswer("");
      setPulseQuestion(response.pulse.question);
      setPulseInputMode(response.pulse.inputMode);
      setPulseMode("current");
      setPulseRevealCount(0);
      setPulsePlaying(true);
      applyGraph(response.graph, layout, "current", 0, response);
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const clearPulseHistory = async () => {
    if (pulsing || activePulseHistory.length === 0) return;
    const requestLibraryId = libraryId;
    try {
      await api.clearPulses(requestLibraryId);
      if (activeLibraryIdRef.current !== requestLibraryId) return;
      setPulseHistory([]);
      setCurrentPulse(undefined);
      setPulseMode("normal");
      setPulseRevealCount(0);
      setPulsePlaying(false);
      const graph = await api.graph(requestLibraryId, {
        ...(focusedNodeId ? { centerId: focusedNodeId } : {}),
        includeChunks: view === "detail" && selected?.nodeType === "abstract" && selected.data.level === 1,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        ...(aspect ? { aspect } : {}),
        view,
      });
      if (activeLibraryIdRef.current !== requestLibraryId) return;
      applyGraph(graph, layout, "normal", 0, undefined);
    } catch (cause) {
      if (activeLibraryIdRef.current !== requestLibraryId) return;
      onError((cause as Error).message);
    }
  };

  const reviewPulse = async (status: "correct" | "wrong") => {
    if (!visibleCurrentPulse) return;
    const requestLibraryId = visibleCurrentPulse.pulse.libraryId;
    try {
      const response = await api.reviewPulse(visibleCurrentPulse.pulse.id, status);
      if (activeLibraryIdRef.current !== requestLibraryId || response.pulse.libraryId !== requestLibraryId) return;
      setCurrentPulse(response);
      setPulseHistory((history) => history.map((pulse) => pulse.id === response.pulse.id && pulse.libraryId === requestLibraryId ? response.pulse : pulse));
      const nextMode = pulseMode === "normal" ? "current" : pulseMode;
      const nextRevealCount = nextMode === "current"
        ? pulsePlaybackSteps(orderedPulseHits(response), response.graph.edges).length
        : pulseRevealCount;
      setPulseRevealCount(nextRevealCount);
      setPulsePlaying(false);
      applyGraph(response.graph, layout, nextMode, nextRevealCount, response);
    } catch (cause) {
      if (activeLibraryIdRef.current !== requestLibraryId) return;
      onError((cause as Error).message);
    }
  };

  const review = async (relation: Relation, nextStatus: "accepted" | "rejected") => {
    try {
      await api.reviewRelation(relation.id, nextStatus);
      await loadGraph(selected?.id, selected?.nodeType === "abstract", "detail");
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const onConnect = async (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const source = records.find((record) => record.id === connection.source);
    const target = records.find((record) => record.id === connection.target);
    if (source?.nodeType !== "abstract" || target?.nodeType !== "abstract") {
      onError("人工关系只能建立在概念或命题节点之间");
      return;
    }
    try {
      await api.createRelation(libraryId, {
        sourceNodeId: source.id,
        targetNodeId: target.id,
        type: manualType,
        reason: manualReason,
      });
      await loadGraph();
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const changeLayout = (nextLayout: LayoutMode) => {
    setLayout(nextLayout);
    const visibleGraph = revealPulseGraph(records, edgeRecords, pulseMode, visibleCurrentPulse, pulseRevealCount);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, nextLayout, aspect || undefined, pulseMode, searchFocus));
    setEdges(displayEdges(visibleGraph.edges, nextLayout, pulseMode));
  };

  const changePulseMode = (nextMode: PulseLayerMode) => {
    setPulseMode(nextMode);
    if (nextMode === "current" && visibleCurrentPulse) {
      setPulseRevealCount(0);
      setPulsePlaying(true);
    } else {
      setPulseRevealCount(currentPulsePlaybackSteps.length);
      setPulsePlaying(false);
    }
  };

  const openPulseHit = (hit: PulseResponse["hits"][number]) => {
    if (hit.targetType === "relation") {
      const edge = edgeRecords.find((record) => record.relation?.id === hit.targetId || record.aggregate?.relationIds.includes(hit.targetId));
      setSelected(undefined);
      setSelectedRelation(edge?.relation);
      setSelectedAggregate(edge?.aggregate);
      return;
    }
    const node = records.find((record) => record.id === hit.targetId);
    if (node) {
      setSelected(node);
      setSelectedRelation(undefined);
      setSelectedAggregate(undefined);
    }
  };

  return (
    <section className="graph-panel card">
      <div className="graph-toolbar">
        <div className="toolbar-group toolbar-search">
          <span className="toolbar-label">检索</span>
          <form onSubmit={(event) => void search(event)}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="模糊搜索 chunk 名称/内容..." />
            <button type="submit">搜索</button>
          </form>
        </div>
        <div className="toolbar-group">
          <span className="toolbar-label">筛选</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as RelationStatus | "")}>
            <option value="">可见关系</option>
            {relationStatuses.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={type} onChange={(event) => setType(event.target.value as RelationType | "")}>
            <option value="">所有类型</option>
            {relationTypes.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className="aspect-filter" value={aspect} onChange={(event) => setAspect(event.target.value as AspectKind | "")}>
            <option value="">全部切面</option>
            {aspectKinds.map((item) => <option key={item} value={item}>{aspectLabels[item]}</option>)}
          </select>
        </div>
        <div className="toolbar-group toolbar-right">
          <span className="toolbar-label">视图</span>
          <div className="graph-depth" aria-label="图谱层级">
            <button className={view === "overview" ? "selected" : ""} onClick={() => { setFocusedNodeId(undefined); setView("overview"); }}>概览</button>
            <button className={view === "detail" ? "selected" : ""} onClick={() => { setFocusedNodeId(undefined); setView("detail"); }}>细节</button>
          </div>
        </div>
      </div>
      <div className="pulse-toolbar">
        <div className="toolbar-group pulse-query">
          <span className="toolbar-label">脉冲</span>
          <form onSubmit={(event) => void runPulse(event)}>
            <input value={pulseQuestion} onChange={(event) => setPulseQuestion(event.target.value)} placeholder="向图谱发起问题..." />
            <select value={pulseInputMode} onChange={(event) => setPulseInputMode(event.target.value as PulseInputMode)}>
              <option value="full">全量输入</option>
              <option value="progressive">渐进输入</option>
            </select>
            <button type="submit" disabled={pulsing}>{pulsing ? "脉冲中" : "脉冲"}</button>
          </form>
        </div>
        <div className="toolbar-group pulse-history-group">
          <span className="toolbar-label">诊断层</span>
          <select value={visibleCurrentPulse?.pulse.id ?? ""} onChange={(event) => void loadPulse(event.target.value)}>
            <option value="">历史脉冲</option>
            {activePulseHistory.map((pulse) => (
              <option key={pulse.id} value={pulse.id}>
                {pulse.status === "correct" ? "正确" : pulse.status === "wrong" ? "错误" : "待判定"} · {pulse.question.slice(0, 28)}
              </option>
            ))}
          </select>
          <select value={pulseMode} onChange={(event) => changePulseMode(event.target.value as PulseLayerMode)}>
            <option value="normal">正常图谱</option>
            <option value="current">当前脉冲</option>
            <option value="stats">累计正误</option>
            <option value="wrong">仅错误路径</option>
            <option value="correct">仅正确路径</option>
          </select>
          <button
            type="button"
            className="ghost pulse-clear-history"
            disabled={pulsing || activePulseHistory.length === 0}
            onClick={() => void clearPulseHistory()}
          >
            清空
          </button>
        </div>
      </div>
      <div className="graph-body">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            edgeTypes={edgeTypes}
            onInit={setFlowInstance}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesConnectable={view === "detail"}
            onConnect={(connection) => void onConnect(connection)}
            onNodeClick={(_event, node) => {
              setSelected(node.data.entity);
              setSelectedRelation(undefined);
              setSelectedAggregate(undefined);
              if (node.data.entity.nodeType === "abstract" && node.data.entity.data.level === 2) {
                setFocusedNodeId(node.id);
                setView("detail");
              } else if (node.data.entity.nodeType === "abstract" && view === "detail") {
                setFocusedNodeId(node.id);
              }
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedRelation(edge.data?.entity.relation);
              setSelectedAggregate(edge.data?.entity.aggregate);
              setSelected(undefined);
            }}
            minZoom={0.35}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.16, minZoom: 0.82, maxZoom: 1.18 }}
          >
            <Background color="#28334c" gap={24} />
            <MiniMap nodeColor={(node) => String(node.className).includes("flow-chunk") ? "#56627c" : String(node.className).includes("flow-theme") ? "#cb9b54" : "#40bca2"} />
            <Controls className="layout-controls" position="bottom-left" showZoom={false} showFitView={false} showInteractive={false}>
              <ControlButton className={layout === "layered" ? "layout-active" : ""} onClick={() => changeLayout("layered")} title="分层布局" aria-label="分层布局">层</ControlButton>
              <ControlButton className={layout === "network" ? "layout-active" : ""} onClick={() => changeLayout("network")} title="网状布局" aria-label="网状布局">网</ControlButton>
              <ControlButton className={layout === "tree" ? "layout-active" : ""} onClick={() => changeLayout("tree")} title="树形布局" aria-label="树形布局">树</ControlButton>
            </Controls>
            <Controls />
          </ReactFlow>
          {aspect && records.length === 0 && (
            <div className="graph-empty">
              {aspectFilter?.anyLabeled
                ? `当前没有“${aspectLabels[aspect]}”切面节点。`
                : "当前资料尚未生成切面标签，请重新分析资料后再筛选。"}
            </div>
          )}
        </div>
        <aside className="inspector">
          {!visibleCurrentPulse && (pulsing || pulseStreamHits.length > 0 || pulseDraftAnswer) && (
            <div className="pulse-panel pulse-stream-panel">
              <div className="pulse-panel-heading">
                <h3>脉冲生成中</h3>
                <small>{pulseInputMode === "progressive" ? "渐进输入" : "全量输入"}</small>
              </div>
              <p className="pulse-question">{pulseQuestion}</p>
              <div className="pulse-stream-status">
                <span className="pulse-live-dot" />
                <span>{pulseStreamMessage || "正在等待首个脉冲事件..."}</span>
              </div>
              {pulseNavigationEvents.length > 0 && (
                <div className="pulse-navigation-log">
                  <strong>模型导航过程</strong>
                  {pulseNavigationEvents.slice(-6).map((event, index) => (
                    <div className={`pulse-navigation-event pulse-navigation-${event.type}`} key={`${event.type}-${event.stepIndex}-${index}`}>
                      {event.type === "candidates" && (
                        <>
                          <span>第 {event.stepIndex} 步：从 {event.fromLabels.join("、")} 看到了 {event.candidates.length} 个候选</span>
                          <small>{event.candidates.slice(0, 4).map((candidate) => `${candidate.label} ${candidate.score.toFixed(2)}`).join(" / ")}</small>
                        </>
                      )}
                      {event.type === "decision" && (
                        <>
                          <span>选择：{event.selected.map((candidate) => candidate.label).join("、") || "无有效节点"}</span>
                          <small>{event.rationale}</small>
                          {event.rejected.length > 0 && (
                            <small>未选：{event.rejected.slice(0, 3).map((candidate) => `${candidate.label}：${candidate.reason}`).join("；")}</small>
                          )}
                        </>
                      )}
                      {event.type === "backtrack" && (
                        <>
                          <span>回退：{event.fromLabel}{event.toLabel ? ` → ${event.toLabel}` : ""}</span>
                          <small>{event.reason}</small>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {pulseDraftAnswer && (
                <div className="pulse-draft-answer">
                  <strong>已生成回答草稿</strong>
                  <p>{pulseDraftAnswer}</p>
                </div>
              )}
              <div className="pulse-hit-summary">
                <span>已命中 {pulseStreamHits.length}</span>
                <span>节点 {pulseStreamHits.filter((hit) => hit.targetType === "node").length}</span>
                <span>关系 {pulseStreamHits.filter((hit) => hit.targetType === "relation").length}</span>
                <span>证据 {pulseStreamHits.filter((hit) => hit.targetType === "chunk").length}</span>
              </div>
              <div className="pulse-hits pulse-stream-hits">
                {pulseStreamHits.slice(-10).reverse().map((hit) => (
                  <button type="button" key={pulseHitKey(hit)} disabled>
                    <strong>{hit.label}</strong>
                    <span>{pulseHitReason(hit)}</span>
                    <small>{hit.pathRole} · {hit.score.toFixed(2)}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {visibleCurrentPulse && (
            <div className={`pulse-panel pulse-status-${visibleCurrentPulse.pulse.status}`}>
              <div className="pulse-panel-heading">
                <h3>脉冲回答</h3>
                <small>
                  {visibleCurrentPulse.pulse.inputMode === "progressive" ? "渐进输入" : "全量输入"} · {" "}
                  {visibleCurrentPulse.pulse.status === "correct" ? "已标记正确" : visibleCurrentPulse.pulse.status === "wrong" ? "已标记错误" : "待判定"}
                </small>
              </div>
              <p className="pulse-question">{visibleCurrentPulse.pulse.question}</p>
              <p>{visibleCurrentPulse.pulse.answer}</p>
              <small>{visibleCurrentPulse.pulse.summary}</small>
              {pulseMode === "current" && (
                <div className="pulse-playback">
                  <span>
                    动画 {Math.min(pulseRevealCount, currentPulsePlaybackSteps.length)} / {currentPulsePlaybackSteps.length}
                    {" · "}命中 {Math.min(
                      currentPulsePlaybackSteps.slice(0, pulseRevealCount).filter((step) => step.kind === "hit").length,
                      currentPulseHits.length,
                    )} / {currentPulseHits.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setPulseRevealCount(0);
                      setPulsePlaying(true);
                    }}
                  >
                    重放
                  </button>
                  <button
                    type="button"
                    onClick={() => setPulsePlaying((playing) => !playing)}
                    disabled={pulseRevealCount >= currentPulsePlaybackSteps.length}
                  >
                    {pulsePlaying ? "暂停" : "继续"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPulseRevealCount(currentPulsePlaybackSteps.length);
                      setPulsePlaying(false);
                    }}
                  >
                    全部显示
                  </button>
                </div>
              )}
              {pulseMode === "current" && (
                <div className="pulse-step-reason">
                  <strong>
                    {currentPulsePlaybackStep?.kind === "backtrack"
                      ? currentPulsePlaybackStep.label
                      : currentPulseStep ? `当前披露：${currentPulseStep.label}` : "等待披露"}
                  </strong>
                  <p>{pulsePlaybackStepExplanation(currentPulsePlaybackStep, currentPulsePlaybackSteps.length)}</p>
                  {currentPulseStep?.observation && <small>看到的信息：{currentPulseStep.observation}</small>}
                  {currentPulseStep?.rationale && <small>选择理由：{currentPulseStep.rationale}</small>}
                </div>
              )}
              <div className="pulse-review-actions">
                <button onClick={() => void reviewPulse("correct")}>回答正确</button>
                <button className="danger" onClick={() => void reviewPulse("wrong")}>回答错误</button>
              </div>
              <div className="pulse-hit-summary">
                <span>节点 {visibleCurrentPulse.hits.filter((hit) => hit.targetType === "node").length}</span>
                <span>关系 {visibleCurrentPulse.hits.filter((hit) => hit.targetType === "relation").length}</span>
                <span>证据 {visibleCurrentPulse.hits.filter((hit) => hit.targetType === "chunk").length}</span>
              </div>
              <div className="pulse-hits">
                {currentPulseHits.slice(0, 10).map((hit) => (
                  <button
                    className={pulseMode === "current" && !revealedPulseTargets.has(pulseHitKey(hit)) ? "pulse-hit-pending" : ""}
                    key={hit.id}
                    onClick={() => openPulseHit(hit)}
                  >
                    <strong>{hit.label}</strong>
                    <span>{pulseHitReason(hit)}</span>
                    <small>{hit.pathRole} · {hit.score.toFixed(2)}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {view === "detail" ? <div className="manual-edge">
            <h3>连边工具</h3>
            <select value={manualType} onChange={(event) => setManualType(event.target.value as RelationType)}>
              {relationTypes.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <input value={manualReason} onChange={(event) => setManualReason(event.target.value)} />
            <small>从一个抽象节点拖到另一个节点以创建关系。</small>
          </div> : <div className="overview-hint">
            <h3>主题概览</h3>
            <p>主题节点折叠了底层概念；聚合边括号内为底层关系数量。点击主题进入可审核细节。</p>
          </div>}
          {results.length > 0 && (
            <div className="search-results">
              <h3>搜索结果 <small>{results.length} 个，按关联度排序</small></h3>
              {results.map((result) => (
                <button
                  className={activeSearchChunkId === result.chunk.id ? "selected" : ""}
                  key={result.chunk.id}
                  onClick={() => void openSearchResult(result)}
                >
                  <span>
                    <strong>{chunkSearchTitle(result.chunk)}</strong>
                    <em>{chunkSearchExcerpt(result.chunk)}</em>
                  </span>
                  <small>{result.score.toFixed(3)}</small>
                </button>
              ))}
            </div>
          )}
          {selected && (
            <SelectedNode
              node={selected}
              onOpenCitation={onOpenCitation}
              onSaved={() => void loadGraph(selected.id, true)}
              onDeleted={() => {
                setSelected(undefined);
                void loadGraph();
              }}
              onError={onError}
            />
          )}
          {selectedRelation && (
            <div className="relation-detail">
              <h3>{selectedRelation.type}</h3>
              <p>{titles.get(selectedRelation.sourceNodeId)} → {titles.get(selectedRelation.targetNodeId)}</p>
              <p>{selectedRelation.reason}</p>
              <CitationList citations={selectedRelation.citations} onOpenCitation={onOpenCitation} />
              <div className="actions">
                {selectedRelation.status === "suggested" && <>
                  <button onClick={() => void review(selectedRelation, "accepted")}>接受</button>
                  <button className="danger" onClick={() => void review(selectedRelation, "rejected")}>拒绝</button>
                </>}
                <button className="ghost" onClick={() => void api.deleteRelation(selectedRelation.id).then(() => loadGraph()).catch((cause: Error) => onError(cause.message))}>删除</button>
              </div>
            </div>
          )}
          {selectedAggregate && (
            <div className="relation-detail">
              <h3>聚合关系：{selectedAggregate.type}</h3>
              <p>该主题连线汇总了 {selectedAggregate.count} 条底层关系。</p>
              <p className="muted">切换到细节视图查看证据并执行审核。</p>
            </div>
          )}
          <div className="suggestions">
            <div className="suggestion-header">
              <h3>待审核关系</h3>
              {suggested.length > 1 && (
                <button onClick={() => void Promise.all(suggested.map((relation) => api.reviewRelation(relation.id, "accepted"))).then(() => loadGraph())}>
                  全部接受
                </button>
              )}
            </div>
            {suggested.map((relation) => (
              <div className="suggestion" key={relation.id}>
                <strong>{relation.type}</strong>
                <span>{relation.reason}</span>
                <div>
                  <button onClick={() => void review(relation, "accepted")}>接受</button>
                  <button className="danger" onClick={() => void review(relation, "rejected")}>拒绝</button>
                </div>
              </div>
            ))}
            {suggested.length === 0 && <p className="muted">{view === "overview" ? "概览不直接审核关系，请进入主题细节。" : "当前局部图没有待审核关系。"}</p>}
          </div>
        </aside>
      </div>
    </section>
  );
}

function SelectedNode({
  node,
  onSaved,
  onDeleted,
  onError,
  onOpenCitation,
}: {
  node: GraphNode;
  onSaved: () => void;
  onDeleted: () => void;
  onError: (message: string) => void;
  onOpenCitation: (citation: Citation) => void;
}) {
  const abstract = node.nodeType === "abstract" ? node.data : undefined;
  const [title, setTitle] = useState(abstract?.title ?? "");
  const [summary, setSummary] = useState(abstract?.summary ?? "");

  useEffect(() => {
    setTitle(abstract?.title ?? "");
    setSummary(abstract?.summary ?? "");
  }, [node.id]);

  if (node.nodeType === "chunk") {
    return (
      <div className="node-detail">
        <h3>原文证据</h3>
        <small>{node.data.headingPath ?? (node.data.pageNumber ? `PDF 第 ${node.data.pageNumber} 页` : "文本片段")}</small>
        <p>{node.data.text}</p>
        <CitationList citations={[{
          versionId: node.data.versionId,
          chunkId: node.data.id,
          documentName: "原文",
          mediaType: node.data.pageNumber ? "application/pdf" : "text/plain",
          headingPath: node.data.headingPath,
          pageNumber: node.data.pageNumber,
          startLine: node.data.startLine,
          endLine: node.data.endLine,
          blockId: node.data.blockId,
          excerpt: node.data.text.slice(0, 280),
        }]} onOpenCitation={onOpenCitation} />
      </div>
    );
  }

  return (
    <form className="node-detail" onSubmit={(event) => {
      event.preventDefault();
      void api.updateNode(node.id, title, summary).then(onSaved).catch((cause: Error) => onError(cause.message));
    }}>
      <h3>{node.data.level === 2 ? "主题抽象" : node.data.kind === "claim" ? "命题" : "概念"}</h3>
      {node.data.level === 2 && <small>包含 {node.data.memberCount} 个细节节点，点击图中主题可展开。</small>}
      {node.focusRole && node.focusRole !== "match" && <small>{node.focusRole === "bridge" ? "桥接路径节点" : "关联上下文节点"}</small>}
      <AspectEditor node={node.data} onSaved={onSaved} onError={onError} />
      <input value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={4} />
      <CitationList citations={node.data.citations} onOpenCitation={onOpenCitation} />
      <div className="node-actions">
        <button type="submit">保存节点</button>
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (!window.confirm("删除该节点及其相连关系？此操作不可撤销。")) return;
            void api.deleteNode(node.id).then(onDeleted).catch((cause: Error) => onError(cause.message));
          }}
        >
          删除节点
        </button>
      </div>
    </form>
  );
}

function AspectEditor({
  node,
  onSaved,
  onError,
}: {
  node: AbstractNode;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<AspectKind[]>(node.aspects);

  useEffect(() => {
    setSelected(node.aspects);
  }, [node.id, node.aspects.join(","), node.aspectSource]);

  const toggle = (aspect: AspectKind) => {
    setSelected((current) => current.includes(aspect)
      ? current.filter((item) => item !== aspect)
      : [...current, aspect]);
  };

  return (
    <section className="aspect-editor">
      <div className="aspect-heading">
        <strong>切面标签</strong>
        {node.aspectSource === "manual" && <small>人工修正</small>}
      </div>
      <div className="aspect-options">
        {aspectKinds.map((aspect) => (
          <label key={aspect} className={selected.includes(aspect) ? "checked" : ""}>
            <input type="checkbox" checked={selected.includes(aspect)} onChange={() => toggle(aspect)} />
            {aspectLabels[aspect]}
          </label>
        ))}
      </div>
      <div className="actions">
        <button type="button" onClick={() => {
          void api.updateNodeAspects(node.id, selected).then(onSaved).catch((cause: Error) => onError(cause.message));
        }}>保存切面</button>
        {node.aspectSource === "manual" && (
          <button type="button" className="ghost" onClick={() => {
            void api.resetNodeAspects(node.id).then(onSaved).catch((cause: Error) => onError(cause.message));
          }}>恢复 AI 分类</button>
        )}
      </div>
    </section>
  );
}

function CitationList({ citations, onOpenCitation }: { citations: Citation[]; onOpenCitation: (citation: Citation) => void }) {
  if (citations.length === 0) return <p className="muted">无来源引用。</p>;
  return (
    <div className="citations">
      {citations.map((citation) => (
        <button type="button" className="citation" key={citation.chunkId} onClick={() => onOpenCitation(citation)}>
          {citation.documentName}
          {citation.pageNumber ? ` / 第 ${citation.pageNumber} 页` : citation.startLine ? ` / L${citation.startLine}-${citation.endLine}` : ""}
        </button>
      ))}
    </div>
  );
}
