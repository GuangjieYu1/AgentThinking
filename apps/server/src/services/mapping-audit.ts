import type { Chunk, MappingAudit, MappingAuditFinding, MappingAuditResult, MappingAuditStatus } from "@agent-thinking/contracts";
import type { AgentDatabase } from "../db.js";
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
      title: "文档缺少 AI 映射节点",
      description: "该版本的 chunk 没有关联到 AI 生成的节点或主题，说明抽取结果可能为空或未覆盖原文。",
      suggestion: "重新分析该文档，并检查 chunk 是否过长、文本解析是否异常、模型配置是否可用。",
      evidenceChunkIds: context.chunks.slice(0, 3).map((chunk) => chunk.id),
      nodeIds: [],
      relationIds: [],
    }],
  };
}

function combineResults(results: MappingAuditResult[]): MappingAuditResult {
  const findings = results.flatMap((result) => result.findings);
  const status = statusFromFindings(findings, results.map((result) => result.status));
  const issueCount = findings.length;
  const summary = status === "clean"
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

export class MappingAuditService {
  constructor(
    private readonly db: AgentDatabase,
    private readonly model: ModelProvider,
  ) {}

  async run(versionId: string): Promise<MappingAudit> {
    const source = this.db.getVersionSource(versionId);
    if (!source) throw new Error("导入版本不存在");
    const context = this.db.getMappingAuditContext(versionId);
    if (!context) throw new Error("导入版本不存在");
    try {
      if (context.chunks.length === 0 || context.nodes.length === 0) {
        return this.db.saveMappingAudit(source.libraryId, versionId, emptyMappingResult(context));
      }
      const results: MappingAuditResult[] = [];
      for (const batch of chunkBatches(context.chunks)) {
        const currentContext = batchContext(context, batch);
        const reconstruction = await this.model.reconstructMapping(currentContext);
        const review = await this.model.auditMapping(reconstruction, batch, currentContext);
        results.push({
          status: review.status,
          summary: review.summary,
          reconstruction,
          findings: review.findings,
        });
      }
      const combined = combineResults(results);
      return this.db.saveMappingAudit(source.libraryId, versionId, combined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "映射审计失败";
      return this.db.saveMappingAudit(source.libraryId, versionId, {
        status: "failed",
        summary: message,
        reconstruction: "",
        findings: [],
      });
    }
  }
}
