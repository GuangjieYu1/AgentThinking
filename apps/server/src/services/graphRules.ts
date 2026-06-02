import { randomUUID } from "node:crypto";
import type {
  Chunk,
  ExtractionOutput,
  GraphRuleAction,
  GraphRuleDecision,
  GraphRuleStage,
  GraphRuleTrace,
  GraphRulesSummary,
  RelationType,
} from "@agent-thinking/contracts";

type ExtractionNode = ExtractionOutput["nodes"][number];
type ExtractionRelation = ExtractionOutput["relations"][number];

export interface GraphRulesResult {
  output: ExtractionOutput;
  traces: GraphRuleTrace[];
  summary: GraphRulesSummary;
}

export interface GraphDiff {
  addedNodes: string[];
  removedNodes: string[];
  updatedNodes: string[];
  addedRelations: string[];
  removedRelations: string[];
  updatedRelations: string[];
  downgradedRelations: string[];
  excludedByRules: string[];
  needsReviewRelations: string[];
}

interface WorkingRelation {
  tempId: string;
  relation: ExtractionRelation;
  warnings: string[];
  decision: GraphRuleDecision;
  excluded: boolean;
}

const strongRelationTypes = new Set<RelationType>([
  "supports",
  "contradicts",
  "explains",
  "depends_on",
  "example_of",
]);

function now(): string {
  return new Date().toISOString();
}

function categoryCounts(): GraphRulesSummary["categoryCounts"] {
  return {
    graph_validity: 0,
    relation_algebra: 0,
    semantic_coverage: 0,
    graph_evolution: 0,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function relationSignature(relation: Pick<ExtractionRelation, "sourceKey" | "targetKey" | "type">): string {
  return `${relation.sourceKey}::${relation.targetKey}::${relation.type}`;
}

function relationDisplay(relation: Pick<ExtractionRelation, "sourceKey" | "targetKey" | "type">): string {
  return `${relation.sourceKey} -[${relation.type}]-> ${relation.targetKey}`;
}

function normalizedConfidence(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value ?? 0.5));
}

function makeTrace(input: {
  batchId?: string;
  sequence?: number;
  stage?: GraphRuleStage;
  category: GraphRuleTrace["category"];
  action: GraphRuleAction;
  relationTempId?: string;
  relationId?: string;
  nodeId?: string;
  sourceKey?: string;
  targetKey?: string;
  originalType?: string;
  finalType?: string;
  originalConfidence?: number;
  finalConfidence?: number;
  decision: GraphRuleDecision;
  warnings?: string[];
  reason: string;
  evidenceChunkIds?: string[];
}): GraphRuleTrace {
  const targetType = input.nodeId ? "node" : input.relationId || input.relationTempId || input.sourceKey || input.targetKey ? "relation" : "graph";
  const targetId = input.nodeId ?? input.relationId ?? input.relationTempId ?? (
    input.sourceKey || input.targetKey ? `${input.sourceKey ?? "?"}->${input.targetKey ?? "?"}` : input.action
  );
  return {
    traceId: randomUUID(),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
    ruleId: input.action,
    category: input.category,
    action: input.action,
    targetType,
    targetId,
    before: targetType === "relation" ? {
      sourceKey: input.sourceKey,
      targetKey: input.targetKey,
      type: input.originalType,
      confidence: input.originalConfidence,
    } : input.nodeId ? { nodeId: input.nodeId } : undefined,
    after: input.decision === "excluded_from_graph" ? null : targetType === "relation" ? {
      sourceKey: input.sourceKey,
      targetKey: input.targetKey,
      type: input.finalType,
      confidence: input.finalConfidence,
    } : input.nodeId ? { nodeId: input.nodeId } : undefined,
    severity: input.decision === "excluded_from_graph" ? "high" : input.decision === "needs_review" ? "medium" : "low",
    ...(input.relationTempId ? { relationTempId: input.relationTempId } : {}),
    ...(input.relationId ? { relationId: input.relationId } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
    ...(input.targetKey ? { targetKey: input.targetKey } : {}),
    ...(input.originalType !== undefined ? { originalType: input.originalType } : {}),
    ...(input.finalType !== undefined ? { finalType: input.finalType } : {}),
    ...(input.originalConfidence !== undefined ? { originalConfidence: input.originalConfidence } : {}),
    ...(input.finalConfidence !== undefined ? { finalConfidence: input.finalConfidence } : {}),
    decision: input.decision,
    warnings: input.warnings ?? [],
    reason: input.reason,
    evidenceChunkIds: input.evidenceChunkIds ?? [],
    timestamp: now(),
  };
}

function markDecision(relation: WorkingRelation, next: GraphRuleDecision): void {
  if (relation.decision === "excluded_from_graph" || relation.decision === "needs_review") return;
  relation.decision = next;
}

function traceSummary(
  totalRelations: number,
  relations: WorkingRelation[],
  traces: GraphRuleTrace[],
): GraphRulesSummary {
  const keptCount = relations.filter((entry) => !entry.excluded && entry.decision === "kept").length;
  const downgradedCount = relations.filter((entry) => !entry.excluded && entry.decision === "downgraded").length;
  const reviewCount = relations.filter((entry) => !entry.excluded && entry.decision === "needs_review").length;
  const excludedCount = relations.filter((entry) => entry.excluded).length;
  const counts = categoryCounts();
  for (const trace of traces) counts[trace.category] += 1;
  return {
    totalRelations,
    keptCount,
    downgradedCount,
    excludedCount,
    droppedCount: excludedCount,
    reviewCount,
    warningCount: traces.filter((trace) => trace.warnings.length > 0).length,
    categoryCounts: counts,
  };
}

function allowedChunkIdSet(allowedChunks?: Chunk[] | Set<string>): Set<string> {
  if (!allowedChunks) return new Set<string>();
  return allowedChunks instanceof Set ? allowedChunks : new Set(allowedChunks.map((chunk) => chunk.id));
}

function weakFallbackConfidence(relation: ExtractionRelation): number {
  if (relation.originalType && relation.originalType !== relation.type) return Math.min(relation.confidence, 0.3);
  return Math.min(relation.confidence, 0.6);
}

export function getInverseRelationLabel(type: RelationType): string {
  switch (type) {
    case "supports":
      return "supported_by";
    case "contradicts":
      return "contradicts";
    case "explains":
      return "explained_by";
    case "depends_on":
      return "prerequisite_for";
    case "example_of":
      return "has_example";
    default:
      return "related_to";
  }
}

export function composeRelationTypes(
  left: RelationType,
  right: RelationType,
): "possible_inference_path" | "weak_path" | "review" {
  if (left === "related_to" || right === "related_to") return "weak_path";
  const table: Record<RelationType, Partial<Record<RelationType, "possible_inference_path" | "weak_path" | "review">>> = {
    supports: {
      supports: "possible_inference_path",
      contradicts: "review",
      explains: "review",
      depends_on: "review",
      example_of: "possible_inference_path",
      related_to: "weak_path",
    },
    explains: {
      supports: "review",
      explains: "possible_inference_path",
      depends_on: "review",
      contradicts: "review",
      example_of: "weak_path",
      related_to: "weak_path",
    },
    depends_on: {
      supports: "review",
      explains: "review",
      depends_on: "possible_inference_path",
      contradicts: "review",
      example_of: "weak_path",
      related_to: "weak_path",
    },
    contradicts: {
      supports: "review",
      explains: "review",
      depends_on: "review",
      contradicts: "review",
      example_of: "weak_path",
      related_to: "weak_path",
    },
    example_of: {
      supports: "possible_inference_path",
      explains: "weak_path",
      depends_on: "weak_path",
      contradicts: "review",
      example_of: "weak_path",
      related_to: "weak_path",
    },
    related_to: {
      supports: "weak_path",
      explains: "weak_path",
      depends_on: "weak_path",
      contradicts: "weak_path",
      example_of: "weak_path",
      related_to: "weak_path",
    },
  };
  return table[left][right] ?? "review";
}

export function requiresReviewByComposition(left: RelationType, right: RelationType): boolean {
  return composeRelationTypes(left, right) === "review";
}

export function applyGraphRulesToExtraction(
  extraction: ExtractionOutput,
  options: { allowedChunks?: Chunk[] | Set<string>; mode?: GraphRuleStage } = {},
): GraphRulesResult {
  const batchId = randomUUID();
  const allowedChunkIds = allowedChunkIdSet(options.allowedChunks);
  const nodes = extraction.nodes.map((node) => ({ ...node }));
  const nodeByKey = new Map<string, ExtractionNode>();
  for (const node of nodes) {
    if (!nodeByKey.has(node.key)) nodeByKey.set(node.key, node);
  }
  const traces: GraphRuleTrace[] = [];
  const working = extraction.relations.map<WorkingRelation>((relation, index) => ({
    tempId: `r${index + 1}`,
    relation: {
      ...relation,
      evidenceChunkIds: [...relation.evidenceChunkIds],
      ruleWarnings: [...(relation.ruleWarnings ?? [])],
      ruleDecision: relation.ruleDecision,
    },
    warnings: [...(relation.ruleWarnings ?? [])],
    decision: relation.ruleDecision ?? "kept",
    excluded: false,
  }));

  for (const entry of working) {
    const relation = entry.relation;
    const sourceExists = nodeByKey.has(relation.sourceKey);
    const targetExists = nodeByKey.has(relation.targetKey);
    if (!sourceExists || !targetExists) {
      entry.excluded = true;
      entry.decision = "excluded_from_graph";
      traces.push(makeTrace({
        category: "graph_validity",
        action: "dangling_relation_dropped",
        relationTempId: entry.tempId,
        sourceKey: relation.sourceKey,
        targetKey: relation.targetKey,
        originalType: relation.originalType ?? relation.type,
        finalType: relation.type,
        originalConfidence: relation.originalConfidence ?? relation.confidence,
        finalConfidence: relation.confidence,
        decision: "excluded_from_graph",
        reason: "关系引用了不存在的源节点或目标节点，已从候选图谱中删除。",
        evidenceChunkIds: relation.evidenceChunkIds,
      }));
      continue;
    }
    if (relation.sourceKey === relation.targetKey) {
      entry.excluded = true;
      entry.decision = "excluded_from_graph";
      traces.push(makeTrace({
        category: "graph_validity",
        action: "self_loop_dropped",
        relationTempId: entry.tempId,
        sourceKey: relation.sourceKey,
        targetKey: relation.targetKey,
        originalType: relation.originalType ?? relation.type,
        finalType: relation.type,
        decision: "excluded_from_graph",
        reason: "自环关系默认不可信，已从候选图谱中删除。",
        evidenceChunkIds: relation.evidenceChunkIds,
      }));
      continue;
    }

    if (allowedChunkIds.size > 0) {
      const filteredEvidence = relation.evidenceChunkIds.filter((chunkId) => allowedChunkIds.has(chunkId));
      if (filteredEvidence.length !== relation.evidenceChunkIds.length) {
        traces.push(makeTrace({
          category: "graph_validity",
          action: "invalid_evidence_filtered",
          relationTempId: entry.tempId,
          sourceKey: relation.sourceKey,
          targetKey: relation.targetKey,
          originalType: relation.originalType ?? relation.type,
          finalType: relation.type,
          originalConfidence: relation.originalConfidence ?? relation.confidence,
          finalConfidence: relation.confidence,
          decision: entry.decision,
          warnings: ["存在不属于当前原文范围的证据 chunk，已过滤。"],
          reason: "过滤了不在允许集合内的证据 chunk。",
          evidenceChunkIds: filteredEvidence,
        }));
        relation.evidenceChunkIds = filteredEvidence;
        entry.warnings.push("已过滤无效证据 chunk");
      }
    }

    if (relation.originalConfidence !== undefined && relation.originalConfidence !== relation.confidence) {
      traces.push(makeTrace({
        category: "graph_validity",
        action: "confidence_normalized",
        relationTempId: entry.tempId,
        sourceKey: relation.sourceKey,
        targetKey: relation.targetKey,
        originalType: relation.originalType ?? relation.type,
        finalType: relation.type,
        originalConfidence: relation.originalConfidence,
        finalConfidence: relation.confidence,
        decision: entry.decision,
        reason: "关系置信度在 sanitize 阶段已归一到 0 到 1。",
        evidenceChunkIds: relation.evidenceChunkIds,
      }));
    }

    const safeConfidence = normalizedConfidence(relation.confidence);
    if (safeConfidence !== relation.confidence) {
      traces.push(makeTrace({
        category: "graph_validity",
        action: "confidence_normalized",
        relationTempId: entry.tempId,
        sourceKey: relation.sourceKey,
        targetKey: relation.targetKey,
        originalType: relation.originalType ?? relation.type,
        finalType: relation.type,
        originalConfidence: relation.originalConfidence ?? relation.confidence,
        finalConfidence: safeConfidence,
        decision: entry.decision,
        reason: "关系置信度已归一到 0 到 1。",
        evidenceChunkIds: relation.evidenceChunkIds,
      }));
      relation.originalConfidence ??= relation.confidence;
      relation.confidence = safeConfidence;
    }

    if (relation.originalType && relation.originalType !== relation.type) {
      const previousType = relation.originalType;
      relation.type = "related_to";
      relation.confidence = Math.min(relation.confidence, 0.3);
      markDecision(entry, "downgraded");
      traces.push(makeTrace({
        category: "graph_validity",
        action: "relation_type_downgraded",
        relationTempId: entry.tempId,
        sourceKey: relation.sourceKey,
        targetKey: relation.targetKey,
        originalType: previousType,
        finalType: relation.type,
        originalConfidence: relation.originalConfidence ?? relation.confidence,
        finalConfidence: relation.confidence,
        decision: "downgraded",
        warnings: ["原始关系类型不在允许集合内，已降级为弱关系。"],
        reason: "非法关系类型已降级为 related_to。",
        evidenceChunkIds: relation.evidenceChunkIds,
      }));
    }

    if (strongRelationTypes.has(relation.type) && relation.evidenceChunkIds.length === 0) {
      entry.excluded = true;
      entry.decision = "excluded_from_graph";
      traces.push(makeTrace({
        category: "relation_algebra",
        action: "strong_relation_without_evidence_dropped",
        relationTempId: entry.tempId,
        sourceKey: relation.sourceKey,
        targetKey: relation.targetKey,
        originalType: relation.originalType ?? relation.type,
        finalType: relation.type,
        originalConfidence: relation.originalConfidence ?? relation.confidence,
        finalConfidence: relation.confidence,
        decision: "excluded_from_graph",
        reason: "强关系缺少直接 evidenceChunkIds，不进入候选图谱。",
      }));
      continue;
    }

    if (relation.type === "related_to") {
      const capped = weakFallbackConfidence(relation);
      if (capped !== relation.confidence) {
        const originalConfidence = relation.originalConfidence ?? relation.confidence;
        relation.originalConfidence ??= relation.confidence;
        relation.confidence = capped;
        markDecision(entry, "downgraded");
        traces.push(makeTrace({
          category: "relation_algebra",
          action: "related_to_confidence_capped",
          relationTempId: entry.tempId,
          sourceKey: relation.sourceKey,
          targetKey: relation.targetKey,
          originalType: relation.originalType ?? relation.type,
          finalType: relation.type,
          originalConfidence,
          finalConfidence: capped,
          decision: "downgraded",
          reason: "related_to 作为弱关系，置信度已压到允许范围内。",
          evidenceChunkIds: relation.evidenceChunkIds,
        }));
      }
    }
  }

  const bySignature = new Map<string, WorkingRelation>();
  for (const entry of working) {
    if (entry.excluded) continue;
    const signature = relationSignature(entry.relation);
    const existing = bySignature.get(signature);
    if (!existing) {
      bySignature.set(signature, entry);
      continue;
    }
    existing.relation.evidenceChunkIds = unique([
      ...existing.relation.evidenceChunkIds,
      ...entry.relation.evidenceChunkIds,
    ]);
    existing.relation.confidence = Math.max(existing.relation.confidence, entry.relation.confidence);
    existing.warnings = unique([...existing.warnings, ...entry.warnings]);
    existing.relation.ruleWarnings = unique([...(existing.relation.ruleWarnings ?? []), ...(entry.relation.ruleWarnings ?? [])]);
    entry.excluded = true;
    entry.decision = "excluded_from_graph";
    traces.push(makeTrace({
      category: "relation_algebra",
      action: "duplicate_relation_merged",
      relationTempId: entry.tempId,
      sourceKey: entry.relation.sourceKey,
      targetKey: entry.relation.targetKey,
      originalType: entry.relation.originalType ?? entry.relation.type,
      finalType: existing.relation.type,
      originalConfidence: entry.relation.originalConfidence ?? entry.relation.confidence,
      finalConfidence: existing.relation.confidence,
      decision: "excluded_from_graph",
      reason: "同源同目标同类型关系已合并为一条候选边。",
      evidenceChunkIds: existing.relation.evidenceChunkIds,
    }));
  }

  const active = [...bySignature.values()];
  const byPair = new Map<string, WorkingRelation[]>();
  for (const entry of active) {
    const pair = `${entry.relation.sourceKey}::${entry.relation.targetKey}`;
    const values = byPair.get(pair) ?? [];
    values.push(entry);
    byPair.set(pair, values);
  }

  for (const entries of byPair.values()) {
    const strong = entries.filter((entry) => strongRelationTypes.has(entry.relation.type));
    const weak = entries.filter((entry) => entry.relation.type === "related_to");
    if (strong.length > 0 && weak.length > 0) {
      for (const weakEntry of weak) {
        weakEntry.excluded = true;
        weakEntry.decision = "excluded_from_graph";
        traces.push(makeTrace({
          category: "relation_algebra",
          action: "weak_relation_removed_by_strong_relation",
          relationTempId: weakEntry.tempId,
          sourceKey: weakEntry.relation.sourceKey,
          targetKey: weakEntry.relation.targetKey,
          originalType: weakEntry.relation.originalType ?? weakEntry.relation.type,
          finalType: weakEntry.relation.type,
          originalConfidence: weakEntry.relation.originalConfidence ?? weakEntry.relation.confidence,
          finalConfidence: weakEntry.relation.confidence,
          decision: "excluded_from_graph",
          reason: "同端点已存在更强的有向关系，related_to 弱边已移除。",
          evidenceChunkIds: weakEntry.relation.evidenceChunkIds,
        }));
      }
    }

    const hasContradicts = entries.filter((entry) => !entry.excluded && entry.relation.type === "contradicts");
    const conflictTargets = entries.filter((entry) => !entry.excluded && ["supports", "explains", "depends_on"].includes(entry.relation.type));
    if (hasContradicts.length > 0 && conflictTargets.length > 0) {
      for (const entry of [...hasContradicts, ...conflictTargets]) {
        entry.warnings = unique([...entry.warnings, "同端点存在互相冲突的强关系组合，需要人工复核。"]);
        entry.relation.ruleWarnings = unique([...(entry.relation.ruleWarnings ?? []), ...entry.warnings]);
        entry.decision = "needs_review";
        entry.relation.ruleDecision = "needs_review";
        traces.push(makeTrace({
          category: "relation_algebra",
          action: "conflicting_relation_marked_review",
          relationTempId: entry.tempId,
          sourceKey: entry.relation.sourceKey,
          targetKey: entry.relation.targetKey,
          originalType: entry.relation.originalType ?? entry.relation.type,
          finalType: entry.relation.type,
          originalConfidence: entry.relation.originalConfidence ?? entry.relation.confidence,
          finalConfidence: entry.relation.confidence,
          decision: "needs_review",
          warnings: entry.warnings,
          reason: "同端点同时存在 contradicts 与其他强关系，保留但标记为待审。",
          evidenceChunkIds: entry.relation.evidenceChunkIds,
        }));
      }
    }
  }

  const outputRelations = active
    .filter((entry) => !entry.excluded)
    .map((entry) => ({
      ...entry.relation,
      evidenceChunkIds: unique(entry.relation.evidenceChunkIds),
      ruleWarnings: unique(entry.warnings),
      ruleDecision: entry.decision,
    }));

  const degree = new Map(nodes.map((node) => [node.key, 0]));
  for (const relation of outputRelations) {
    degree.set(relation.sourceKey, (degree.get(relation.sourceKey) ?? 0) + 1);
    degree.set(relation.targetKey, (degree.get(relation.targetKey) ?? 0) + 1);
  }
  for (const node of nodes) {
    if ((degree.get(node.key) ?? 0) > 0) continue;
    const decision: GraphRuleDecision = node.evidenceChunkIds.length > 0 ? "kept" : "needs_review";
    traces.push(makeTrace({
      category: "graph_validity",
      action: "isolated_node_flagged",
      nodeId: node.key,
      decision,
      warnings: ["节点当前没有任何入边或出边。"],
      reason: node.evidenceChunkIds.length > 0
        ? "孤立节点已保留，但建议人工确认它是否需要关系补充。"
        : "孤立节点且缺少证据，建议优先人工复核。",
      evidenceChunkIds: node.evidenceChunkIds,
    }));
  }

  for (const entry of active.filter((item) => !item.excluded)) {
    if (traces.some((trace) => trace.relationTempId === entry.tempId)) continue;
    traces.push(makeTrace({
      category: "graph_validity",
      action: "relation_type_validated",
      relationTempId: entry.tempId,
      sourceKey: entry.relation.sourceKey,
      targetKey: entry.relation.targetKey,
      originalType: entry.relation.originalType ?? entry.relation.type,
      finalType: entry.relation.type,
      originalConfidence: entry.relation.originalConfidence ?? entry.relation.confidence,
      finalConfidence: entry.relation.confidence,
      decision: entry.decision,
      reason: "关系通过了图合法性与关系代数治理。",
      evidenceChunkIds: entry.relation.evidenceChunkIds,
    }));
  }

  const sequencedTraces = traces.map((trace, index) => ({
    ...trace,
    batchId: trace.batchId ?? batchId,
    sequence: trace.sequence ?? index + 1,
    stage: trace.stage ?? options.mode ?? "extraction",
  }));
  return {
    output: {
      ...extraction,
      nodes,
      relations: outputRelations,
    },
    traces: sequencedTraces,
    summary: traceSummary(extraction.relations.length, working, sequencedTraces),
  };
}

export function quickRuleAudit(result: GraphRulesResult, mode: GraphRuleStage = "rebuild"): GraphRulesResult {
  const traces: GraphRuleTrace[] = [];
  const degree = new Map(result.output.nodes.map((node) => [node.key, 0]));
  for (const relation of result.output.relations) {
    degree.set(relation.sourceKey, (degree.get(relation.sourceKey) ?? 0) + 1);
    degree.set(relation.targetKey, (degree.get(relation.targetKey) ?? 0) + 1);
    if (relation.ruleDecision === "needs_review") {
      traces.push(makeTrace({
        category: "graph_evolution",
        action: "rebuild_rule_quick_audit_flagged",
        relationTempId: relationSignature(relation),
        sourceKey: relation.sourceKey,
        targetKey: relation.targetKey,
        originalType: relation.originalType ?? relation.type,
        finalType: relation.type,
        originalConfidence: relation.originalConfidence ?? relation.confidence,
        finalConfidence: relation.confidence,
        decision: "needs_review",
        warnings: relation.ruleWarnings ?? [],
        reason: `${mode === "rebuild" ? "重构候选" : "候选图谱"} 中仍存在需要人工复核的关系。`,
        evidenceChunkIds: relation.evidenceChunkIds,
      }));
    }
  }
  for (const node of result.output.nodes) {
    if ((degree.get(node.key) ?? 0) > 0) continue;
    traces.push(makeTrace({
      category: "graph_evolution",
      action: "rebuild_rule_quick_audit_flagged",
      nodeId: node.key,
      decision: node.evidenceChunkIds.length > 0 ? "kept" : "needs_review",
      warnings: ["重构后该节点仍处于孤立状态。"],
      reason: "quick rule audit 发现候选图谱中仍有孤立节点。",
      evidenceChunkIds: node.evidenceChunkIds,
    }));
  }
  return {
    output: result.output,
    traces,
    summary: traceSummary(result.summary.totalRelations, result.output.relations.map((relation, index) => ({
      tempId: `q${index + 1}`,
      relation,
      warnings: relation.ruleWarnings ?? [],
      decision: relation.ruleDecision ?? "kept",
      excluded: false,
    })), traces),
  };
}

export function buildGraphDiff(
  beforeGraph: {
    nodes: Array<{ id: string; title: string; summary: string }>;
    relations: Array<{ id: string; type: RelationType; sourceTitle: string; targetTitle: string; reason: string; evidenceChunkIds: string[] }>;
  },
  afterExtraction: ExtractionOutput,
  traces: GraphRuleTrace[],
): GraphDiff {
  const beforeNodes = new Map(beforeGraph.nodes.map((node) => [node.title.normalize("NFKC").toLowerCase(), node]));
  const afterNodes = new Map(afterExtraction.nodes.map((node) => [node.title.normalize("NFKC").toLowerCase(), node]));
  const beforeRelations = new Map(beforeGraph.relations.map((relation) => [
    `${relation.sourceTitle}::${relation.targetTitle}::${relation.type}`,
    relation,
  ]));
  const titleByKey = new Map(afterExtraction.nodes.map((node) => [node.key, node.title]));
  const afterRelations = new Map(afterExtraction.relations.map((relation) => [
    `${titleByKey.get(relation.sourceKey) ?? relation.sourceKey}::${titleByKey.get(relation.targetKey) ?? relation.targetKey}::${relation.type}`,
    relation,
  ]));

  const addedNodes = [...afterNodes.keys()].filter((key) => !beforeNodes.has(key)).map((key) => afterNodes.get(key)!.title);
  const removedNodes = [...beforeNodes.keys()].filter((key) => !afterNodes.has(key)).map((key) => beforeNodes.get(key)!.title);
  const updatedNodes = [...afterNodes.keys()]
    .filter((key) => beforeNodes.has(key) && beforeNodes.get(key)!.summary !== afterNodes.get(key)!.summary)
    .map((key) => afterNodes.get(key)!.title);

  const addedRelations = [...afterRelations.keys()]
    .filter((key) => !beforeRelations.has(key))
    .map((key) => relationDisplay(afterRelations.get(key)!));
  const removedRelations = [...beforeRelations.keys()]
    .filter((key) => !afterRelations.has(key))
    .map((key) => {
      const relation = beforeRelations.get(key)!;
      return `${relation.sourceTitle} -[${relation.type}]-> ${relation.targetTitle}`;
    });
  const updatedRelations = [...afterRelations.keys()]
    .filter((key) => beforeRelations.has(key) && beforeRelations.get(key)!.reason !== afterRelations.get(key)!.reason)
    .map((key) => relationDisplay(afterRelations.get(key)!));

  const downgradedRelations = traces
    .filter((trace) => trace.decision === "downgraded" && trace.sourceKey && trace.targetKey)
    .map((trace) => `${trace.sourceKey} -[${trace.originalType ?? trace.finalType ?? "?"}]-> ${trace.targetKey} => ${trace.finalType ?? "related_to"}`);
  const excludedByRules = traces
    .filter((trace) => trace.decision === "excluded_from_graph" && trace.sourceKey && trace.targetKey)
    .map((trace) => `${trace.sourceKey} -[${trace.originalType ?? trace.finalType ?? "?"}]-> ${trace.targetKey}`);
  const needsReviewRelations = traces
    .filter((trace) => trace.decision === "needs_review" && trace.sourceKey && trace.targetKey)
    .map((trace) => `${trace.sourceKey} -[${trace.finalType ?? trace.originalType ?? "?"}]-> ${trace.targetKey}`);

  return {
    addedNodes,
    removedNodes,
    updatedNodes,
    addedRelations,
    removedRelations,
    updatedRelations,
    downgradedRelations: unique(downgradedRelations),
    excludedByRules: unique(excludedByRules),
    needsReviewRelations: unique(needsReviewRelations),
  };
}
