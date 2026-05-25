import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { forceCenter, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from "d3-force";
import {
  relationStatuses,
  relationTypes,
  type AbstractNode,
  type Citation,
  type GraphEdge,
  type GraphNode,
  type Relation,
  type RelationStatus,
  type RelationType,
  type SearchResult,
} from "@agent-thinking/contracts";
import { api } from "./api";

type VisualNode = Node<{ label: string; entity: GraphNode }>;
type VisualEdge = Edge<{ entity: GraphEdge }>;
interface PositionedNode extends SimulationNodeDatum {
  id: string;
}

function relationColor(status: RelationStatus): string {
  if (status === "suggested") return "#e7a93c";
  if (status === "accepted") return "#43cca0";
  if (status === "manual") return "#48a9ff";
  return "#64748b";
}

function layoutNodes(records: GraphNode[], graphEdges: GraphEdge[]): VisualNode[] {
  const positions: PositionedNode[] = records.map((record) => ({ id: record.id }));
  const links = graphEdges.map((edge) => ({ source: edge.source, target: edge.target }));
  const simulation = forceSimulation(positions)
    .force("charge", forceManyBody().strength(-360))
    .force("link", forceLink(links).id((record) => (record as PositionedNode).id).distance(125))
    .force("center", forceCenter(370, 280))
    .stop();
  for (let index = 0; index < 140; index += 1) simulation.tick();
  return records.map((record) => {
    const point = positions.find((position) => position.id === record.id);
    const label = record.nodeType === "abstract"
      ? record.data.title
      : `${record.data.pageNumber ? `P${record.data.pageNumber} ` : ""}${record.data.text.slice(0, 36)}`;
    return {
      id: record.id,
      position: { x: point?.x ?? 0, y: point?.y ?? 0 },
      data: { label, entity: record },
      className: record.nodeType === "chunk" ? "flow-chunk" : `flow-${record.data.kind}`,
      style: {
        width: record.nodeType === "chunk" ? 250 : 210,
        border: "none",
        borderRadius: record.nodeType === "chunk" ? 10 : 28,
      },
    };
  });
}

function displayEdges(records: GraphEdge[]): VisualEdge[] {
  return records.map((record) => {
    const status = record.relation?.status;
    const edge: VisualEdge = {
      id: record.id,
      source: record.source,
      target: record.target,
      data: { entity: record },
      animated: status === "suggested",
      style: {
        stroke: record.edgeType === "evidence" ? "#56627c" : relationColor(status ?? "manual"),
        strokeWidth: record.edgeType === "evidence" ? 1.5 : 2,
        ...(status === "suggested" || record.edgeType === "evidence" ? { strokeDasharray: "5 4" } : {}),
      },
      labelStyle: { fill: "#b5c5dd", fontSize: 12, fontWeight: 600 },
    };
    if (record.edgeType === "relation") {
      edge.label = record.relation?.type ?? "relation";
      edge.markerEnd = { type: MarkerType.ArrowClosed };
    } else {
      edge.label = "evidence";
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
  const [records, setRecords] = useState<GraphNode[]>([]);
  const [selected, setSelected] = useState<GraphNode>();
  const [selectedRelation, setSelectedRelation] = useState<Relation>();
  const [status, setStatus] = useState<RelationStatus | "">("");
  const [type, setType] = useState<RelationType | "">("");
  const [manualType, setManualType] = useState<RelationType>("related_to");
  const [manualReason, setManualReason] = useState("用户手动建立的关联");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);

  const loadGraph = async (centerId?: string, includeChunks = false) => {
    try {
      const graph = await api.graph(libraryId, {
        ...(centerId ? { centerId } : {}),
        includeChunks,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
      });
      setRecords(graph.nodes);
      setNodes(layoutNodes(graph.nodes, graph.edges));
      setEdges(displayEdges(graph.edges));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  useEffect(() => {
    setSelected(undefined);
    setSelectedRelation(undefined);
    setResults([]);
    void loadGraph();
  }, [libraryId, refreshKey, status, type]);

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
      await loadGraph(selected?.id, selected?.nodeType === "abstract");
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
        <button onClick={() => void loadGraph()}>概览</button>
      </div>
      <div className="graph-body">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(connection) => void onConnect(connection)}
            onNodeClick={(_event, node) => {
              setSelected(node.data.entity);
              setSelectedRelation(undefined);
              if (node.data.entity.nodeType === "abstract") void loadGraph(node.id, true);
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedRelation(edge.data?.entity.relation);
              setSelected(undefined);
            }}
            minZoom={0.35}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.16, minZoom: 0.82, maxZoom: 1.18 }}
          >
            <Background color="#28334c" gap={24} />
            <MiniMap nodeColor={(node) => node.className === "flow-chunk" ? "#56627c" : "#40bca2"} />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="inspector">
          <div className="manual-edge">
            <h3>连边工具</h3>
            <select value={manualType} onChange={(event) => setManualType(event.target.value as RelationType)}>
              {relationTypes.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <input value={manualReason} onChange={(event) => setManualReason(event.target.value)} />
            <small>从一个抽象节点拖到另一个节点以创建关系。</small>
          </div>
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
            {suggested.length === 0 && <p className="muted">当前局部图没有待审核关系。</p>}
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
      <h3>{node.data.kind === "claim" ? "命题" : "概念"}</h3>
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
