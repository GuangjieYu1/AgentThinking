import { randomUUID } from "node:crypto";
import type {
  Chunk,
  ExtractionOutput,
  GraphRuleTrace,
  GraphRulesSummary,
  MappingAudit,
  MappingAuditFinding,
  MappingAuditResult,
  MappingAuditStatus,
  Relation,
} from "@agent-thinking/contracts";
import type { AgentDatabase } from "../db.js";
import { buildGraphDiff, quickRuleAudit, type GraphRulesResult } from "./graphRules.js";
import { LibraryEventBus } from "./library-events.js";
import { buildMappingAuditMetrics, mergeProgrammaticFindings, programmaticSemanticCoverageAudit } from "./mapping-audit-rules.js";
import type { MappingAuditContext, ModelProvider } from "./models.js";

const maxBatchChunks = 8;
const maxBatchCharacters = 18_000;

function chunkBatches(chunks: Chunk[]): Chunk[][] {
  const batches: Chunk[][] = [];
  let current: Chunk[] = [];
  let characters = 0;
  for (const chunk of chunks) {
    const wouldOverflow = current.length >= maxBatchChunks || (current.length > 0 && characters + chunk.text.length > maxBatchCharacters);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(chunk);
    characters += chunk.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function batchContext(context: MappingAuditContext, chunks: Chunk[]): MappingAuditContext {
  const chunkIds = new Set(chunks.map((chunk) => chunk.id));
  const nodes = context.nodes.filter((node) => node.evidenceChunkIds.some((chunkId) => chunkIds.has(chunkId)));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const relations = context.relations.filter((relation) => (
    relation.evidenceChunkIds.some((chunkId) => chunkIds.has(chunkId))
    || nodeIds.has(relation.sourceNodeId)
    || nodeIds.has(relation.targetNodeId)
  ));
  const relationEndpointIds = new Set(relations.flatMap((relation) => [relation.sourceNodeId, relation.targetNodeId]));
  const expandedNodes = context.nodes.filter((node) => nodeIds.has(node.id) || relationEndpointIds.has(node.id));
  const result: MappingAuditContext = {
    versionId: context.versionId,
    documentName: context.documentName,
    chunks,
    nodes: expandedNodes,
    relations,
  };
  if (context.note) result.note = context.note;
  return result;
}

function statusFromFindings(findings: MappingAuditFinding[], statuses: MappingAuditStatus[]): MappingAuditStatus {
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "major_issues") || findings.some((finding) => finding.severity === "high")) return "major_issues";
  if (statuses.some((status) => status === "minor_issues") || findings.length > 0) return "minor_issues";
  return "clean";
}

function emptyMappingResult(context: MappingAuditContext): MappingAuditResult {
  return {
    status: "major_issues",
    summary: "当前文档已经切分，但没有发现可审计的 AI 映射节点。mapping 覆盖不足。",
    reconstruction: "图谱中没有足够的 AI 节点与关系，无法从 mapping 反向重构该文档的语义轮廓。",
    findings: [{
      kind: "missing_source_meaning",
      severity: "high",
      ruleCategory: "semantic_coverage",
      title: "文档缺少 AI 映射节点",
      description: "该版本的 chunk 没有关联到 AI 生成的节点或主题，说明抽取结果可能为空或未覆盖原文。",
      suggestion: "重新分析该文档，并检查 chunk 是否过长、文本解析是否异常、模型配置是否可用。",
      evidenceChunkIds: context.chunks.slice(0, 3).map((chunk) => chunk.id),
      nodeIds: [],
      relationIds: [],
      userComment: "",
      status: "open",
    }],
  };
}

function combineResults(results: MappingAuditResult[]): MappingAuditResult {
  const findings = results.flatMap((result) => result.findings);
  const status = statusFromFindings(findings, results.map((result) => result.status));
  const issueCount = findings.length;
  const summary = status === "failed"
    ? "映射审计部分失败；已保留可用的语义重构，请重新运行或缩短输入后再试。"
    : status === "clean"
      ? "语义重构审计未发现明显分歧。"
      : `语义重构审计发现 ${issueCount} 个需要核对的问题。`;
  return {
    status,
    summary,
    reconstruction: results
      .map((result, index) => `## 批次 ${index + 1}\n${result.reconstruction}`)
      .join("\n\n"),
    findings,
  };
}

function failedReviewResult(reconstruction: string, chunks: Chunk[], context: MappingAuditContext): MappingAuditResult {
  return {
    status: "failed",
    summary: "审计模型返回的结构化 JSON 无法整理；已保留语义重构文本，请重新运行审计。",
    reconstruction,
    findings: [{
      kind: "other",
      severity: "medium",
      ruleCategory: "semantic_coverage",
      title: "审计结构化输出不可用",
      description: "模型返回的审计 JSON 不完整、格式异常或字段超出预期，系统未将其作为正式审计结论。",
      suggestion: "点击重新运行；如果反复出现，可缩短输入文档或检查当前模型的 JSON 输出稳定性。",
      evidenceChunkIds: chunks.slice(0, 3).map((chunk) => chunk.id),
      nodeIds: context.nodes.slice(0, 3).map((node) => node.id),
      relationIds: context.relations.slice(0, 3).map((relation) => relation.id),
      userComment: "",
      status: "open",
    }],
  };
}

function chunksForAuditFindings(audit: MappingAudit, context: MappingAuditContext): Chunk[] {
  const referencedIds = new Set(audit.findings.flatMap((finding) => finding.evidenceChunkIds));
  const referenced = context.chunks.filter((chunk) => referencedIds.has(chunk.id));
  if (referenced.length > 0) {
    const selected = new Map<string, Chunk>();
    for (const chunk of referenced) {
      selected.set(chunk.id, chunk);
      for (const neighbor of context.chunks) {
        if (neighbor.versionId === chunk.versionId && Math.abs(neighbor.ordinal - chunk.ordinal) <= 1) {
          selected.set(neighbor.id, neighbor);
        }
      }
    }
    return [...selected.values()]
      .sort((left, right) => left.ordinal - right.ordinal)
      .slice(0, 24);
  }
  return context.chunks.slice(0, 12);
}

const severityLabels: Record<MappingAuditFinding["severity"], string> = {
  high: "红色 / 高",
  medium: "黄色 / 中",
  low: "蓝色 / 低",
};

const kindLabels: Record<MappingAuditFinding["kind"], string> = {
  missing_source_meaning: "原文语义遗漏",
  unsupported_graph_claim: "图谱推断缺证据",
  wrong_relation: "关系错误",
  chunk_boundary_loss: "切分边界丢失",
  overgeneralization: "过度概括",
  other: "其他",
};

function issueCounts(findings: MappingAuditFinding[]): { high: number; medium: number; low: number } {
  return findings.reduce((counts, finding) => {
    counts[finding.severity] += 1;
    return counts;
  }, { high: 0, medium: 0, low: 0 });
}

function relationLine(relation: ExtractionOutput["relations"][number], titles: Map<string, string>): string {
  return `${titles.get(relation.sourceKey) ?? relation.sourceKey} -[${relation.type}]-> ${titles.get(relation.targetKey) ?? relation.targetKey}`;
}

function handlingForFinding(
  finding: MappingAuditFinding,
  extraction: ExtractionOutput,
): string {
  const referencedChunks = new Set(finding.evidenceChunkIds);
  const titles = new Map(extraction.nodes.map((node) => [node.key, node.title]));
  const relatedNodes = extraction.nodes
    .filter((node) => node.evidenceChunkIds.some((chunkId) => referencedChunks.has(chunkId)))
    .slice(0, 3)
    .map((node) => `节点「${node.title}」`);
  const relatedRelations = extraction.relations
    .filter((relation) => relation.evidenceChunkIds.some((chunkId) => referencedChunks.has(chunkId)))
    .slice(0, 3)
    .map((relation) => `关系「${relationLine(relation, titles)}」`);
  const related = [...relatedNodes, ...relatedRelations];
  const generic = {
    missing_source_meaning: "将被遗漏的原文含义作为重构优先项，要求模型补成有 chunk 证据的候选节点或关系。",
    unsupported_graph_claim: "要求模型只保留能由原文 chunk 支撑的候选，并用更保守的表达替代无证据断言。",
    wrong_relation: "要求模型重新判断关系方向与类型；被点名的旧 AI suggested 关系会在本轮重构中下线。",
    chunk_boundary_loss: "重构输入加入相关 chunk 的前后邻近片段，用来恢复跨边界语义。",
    overgeneralization: "要求模型保留不确定性、传闻和推断边界，避免把暗示写成确定事实。",
    other: "将该问题作为重构约束，生成更贴近原文证据的候选结构。",
  } satisfies Record<MappingAuditFinding["kind"], string>;
  if (related.length === 0) return generic[finding.kind];
  return `${generic[finding.kind]} 本轮相关候选：${related.join("；")}。`;
}

function flaggedRelationIds(audit: MappingAudit): string[] {
  const fixableKinds = new Set<MappingAuditFinding["kind"]>([
    "unsupported_graph_claim",
    "wrong_relation",
    "overgeneralization",
    "other",
  ]);
  return [...new Set(audit.findings.flatMap((finding) => (
    finding.severity === "low" || !fixableKinds.has(finding.kind) ? [] : finding.relationIds
  )))];
}

function graphRebuildReport(audit: MappingAudit, extraction: ExtractionOutput, rejectedRelations: Relation[]): string {
  const issueCount = audit.findings.length;
  const counts = issueCounts(audit.findings);
  const selectedFindings = [...audit.findings]
    .sort((left, right) => {
      const weight = { high: 0, medium: 1, low: 2 };
      return weight[left.severity] - weight[right.severity];
    })
    .slice(0, 12);
  return [
    "审计驱动图谱重构已完成。",
    `输入材料：原文 chunk、当前关系图谱、映射审计报告（${issueCount} 条发现：红色 ${counts.high}，黄色 ${counts.medium}，蓝色 ${counts.low}）。`,
    `生成结果：${extraction.nodes.length} 个候选节点、${extraction.relations.length} 条候选关系、${extraction.themes?.length ?? 0} 个上层主题。`,
    rejectedRelations.length > 0
      ? `图谱优化：已下线 ${rejectedRelations.length} 条被审计点名的旧 AI suggested 关系，保留人工关系和已接受关系。`
      : "图谱优化：没有自动下线关系；本轮仅新增或更新 AI 候选。",
    "这些结果已写入图谱作为 AI 建议；请继续在关系图谱审核中接受、拒绝或手动修正。",
    "",
    "## 审计发现与本次处理",
    ...selectedFindings.map((finding, index) => [
      `${index + 1}. ${finding.title}（${severityLabels[finding.severity]}，${kindLabels[finding.kind]}）`,
      `   - 审计建议：${finding.suggestion}`,
      finding.userComment ? `   - 用户评论：${finding.userComment}` : undefined,
      `   - 本次处理：${handlingForFinding(finding, extraction)}`,
    ].filter(Boolean).join("\n")),
    audit.findings.length > selectedFindings.length
      ? `\n其余 ${audit.findings.length - selectedFindings.length} 条较低优先级问题已作为重构上下文传入模型，但不在此处逐条展开。`
      : "",
  ].join("\n");
}

function localRebuildContext(audit: MappingAudit, context: MappingAuditContext): {
  context: MappingAuditContext;
  scope: { findingCount: number; chunkCount: number; nodeCount: number; relationCount: number };
} {
  const selectedChunks = chunksForAuditFindings(audit, context);
  const chunkIds = new Set(selectedChunks.map((chunk) => chunk.id));
  const seedNodeIds = new Set(audit.findings.flatMap((finding) => finding.nodeIds));
  for (const node of context.nodes) {
    if (node.evidenceChunkIds.some((chunkId) => chunkIds.has(chunkId))) seedNodeIds.add(node.id);
  }
  const relations = context.relations.filter((relation) => (
    audit.findings.some((finding) => finding.relationIds.includes(relation.id))
    || relation.evidenceChunkIds.some((chunkId) => chunkIds.has(chunkId))
    || seedNodeIds.has(relation.sourceNodeId)
    || seedNodeIds.has(relation.targetNodeId)
  ));
  const nodeIds = new Set(seedNodeIds);
  for (const relation of relations) {
    nodeIds.add(relation.sourceNodeId);
    nodeIds.add(relation.targetNodeId);
  }
  const nodes = context.nodes.filter((node) => nodeIds.has(node.id));
  const comments = audit.findings
    .filter((finding) => finding.userComment.trim())
    .map((finding, index) => `${index + 1}. ${finding.title}：${finding.userComment.trim()}`);
  return {
    context: {
      ...context,
      chunks: selectedChunks,
      nodes,
      relations,
      note: [
        context.note,
        comments.length > 0 ? `用户对审计问题的评论：\n${comments.join("\n")}` : "",
      ].filter(Boolean).join("\n\n"),
    },
    scope: {
      findingCount: audit.findings.length,
      chunkCount: selectedChunks.length,
      nodeCount: nodes.length,
      relationCount: relations.length,
    },
  };
}

function graphRulesSummaryLines(summary: GraphRulesResult["summary"]): string[] {
  return [
    `- 图合法性规则：${summary.categoryCounts.graph_validity}`,
    `- 关系代数规则：${summary.categoryCounts.relation_algebra}`,
    `- 语义覆盖规则：${summary.categoryCounts.semantic_coverage}`,
    `- 图演化规则：${summary.categoryCounts.graph_evolution}`,
  ];
}

function emptyGraphRulesSummary(totalRelations = 0): GraphRulesSummary {
  return {
    totalRelations,
    keptCount: totalRelations,
    downgradedCount: 0,
    excludedCount: 0,
    droppedCount: 0,
    reviewCount: 0,
    warningCount: 0,
    categoryCounts: {
      graph_validity: 0,
      relation_algebra: 0,
      semantic_coverage: 0,
      graph_evolution: 0,
    },
  };
}

function semanticCoverageTrace(finding: MappingAuditFinding): GraphRuleTrace {
  return {
    traceId: randomUUID(),
    category: "semantic_coverage",
    action: "semantic_coverage_gap_flagged",
    relationId: finding.relationIds[0],
    nodeId: finding.nodeIds[0],
    decision: "needs_review",
    warnings: [finding.title],
    reason: finding.description,
    evidenceChunkIds: finding.evidenceChunkIds,
    timestamp: new Date().toISOString(),
  };
}

function rebuildReport(
  audit: MappingAudit,
  extraction: ExtractionOutput,
  graphRules: GraphRulesResult,
  quickAudit: GraphRulesResult,
  rejectedRelations: Relation[],
  scope: { findingCount: number; chunkCount: number; nodeCount: number; relationCount: number },
  localContext: MappingAuditContext,
): string {
  const diff = buildGraphDiff({
    nodes: localContext.nodes.map((node) => ({ id: node.id, title: node.title, summary: node.summary })),
    relations: localContext.relations.map((relation) => ({
      id: relation.id,
      type: relation.type,
      sourceTitle: relation.sourceTitle,
      targetTitle: relation.targetTitle,
      reason: relation.reason,
      evidenceChunkIds: relation.evidenceChunkIds,
    })),
  }, extraction, [...graphRules.traces, ...quickAudit.traces]);
  return [
    "审计驱动图谱重构已完成。",
    "",
    "## 本次重构范围",
    `- 使用了 ${scope.findingCount} 条 audit findings`,
    `- 涉及 ${scope.chunkCount} 个 chunks`,
    `- 涉及 ${scope.nodeCount} 个 nodes / ${scope.relationCount} 条 relations`,
    "",
    "## 候选修复结果",
    `- 生成 ${extraction.nodes.length} 个节点、${extraction.relations.length} 条关系、${extraction.themes?.length ?? 0} 个主题`,
    rejectedRelations.length > 0
      ? `- 已下线 ${rejectedRelations.length} 条被点名且仍为 AI suggested 的旧关系`
      : "- 没有自动下线旧 suggested 关系",
    "",
    "## 四类规则治理结果",
    ...graphRulesSummaryLines({
      ...graphRules.summary,
      categoryCounts: {
        ...graphRules.summary.categoryCounts,
        semantic_coverage: audit.metrics?.findingCount ?? audit.findings.length,
        graph_evolution: quickAudit.summary.categoryCounts.graph_evolution,
      },
    }),
    "",
    "## graphRules 结果",
    `- kept：${graphRules.summary.keptCount}`,
    `- downgraded：${graphRules.summary.downgradedCount}`,
    `- excluded：${graphRules.summary.excludedCount}`,
    `- needs_review：${graphRules.summary.reviewCount}`,
    "",
    "## Before / After Diff",
    `- addedNodes：${diff.addedNodes.length}`,
    `- removedNodes：${diff.removedNodes.length}`,
    `- updatedNodes：${diff.updatedNodes.length}`,
    `- addedRelations：${diff.addedRelations.length}`,
    `- removedRelations：${diff.removedRelations.length}`,
    `- updatedRelations：${diff.updatedRelations.length}`,
    `- downgradedRelations：${diff.downgradedRelations.length}`,
    `- excludedByRules：${diff.excludedByRules.length}`,
    `- needsReviewRelations：${diff.needsReviewRelations.length}`,
    "",
    "## 审计发现与本次处理",
    ...audit.findings.slice(0, 8).map((finding, index) => [
      `${index + 1}. ${finding.title}（${severityLabels[finding.severity]}，${kindLabels[finding.kind]}）`,
      `   - 审计建议：${finding.suggestion}`,
      finding.userComment ? `   - 用户评论：${finding.userComment}` : undefined,
      `   - 本次处理：${handlingForFinding(finding, extraction)}`,
    ].filter(Boolean).join("\n")),
    "",
    "## Quick Audit 说明",
    "本次 quick rule audit 只检查结构与规则问题，不等同于完整 mapping audit。",
    "如需确认语义覆盖、过度概括或 chunk boundary loss，请重新运行完整映射审计。",
    "重构输出仍是 AI candidate，不会自动变成 verified 结果。",
  ].join("\n");
}

function contextWithPreviousRebuild(context: MappingAuditContext, previousAudit?: MappingAudit): MappingAuditContext {
  if (!previousAudit?.graphRebuildReport) return context;
  return {
    ...context,
    note: [
      context.note,
      "上一轮“审计驱动图谱重构”报告如下。重新运行审计时，请对照它判断旧问题是否仍然存在、哪些修复没有奏效：",
      previousAudit.graphRebuildReport.slice(0, 6000),
    ].filter(Boolean).join("\n\n"),
  };
}

export class MappingAuditService {
  constructor(
    private readonly db: AgentDatabase,
    private readonly model: ModelProvider,
    private readonly events?: LibraryEventBus,
  ) {}

  private emitSemanticCoverageEvents(
    source: { libraryId: string; documentId: string },
    versionId: string,
    relationCount: number,
    findings: MappingAuditFinding[],
  ): void {
    const summary: GraphRulesSummary = {
      ...emptyGraphRulesSummary(relationCount),
      keptCount: 0,
      reviewCount: findings.length,
      warningCount: findings.length,
      categoryCounts: {
        graph_validity: 0,
        relation_algebra: 0,
        semantic_coverage: findings.length,
        graph_evolution: 0,
      },
    };
    const createdAt = new Date().toISOString();
    if (findings.length > 0) {
      this.events?.emitEvent({
        type: "graph_rule_trace",
        libraryId: source.libraryId,
        documentId: source.documentId,
        versionId,
        stage: "mapping_audit",
        createdAt,
        traces: findings.slice(-8).map(semanticCoverageTrace),
        summary,
      });
    }
    this.events?.emitEvent({
      type: "graph_rule_summary",
      libraryId: source.libraryId,
      documentId: source.documentId,
      versionId,
      stage: "mapping_audit",
      createdAt,
      summary,
    });
  }

  async run(versionId: string): Promise<MappingAudit> {
    const source = this.db.getVersionSource(versionId);
    if (!source) throw new Error("导入版本不存在");
    const baseContext = this.db.getMappingAuditContext(versionId);
    if (!baseContext) throw new Error("导入版本不存在");
    const ruleFindings = programmaticSemanticCoverageAudit(baseContext);
    const context = contextWithPreviousRebuild(baseContext, this.db.getMappingAudit(versionId));
    try {
      if (context.chunks.length === 0 || context.nodes.length === 0) {
        const audit = mergeProgrammaticFindings(emptyMappingResult(context), ruleFindings);
        this.emitSemanticCoverageEvents(source, versionId, baseContext.relations.length, audit.findings);
        return this.db.saveMappingAudit(source.libraryId, versionId, {
          ...audit,
          metrics: buildMappingAuditMetrics(baseContext, audit.findings),
        });
      }
      const results: MappingAuditResult[] = [];
      for (const batch of chunkBatches(context.chunks)) {
        const currentContext = batchContext(context, batch);
        const reconstruction = await this.model.reconstructMapping(currentContext);
        let review: Awaited<ReturnType<ModelProvider["auditMapping"]>>;
        try {
          review = await this.model.auditMapping(reconstruction, batch, currentContext);
        } catch {
          results.push(failedReviewResult(reconstruction, batch, currentContext));
          continue;
        }
        results.push({
          status: review.status,
          summary: review.summary,
          reconstruction,
          findings: review.findings,
        });
      }
      const combined = mergeProgrammaticFindings(combineResults(results), ruleFindings);
      const finalResult: MappingAuditResult = {
        ...combined,
        metrics: buildMappingAuditMetrics(baseContext, combined.findings),
      };
      this.emitSemanticCoverageEvents(source, versionId, baseContext.relations.length, combined.findings);
      return this.db.saveMappingAudit(source.libraryId, versionId, finalResult);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "映射审计失败";
      const failed = mergeProgrammaticFindings({
        status: "failed",
        summary: message,
        reconstruction: "",
        findings: [],
      }, ruleFindings);
      this.emitSemanticCoverageEvents(source, versionId, baseContext.relations.length, failed.findings);
      return this.db.saveMappingAudit(source.libraryId, versionId, {
        ...failed,
        metrics: buildMappingAuditMetrics(baseContext, failed.findings),
      });
    }
  }

  async rebuildGraph(versionId: string): Promise<MappingAudit> {
    const source = this.db.getVersionSource(versionId);
    if (!source) throw new Error("导入版本不存在");
    const context = this.db.getMappingAuditContext(versionId);
    if (!context) throw new Error("导入版本不存在");
    const audit = this.db.getMappingAudit(versionId);
    if (!audit) throw new Error("尚未运行映射审计");
    const local = localRebuildContext(audit, context);
    let graphRules: GraphRulesResult | undefined;
    const extraction = await this.model.rebuildGraphFromMappingAudit(
      audit,
      local.context.chunks,
      local.context,
      {
        stage: "rebuild",
        onGraphRules: (result) => {
          graphRules = result;
          this.events?.emitEvent({
            type: "graph_rebuild_rule_trace",
            libraryId: source.libraryId,
            documentId: source.documentId,
            versionId,
            stage: "rebuild",
            createdAt: new Date().toISOString(),
            traces: result.traces.slice(-8),
            summary: result.summary,
          });
          this.events?.emitEvent({
            type: "graph_rebuild_summary",
            libraryId: source.libraryId,
            documentId: source.documentId,
            versionId,
            stage: "rebuild",
            createdAt: new Date().toISOString(),
            summary: result.summary,
          });
        },
      },
    );
    const rejectedRelations = flaggedRelationIds(audit).flatMap((relationId) => {
      const relation = this.db.getRelation(relationId);
      if (!relation || relation.libraryId !== source.libraryId || relation.createdBy !== "ai" || relation.status !== "suggested") {
        return [];
      }
      return [this.db.updateRelation(relationId, { status: "rejected" })];
    });
    this.db.saveExtraction(source.libraryId, extraction, versionId, { updateExistingAi: true });
    const quickAudit = quickRuleAudit(graphRules ?? {
      output: extraction,
      traces: [],
      summary: emptyGraphRulesSummary(extraction.relations.length),
    });
    const baseSummary = graphRules?.summary ?? emptyGraphRulesSummary(extraction.relations.length);
    this.events?.emitEvent({
      type: "graph_rebuild_summary",
      libraryId: source.libraryId,
      documentId: source.documentId,
      versionId,
      stage: "rebuild",
      createdAt: new Date().toISOString(),
      summary: {
        ...baseSummary,
        reviewCount: baseSummary.reviewCount + quickAudit.summary.reviewCount,
        warningCount: baseSummary.warningCount + quickAudit.summary.warningCount,
        categoryCounts: {
          ...baseSummary.categoryCounts,
          graph_evolution: quickAudit.summary.categoryCounts.graph_evolution,
        },
      },
    });
    return this.db.saveMappingAuditGraphRebuildReport(
      versionId,
      rebuildReport(
        audit,
        extraction,
        graphRules ?? {
          output: extraction,
          traces: [],
          summary: emptyGraphRulesSummary(extraction.relations.length),
        },
        quickAudit,
        rejectedRelations,
        local.scope,
        local.context,
      ),
    );
  }
}
