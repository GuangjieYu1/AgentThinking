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
  type AoriGraphEdge,
  type AoriGraphNode,
  type AoriGraphScope,
  type AoriGraphViewMode,
  type AoriGraphView,
  type AbstractNode,
  type AspectKind,
  type Citation,
  type DemandAnswerPlan,
  type DemandOperationResult,
  type Document,
  type DocumentTreeNode,
  type EvidencePack,
  type EvidenceRecord,
  type GraphEdge,
  type GraphNode,
  type GraphRuleStage,
  type GraphRulesSummary,
  type GraphRuleTrace,
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

type VisualNode = Node<{ label: ReactNode; entity?: GraphNode; aori?: AoriGraphNode }>;
type VisualEdge = Edge<{ entity?: GraphEdge; aori?: AoriGraphEdge }>;
type LayoutMode = "layered" | "network" | "tree";
type PulseLayerMode = "normal" | "current" | "stats" | "wrong" | "correct";
type WorkspaceViewMode = "graph" | "evidence" | "document" | "retrieval" | "governance";
type GraphSurfaceMode = "legacy" | "aori_overview" | "aori_detail" | "hybrid";
type AoriGraphMode = AoriGraphView["layoutHints"]["mode"];
interface RuleGovernanceFeed {
  stage?: GraphRuleStage;
  summary?: GraphRulesSummary;
  traces: GraphRuleTrace[];
}
type PulseHitRecord = PulseResponse["hits"][number];
type PulseStreamHitRecord = PulseStreamHit;
type PulseNavigationEvent = Extract<PulseStreamEvent, { type: "candidates" | "decision" | "backtrack" }>;
type PulseProcessEvent = Exclude<Extract<PulseStreamEvent, { message: string }>, { type: "error" }>;
type PulseDecorated = { pulseActive?: boolean; pulseReverse?: boolean; pulseTransitKey?: string };
type PulseVisualHit = Pick<PulseHitRecord, "targetType" | "targetId">;
type PulseDisplayHit = Pick<PulseStreamHitRecord, "targetType" | "targetId" | "score" | "pathRole">;
type PulseHitListRecord = Pick<PulseStreamHitRecord, "label" | "reason" | "rationale" | "observation" | "excerpt" | "pathRole" | "score">;
type DemandRecordEventPayload = {
  record?: EvidenceRecord;
  recordSpec?: DemandAnswerPlan["requiredRecords"][number];
  sourceItem?: {
    id: string;
    title: string;
    summary: string;
    sourceNodeId?: string;
    sourceAspectId?: string;
    sourceItemId?: string;
    chunkIds?: string[];
  };
  chunks?: Array<{ id: string; label: string; excerpt: string }>;
};
type DemandPlanEventPayload = { plan?: DemandAnswerPlan };
type DemandOperationEventPayload = { operationResult?: DemandOperationResult };
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
  entity: "实体",
  person: "人物",
  organization: "组织",
  place: "地点",
  object: "对象",
  event: "事件",
  timeline: "时间线",
  causality: "因果",
  state_change: "状态变化",
  amount: "数值",
  evidence: "证据",
  argument: "论证",
  counterargument: "反论证",
  finding: "认定",
  method: "方法",
  experiment: "实验",
  result: "结果",
  limitation: "限制",
  operation: "操作",
  system: "系统",
  story: "事件",
  claim: "命题",
  conflict: "冲突",
  question: "问题",
  gap: "缺口",
  other: "其他",
};

const graphRuleStageLabels: Record<GraphRuleStage, string> = {
  extraction: "抽取",
  mapping_audit: "映射审计",
  rebuild: "重构",
};

const graphRuleCategoryLabels = {
  graph_validity: "图合法性",
  relation_algebra: "关系代数",
  semantic_coverage: "语义覆盖",
  graph_evolution: "图演化",
} satisfies Record<GraphRuleTrace["category"], string>;

const graphRuleDecisionLabels = {
  kept: "保留",
  downgraded: "降级",
  excluded_from_graph: "排除",
  needs_review: "待复核",
} satisfies Record<GraphRuleTrace["decision"], string>;

const workspaceViewLabels: Record<WorkspaceViewMode, string> = {
  graph: "图谱",
  evidence: "证据",
  document: "文档",
  retrieval: "检索",
  governance: "治理",
};

const graphSurfaceLabels: Record<GraphSurfaceMode, string> = {
  legacy: "Legacy",
  aori_overview: "AORI",
  aori_detail: "AORI",
  hybrid: "AORI",
};

const aoriScopeLabels: Record<AoriGraphScope, string> = {
  document: "Document",
  library: "Library",
};

const aoriViewModeLabels: Record<AoriGraphViewMode, string> = {
  layer: "Layer",
  tree: "Tree",
  network: "Network",
};

const aoriNodeTypeLabels: Record<AoriGraphNode["type"], string> = {
  document_center: "文档中心",
  aspect: "切面",
  aspect_item: "切面项",
  relation: "关系",
  gap: "缺口",
  self_question: "自问",
  source_chunk: "原文片段",
  warning: "告警",
  library_center: "知识库中心",
  entity: "实体",
  library_aspect: "库级切面",
  relation_assertion: "关系断言",
  document: "文档",
  evidence: "证据",
  aggregate_relation: "聚合关系",
};

const evidenceStatusLabels = {
  supported: "supported",
  partially_supported: "partial",
  unsupported: "unsupported",
  disputed: "disputed",
} satisfies Record<NonNullable<AoriGraphNode["evidenceStatus"]>, string>;

const closureStatusLabels = {
  closed: "closed",
  partial: "partial",
  open: "open",
} satisfies Record<NonNullable<AoriGraphNode["closureStatus"]>, string>;

const pulseInitialRevealDelayMs = 455;
const pulseRevealDelayMs = 1050;

function isAoriGraphMode(mode: GraphSurfaceMode): mode is Exclude<GraphSurfaceMode, "legacy"> {
  return mode !== "legacy";
}

function aoriModeFromSurface(mode: Exclude<GraphSurfaceMode, "legacy">): AoriGraphMode {
  if (mode === "aori_overview") return "overview";
  if (mode === "aori_detail") return "detail";
  return "hybrid";
}

function layoutFromAoriViewMode(mode: AoriGraphViewMode): LayoutMode {
  if (mode === "network") return "network";
  if (mode === "tree") return "tree";
  return "layered";
}

function confidenceText(confidence: number | undefined): string | undefined {
  return typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : undefined;
}

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

function isPulseProcessEvent(event: PulseStreamEvent): event is PulseProcessEvent {
  return event.type !== "error" && "message" in event && typeof event.message === "string";
}

function pulseProcessTitle(type: PulseProcessEvent["type"]): string {
  switch (type) {
    case "stage": return "阶段";
    case "demand_plan_generated": return "生成 Demand Plan";
    case "demand_records_started": return "开始抽取 Evidence Records";
    case "demand_record_extracted": return "抽取 Evidence Record";
    case "demand_operations_finished": return "执行 Operations";
    case "demand_answer_synthesized": return "合成答案";
    case "skill_route_generated": return "选择回答路径";
    case "skill_execution_started": return "执行回答路径";
    case "facet_table_build_started": return "构建事实表";
    case "facet_row_extracted": return "抽取事实行";
    case "facet_table_build_finished": return "完成事实表";
    case "facet_operation_planned": return "规划操作";
    case "facet_filter_applied": return "应用过滤";
    case "facet_dedupe_finished": return "完成去重";
    case "skill_answer_synthesized": return "合成回答";
    case "aori_traversal_started": return "启动 AORI 遍历";
    case "bfs_layer_started": return "扫描 BFS 层";
    case "bfs_node_decision": return "判断节点";
    case "bfs_node_expanded": return "展开节点";
    case "bfs_chunk_collected": return "收集证据";
    case "bfs_layer_finished": return "完成 BFS 层";
    case "dfs_node_entered": return "进入节点";
    case "dfs_candidate_selected": return "选择候选";
    case "dfs_chunk_found": return "找到证据";
    case "dfs_backtrack": return "回退";
    case "chunk_summary_started": return "读取片段";
    case "chunk_summary_finished": return "完成片段摘要";
    case "final_answer_started": return "开始最终回答";
    case "final_answer_finished": return "完成最终回答";
    default: return type.replaceAll("_", " ");
  }
}

function compactText(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}...` : normalized;
}

function valuePreview(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未抽到";
  if (Array.isArray(value)) return value.map(valuePreview).filter(Boolean).join("、");
  if (typeof value === "object") return compactText(JSON.stringify(value), 120);
  return compactText(String(value), 120);
}

function payloadOf<T>(event: PulseProcessEvent): T | undefined {
  return "payload" in event && event.payload && typeof event.payload === "object"
    ? event.payload as T
    : undefined;
}

function DemandPlanDetails({ event }: { event: PulseProcessEvent }): ReactNode {
  const plan = payloadOf<DemandPlanEventPayload>(event)?.plan;
  if (!plan) return null;
  return (
    <div className="pulse-process-detail">
      <small>回答目标：{compactText(plan.answerGoal, 150)}</small>
      <small>相关范围：{compactText(plan.targetScope.reason, 150)}</small>
      <small>需要材料：{plan.requiredRecords.map((record) => `${record.recordName}(${record.coverage})`).join(" / ")}</small>
      <small>需要字段：{plan.requiredRecords.flatMap((record) => record.fields.map((field) => field.name)).slice(0, 8).join("、")}</small>
      <small>相关判断：{compactText(plan.reason, 180)}</small>
    </div>
  );
}

function DemandRecordDetails({ event }: { event: PulseProcessEvent }): ReactNode {
  const payload = payloadOf<DemandRecordEventPayload>(event);
  const record = payload?.record;
  if (!record) return null;
  const fields = Object.entries(record.fields).slice(0, 6);
  const chunks = payload?.chunks ?? [];
  return (
    <div className="pulse-process-detail">
      <small>看到来源：{payload?.sourceItem?.title ?? record.sourceItemId ?? record.sourceNodeId ?? record.recordName}</small>
      {payload?.recordSpec && <small>认为相关：需要抽取 {payload.recordSpec.fields.map((field) => field.name).join("、")}；覆盖要求 {payload.recordSpec.coverage}</small>}
      {fields.map(([name, field]) => (
        <small key={name}>
          {name}：{valuePreview(field.value)}
          {typeof field.confidence === "number" ? ` · 置信 ${field.confidence.toFixed(2)}` : ""}
          {field.quote ? ` · 引文「${compactText(field.quote, 120)}」` : ""}
          {field.uncertainty ? ` · 不确定：${compactText(field.uncertainty, 90)}` : ""}
        </small>
      ))}
      {chunks.slice(0, 3).map((chunk) => (
        <small key={chunk.id}>原文片段：{chunk.label} · {compactText(chunk.excerpt, 130)}</small>
      ))}
    </div>
  );
}

function DemandOperationDetails({ event }: { event: PulseProcessEvent }): ReactNode {
  const operationResult = payloadOf<DemandOperationEventPayload>(event)?.operationResult;
  if (!operationResult) return null;
  return (
    <div className="pulse-process-detail">
      <small>处理状态：{operationResult.status}</small>
      {operationResult.operationResults.slice(0, 4).map((operation) => (
        <small key={operation.outputName}>
          {operation.outputName}：included {operation.includedRecordIds.length}
          {" · "}excluded {operation.excludedRecordIds.length}
          {" · "}uncertain {operation.uncertainRecordIds.length}
          {operation.warnings.length ? ` · ${operation.warnings.slice(0, 2).join("；")}` : ""}
        </small>
      ))}
      {operationResult.answerFacts.slice(0, 3).map((fact, index) => (
        <small key={`${fact.text}-${index}`}>可回答事实：{compactText(fact.text, 150)}</small>
      ))}
      {operationResult.warnings.slice(0, 3).map((warning, index) => (
        <small key={`${warning}-${index}`}>警告：{compactText(warning, 130)}</small>
      ))}
    </div>
  );
}

function PulseProcessDetails({ event }: { event: PulseProcessEvent }): ReactNode {
  if (event.type === "demand_plan_generated") return <DemandPlanDetails event={event} />;
  if (event.type === "demand_record_extracted") return <DemandRecordDetails event={event} />;
  if (event.type === "demand_operations_finished") return <DemandOperationDetails event={event} />;
  return null;
}

function PulseProcessLog({ events, limit = 8 }: { events: PulseProcessEvent[]; limit?: number }): ReactNode {
  if (events.length === 0) return null;
  return (
    <div className="pulse-navigation-log pulse-process-log">
      <strong>思考过程</strong>
      {events.slice(-limit).map((event, index) => (
        <div
          className={`pulse-navigation-event pulse-process-${event.type.replaceAll("_", "-")}`}
          key={`${event.type}-${index}-${event.message}`}
        >
          <span>{pulseProcessTitle(event.type)}</span>
          <small>{event.message}</small>
          <PulseProcessDetails event={event} />
        </div>
      ))}
    </div>
  );
}

function PulseHitContent({ hit }: { hit: PulseHitListRecord }): ReactNode {
  return (
    <>
      <strong>{hit.label}</strong>
      <span>相关理由：{pulseHitReason(hit)}</span>
      {hit.observation && <small>看到的信息：{compactText(hit.observation, 140)}</small>}
      {hit.rationale && hit.rationale !== pulseHitReason(hit) && <small>判断依据：{compactText(hit.rationale, 150)}</small>}
      {hit.excerpt && <small>证据摘录：{compactText(hit.excerpt, 150)}</small>}
      <small>{hit.pathRole} · {hit.score.toFixed(2)}</small>
    </>
  );
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

function aoriNodeMeta(record: AoriGraphNode): string {
  return [
    record.kind ? aspectLabels[record.kind] : aoriNodeTypeLabels[record.type],
    record.domainKind && record.domainKind !== "unknown" ? record.domainKind : undefined,
    record.evidenceStatus ? evidenceStatusLabels[record.evidenceStatus] : undefined,
    record.fallbackOnly ? "fallback" : undefined,
    record.closureStatus ? closureStatusLabels[record.closureStatus] : undefined,
    confidenceText(record.confidence),
  ].filter(Boolean).slice(0, 5).join(" · ");
}

function uniquePulseKeys(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function aoriNodePulseKeys(record: AoriGraphNode): string[] {
  return uniquePulseKeys([
    `node:${record.id}`,
    record.itemId ? `node:item:${record.itemId}` : undefined,
    record.chunkId ? `chunk:${record.chunkId}` : undefined,
    record.relationId ? `node:relation:${record.relationId}` : undefined,
    record.assertionId ? `relation:${record.assertionId}` : undefined,
    record.documentId ? `node:document:${record.documentId}` : undefined,
  ]);
}

function aoriEdgePulseKeys(record: AoriGraphEdge): string[] {
  return uniquePulseKeys([
    `relation:${record.id}`,
    ...((record.assertionIds ?? []).map((id) => `relation:${id}`)),
  ]);
}

function pulseHitForKeys(keys: string[], hitByKey: ReadonlyMap<string, PulseDisplayHit>): PulseDisplayHit | undefined {
  for (const key of keys) {
    const hit = hitByKey.get(key);
    if (hit) return hit;
  }
  return undefined;
}

function aoriNodeClass(
  record: AoriGraphNode,
  collapsedNodeIds: ReadonlySet<string>,
  selectedNodeId?: string,
  pulseHit?: PulseDisplayHit,
  activePulseKey?: string,
): string {
  const pulseKeys = aoriNodePulseKeys(record);
  return [
    "flow-aori",
    `flow-aori-${record.type.replaceAll("_", "-")}`,
    record.evidenceStatus ? `flow-aori-evidence-${record.evidenceStatus.replaceAll("_", "-")}` : "",
    record.closureStatus ? `flow-aori-closure-${record.closureStatus}` : "",
    record.fallbackOnly ? "flow-aori-fallback-only" : "",
    collapsedNodeIds.has(record.id) ? "flow-aori-collapsed" : "",
    selectedNodeId === record.id ? "flow-aori-selected" : "",
    pulseHit ? `flow-pulse-${pulseHit.pathRole}` : "",
    activePulseKey && pulseKeys.includes(activePulseKey) ? "flow-pulse-active" : "",
  ].filter(Boolean).join(" ");
}

function aoriNodeWidth(record: AoriGraphNode): number {
  if (record.type === "document_center") return 280;
  if (record.type === "aspect") return 250;
  if (record.type === "source_chunk") return 220;
  return 235;
}

function aoriNodeOrder(record: AoriGraphNode, graph: AoriGraphView): string {
  const groupIndex = graph.groups.findIndex((group) => group.nodeIds.includes(record.id));
  const typeRank = {
    library_center: 0,
    document_center: 0,
    document: 1,
    aspect: 1,
    library_aspect: 1,
    entity: 2,
    aspect_item: 2,
    relation: 3,
    aggregate_relation: 3,
    relation_assertion: 4,
    gap: 4,
    self_question: 5,
    source_chunk: 6,
    evidence: 6,
    warning: 7,
  } satisfies Record<AoriGraphNode["type"], number>;
  return [
    String(groupIndex < 0 ? 9999 : groupIndex).padStart(4, "0"),
    String(typeRank[record.type]).padStart(2, "0"),
    record.label,
    record.id,
  ].join(":");
}

function aoriVisibleNodes(graph: AoriGraphView, viewMode: AoriGraphViewMode, selectedNodeId?: string): AoriGraphNode[] {
  if (viewMode !== "network") return graph.nodes;
  const collapsedNodeIds = new Set(graph.layoutHints.collapsedNodeIds);
  return graph.nodes.filter((node) =>
    node.id === selectedNodeId ||
    !collapsedNodeIds.has(node.id) ||
    (node.type !== "source_chunk" && node.type !== "evidence")
  );
}

function aoriVisualNodes(
  graph: AoriGraphView,
  requestedViewMode?: AoriGraphViewMode,
  selectedNodeId?: string,
  pulseHits: PulseDisplayHit[] = [],
): VisualNode[] {
  const viewMode = requestedViewMode ?? graph.layoutHints.viewMode ?? (graph.layoutHints.mode === "overview" ? "layer" : "layer");
  const collapsedNodeIds = new Set(graph.layoutHints.collapsedNodeIds);
  const visibleNodes = aoriVisibleNodes(graph, viewMode, selectedNodeId);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = graph.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const hitByKey = new Map(pulseHits.map((hit) => [pulseHitKey(hit), hit]));
  const activeKey = pulseHits.at(-1) ? pulseHitKey(pulseHits.at(-1)!) : "";
  const positions = new Map<string, { x: number; y: number }>();
  const center = visibleNodes.find((node) => node.id === graph.layoutHints.centerNodeId) ?? visibleNodes[0] ?? graph.centerNode;

  if (viewMode === "network") {
    const degree = new Map<string, number>();
    for (const edge of visibleEdges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const simulatedNodes: PositionedNode[] = visibleNodes.map((node, index) => {
      const angle = visibleNodes.length === 1 ? 0 : (index * Math.PI * 2) / visibleNodes.length;
      const rankRadius = node.id === center.id ? 0 : node.type === "source_chunk" || node.type === "evidence" ? 520 : 320;
      return {
        id: node.id,
        x: 420 + Math.cos(angle) * rankRadius,
        y: 320 + Math.sin(angle) * rankRadius,
      };
    });
    const byId = new Map(visibleNodes.map((node) => [node.id, node]));
    const links = visibleEdges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
    }));
    const simulation = forceSimulation(simulatedNodes)
      .force("charge", forceManyBody<PositionedNode>().strength((node) => {
        const record = byId.get(node.id);
        if (record?.type === "source_chunk" || record?.type === "evidence") return -460;
        return -920 - ((degree.get(node.id) ?? 0) * 60);
      }).distanceMax(900))
      .force("collide", forceCollide<PositionedNode>().radius((node) => {
        const record = byId.get(node.id);
        if (!record) return 128;
        return aoriNodeWidth(record) * 0.58;
      }).strength(1).iterations(3))
      .force("link", forceLink<PositionedNode, { source: string; target: string; type: AoriGraphEdge["type"] }>(links)
        .id((node) => node.id)
        .distance((link) => link.type === "evidence" || link.type === "evidence_for" ? 210 : link.type === "aggregate_relation" ? 285 : 250)
        .strength((link) => link.type === "evidence" || link.type === "evidence_for" ? 0.26 : 0.52))
      .force("center", forceCenter(420, 320))
      .stop();
    for (let index = 0; index < 260; index += 1) simulation.tick();
    for (const node of simulatedNodes) {
      positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
    }
  } else if (viewMode === "tree") {
    const layers = new Map<number, AoriGraphNode[]>();
    for (const node of visibleNodes) {
      const layer = graph.layoutHints.layers[node.id] ?? 0;
      const bucket = layers.get(layer) ?? [];
      bucket.push(node);
      layers.set(layer, bucket);
    }
    [...layers.entries()].forEach(([layerIndex, layerNodes]) => {
      layerNodes.sort((left, right) => aoriNodeOrder(left, graph).localeCompare(aoriNodeOrder(right, graph), "zh-CN"));
      const columnGap = layerNodes.some((node) => node.type === "source_chunk") ? 260 : 245;
      layerNodes.forEach((node, columnIndex) => {
        positions.set(node.id, {
          x: 380 + (columnIndex - ((layerNodes.length - 1) / 2)) * columnGap,
          y: layerIndex * 170,
        });
      });
    });
  } else if (graph.layoutHints.mode === "overview") {
    positions.set(center.id, { x: 360, y: 280 });
    const aspects = visibleNodes
      .filter((node) => node.type === "aspect" || node.type === "library_aspect" || node.type === "entity" || node.type === "aggregate_relation")
      .sort((left, right) => aoriNodeOrder(left, graph).localeCompare(aoriNodeOrder(right, graph), "zh-CN"));
    const radiusX = Math.max(360, Math.min(620, 300 + aspects.length * 16));
    const radiusY = Math.max(210, Math.min(430, 180 + aspects.length * 11));
    aspects.forEach((node, index) => {
      const angle = aspects.length === 1 ? 0 : (-Math.PI / 2) + (index * Math.PI * 2 / aspects.length);
      positions.set(node.id, {
        x: 360 + Math.cos(angle) * radiusX,
        y: 280 + Math.sin(angle) * radiusY,
      });
    });
  } else {
    const layers = new Map<number, AoriGraphNode[]>();
    for (const node of visibleNodes) {
      const layer = graph.layoutHints.layers[node.id] ?? 0;
      const bucket = layers.get(layer) ?? [];
      bucket.push(node);
      layers.set(layer, bucket);
    }
    [...layers.entries()].forEach(([layerIndex, layerNodes]) => {
      layerNodes.sort((left, right) => aoriNodeOrder(left, graph).localeCompare(aoriNodeOrder(right, graph), "zh-CN"));
      const rowGap = layerNodes.some((node) => node.type === "source_chunk") ? 118 : 146;
      layerNodes.forEach((node, rowIndex) => {
        positions.set(node.id, {
          x: layerIndex * 330,
          y: 310 + (rowIndex - ((layerNodes.length - 1) / 2)) * rowGap,
        });
      });
    });
  }

  return visibleNodes.map((record) => {
    const point = positions.get(record.id) ?? { x: 0, y: 0 };
    const meta = aoriNodeMeta(record);
    const pulseHit = pulseHitForKeys(aoriNodePulseKeys(record), hitByKey);
    return {
      id: record.id,
      position: point,
      sourcePosition: viewMode === "tree" ? Position.Bottom : Position.Right,
      targetPosition: viewMode === "tree" ? Position.Top : Position.Left,
      data: {
        aori: record,
        label: (
          <div className="flow-label flow-aori-label">
            <span>{record.label}</span>
            {meta && <small>{meta}</small>}
          </div>
        ),
      },
      className: aoriNodeClass(record, collapsedNodeIds, selectedNodeId, pulseHit, activeKey),
      style: {
        width: aoriNodeWidth(record),
        minHeight: record.type === "source_chunk" ? 58 : 72,
        borderRadius: 8,
      },
    };
  });
}

function aoriEdgeColor(record: AoriGraphEdge): string {
  if (record.type === "relates") return "#a8b2ff";
  if (record.type === "evidence") return "#64748b";
  if (record.type === "has_gap") return "#ef8fa5";
  if (record.type === "asks") return "#f0c86d";
  if (record.type === "warning" || record.evidenceStatus === "unsupported") return "#e7ba63";
  return "#56c7b0";
}

function pulseRoleColor(role: PulseDisplayHit["pathRole"]): string {
  if (role === "direct") return "#f8d26a";
  if (role === "bridge") return "#c6a2ff";
  return "#7db8ff";
}

function displayAoriEdges(
  graph: AoriGraphView,
  requestedViewMode?: AoriGraphViewMode,
  selectedNodeId?: string,
  selectedEdgeId?: string,
  pulseHits: PulseDisplayHit[] = [],
): VisualEdge[] {
  const viewMode = requestedViewMode ?? graph.layoutHints.viewMode ?? (graph.layoutHints.mode === "overview" ? "layer" : "layer");
  const visibleNodeIds = new Set(aoriVisibleNodes(graph, viewMode, selectedNodeId).map((node) => node.id));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const hitByKey = new Map(pulseHits.map((hit) => [pulseHitKey(hit), hit]));
  const activeHit = pulseHits.at(-1);
  const activeKey = activeHit ? pulseHitKey(activeHit) : "";
  const nodeHasHit = (nodeId: string) => {
    const node = nodeById.get(nodeId);
    return node ? Boolean(pulseHitForKeys(aoriNodePulseKeys(node), hitByKey)) : hitByKey.has(`node:${nodeId}`);
  };
  return graph.edges.filter((record) => visibleNodeIds.has(record.source) && visibleNodeIds.has(record.target)).map((record) => {
    const warning = record.type === "warning" || record.evidenceStatus === "unsupported" || record.closureStatus === "open";
    const selected = selectedEdgeId === record.id;
    const edgeHit = pulseHitForKeys(aoriEdgePulseKeys(record), hitByKey);
    const endpointHit = !edgeHit && nodeHasHit(record.source) && nodeHasHit(record.target);
    const targetChunkId = nodeById.get(record.target)?.chunkId;
    const active = Boolean(edgeHit && aoriEdgePulseKeys(record).includes(activeKey)) ||
      (endpointHit && (activeKey === `node:${record.source}` || activeKey === `node:${record.target}` || activeKey === `chunk:${targetChunkId ?? ""}`));
    const pulseColor = edgeHit ? pulseRoleColor(edgeHit.pathRole) : endpointHit ? pulseRoleColor("expanded") : undefined;
    const edge: VisualEdge = {
      id: record.id,
      source: record.source,
      target: record.target,
      type: active
        ? viewMode === "network" || graph.layoutHints.mode === "overview" ? "pulseBezier" : "pulseSmoothStep"
        : viewMode === "network" || graph.layoutHints.mode === "overview" ? "default" : "smoothstep",
      data: { aori: record },
      label: record.domainRelation || record.label,
      animated: warning,
      className: [
        "flow-aori-edge",
        `flow-aori-edge-${record.type.replaceAll("_", "-")}`,
        selected ? "flow-aori-edge-selected" : "",
        active ? "flow-pulse-active-edge" : "",
      ].filter(Boolean).join(" "),
      style: {
        stroke: pulseColor ?? aoriEdgeColor(record),
        strokeWidth: active ? 4.8 : edgeHit || endpointHit ? 3.3 : selected ? 4.2 : record.type === "relates" || record.type === "aggregate_relation" ? 2.8 : record.type === "evidence" ? 1.5 : 2.2,
        opacity: selected ? 1 : record.type === "evidence" ? 0.72 : 0.95,
        ...(warning || record.type === "evidence" ? { strokeDasharray: "5 4" } : {}),
        ...(active ? { filter: "drop-shadow(0 0 7px #f8d26a)" } : {}),
      },
      labelStyle: { fill: "#c7d4e7", fontSize: 12, fontWeight: 700 },
    };
    if (record.type !== "evidence") edge.markerEnd = { type: MarkerType.ArrowClosed };
    return edge;
  });
}

function miniMapNodeColor(node: Node): string {
  const className = String(node.className ?? "");
  if (className.includes("flow-aori-document-center")) return "#56c7b0";
  if (className.includes("flow-aori-aspect")) return "#f0c86d";
  if (className.includes("flow-aori-gap") || className.includes("unsupported")) return "#ef8fa5";
  if (className.includes("flow-aori-source-chunk")) return "#64748b";
  if (className.includes("flow-chunk")) return "#56627c";
  if (className.includes("flow-theme")) return "#cb9b54";
  return "#40bca2";
}

export function GraphWorkspace({
  libraryId,
  documents,
  refreshKey,
  ruleGovernanceFeed,
  onError,
  onOpenCitation,
}: {
  libraryId: string;
  documents: Document[];
  refreshKey: number;
  ruleGovernanceFeed: RuleGovernanceFeed;
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
  const [selectedAoriNode, setSelectedAoriNode] = useState<AoriGraphNode>();
  const [selectedAoriEdge, setSelectedAoriEdge] = useState<AoriGraphEdge>();
  const [view, setView] = useState<GraphView>("detail");
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>("graph");
  const [graphMode, setGraphMode] = useState<GraphSurfaceMode>(() =>
    documents.some((document) => document.latestVersion?.status === "completed" && document.latestVersion.indexStrategy === "aspect_oriented_reflective")
      ? "aori_overview"
      : "legacy",
  );
  const [aoriScope, setAoriScope] = useState<AoriGraphScope>("document");
  const [aoriViewMode, setAoriViewMode] = useState<AoriGraphViewMode>("layer");
  const [aoriVersionId, setAoriVersionId] = useState<string | undefined>(() =>
    documents.find((document) => document.latestVersion?.status === "completed" && document.latestVersion.indexStrategy === "aspect_oriented_reflective")?.latestVersion?.id,
  );
  const [aoriGraph, setAoriGraph] = useState<AoriGraphView>();
  const [aoriGraphMessage, setAoriGraphMessage] = useState("");
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
  const [pulseProcessEvents, setPulseProcessEvents] = useState<PulseProcessEvent[]>([]);
  const [pulseDraftAnswer, setPulseDraftAnswer] = useState("");
  const [documentTree, setDocumentTree] = useState<DocumentTreeNode[]>([]);
  const [documentTreeLoading, setDocumentTreeLoading] = useState(false);
  const [activeTreeNodeId, setActiveTreeNodeId] = useState<string>();
  const [nodeEvidenceDetail, setNodeEvidenceDetail] = useState<Awaited<ReturnType<typeof api.nodeEvidenceDetail>>>();
  const activeLibraryIdRef = useRef(libraryId);
  const graphRequestSeqRef = useRef(0);
  const pendingFocusNodeIdRef = useRef<string | undefined>(undefined);
  const aoriDefaultAppliedRef = useRef(false);
  activeLibraryIdRef.current = libraryId;
  const visibleCurrentPulse = currentPulse?.pulse.libraryId === libraryId ? currentPulse : undefined;
  const isAoriMode = isAoriGraphMode(graphMode);
  const activeAoriMode = isAoriMode
    ? aoriScope === "document"
      ? aoriViewMode === "layer" ? "overview" : "detail"
      : aoriViewMode === "layer" ? "overview" : "detail"
    : undefined;
  const aoriDocuments = useMemo(
    () => documents.filter((document) =>
      document.libraryId === libraryId &&
      document.latestVersion?.status === "completed" &&
      document.latestVersion.indexStrategy === "aspect_oriented_reflective",
    ),
    [documents, libraryId],
  );
  const activeAoriDocument = useMemo(
    () => aoriDocuments.find((document) => document.latestVersion?.id === aoriVersionId) ?? aoriDocuments[0],
    [aoriDocuments, aoriVersionId],
  );
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
  const currentAoriPulseHits = useMemo(
    () => currentPulsePlaybackSteps.slice(0, pulseRevealCount).flatMap((step) => step.kind === "hit" ? [step.hit] : []),
    [currentPulsePlaybackSteps, pulseRevealCount],
  );
  const aoriPulseHits = useMemo<PulseDisplayHit[]>(
    () => visibleCurrentPulse && pulseMode === "current" ? currentAoriPulseHits : pulsing ? pulseStreamHits : [],
    [currentAoriPulseHits, pulseMode, pulseStreamHits, pulsing, visibleCurrentPulse],
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

  const applyAoriGraph = (graph: AoriGraphView) => {
    setAoriGraph(graph);
    setAoriGraphMessage("");
    setRecords([]);
    setEdgeRecords([]);
    setAspectFilter(undefined);
    setSelected(undefined);
    setSelectedRelation(undefined);
    setSelectedAggregate(undefined);
    setSelectedAoriNode((current) => current ? graph.nodes.find((node) => node.id === current.id) : undefined);
    setSelectedAoriEdge((current) => current ? graph.edges.find((edge) => edge.id === current.id) : undefined);
    setNodes(aoriVisualNodes(graph, aoriViewMode, selectedAoriNode?.id));
    setEdges(displayAoriEdges(graph, aoriViewMode, selectedAoriNode?.id, selectedAoriEdge?.id));
  };

  const loadAoriGraph = async (mode: AoriGraphMode = activeAoriMode ?? "overview") => {
    const requestLibraryId = libraryId;
    const requestVersionId = aoriVersionId;
    if (aoriScope === "document" && !requestVersionId) {
      setAoriGraph(undefined);
      setNodes([]);
      setEdges([]);
      return undefined;
    }
    const requestSeq = graphRequestSeqRef.current + 1;
    graphRequestSeqRef.current = requestSeq;
    try {
      const graph = aoriScope === "library"
        ? await api.libraryAoriGraph(requestLibraryId, aoriViewMode)
        : await api.aoriGraph(requestVersionId!, mode);
      if (activeLibraryIdRef.current !== requestLibraryId || graphRequestSeqRef.current !== requestSeq) return undefined;
      applyAoriGraph(graph);
      return graph;
    } catch (cause) {
      if (activeLibraryIdRef.current !== requestLibraryId || graphRequestSeqRef.current !== requestSeq) return undefined;
      const message = (cause as Error).message;
      setAoriGraph(undefined);
      setNodes([]);
      setEdges([]);
      setAoriGraphMessage(aoriScope === "library" ? message : "");
      if (aoriScope !== "library") onError(message);
      return undefined;
    }
  };

  useEffect(() => {
    const firstAoriVersionId = aoriDocuments[0]?.latestVersion?.id;
    if (!firstAoriVersionId) {
      aoriDefaultAppliedRef.current = false;
      setAoriVersionId(undefined);
      setAoriGraph(undefined);
      if (isAoriMode) setGraphMode("legacy");
      return;
    }
    setAoriVersionId((current) =>
      current && aoriDocuments.some((document) => document.latestVersion?.id === current) ? current : firstAoriVersionId,
    );
    if (!aoriDefaultAppliedRef.current) {
      aoriDefaultAppliedRef.current = true;
      if (graphMode === "legacy") setGraphMode("aori_overview");
    }
  }, [aoriDocuments, graphMode, isAoriMode]);

  useEffect(() => {
    if (!flowInstance || nodes.length === 0) return;
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
  }, [flowInstance, nodes.length, layout, graphMode, aoriGraph?.layoutHints.mode, aoriScope, aoriViewMode]);

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
    if (isAoriMode) return;
    if (records.length === 0) return;
    const visibleGraph = revealPulseGraph(records, edgeRecords, pulseMode, visibleCurrentPulse, pulseRevealCount);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, layout, aspect || undefined, pulseMode, searchFocus));
    setEdges(displayEdges(visibleGraph.edges, layout, pulseMode));
  }, [isAoriMode, pulseMode, pulseRevealCount, visibleCurrentPulse?.pulse.id, records, edgeRecords, layout, aspect, searchFocus]);

  useEffect(() => {
    if (isAoriMode) return;
    if (!pulsing || visibleCurrentPulse || pulseStreamHits.length === 0 || records.length === 0) return;
    const visibleGraph = decoratePulseStreamGraph(records, edgeRecords, pulseStreamHits);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, layout, aspect || undefined, "current", searchFocus));
    setEdges(displayEdges(visibleGraph.edges, layout, "current"));
  }, [isAoriMode, pulsing, visibleCurrentPulse?.pulse.id, pulseStreamHits, records, edgeRecords, layout, aspect, searchFocus]);

  useEffect(() => {
    if (!isAoriMode || !aoriGraph) return;
    setNodes(aoriVisualNodes(aoriGraph, aoriViewMode, selectedAoriNode?.id, aoriPulseHits));
    setEdges(displayAoriEdges(aoriGraph, aoriViewMode, selectedAoriNode?.id, selectedAoriEdge?.id, aoriPulseHits));
  }, [isAoriMode, aoriGraph, aoriViewMode, selectedAoriNode?.id, selectedAoriEdge?.id, aoriPulseHits]);

  useEffect(() => {
    if (viewMode !== "document" || documentTree.length > 0 || documentTreeLoading) return;
    const requestLibraryId = libraryId;
    setDocumentTreeLoading(true);
    void api.documentTree(requestLibraryId)
      .then((tree) => {
        if (activeLibraryIdRef.current !== requestLibraryId) return;
        setDocumentTree(tree);
      })
      .catch((cause: Error) => {
        if (activeLibraryIdRef.current !== requestLibraryId) return;
        onError(cause.message);
      })
      .finally(() => {
        if (activeLibraryIdRef.current === requestLibraryId) setDocumentTreeLoading(false);
      });
  }, [viewMode, documentTree.length, documentTreeLoading, libraryId, onError]);

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
    setPulseProcessEvents([]);
    setPulseDraftAnswer("");
    setViewMode("graph");
    setDocumentTree([]);
    setActiveTreeNodeId(undefined);
    setNodeEvidenceDetail(undefined);
    setFocusedNodeId(undefined);
    setSelected(undefined);
    setSelectedRelation(undefined);
    setSelectedAggregate(undefined);
    setSelectedAoriNode(undefined);
    setSelectedAoriEdge(undefined);
    setResults([]);
    setActiveSearchChunkId(undefined);
    setRecords([]);
    setEdgeRecords([]);
    setAspectFilter(undefined);
    setAoriGraph(undefined);
    setAoriGraphMessage("");
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
    setSelectedAoriNode(undefined);
    setSelectedAoriEdge(undefined);
    setResults([]);
    setActiveSearchChunkId(undefined);
    if (isAoriMode) {
      setFocusedNodeId(undefined);
      void loadAoriGraph(activeAoriMode ?? "overview");
      return;
    }
    setAoriGraph(undefined);
    void loadGraph(focusedNodeId, view === "detail" && selected?.nodeType === "abstract" && selected.data.level === 1, view, [], undefined);
  }, [libraryId, refreshKey, status, type, aspect, view, focusedNodeId, pulseMode, visibleCurrentPulse?.pulse.id, isAoriMode, activeAoriMode, aoriVersionId, aoriScope, aoriViewMode]);

  useEffect(() => {
    if (selected?.nodeType !== "abstract") {
      setNodeEvidenceDetail(undefined);
      return;
    }
    const nodeId = selected.id;
    void api.nodeEvidenceDetail(nodeId)
      .then((detail) => {
        if (selected?.id === nodeId) setNodeEvidenceDetail(detail);
      })
      .catch(() => undefined);
  }, [selected?.id, selected?.nodeType]);

  const suggested = useMemo(
    () => edges.flatMap((edge) => edge.data?.entity?.relation?.status === "suggested" ? [edge.data.entity.relation] : []),
    [edges],
  );
  const titles = useMemo(
    () => new Map(records.flatMap((node) => node.nodeType === "abstract" ? [[node.id, node.data.title]] : [])),
    [records],
  );

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (isAoriMode) return;
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
    const startedInAoriMode = isAoriMode;
    setPulsing(true);
    setCurrentPulse(undefined);
    setPulseMode("normal");
    setPulseRevealCount(0);
    setPulsePlaying(false);
    setPulseStreamMessage("正在启动脉冲...");
    setPulseStreamHits([]);
    setPulseNavigationEvents([]);
    setPulseProcessEvents([]);
    setPulseDraftAnswer("");
    try {
      await api.streamPulse(requestLibraryId, question, pulseInputMode, (update) => {
        if (activeLibraryIdRef.current !== requestLibraryId) return;
        if (update.type === "start") {
          setPulseStreamMessage(update.mode === "progressive" ? "正在渐进式点亮图谱..." : "正在全量召回图谱...");
          return;
        }
        if (isPulseProcessEvent(update)) {
          setPulseStreamMessage(update.message);
          setPulseProcessEvents((events) => [...events, update].slice(-32));
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
          if (startedInAoriMode) {
            if (aoriGraph) {
              setNodes(aoriVisualNodes(aoriGraph, aoriViewMode, selectedAoriNode?.id));
              setEdges(displayAoriEdges(aoriGraph, aoriViewMode, selectedAoriNode?.id, selectedAoriEdge?.id));
            }
          } else {
            applyGraph(response.graph, layout, "current", 0, response);
          }
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
      setPulseProcessEvents([]);
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
      setPulseProcessEvents([]);
      setPulseDraftAnswer("");
      setPulseQuestion(response.pulse.question);
      setPulseInputMode(response.pulse.inputMode);
      setPulseMode("current");
      setPulseRevealCount(0);
      setPulsePlaying(true);
      if (isAoriMode) {
        if (aoriGraph) {
          setNodes(aoriVisualNodes(aoriGraph, aoriViewMode, selectedAoriNode?.id));
          setEdges(displayAoriEdges(aoriGraph, aoriViewMode, selectedAoriNode?.id, selectedAoriEdge?.id));
        }
      } else {
        applyGraph(response.graph, layout, "current", 0, response);
      }
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
      setPulseProcessEvents([]);
      if (isAoriMode) {
        if (aoriGraph) {
          setNodes(aoriVisualNodes(aoriGraph, aoriViewMode, selectedAoriNode?.id));
          setEdges(displayAoriEdges(aoriGraph, aoriViewMode, selectedAoriNode?.id, selectedAoriEdge?.id));
        }
        return;
      }
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
      if (isAoriMode) {
        if (aoriGraph) {
          setNodes(aoriVisualNodes(aoriGraph, aoriViewMode, selectedAoriNode?.id));
          setEdges(displayAoriEdges(aoriGraph, aoriViewMode, selectedAoriNode?.id, selectedAoriEdge?.id));
        }
      } else {
        applyGraph(response.graph, layout, nextMode, nextRevealCount, response);
      }
    } catch (cause) {
      if (activeLibraryIdRef.current !== requestLibraryId) return;
      onError((cause as Error).message);
    }
  };

  const review = async (relation: Relation, nextStatus: "accepted" | "rejected") => {
    if (isAoriMode) return;
    try {
      await api.reviewRelation(relation.id, nextStatus);
      await loadGraph(selected?.id, selected?.nodeType === "abstract", "detail");
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const onConnect = async (connection: Connection) => {
    if (isAoriMode) return;
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

  const changeGraphMode = (nextMode: GraphSurfaceMode) => {
    if (nextMode !== "legacy" && !aoriVersionId) return;
    setGraphMode(nextMode);
    setFocusedNodeId(undefined);
    setSelected(undefined);
    setSelectedRelation(undefined);
    setSelectedAggregate(undefined);
    setSelectedAoriNode(undefined);
    setSelectedAoriEdge(undefined);
    setResults([]);
    setActiveSearchChunkId(undefined);
    if (nextMode !== "legacy") {
      setPulseMode("normal");
      setPulseRevealCount(0);
      setPulsePlaying(false);
    }
  };

  const changeLayout = (nextLayout: LayoutMode) => {
    setLayout(nextLayout);
    if (isAoriMode) {
      if (aoriGraph) {
        setNodes(aoriVisualNodes(aoriGraph, aoriViewMode, selectedAoriNode?.id));
        setEdges(displayAoriEdges(aoriGraph, aoriViewMode, selectedAoriNode?.id, selectedAoriEdge?.id));
      }
      return;
    }
    const visibleGraph = revealPulseGraph(records, edgeRecords, pulseMode, visibleCurrentPulse, pulseRevealCount);
    setNodes(layoutNodes(visibleGraph.nodes, visibleGraph.edges, nextLayout, aspect || undefined, pulseMode, searchFocus));
    setEdges(displayEdges(visibleGraph.edges, nextLayout, pulseMode));
  };

  const changeAoriScope = (nextScope: AoriGraphScope) => {
    setSelectedAoriNode(undefined);
    setSelectedAoriEdge(undefined);
    setAoriScope(nextScope);
  };

  const changeAoriViewMode = (nextMode: AoriGraphViewMode) => {
    setAoriViewMode(nextMode);
    setLayout(layoutFromAoriViewMode(nextMode));
    if (aoriGraph) {
      setNodes(aoriVisualNodes(aoriGraph, nextMode, selectedAoriNode?.id));
      setEdges(displayAoriEdges(aoriGraph, nextMode, selectedAoriNode?.id, selectedAoriEdge?.id));
    }
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
    if (isAoriMode && aoriGraph) {
      if (hit.targetType === "relation") {
        const edge = aoriGraph.edges.find((record) =>
          record.id === hit.targetId ||
          record.assertionIds?.includes(hit.targetId) ||
          record.domainRelation === hit.label ||
          record.label === hit.label
        );
        if (edge) {
          setSelectedAoriEdge(edge);
          setSelectedAoriNode(undefined);
          setSelected(undefined);
          setSelectedRelation(undefined);
          setSelectedAggregate(undefined);
          return;
        }
      }
      const node = aoriGraph.nodes.find((record) =>
        record.id === hit.targetId ||
        record.chunkId === hit.targetId ||
        record.assertionId === hit.targetId ||
        record.relationId === hit.targetId ||
        record.entityId === hit.targetId ||
        record.documentId === hit.targetId
      );
      if (node) {
        setSelectedAoriNode(node);
        setSelectedAoriEdge(undefined);
        setSelected(undefined);
        setSelectedRelation(undefined);
        setSelectedAggregate(undefined);
        pendingFocusNodeIdRef.current = node.id;
        return;
      }
    }
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
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isAoriMode ? "AORI 图谱按切面浏览" : "模糊搜索 chunk 名称/内容..."}
              disabled={isAoriMode}
            />
            <button type="submit" disabled={isAoriMode}>搜索</button>
          </form>
        </div>
        <div className="toolbar-group">
          <span className="toolbar-label">筛选</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as RelationStatus | "")} disabled={isAoriMode}>
            <option value="">可见关系</option>
            {relationStatuses.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={type} onChange={(event) => setType(event.target.value as RelationType | "")} disabled={isAoriMode}>
            <option value="">所有类型</option>
            {relationTypes.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className="aspect-filter" value={aspect} onChange={(event) => setAspect(event.target.value as AspectKind | "")} disabled={isAoriMode}>
            <option value="">全部切面</option>
            {aspectKinds.map((item) => <option key={item} value={item}>{aspectLabels[item]}</option>)}
          </select>
        </div>
        <div className="toolbar-group toolbar-right">
          <span className="toolbar-label">视图</span>
          <div className="graph-depth" aria-label="工作区视图">
            {(["graph", "evidence", "document", "retrieval", "governance"] as WorkspaceViewMode[]).map((mode) => (
              <button key={mode} className={viewMode === mode ? "selected" : ""} onClick={() => setViewMode(mode)}>
                {workspaceViewLabels[mode]}
              </button>
            ))}
          </div>
          <div className="graph-depth" aria-label="图谱模式">
            {(["legacy", "aori_overview"] as GraphSurfaceMode[]).map((mode) => (
              <button
                key={mode}
                className={graphMode === mode ? "selected" : ""}
                disabled={mode !== "legacy" && !aoriVersionId}
                onClick={() => changeGraphMode(mode)}
              >
                {graphSurfaceLabels[mode]}
              </button>
            ))}
          </div>
          {graphMode === "legacy" && (
            <div className="graph-depth" aria-label="Legacy 图谱层级">
              <button className={view === "overview" ? "selected" : ""} onClick={() => { setFocusedNodeId(undefined); setView("overview"); }}>概览</button>
              <button className={view === "detail" ? "selected" : ""} onClick={() => { setFocusedNodeId(undefined); setView("detail"); }}>细节</button>
            </div>
          )}
          {isAoriMode && aoriScope === "document" && aoriDocuments.length > 0 && (
            <select
              className="aori-version-select"
              value={aoriVersionId ?? ""}
              onChange={(event) => {
                setAoriVersionId(event.target.value || undefined);
              }}
            >
              {aoriDocuments.map((document) => (
                <option key={document.latestVersion!.id} value={document.latestVersion!.id}>{document.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="pulse-toolbar">
        <div className="toolbar-group pulse-query">
          <span className="toolbar-label">脉冲</span>
          <form onSubmit={(event) => void runPulse(event)}>
            <input value={pulseQuestion} onChange={(event) => setPulseQuestion(event.target.value)} placeholder={isAoriMode ? "向 AORI 发起问题..." : "向图谱发起问题..."} />
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
            nodesConnectable={!isAoriMode && view === "detail"}
            onConnect={(connection) => void onConnect(connection)}
            onNodeClick={(_event, node) => {
              if (node.data.aori) {
                setSelectedAoriNode(node.data.aori);
                setSelectedAoriEdge(undefined);
                setSelected(undefined);
                setSelectedRelation(undefined);
                setSelectedAggregate(undefined);
                return;
              }
              const entity = node.data.entity;
              if (!entity) return;
              setSelected(entity);
              setSelectedRelation(undefined);
              setSelectedAggregate(undefined);
              setSelectedAoriNode(undefined);
              setSelectedAoriEdge(undefined);
              if (entity.nodeType === "abstract" && entity.data.level === 2) {
                setFocusedNodeId(node.id);
                setView("detail");
              } else if (entity.nodeType === "abstract" && view === "detail") {
                setFocusedNodeId(node.id);
              }
            }}
            onEdgeClick={(_event, edge) => {
              if (edge.data?.aori) {
                setSelectedAoriEdge(edge.data.aori);
                setSelectedAoriNode(undefined);
                setSelected(undefined);
                setSelectedRelation(undefined);
                setSelectedAggregate(undefined);
                return;
              }
              setSelectedRelation(edge.data?.entity?.relation);
              setSelectedAggregate(edge.data?.entity?.aggregate);
              setSelected(undefined);
              setSelectedAoriNode(undefined);
              setSelectedAoriEdge(undefined);
            }}
            minZoom={0.35}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.16, minZoom: 0.82, maxZoom: 1.18 }}
          >
            <Background color="#28334c" gap={24} />
            <MiniMap nodeColor={miniMapNodeColor} />
            <Controls className="graph-controls" position="bottom-left">
              {isAoriMode ? (
                <>
                  <ControlButton className={aoriScope === "document" ? "layout-active" : ""} onClick={() => changeAoriScope("document")} title="Document AORI" aria-label="Document AORI">文</ControlButton>
                  <ControlButton className={aoriScope === "library" ? "layout-active" : ""} onClick={() => changeAoriScope("library")} title="Library AORI" aria-label="Library AORI">库</ControlButton>
                  <ControlButton className={aoriViewMode === "layer" ? "layout-active" : ""} onClick={() => changeAoriViewMode("layer")} title={aoriViewModeLabels.layer} aria-label={aoriViewModeLabels.layer}>层</ControlButton>
                  <ControlButton className={aoriViewMode === "network" ? "layout-active" : ""} onClick={() => changeAoriViewMode("network")} title={aoriViewModeLabels.network} aria-label={aoriViewModeLabels.network}>网</ControlButton>
                  <ControlButton className={aoriViewMode === "tree" ? "layout-active" : ""} onClick={() => changeAoriViewMode("tree")} title={aoriViewModeLabels.tree} aria-label={aoriViewModeLabels.tree}>树</ControlButton>
                </>
              ) : (
                <>
                  <ControlButton className={layout === "layered" ? "layout-active" : ""} onClick={() => changeLayout("layered")} title="分层布局" aria-label="分层布局">层</ControlButton>
                  <ControlButton className={layout === "network" ? "layout-active" : ""} onClick={() => changeLayout("network")} title="网状布局" aria-label="网状布局">网</ControlButton>
                  <ControlButton className={layout === "tree" ? "layout-active" : ""} onClick={() => changeLayout("tree")} title="树形布局" aria-label="树形布局">树</ControlButton>
                </>
              )}
            </Controls>
          </ReactFlow>
          {!isAoriMode && aspect && records.length === 0 && (
            <div className="graph-empty">
              {aspectFilter?.anyLabeled
                ? `当前没有“${aspectLabels[aspect]}”切面节点。`
                : "当前资料尚未生成切面标签，请重新分析资料后再筛选。"}
            </div>
          )}
          {isAoriMode && !aoriGraph && (
            <div className="graph-empty">{aoriGraphMessage || "当前没有可显示的 AORI 图谱。"}</div>
          )}
        </div>
        <aside className="inspector">
          {viewMode === "governance" ? (
            <GovernanceTracePanel feed={ruleGovernanceFeed} />
          ) : (
            <RuleGovernanceCard feed={ruleGovernanceFeed} />
          )}
          {isAoriMode && (
            <>
              <AoriGraphInspector graph={aoriGraph} document={activeAoriDocument} mode={activeAoriMode ?? "overview"} />
              {selectedAoriNode && (
                <AoriSelectedNode
                  node={selectedAoriNode}
                  graph={aoriGraph}
                  document={activeAoriDocument}
                  onOpenCitation={onOpenCitation}
                />
              )}
              {selectedAoriEdge && <AoriSelectedEdge edge={selectedAoriEdge} />}
            </>
          )}
          {!isAoriMode && viewMode === "document" && (
            <DocumentTreePanel
              nodes={documentTree}
              loading={documentTreeLoading}
              activeNodeId={activeTreeNodeId}
              evidencePack={visibleCurrentPulse?.evidencePack}
              onSelect={(node) => {
                setActiveTreeNodeId(node.id);
                const chunkId = node.sourceChunkIds[0];
                const graphNode = chunkId ? records.find((record) => record.id === chunkId) : undefined;
                if (graphNode) setSelected(graphNode);
              }}
            />
          )}
          {viewMode === "evidence" && (
            <EvidencePackPanel evidencePack={visibleCurrentPulse?.evidencePack} onOpenChunk={(chunkId) => openPulseHit({
              id: chunkId,
              pulseId: visibleCurrentPulse?.pulse.id ?? "",
              libraryId,
              targetType: "chunk",
              targetId: chunkId,
              score: 1,
              reason: "EvidencePack",
              pathRole: "direct",
              stepIndex: null,
              observation: null,
              rationale: null,
              label: chunkId,
              excerpt: null,
            })} />
          )}
          {viewMode === "retrieval" && (
            <RetrievalTracePanel evidencePack={visibleCurrentPulse?.evidencePack} />
          )}
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
              <PulseProcessLog events={pulseProcessEvents} />
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
                    <PulseHitContent hit={hit} />
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
              <PulseProcessLog events={pulseProcessEvents} limit={10} />
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
                    <PulseHitContent hit={hit} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {!isAoriMode && (view === "detail" ? <div className="manual-edge">
            <h3>连边工具</h3>
            <select value={manualType} onChange={(event) => setManualType(event.target.value as RelationType)}>
              {relationTypes.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <input value={manualReason} onChange={(event) => setManualReason(event.target.value)} />
            <small>从一个抽象节点拖到另一个节点以创建关系。</small>
          </div> : <div className="overview-hint">
            <h3>主题概览</h3>
            <p>主题节点折叠了底层概念；聚合边括号内为底层关系数量。点击主题进入可审核细节。</p>
          </div>)}
          {!isAoriMode && results.length > 0 && (
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
          {!isAoriMode && selected && (
            <>
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
              {selected.nodeType === "abstract" && (
                <NodeEvidenceDetail detail={nodeEvidenceDetail} onOpenCitation={onOpenCitation} />
              )}
            </>
          )}
          {!isAoriMode && selectedRelation && (
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
          {!isAoriMode && selectedAggregate && (
            <div className="relation-detail">
              <h3>聚合关系：{selectedAggregate.type}</h3>
              <p>该主题连线汇总了 {selectedAggregate.count} 条底层关系。</p>
              <p className="muted">切换到细节视图查看证据并执行审核。</p>
            </div>
          )}
          {!isAoriMode && <div className="suggestions">
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
          </div>}
        </aside>
      </div>
    </section>
  );
}

function AoriGraphInspector({
  graph,
  document,
  mode,
}: {
  graph?: AoriGraphView | undefined;
  document?: Document | undefined;
  mode: AoriGraphMode;
}) {
  if (!graph) {
    return (
      <div className="aori-graph-panel">
        <div className="pulse-panel-heading">
          <h3>AORI 图谱</h3>
          <small>{mode}</small>
        </div>
        <p className="muted">暂无可用 AORI 图谱。</p>
      </div>
    );
  }
  const diagnostics = graph.diagnostics;
  const kindDistribution = Object.entries(diagnostics.aspectKindDistribution)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
    .slice(0, 8);
  return (
    <div className="aori-graph-panel">
      <div className="pulse-panel-heading">
        <h3>AORI 图谱</h3>
        <small>{document?.name ?? graph.versionId} · {mode}</small>
      </div>
      <div className="aori-status-grid">
        <span><strong>{diagnostics.aspectCount}</strong>切面</span>
        <span><strong>{diagnostics.itemCount}</strong>切面项</span>
        <span><strong>{diagnostics.relationCount}</strong>动态关系</span>
        <span><strong>{diagnostics.isolatedItemCount}</strong>孤立项</span>
        <span><strong>{diagnostics.unsupportedItemCount}</strong>unsupported</span>
        <span><strong>{diagnostics.fallbackOnlyItemCount}</strong>fallback</span>
      </div>
      {kindDistribution.length > 0 && (
        <div className="aori-distribution-list">
          <strong>AspectKind</strong>
          {kindDistribution.map(([label, count]) => (
            <span key={label}><em>{aspectLabels[label as AspectKind] ?? label}</em><small>{count}</small></span>
          ))}
        </div>
      )}
      {diagnostics.domainKindTopK.length > 0 && (
        <div className="aori-distribution-list">
          <strong>DomainKind</strong>
          {diagnostics.domainKindTopK.slice(0, 6).map((item) => (
            <span key={item.label}><em>{item.label}</em><small>{item.count}</small></span>
          ))}
        </div>
      )}
      {diagnostics.domainRelationTopK.length > 0 && (
        <div className="aori-distribution-list">
          <strong>DomainRelation</strong>
          {diagnostics.domainRelationTopK.slice(0, 6).map((item) => (
            <span key={item.label}><em>{item.label}</em><small>{item.count}</small></span>
          ))}
        </div>
      )}
      {diagnostics.warnings.length > 0 && (
        <div className="aori-warning-list">
          <strong>Warnings</strong>
          {diagnostics.warnings.slice(0, 8).map((warning, index) => <small key={`${warning}-${index}`}>{warning}</small>)}
        </div>
      )}
    </div>
  );
}

function AoriStatusTags({ record }: { record: AoriGraphNode | AoriGraphEdge }) {
  return (
    <div className="aori-tags">
      {"type" in record && <span>{record.type}</span>}
      {record.evidenceStatus && <span>{evidenceStatusLabels[record.evidenceStatus]}</span>}
      {record.closureStatus && <span>{closureStatusLabels[record.closureStatus]}</span>}
      {"fallbackOnly" in record && record.fallbackOnly && <span>fallback</span>}
      {confidenceText(record.confidence) && <span>{confidenceText(record.confidence)}</span>}
    </div>
  );
}

function AoriSelectedNode({
  node,
  graph,
  document,
  onOpenCitation,
}: {
  node: AoriGraphNode;
  graph?: AoriGraphView | undefined;
  document?: Document | undefined;
  onOpenCitation: (citation: Citation) => void;
}) {
  return (
    <div className="aori-detail-card node-detail">
      <h3>{node.label}</h3>
      <small>{aoriNodeTypeLabels[node.type]}{node.kind ? ` · ${aspectLabels[node.kind]}` : ""}{node.domainKind ? ` · ${node.domainKind}` : ""}</small>
      {node.summary && <p>{node.summary}</p>}
      <AoriStatusTags record={node} />
      {node.type === "source_chunk" && node.chunkId && graph && (
        <div className="actions">
          <button
            type="button"
            onClick={() => onOpenCitation({
              versionId: graph.versionId,
              chunkId: node.chunkId!,
              documentName: document?.name ?? "AORI source",
              mediaType: document?.mediaType ?? "text/plain",
              headingPath: null,
              pageNumber: null,
              startLine: null,
              endLine: null,
              blockId: null,
              excerpt: node.label,
            })}
          >
            查看原文
          </button>
        </div>
      )}
    </div>
  );
}

function AoriSelectedEdge({ edge }: { edge: AoriGraphEdge }) {
  return (
    <div className="aori-detail-card relation-detail">
      <h3>{edge.domainRelation || edge.label}</h3>
      <p>{edge.source} → {edge.target}</p>
      <AoriStatusTags record={edge} />
      <div className="aori-edge-meta">
        <span>{edge.type}</span>
        {edge.baseRelation && <span>{edge.baseRelation}</span>}
        {edge.domainRelation && <span>{edge.domainRelation}</span>}
      </div>
    </div>
  );
}

function DocumentTreePanel({
  nodes,
  loading,
  activeNodeId,
  evidencePack,
  onSelect,
}: {
  nodes: DocumentTreeNode[];
  loading: boolean;
  activeNodeId?: string | undefined;
  evidencePack?: EvidencePack | undefined;
  onSelect: (node: DocumentTreeNode) => void;
}) {
  const evidenceNodeIds = new Set(evidencePack?.treeNodes.map((node) => node.id) ?? []);
  const visible = nodes.slice(0, 240);
  return (
    <div className="workspace-panel document-tree-panel">
      <div className="pulse-panel-heading">
        <h3>文档结构树</h3>
        <small>{loading ? "加载中" : `${nodes.length} 个节点`}</small>
      </div>
      {visible.length === 0 && <p className="muted">{loading ? "正在读取文档结构..." : "暂无 DocumentTreeNode，请重新导入或分析文档。"}</p>}
      <div className="document-tree-list">
        {visible.map((node) => (
          <button
            type="button"
            key={node.id}
            className={`${activeNodeId === node.id ? "selected" : ""} ${evidenceNodeIds.has(node.id) ? "has-evidence" : ""}`}
            style={{ paddingLeft: `${Math.min(node.level, 5) * 12 + 10}px` }}
            onClick={() => onSelect(node)}
          >
            <span>{node.nodeType}</span>
            <strong>{(node.headingPath.at(-1) ?? node.summary.slice(0, 48)) || "未命名节点"}</strong>
            <small>{node.summary || node.text.slice(0, 80)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function EvidencePackPanel({ evidencePack, onOpenChunk }: { evidencePack?: EvidencePack | undefined; onOpenChunk: (chunkId: string) => void }) {
  if (!evidencePack) {
    return (
      <div className="workspace-panel">
        <h3>证据包</h3>
        <p className="muted">运行或打开一个新版脉冲后可查看 EvidencePack。</p>
      </div>
    );
  }
  const skillDiagnostics = evidencePack.diagnostics as {
    answerPipeline?: string;
    selectedSkill?: string;
    targetAspects?: Array<{ title: string }>;
    facetResult?: { finalCount?: number; total?: number; unit?: string };
    argumentResult?: { pairs?: unknown[] };
    timelineResult?: { events?: unknown[] };
    fallbackTraversalUsed?: boolean;
  } | undefined;
  return (
    <div className="workspace-panel evidence-pack-panel">
      <div className="pulse-panel-heading">
        <h3>证据包</h3>
        <small>
          {evidencePack.evidenceRows.length} rows · {evidencePack.citations.length} citations
          {evidencePack.chunkEvidencePack ? ` · ${evidencePack.chunkEvidencePack.selectedChunks.length} chunks` : ""}
          {evidencePack.pipeline ? ` · ${evidencePack.pipeline.indexProfile} ${evidencePack.pipeline.packBuilder}` : ""}
        </small>
      </div>
      {evidencePack.pipeline && (
        <div className="pipeline-strip">
          <span>Generated by {evidencePack.pipeline.indexProfile} {evidencePack.pipeline.packBuilder}</span>
          <span>{evidencePack.pipeline.model}</span>
          <span>{evidencePack.pipeline.promptVersion}</span>
        </div>
      )}
      {evidencePack.chunkEvidencePack && (
        <div className="pipeline-strip">
          <span>{evidencePack.chunkEvidencePack.mode}</span>
          <span>{evidencePack.chunkEvidencePack.diagnostics.visitedNodeCount} visited nodes</span>
          <span>{evidencePack.chunkEvidencePack.diagnostics.selectedChunkCount} selected chunks</span>
        </div>
      )}
      {skillDiagnostics?.answerPipeline && (
        <div className="pipeline-strip">
          <span>{skillDiagnostics.answerPipeline}</span>
          {skillDiagnostics.selectedSkill && <span>{skillDiagnostics.selectedSkill}</span>}
          {skillDiagnostics.targetAspects?.length ? <span>{skillDiagnostics.targetAspects.map((aspect) => aspect.title).join(" / ")}</span> : null}
          {typeof skillDiagnostics.facetResult?.finalCount === "number" && <span>count {skillDiagnostics.facetResult.finalCount}</span>}
          {typeof skillDiagnostics.facetResult?.total === "number" && <span>sum {skillDiagnostics.facetResult.total} {skillDiagnostics.facetResult.unit ?? ""}</span>}
          {skillDiagnostics.argumentResult?.pairs && <span>pairs {skillDiagnostics.argumentResult.pairs.length}</span>}
          {skillDiagnostics.timelineResult?.events && <span>events {skillDiagnostics.timelineResult.events.length}</span>}
          {skillDiagnostics.fallbackTraversalUsed && <span>fallback traversal</span>}
        </div>
      )}
      {(evidencePack.routePlan || evidencePack.questionTaskFrame || evidencePack.evidenceTables?.length) && (
        <div className="pipeline-strip">
          {evidencePack.routePlan && <span>route {evidencePack.routePlan.routeType}</span>}
          {evidencePack.questionTaskFrame && <span>task {evidencePack.questionTaskFrame.taskIntent.shortName}</span>}
          {evidencePack.evidenceTables && <span>{evidencePack.evidenceTables.length} tables</span>}
          {evidencePack.fallbackRetrieval && <span>{evidencePack.fallbackRetrieval.length} fallback steps</span>}
        </div>
      )}
      {evidencePack.reconciliation && (
        <div className="reconciliation-strip">
          <span>declared {evidencePack.reconciliation.declaredTotal ?? "-"}</span>
          <span>sum {evidencePack.reconciliation.itemizedSum ?? "-"}</span>
          <span>diff {evidencePack.reconciliation.difference ?? "-"}</span>
          <strong>{evidencePack.reconciliation.closed ? "closed" : "open"}</strong>
        </div>
      )}
      {evidencePack.chunkEvidencePack && (
        <div className="evidence-table">
          {evidencePack.chunkEvidencePack.selectedChunks.slice(0, 40).map((entry) => (
            <button type="button" key={entry.chunkId} onClick={() => onOpenChunk(entry.chunkId)}>
              <span>{entry.confidence.toFixed(2)} · {entry.path.map((step) => step.title).join(" / ")}</span>
              <strong>{entry.chunkId}</strong>
              <small>{entry.relevanceReason}</small>
            </button>
          ))}
        </div>
      )}
      {evidencePack.chunkSummaries && evidencePack.chunkSummaries.length > 0 && (
        <div className="evidence-gaps">
          <strong>Chunk summaries</strong>
          {evidencePack.chunkSummaries.slice(0, 20).map((summary) => (
            <small key={summary.chunkId}>
              {summary.relevant ? "relevant" : "irrelevant"} · {summary.usage ?? "unknown"} · {summary.chunkId} · {summary.shortSummary}
            </small>
          ))}
        </div>
      )}
      <div className="evidence-table">
        {evidencePack.evidenceRows.slice(0, 80).map((row) => (
          <button type="button" key={row.rowId} onClick={() => onOpenChunk(row.evidenceChunkId)}>
            <span>{row.evidenceType}</span>
            <strong>{row.claimText}</strong>
            <small>{row.evidenceQuote}</small>
          </button>
        ))}
      </div>
      {evidencePack.gaps.length > 0 && (
        <div className="evidence-gaps">
          <strong>Gaps</strong>
          {evidencePack.gaps.map((gap, index) => (
            <small key={`${gap.type}-${index}`}>{gap.severity} · {gap.description}</small>
          ))}
        </div>
      )}
    </div>
  );
}

function RetrievalTracePanel({ evidencePack }: { evidencePack?: EvidencePack | undefined }) {
  return (
    <div className="workspace-panel retrieval-trace-panel">
      <div className="pulse-panel-heading">
        <h3>检索路径</h3>
        <small>{evidencePack ? `${evidencePack.retrievalTrace.length} steps` : "等待脉冲"}</small>
      </div>
      {!evidencePack && <p className="muted">运行或打开一个新版脉冲后可查看 RetrievalTrace。</p>}
      {evidencePack?.retrievalTrace.map((trace, index) => (
        <div className={`retrieval-step retrieval-${trace.status}`} key={`${trace.stepIndex}-${trace.tool}-${index}`}>
          <span>{trace.stepIndex} · {trace.tool}</span>
          <strong>{trace.purpose}</strong>
          <small>{trace.query ? `query: ${trace.query}` : "no query"} · new rows {trace.newEvidenceRowCount} · outputs {trace.outputIds.length}</small>
        </div>
      ))}
    </div>
  );
}

function GovernanceTracePanel({ feed }: { feed: RuleGovernanceFeed }) {
  return (
    <div className="workspace-panel">
      <RuleGovernanceCard feed={feed} />
    </div>
  );
}

function NodeEvidenceDetail({
  detail,
  onOpenCitation,
}: {
  detail?: Awaited<ReturnType<typeof api.nodeEvidenceDetail>> | undefined;
  onOpenCitation: (citation: Citation) => void;
}) {
  if (!detail) return <div className="node-evidence-detail"><p className="muted">正在读取节点证据...</p></div>;
  return (
    <div className="node-evidence-detail">
      <h3>节点证据详情</h3>
      <p>{detail.node.summary}</p>
      <CitationList citations={detail.node.citations} onOpenCitation={onOpenCitation} />
      {detail.treeNodes.length > 0 && (
        <div className="evidence-gaps">
          <strong>来源结构</strong>
          {detail.treeNodes.slice(0, 8).map((node) => (
            <small key={node.id}>{node.headingPath.join(" / ") || node.nodeType} · {node.summary}</small>
          ))}
        </div>
      )}
      {detail.parentChunks.length > 0 && (
        <div className="evidence-gaps">
          <strong>Parent context</strong>
          {detail.parentChunks.slice(0, 4).map((link) => (
            <small key={link.childChunkId}>{link.parentText.slice(0, 180)}</small>
          ))}
        </div>
      )}
      {detail.relations.length > 0 && (
        <div className="evidence-gaps">
          <strong>Relations</strong>
          {detail.relations.slice(0, 8).map((relation) => (
            <small key={relation.id}>{relation.type} · {relation.reason}</small>
          ))}
        </div>
      )}
    </div>
  );
}

function RuleGovernanceCard({ feed }: { feed: RuleGovernanceFeed }) {
  const summary = feed.summary;
  const traces = feed.traces.slice(-20).reverse();
  return (
    <div className="rule-governance-card">
      <div className="rule-governance-heading">
        <h3>关系规则治理</h3>
        <small>{feed.stage ? graphRuleStageLabels[feed.stage] : "等待事件"}</small>
      </div>
      <div className="rule-governance-counts">
        <span><strong>{summary?.categoryCounts.graph_validity ?? 0}</strong>图合法性</span>
        <span><strong>{summary?.categoryCounts.relation_algebra ?? 0}</strong>关系代数</span>
        <span><strong>{summary?.categoryCounts.semantic_coverage ?? 0}</strong>语义覆盖</span>
        <span><strong>{summary?.categoryCounts.graph_evolution ?? 0}</strong>图演化</span>
      </div>
      <div className="rule-governance-decisions">
        <span>kept {summary?.keptCount ?? 0}</span>
        <span>downgraded {summary?.downgradedCount ?? 0}</span>
        <span>excluded {summary?.excludedCount ?? 0}</span>
        <span>needs_review {summary?.reviewCount ?? 0}</span>
      </div>
      <div className="rule-governance-traces">
        {traces.length === 0 ? (
          <p className="muted">暂无治理 trace。</p>
        ) : traces.map((trace) => (
          <div className={`rule-trace rule-trace-${trace.decision}`} key={trace.traceId}>
            <span>{graphRuleCategoryLabels[trace.category]} · {graphRuleDecisionLabels[trace.decision]}</span>
            <strong>
              {trace.sourceKey && trace.targetKey
                ? `${trace.sourceKey} → ${trace.targetKey}`
                : trace.nodeId ?? trace.relationId ?? trace.action}
            </strong>
            <small>{trace.reason}</small>
          </div>
        ))}
      </div>
    </div>
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
