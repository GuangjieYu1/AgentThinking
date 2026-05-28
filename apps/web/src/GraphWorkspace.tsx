import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Background,
  ControlButton,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
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
interface LayoutLink {
  source: string;
  target: string;
}
interface PositionedNode extends SimulationNodeDatum {
  id: string;
}

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

const pulseRoleRank = { direct: 0, bridge: 1, expanded: 2 } satisfies Record<NonNullable<GraphNode["pulseRole"]>, number>;

function sortPulseHits(left: PulseHitRecord, right: PulseHitRecord): number {
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
    for (const chunkHit of evidenceChunksByNode.get(nodeId) ?? []) append(chunkHit);
    append(byKey.get(`node:${nodeId}`));
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

function pulseHitKey(hit: PulseHitRecord): string {
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
  const { pulseScore: _pulseScore, pulseRole: _pulseRole, ...rest } = record;
  return rest as T;
}

function revealPulseGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  mode: PulseLayerMode,
  pulse: PulseResponse | undefined,
  revealCount: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (mode !== "current" || !pulse) return { nodes: graphNodes, edges: graphEdges };
  const revealed = new Set(orderedPulseHits(pulse).slice(0, revealCount).map(pulseHitKey));
  const nodes = graphNodes.map((record) =>
    record.pulseRole && !revealed.has(graphNodePulseKey(record)) ? withoutCurrentPulse(record) : record,
  );
  const edges = graphEdges.map((record) => {
    const keys = graphEdgePulseKeys(record);
    const edgeIsRevealed = keys.some((key) => revealed.has(key));
    if (record.pulseRole && !edgeIsRevealed) return withoutCurrentPulse(record);
    if (!record.pulseRole && record.edgeType === "evidence" && revealed.has(`node:${record.source}`) && revealed.has(`chunk:${record.target}`)) {
      return { ...record, pulseRole: "expanded" as const, pulseScore: 0.32 };
    }
    return record;
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
): VisualNode[] {
  return records.map((record) => {
    const point = positions.get(record.id);
    const title = record.nodeType === "abstract"
      ? record.data.title
      : `${record.data.pageNumber ? `P${record.data.pageNumber} ` : ""}${record.data.text.slice(0, 36)}`;
    const label = record.nodeType === "abstract" && record.focusRole === "match" && activeAspect
      ? <div className="flow-label"><span>{title}</span><small className="flow-aspect-tag">{aspectLabels[activeAspect]}</small></div>
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
        pulseTraceClass(record, pulseMode),
      ].filter(Boolean).join(" "),
      style: {
        width: record.nodeType === "chunk" ? 250 : record.data.level === 2 ? 245 : 210,
        border: "none",
        borderRadius: record.nodeType === "chunk" ? 10 : record.data.level === 2 ? 15 : 28,
      },
    };
  });
}

function layeredLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind, pulseMode?: PulseLayerMode): VisualNode[] {
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
  return visualNodes(records, positions, "horizontal", activeAspect, pulseMode);
}

function treeLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind, pulseMode?: PulseLayerMode): VisualNode[] {
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
  return visualNodes(records, positions, "vertical", activeAspect, pulseMode);
}

function networkLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind, pulseMode?: PulseLayerMode): VisualNode[] {
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
  }])), undefined, activeAspect, pulseMode);
}

function layoutNodes(records: GraphNode[], graphEdges: GraphEdge[], layout: LayoutMode, activeAspect?: AspectKind, pulseMode?: PulseLayerMode): VisualNode[] {
  if (layout === "network") return networkLayout(records, graphEdges, activeAspect, pulseMode);
  return layout === "tree" ? treeLayout(records, graphEdges, activeAspect, pulseMode) : layeredLayout(records, graphEdges, activeAspect, pulseMode);
}

function displayEdges(records: GraphEdge[], layout: LayoutMode, pulseMode: PulseLayerMode = "normal"): VisualEdge[] {
  return records.map((record) => {
    const status = record.relation?.status;
    const baseStroke = record.edgeType === "evidence" ? "#56627c" : record.edgeType === "membership" ? "#557d85" : relationColor(status ?? "manual");
    const pulseClass = pulseTraceClass(record, pulseMode);
    const edge: VisualEdge = {
      id: record.id,
      source: record.source,
      target: record.target,
      type: layout === "network" ? "default" : "smoothstep",
      data: { entity: record },
      animated: status === "suggested",
      style: {
        stroke: pulseTraceColor(record, pulseMode, baseStroke),
        strokeWidth: record.pulseRole ? 3.5 : record.pulseStats ? 3 : record.aggregate ? 2.8 : record.edgeType === "evidence" ? 1.5 : 2,
        opacity: pulseClass === "flow-pulse-muted" ? 0.22 : 1,
        ...(status === "suggested" || record.edgeType !== "relation" ? { strokeDasharray: "5 4" } : {}),
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
  const [pulseQuestion, setPulseQuestion] = useState("");
  const [pulseInputMode, setPulseInputMode] = useState<PulseInputMode>("full");
  const [pulseHistory, setPulseHistory] = useState<Pulse[]>([]);
  const [currentPulse, setCurrentPulse] = useState<PulseResponse>();
  const [pulseMode, setPulseMode] = useState<PulseLayerMode>("normal");
  const [pulseRevealCount, setPulseRevealCount] = useState(0);
  const [pulsePlaying, setPulsePlaying] = useState(false);
  const [pulsing, setPulsing] = useState(false);
  const currentPulseHits = useMemo(() => orderedPulseHits(currentPulse), [currentPulse]);
  const currentPulseStep = currentPulseHits[Math.max(0, Math.min(pulseRevealCount, currentPulseHits.length) - 1)];
  const revealedPulseTargets = useMemo(
    () => new Set(currentPulseHits.slice(0, pulseRevealCount).map(pulseHitKey)),
    [currentPulseHits, pulseRevealCount],
  );

  const applyGraph = (
    graph: GraphResponse,
    nextLayout = layout,
    nextPulseMode = pulseMode,
    nextRevealCount = pulseRevealCount,
    nextPulse = currentPulse,
  ) => {
    const visibleGraph = revealPulseGraph(graph.nodes, graph.edges, nextPulseMode, nextPulse, nextRevealCount);
    setRecords(graph.nodes);
    setEdgeRecords(graph.edges);
    setAspectFilter(graph.aspectFilter);
    setSelected((current) => current ? graph.nodes.find((node) => node.id === current.id) : undefined);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, nextLayout, aspect || undefined, nextPulseMode));
    setEdges(displayEdges(visibleGraph.edges, nextLayout, nextPulseMode));
  };

  const loadGraph = async (centerId?: string, includeChunks = false, requestedView = view) => {
    try {
      const graph = await api.graph(libraryId, {
        ...(centerId ? { centerId } : {}),
        includeChunks,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        ...(aspect ? { aspect } : {}),
        ...(pulseMode === "current" && currentPulse ? { pulseId: currentPulse.pulse.id } : {}),
        pulseStats: pulseMode !== "normal",
        view: requestedView,
      });
      applyGraph(graph);
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  useEffect(() => {
    if (!flowInstance || records.length === 0) return;
    window.requestAnimationFrame(() => void flowInstance.fitView({ padding: 0.16, minZoom: 0.35, maxZoom: 1.18 }));
  }, [flowInstance, records, layout]);

  useEffect(() => {
    if (pulseMode !== "current" || !currentPulse || !pulsePlaying) return;
    if (pulseRevealCount >= currentPulseHits.length) {
      setPulsePlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setPulseRevealCount((count) => Math.min(count + 1, currentPulseHits.length));
    }, pulseRevealCount === 0 ? 650 : 1500);
    return () => window.clearTimeout(timer);
  }, [pulseMode, currentPulse?.pulse.id, pulsePlaying, pulseRevealCount, currentPulseHits.length]);

  useEffect(() => {
    if (records.length === 0) return;
    const visibleGraph = revealPulseGraph(records, edgeRecords, pulseMode, currentPulse, pulseRevealCount);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, layout, aspect || undefined, pulseMode));
    setEdges(displayEdges(visibleGraph.edges, layout, pulseMode));
  }, [pulseMode, pulseRevealCount, currentPulse?.pulse.id, records, edgeRecords, layout, aspect]);

  useEffect(() => {
    setCurrentPulse(undefined);
    setPulseMode("normal");
    setPulseRevealCount(0);
    setPulsePlaying(false);
    void api.pulses(libraryId).then(setPulseHistory).catch((cause: Error) => onError(cause.message));
  }, [libraryId, refreshKey]);

  useEffect(() => {
    setSelected(undefined);
    setSelectedRelation(undefined);
    setSelectedAggregate(undefined);
    setResults([]);
    void loadGraph(focusedNodeId, view === "detail" && selected?.nodeType === "abstract" && selected.data.level === 1, view);
  }, [libraryId, refreshKey, status, type, aspect, view, focusedNodeId, pulseMode, currentPulse?.pulse.id]);

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
    if (!query.trim()) return;
    try {
      setResults(await api.search(libraryId, query));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const runPulse = async (event: FormEvent) => {
    event.preventDefault();
    if (!pulseQuestion.trim() || pulsing) return;
    setPulsing(true);
    try {
      const response = await api.createPulse(libraryId, pulseQuestion, pulseInputMode);
      setCurrentPulse(response);
      setPulseHistory((history) => [response.pulse, ...history.filter((pulse) => pulse.id !== response.pulse.id)]);
      setPulseMode("current");
      setPulseRevealCount(0);
      setPulsePlaying(true);
      applyGraph(response.graph, layout, "current", 0, response);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setPulsing(false);
    }
  };

  const loadPulse = async (pulseId: string) => {
    if (!pulseId) {
      setCurrentPulse(undefined);
      setPulseMode("normal");
      return;
    }
    try {
      const response = await api.pulse(libraryId, pulseId);
      setCurrentPulse(response);
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

  const reviewPulse = async (status: "correct" | "wrong") => {
    if (!currentPulse) return;
    try {
      const response = await api.reviewPulse(currentPulse.pulse.id, status);
      setCurrentPulse(response);
      setPulseHistory((history) => history.map((pulse) => pulse.id === response.pulse.id ? response.pulse : pulse));
      const nextMode = pulseMode === "normal" ? "current" : pulseMode;
      const nextRevealCount = nextMode === "current" ? response.hits.length : pulseRevealCount;
      setPulseRevealCount(nextRevealCount);
      setPulsePlaying(false);
      applyGraph(response.graph, layout, nextMode, nextRevealCount, response);
    } catch (cause) {
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
    const visibleGraph = revealPulseGraph(records, edgeRecords, pulseMode, currentPulse, pulseRevealCount);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, nextLayout, aspect || undefined, pulseMode));
    setEdges(displayEdges(visibleGraph.edges, nextLayout, pulseMode));
  };

  const changePulseMode = (nextMode: PulseLayerMode) => {
    setPulseMode(nextMode);
    if (nextMode === "current" && currentPulse) {
      setPulseRevealCount(0);
      setPulsePlaying(true);
    } else {
      setPulseRevealCount(currentPulseHits.length);
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
        <form onSubmit={(event) => void search(event)}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="语义搜索 chunk..." />
          <button type="submit">搜索</button>
        </form>
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
        <div className="graph-depth" aria-label="图谱层级">
          <button className={view === "overview" ? "selected" : ""} onClick={() => { setFocusedNodeId(undefined); setView("overview"); }}>概览</button>
          <button className={view === "detail" ? "selected" : ""} onClick={() => { setFocusedNodeId(undefined); setView("detail"); }}>细节</button>
        </div>
      </div>
      <div className="pulse-toolbar">
        <form onSubmit={(event) => void runPulse(event)}>
          <input value={pulseQuestion} onChange={(event) => setPulseQuestion(event.target.value)} placeholder="向图谱发起脉冲问题..." />
          <select value={pulseInputMode} onChange={(event) => setPulseInputMode(event.target.value as PulseInputMode)}>
            <option value="full">全量输入</option>
            <option value="progressive">渐进输入</option>
          </select>
          <button type="submit" disabled={pulsing}>{pulsing ? "脉冲中" : "脉冲"}</button>
        </form>
        <select value={currentPulse?.pulse.id ?? ""} onChange={(event) => void loadPulse(event.target.value)}>
          <option value="">历史脉冲</option>
          {pulseHistory.map((pulse) => (
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
      </div>
      <div className="graph-body">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
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
          {currentPulse && (
            <div className={`pulse-panel pulse-status-${currentPulse.pulse.status}`}>
              <div className="pulse-panel-heading">
                <h3>脉冲回答</h3>
                <small>
                  {currentPulse.pulse.inputMode === "progressive" ? "渐进输入" : "全量输入"} · {" "}
                  {currentPulse.pulse.status === "correct" ? "已标记正确" : currentPulse.pulse.status === "wrong" ? "已标记错误" : "待判定"}
                </small>
              </div>
              <p className="pulse-question">{currentPulse.pulse.question}</p>
              <p>{currentPulse.pulse.answer}</p>
              <small>{currentPulse.pulse.summary}</small>
              {pulseMode === "current" && (
                <div className="pulse-playback">
                  <span>披露 {Math.min(pulseRevealCount, currentPulseHits.length)} / {currentPulseHits.length}</span>
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
                    disabled={pulseRevealCount >= currentPulseHits.length}
                  >
                    {pulsePlaying ? "暂停" : "继续"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPulseRevealCount(currentPulseHits.length);
                      setPulsePlaying(false);
                    }}
                  >
                    全部显示
                  </button>
                </div>
              )}
              {pulseMode === "current" && (
                <div className="pulse-step-reason">
                  <strong>{currentPulseStep ? `当前披露：${currentPulseStep.label}` : "等待披露"}</strong>
                  <p>{pulseStepExplanation(currentPulseStep, currentPulseHits.length)}</p>
                  {currentPulseStep?.observation && <small>看到的信息：{currentPulseStep.observation}</small>}
                  {currentPulseStep?.rationale && <small>选择理由：{currentPulseStep.rationale}</small>}
                </div>
              )}
              <div className="pulse-review-actions">
                <button onClick={() => void reviewPulse("correct")}>回答正确</button>
                <button className="danger" onClick={() => void reviewPulse("wrong")}>回答错误</button>
              </div>
              <div className="pulse-hit-summary">
                <span>节点 {currentPulse.hits.filter((hit) => hit.targetType === "node").length}</span>
                <span>关系 {currentPulse.hits.filter((hit) => hit.targetType === "relation").length}</span>
                <span>证据 {currentPulse.hits.filter((hit) => hit.targetType === "chunk").length}</span>
              </div>
              <div className="pulse-hits">
                {currentPulseHits.slice(0, 10).map((hit) => (
                  <button
                    className={pulseMode === "current" && !revealedPulseTargets.has(pulseHitKey(hit)) ? "pulse-hit-pending" : ""}
                    key={hit.id}
                    onClick={() => openPulseHit(hit)}
                  >
                    <strong>{hit.label}</strong>
                    <span>{hit.reason}</span>
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
              <h3>搜索结果</h3>
              {results.map((result) => (
                <button key={result.chunk.id} onClick={() => {
                  setSelected({ id: result.chunk.id, nodeType: "chunk", data: result.chunk });
                  void loadGraph(result.chunk.id, true);
                }}>
                  <span>{result.chunk.text.slice(0, 65)}</span>
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
