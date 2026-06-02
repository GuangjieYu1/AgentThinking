import type {
  MappingAuditFinding,
  MappingAuditMetrics,
  MappingAuditResult,
  MappingAuditStatus,
  RelationType,
} from "@agent-thinking/contracts";
import type { MappingAuditContext } from "./models.js";

function relationSeverity(type: RelationType, hasEvidence: boolean): MappingAuditFinding["severity"] {
  if (!hasEvidence && type !== "related_to") return "high";
  return type === "related_to" ? "low" : "medium";
}

function findingKey(finding: MappingAuditFinding): string {
  return [
    finding.ruleCategory ?? "",
    finding.kind,
    finding.title,
    [...finding.evidenceChunkIds].sort().join(","),
    [...finding.nodeIds].sort().join(","),
    [...finding.relationIds].sort().join(","),
  ].join("|");
}

function withLifecycle(finding: MappingAuditFinding): MappingAuditFinding {
  return {
    ...finding,
    ruleCategory: finding.ruleCategory ?? "semantic_coverage",
    status: finding.status ?? "open",
  };
}

export function programmaticSemanticCoverageAudit(context: MappingAuditContext): MappingAuditFinding[] {
  const findings: MappingAuditFinding[] = [];
  const nodeIdsByChunk = new Map<string, Set<string>>();
  const relationIdsByChunk = new Map<string, Set<string>>();
  const nodeById = new Map(context.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Set<string>>();
  const strongDegrees = new Map<string, number>();

  for (const node of context.nodes) {
    for (const chunkId of node.evidenceChunkIds) {
      const ids = nodeIdsByChunk.get(chunkId) ?? new Set<string>();
      ids.add(node.id);
      nodeIdsByChunk.set(chunkId, ids);
    }
    strongDegrees.set(node.id, 0);
  }

  for (const relation of context.relations) {
    for (const chunkId of relation.evidenceChunkIds) {
      const ids = relationIdsByChunk.get(chunkId) ?? new Set<string>();
      ids.add(relation.id);
      relationIdsByChunk.set(chunkId, ids);
    }
    const sourceNeighbors = adjacency.get(relation.sourceNodeId) ?? new Set<string>();
    sourceNeighbors.add(relation.targetNodeId);
    adjacency.set(relation.sourceNodeId, sourceNeighbors);
    const targetNeighbors = adjacency.get(relation.targetNodeId) ?? new Set<string>();
    targetNeighbors.add(relation.sourceNodeId);
    adjacency.set(relation.targetNodeId, targetNeighbors);
    if (relation.type !== "related_to") {
      strongDegrees.set(relation.sourceNodeId, (strongDegrees.get(relation.sourceNodeId) ?? 0) + 1);
      strongDegrees.set(relation.targetNodeId, (strongDegrees.get(relation.targetNodeId) ?? 0) + 1);
    }
  }

  for (const chunk of context.chunks) {
    const nodeCount = nodeIdsByChunk.get(chunk.id)?.size ?? 0;
    const relationCount = relationIdsByChunk.get(chunk.id)?.size ?? 0;
    if (nodeCount > 0 || relationCount > 0) continue;
    findings.push(withLifecycle({
      kind: "missing_source_meaning",
      severity: "medium",
      ruleCategory: "semantic_coverage",
      title: "原文片段没有映射到图谱",
      description: `chunk ${chunk.id.slice(0, 8)} 没有被任何节点或关系引用，原文语义可能未进入图谱。`,
      suggestion: "补充节点、关系或主题对该 chunk 的引用，避免重要原文被遗漏。",
      evidenceChunkIds: [chunk.id],
      nodeIds: [],
      relationIds: [],
      userComment: "",
    }));
  }

  for (const node of context.nodes) {
    if (node.evidenceChunkIds.length > 0) continue;
    findings.push(withLifecycle({
      kind: "unsupported_graph_claim",
      severity: "medium",
      ruleCategory: "semantic_coverage",
      title: "节点缺少证据",
      description: `节点“${node.title}”没有 evidenceChunkIds，图谱无法追溯它来自哪些原文。`,
      suggestion: "补充该节点的证据 chunk，或删除该无证据节点。",
      evidenceChunkIds: [],
      nodeIds: [node.id],
      relationIds: [],
      userComment: "",
    }));
  }

  for (const relation of context.relations) {
    if (relation.evidenceChunkIds.length === 0) {
      findings.push(withLifecycle({
        kind: "unsupported_graph_claim",
        severity: relationSeverity(relation.type, false),
        ruleCategory: "semantic_coverage",
        title: "关系缺少证据",
        description: `关系“${relation.sourceTitle} -[${relation.type}]-> ${relation.targetTitle}”没有 evidenceChunkIds。`,
        suggestion: relation.type === "related_to"
          ? "为该弱关系补充原文证据，或考虑直接删除。"
          : "为该强关系补充直接证据，否则应拒绝或删除。",
        evidenceChunkIds: [],
        nodeIds: [relation.sourceNodeId, relation.targetNodeId],
        relationIds: [relation.id],
        userComment: "",
      }));
    }
    if (relation.sourceNodeId === relation.targetNodeId || !nodeById.has(relation.sourceNodeId) || !nodeById.has(relation.targetNodeId)) {
      findings.push(withLifecycle({
        kind: "wrong_relation",
        severity: "medium",
        ruleCategory: "semantic_coverage",
        title: "关系结构不可信",
        description: `关系“${relation.sourceTitle} -[${relation.type}]-> ${relation.targetTitle}”的端点结构异常，建议人工核对。`,
        suggestion: "检查该关系的方向、端点和类型是否仍然可信。",
        evidenceChunkIds: relation.evidenceChunkIds,
        nodeIds: [relation.sourceNodeId, relation.targetNodeId],
        relationIds: [relation.id],
        userComment: "",
      }));
    }
  }

  for (let index = 0; index < context.chunks.length - 1; index += 1) {
    const current = context.chunks[index]!;
    const next = context.chunks[index + 1]!;
    if (current.headingPath !== next.headingPath) continue;
    const currentNodes = [...(nodeIdsByChunk.get(current.id) ?? new Set<string>())];
    const nextNodes = [...(nodeIdsByChunk.get(next.id) ?? new Set<string>())];
    if (currentNodes.length === 0 || nextNodes.length === 0) continue;
    const connected = currentNodes.some((leftId) => nextNodes.some((rightId) => adjacency.get(leftId)?.has(rightId)));
    if (connected) continue;
    findings.push(withLifecycle({
      kind: "chunk_boundary_loss",
      severity: "low",
      ruleCategory: "semantic_coverage",
      title: "相邻 chunk 之间可能丢失语义连接",
      description: `相邻 chunk ${current.id.slice(0, 8)} 与 ${next.id.slice(0, 8)} 都映射到了节点，但它们之间没有图谱连接。`,
      suggestion: "检查这两个相邻 chunk 是否共享同一事件、因果链或论证关系，并补上必要关系。",
      evidenceChunkIds: [current.id, next.id],
      nodeIds: [...currentNodes.slice(0, 2), ...nextNodes.slice(0, 2)],
      relationIds: [],
      userComment: "",
    }));
  }

  for (const node of context.nodes) {
    const degree = adjacency.get(node.id)?.size ?? 0;
    const strongDegree = strongDegrees.get(node.id) ?? 0;
    if (degree < 3 || strongDegree > 0 || node.kind !== "claim") continue;
    findings.push(withLifecycle({
      kind: "overgeneralization",
      severity: "low",
      ruleCategory: "semantic_coverage",
      title: "related_to 社区缺少中心命题关系",
      description: `命题节点“${node.title}”周围主要是弱 related_to 边，缺少 supports / explains 等更明确的语义关系。`,
      suggestion: "检查这些弱关系是否可以收敛为更具体的命题、解释或支撑关系。",
      evidenceChunkIds: node.evidenceChunkIds,
      nodeIds: [node.id],
      relationIds: context.relations
        .filter((relation) => relation.sourceNodeId === node.id || relation.targetNodeId === node.id)
        .slice(0, 4)
        .map((relation) => relation.id),
      userComment: "",
    }));
  }

  return findings;
}

export function mergeProgrammaticFindings(
  audit: MappingAuditResult,
  ruleFindings: MappingAuditFinding[],
): MappingAuditResult {
  if (ruleFindings.length === 0) {
    return {
      ...audit,
      findings: audit.findings.map(withLifecycle),
    };
  }
  const deduped = new Map<string, MappingAuditFinding>();
  for (const finding of [...ruleFindings.map(withLifecycle), ...audit.findings.map(withLifecycle)]) {
    const key = findingKey(finding);
    if (!deduped.has(key)) deduped.set(key, finding);
  }
  const findings = [...deduped.values()];
  const highestStatus: MappingAuditStatus = audit.status === "failed"
    ? "failed"
    : findings.some((finding) => finding.severity === "high")
      ? "major_issues"
      : findings.length > 0
        ? "minor_issues"
        : audit.status;
  const extraSummary = `程序规则审计另外发现 ${ruleFindings.length} 个结构性问题。`;
  return {
    ...audit,
    status: highestStatus,
    summary: audit.summary.includes(extraSummary) ? audit.summary : `${audit.summary} ${extraSummary}`.trim(),
    findings,
  };
}

export function buildMappingAuditMetrics(
  context: MappingAuditContext,
  findings: MappingAuditFinding[],
): MappingAuditMetrics {
  const countByKind = {
    missing_source_meaning: 0,
    unsupported_graph_claim: 0,
    wrong_relation: 0,
    chunk_boundary_loss: 0,
    overgeneralization: 0,
  } satisfies Record<"missing_source_meaning" | "unsupported_graph_claim" | "wrong_relation" | "chunk_boundary_loss" | "overgeneralization", number>;
  let highSeverityCount = 0;
  let mediumSeverityCount = 0;
  let lowSeverityCount = 0;
  for (const finding of findings) {
    if (finding.severity === "high") highSeverityCount += 1;
    else if (finding.severity === "medium") mediumSeverityCount += 1;
    else lowSeverityCount += 1;
    if (finding.kind in countByKind) countByKind[finding.kind as keyof typeof countByKind] += 1;
  }
  const chunkCount = context.chunks.length;
  const nodeCount = context.nodes.length;
  const relationCount = context.relations.length;
  return {
    chunkCount,
    nodeCount,
    relationCount,
    findingCount: findings.length,
    highSeverityCount,
    mediumSeverityCount,
    lowSeverityCount,
    missingSourceMeaningCount: countByKind.missing_source_meaning,
    unsupportedGraphClaimCount: countByKind.unsupported_graph_claim,
    wrongRelationCount: countByKind.wrong_relation,
    chunkBoundaryLossCount: countByKind.chunk_boundary_loss,
    overgeneralizationCount: countByKind.overgeneralization,
    coverageScore: Math.max(0, 1 - (countByKind.missing_source_meaning / Math.max(chunkCount, 1))),
    unsupportedClaimRate: countByKind.unsupported_graph_claim / Math.max(nodeCount + relationCount, 1),
    wrongRelationRate: countByKind.wrong_relation / Math.max(relationCount, 1),
  };
}
