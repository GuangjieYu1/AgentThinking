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
  type Relation,
  type RelationStatus,
  type RelationType,
  type SearchResult,
} from "@agent-thinking/contracts";
import { api } from "./api";

type VisualNode = Node<{ label: ReactNode; entity: GraphNode }>;
type VisualEdge = Edge<{ entity: GraphEdge }>;
type LayoutMode = "layered" | "network" | "tree";
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
      ].filter(Boolean).join(" "),
      style: {
        width: record.nodeType === "chunk" ? 250 : record.data.level === 2 ? 245 : 210,
        border: "none",
        borderRadius: record.nodeType === "chunk" ? 10 : record.data.level === 2 ? 15 : 28,
      },
    };
  });
}

function layeredLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind): VisualNode[] {
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
  return visualNodes(records, positions, "horizontal", activeAspect);
}

function treeLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind): VisualNode[] {
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
  return visualNodes(records, positions, "vertical", activeAspect);
}

function networkLayout(records: GraphNode[], graphEdges: GraphEdge[], activeAspect?: AspectKind): VisualNode[] {
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
  }])), undefined, activeAspect);
}

function layoutNodes(records: GraphNode[], graphEdges: GraphEdge[], layout: LayoutMode, activeAspect?: AspectKind): VisualNode[] {
  if (layout === "network") return networkLayout(records, graphEdges, activeAspect);
  return layout === "tree" ? treeLayout(records, graphEdges, activeAspect) : layeredLayout(records, graphEdges, activeAspect);
}

function displayEdges(records: GraphEdge[], layout: LayoutMode): VisualEdge[] {
  return records.map((record) => {
    const status = record.relation?.status;
    const edge: VisualEdge = {
      id: record.id,
      source: record.source,
      target: record.target,
      type: layout === "network" ? "default" : "smoothstep",
      data: { entity: record },
      animated: status === "suggested",
      style: {
        stroke: record.edgeType === "evidence" ? "#56627c" : record.edgeType === "membership" ? "#557d85" : relationColor(status ?? "manual"),
        strokeWidth: record.aggregate ? 2.8 : record.edgeType === "evidence" ? 1.5 : 2,
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

  const loadGraph = async (centerId?: string, includeChunks = false, requestedView = view) => {
    try {
      const graph = await api.graph(libraryId, {
        ...(centerId ? { centerId } : {}),
        includeChunks,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        ...(aspect ? { aspect } : {}),
        view: requestedView,
      });
      setRecords(graph.nodes);
      setEdgeRecords(graph.edges);
      setAspectFilter(graph.aspectFilter);
      setSelected((current) => current ? graph.nodes.find((node) => node.id === current.id) : undefined);
      setNodes(layoutNodes(graph.nodes, graph.edges, layout, aspect || undefined));
      setEdges(displayEdges(graph.edges, layout));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  useEffect(() => {
    if (!flowInstance || records.length === 0) return;
    window.requestAnimationFrame(() => void flowInstance.fitView({ padding: 0.16, minZoom: 0.35, maxZoom: 1.18 }));
  }, [flowInstance, records, layout]);

  useEffect(() => {
    setSelected(undefined);
    setSelectedRelation(undefined);
    setSelectedAggregate(undefined);
    setResults([]);
    void loadGraph(focusedNodeId, view === "detail" && selected?.nodeType === "abstract" && selected.data.level === 1, view);
  }, [libraryId, refreshKey, status, type, aspect, view, focusedNodeId]);

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
    setNodes(layoutNodes(records, edgeRecords, nextLayout, aspect || undefined));
    setEdges(displayEdges(edgeRecords, nextLayout));
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
