import type {
  AbstractNodeKind,
  AspectKind,
  Chunk,
  Citation,
  ExtractionOutput,
  MappingAuditResult,
  ModelTestResult,
  PulseAnswerContext,
  PulseAnswerOutput,
  PulseNavigationCandidate,
  PulseNavigationDecision,
  RelationType,
  StatementPrecheckOutput,
} from "@agent-thinking/contracts";
import { extractionSchema, mappingAuditResultSchema, pulseAnswerSchema, pulseNavigationDecisionSchema, statementPrecheckSchema } from "@agent-thinking/contracts";
import type { AppConfig } from "../config.js";

export interface MappingAuditNodeContext {
  id: string;
  kind: AbstractNodeKind;
  title: string;
  summary: string;
  level: 1 | 2;
  evidenceChunkIds: string[];
}

export interface MappingAuditRelationContext {
  id: string;
  type: RelationType;
  sourceNodeId: string;
  sourceTitle: string;
  targetNodeId: string;
  targetTitle: string;
  reason: string;
  confidence: number | null;
  evidenceChunkIds: string[];
}

export interface MappingAuditContext {
  versionId: string;
  documentName: string;
  chunks: Chunk[];
  nodes: MappingAuditNodeContext[];
  relations: MappingAuditRelationContext[];
  note?: string;
}

type MappingAuditReview = Pick<MappingAuditResult, "status" | "summary" | "findings">;
const mappingAuditReviewSchema = mappingAuditResultSchema.omit({ reconstruction: true });

function stripModelFences(value: string): string {
  return value.trim().replace(/^```(?:json|markdown|md)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function jsonCandidate(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : undefined;
}

function parseJsonModelObject(raw: string): unknown {
  const cleaned = stripModelFences(raw);
  const candidates = [cleaned, jsonCandidate(cleaned)].filter((candidate): candidate is string => Boolean(candidate));
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型返回了不可解析的 JSON");
}

function modelText(raw: string): string {
  const cleaned = stripModelFences(raw);
  try {
    const parsed = parseJsonModelObject(cleaned) as { reconstruction?: unknown };
    if (typeof parsed.reconstruction === "string" && parsed.reconstruction.trim()) {
      return parsed.reconstruction.trim();
    }
  } catch {
    // Plain text is the preferred format for reconstruction; malformed JSON is shown as text.
  }
  return cleaned;
}

export interface ModelProvider {
  readonly name: string;
  readonly configured: boolean;
  embed(texts: string[]): Promise<number[][]>;
  extract(chunks: Chunk[], relatedChunks: Map<string, Chunk[]>): Promise<ExtractionOutput>;
  precheckStatement(text: string, citations: Citation[]): Promise<StatementPrecheckOutput>;
  reconstructMapping(context: MappingAuditContext): Promise<string>;
  auditMapping(reconstruction: string, originalChunks: Chunk[], graphContext: MappingAuditContext): Promise<MappingAuditReview>;
  answerPulse(question: string, context: PulseAnswerContext): Promise<PulseAnswerOutput>;
  selectPulseNavigation(question: string, step: string, candidates: PulseNavigationCandidate[]): Promise<PulseNavigationDecision>;
  stream(prompt: string): AsyncGenerator<{ type: "reasoning" | "content"; text: string }>;
  test(): Promise<ModelTestResult>;
}

function normalizedVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / magnitude);
}

function hashedEmbedding(text: string, dimensions = 384): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const normalized = text.normalize("NFKC").toLowerCase();
  const latinTokens = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjkRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const cjkTokens = cjkRuns.flatMap((run) => {
    const characters = [...run];
    return [
      ...characters,
      ...characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`),
    ];
  });
  for (const token of [...latinTokens, ...cjkTokens]) {
    let hash = 2166136261;
    for (const char of token) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    vector[(hash >>> 0) % dimensions] = (vector[(hash >>> 0) % dimensions] ?? 0) + 1;
  }
  return normalizedVector(vector);
}

function demoAspects(text: string, kind: "concept" | "claim"): AspectKind[] {
  if (kind === "claim") return ["claim"];
  if (/人|用户|研究者|author|person|team/i.test(text)) return ["person"];
  if (/系统|模型|平台|数据集|system|model|dataset|schema|programming/i.test(text)) return ["system"];
  if (/步骤|操作|更新|流程|方法|operation|process|update/i.test(text)) return ["operation"];
  if (/时间|阶段|日期|年|time|date|phase/i.test(text)) return ["time"];
  return ["other"];
}

export class FakeModelProvider implements ModelProvider {
  readonly name = "fake";
  readonly configured = true;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashedEmbedding(text));
  }

  async extract(chunks: Chunk[]): Promise<ExtractionOutput> {
    const selected = chunks.slice(0, 10);
    const nodes = selected.map((chunk, index) => {
      const opening = chunk.text.split(/[。\n.!?]/, 1)[0]?.trim() || `片段 ${index + 1}`;
      const kind = /因此|所以|therefore|conclusion|should|必须/i.test(chunk.text) ? "claim" as const : "concept" as const;
      return {
        key: `n${index}`,
        kind,
        title: chunk.headingPath || opening.slice(0, 44),
        summary: chunk.text.slice(0, 160),
        evidenceChunkIds: [chunk.id],
        aspects: demoAspects(chunk.text, kind),
      };
    });
    const relations = nodes.slice(1).map((node, index) => ({
      sourceKey: nodes[index]?.key ?? node.key,
      targetKey: node.key,
      type: "related_to" as const,
      reason: "演示模型根据相邻材料生成的待审核关联。",
      confidence: 0.55,
      evidenceChunkIds: [
        ...(nodes[index]?.evidenceChunkIds ?? []),
        ...node.evidenceChunkIds,
      ],
    }));
    const themes = nodes.length > 1 ? [{
      title: "材料主题概览",
      summary: "演示模型归纳的上层主题，用于概览与展开查看。",
      memberKeys: nodes.map((node) => node.key),
      evidenceChunkIds: nodes.flatMap((node) => node.evidenceChunkIds),
      aspects: [...new Set(nodes.flatMap((node) => node.aspects))],
    }] : [];
    return { nodes, relations, themes };
  }

  async precheckStatement(_text: string, citations: Citation[]): Promise<StatementPrecheckOutput> {
    if (citations.length === 0) {
      return {
        status: "unsupported",
        reason: "尚未关联原文证据，无法验证陈述。",
        suggestions: ["为该陈述添加能够直接支撑其结论或关联关系的原文引用。"],
      };
    }
    return {
      status: "supported",
      reason: "演示模式：该陈述已附带可定位来源，请由审核者核对原文后裁决。",
      suggestions: [],
    };
  }

  async reconstructMapping(context: MappingAuditContext): Promise<string> {
    const chunkOutline = context.chunks
      .slice(0, 8)
      .map((chunk) => `${chunk.ordinal + 1}. ${chunk.headingPath ? `${chunk.headingPath}：` : ""}${chunk.text.slice(0, 120)}`)
      .join("\n");
    const graphOutline = context.nodes
      .slice(0, 8)
      .map((node) => `- ${node.title}：${node.summary || "暂无摘要"}`)
      .join("\n");
    return [
      `演示语义重构：${context.documentName}`,
      "原文片段要点：",
      chunkOutline || "暂无可重构的原文片段。",
      "图谱映射要点：",
      graphOutline || "当前批次没有映射节点。",
    ].join("\n");
  }

  async auditMapping(_reconstruction: string, originalChunks: Chunk[], graphContext: MappingAuditContext): Promise<MappingAuditReview> {
    const firstChunk = originalChunks[0];
    if (graphContext.nodes.length === 0) {
      return {
        status: "major_issues",
        summary: "演示审计发现：当前原文片段没有形成可追踪的 AI 节点，mapping 覆盖不足。",
        findings: [{
          kind: "missing_source_meaning",
          severity: "high",
          title: "原文片段缺少映射节点",
          description: "这些 chunk 已完成切分，但审计上下文中没有可对应的 AI 节点或主题。",
          suggestion: "重新分析该文档，或检查 chunk 是否过长、标题是否缺失、模型抽取是否失败。",
          evidenceChunkIds: firstChunk ? [firstChunk.id] : [],
          nodeIds: [],
          relationIds: [],
        }],
      };
    }
    const relationWithoutEvidence = graphContext.relations.find((relation) => relation.evidenceChunkIds.length === 0);
    if (relationWithoutEvidence) {
      return {
        status: "minor_issues",
        summary: "演示审计发现：至少一条 AI 关系缺少直接证据，需要人工核对。",
        findings: [{
          kind: "unsupported_graph_claim",
          severity: "medium",
          title: "关系缺少原文证据",
          description: `关系 ${relationWithoutEvidence.sourceTitle} → ${relationWithoutEvidence.targetTitle} 没有关联证据 chunk。`,
          suggestion: "补充关系证据，或在关系审核中拒绝/改写该关系。",
          evidenceChunkIds: firstChunk ? [firstChunk.id] : [],
          nodeIds: [relationWithoutEvidence.sourceNodeId, relationWithoutEvidence.targetNodeId],
          relationIds: [relationWithoutEvidence.id],
        }],
      };
    }
    const firstNode = graphContext.nodes[0]!;
    return {
      status: "minor_issues",
      summary: "演示审计建议：mapping 基本可读，但仍建议核对节点摘要是否保留原文限定条件。",
      findings: [{
        kind: "overgeneralization",
        severity: "low",
        title: "核对节点摘要的限定条件",
        description: `节点“${firstNode.title}”由原文抽象而来，演示审计建议人工确认摘要没有扩大原文含义。`,
        suggestion: "打开相关 chunk，对照节点标题和摘要，必要时手动修改节点摘要或关系说明。",
        evidenceChunkIds: firstNode.evidenceChunkIds.length > 0 ? firstNode.evidenceChunkIds : firstChunk ? [firstChunk.id] : [],
        nodeIds: [firstNode.id],
        relationIds: [],
      }],
    };
  }

  async answerPulse(question: string, context: PulseAnswerContext): Promise<PulseAnswerOutput> {
    const topNodes = context.nodes.slice(0, 3).map((node) => node.title).join("、") || "暂无节点";
    const topChunks = context.chunks.slice(0, 2).map((chunk) => chunk.text.slice(0, 80)).join("；") || "暂无证据片段";
    return {
      answer: `演示脉冲回答：问题“${question}”主要激活了 ${topNodes}。相关证据包括：${topChunks}`,
      summary: `激活 ${context.nodes.length} 个节点、${context.relations.length} 条关系、${context.chunks.length} 个证据片段。`,
    };
  }

  async selectPulseNavigation(question: string, step: string, candidates: PulseNavigationCandidate[]): Promise<PulseNavigationDecision> {
    const terms = question.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
    const ranked = candidates
      .map((candidate) => {
        const text = `${candidate.label} ${candidate.summary} ${candidate.relationLabel ?? ""} ${candidate.relationReason ?? ""}`
          .normalize("NFKC")
          .toLowerCase();
        const matches = terms.filter((term) => text.includes(term)).length;
        return { candidate, score: matches * 2 + candidate.score };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .map((entry) => entry.candidate);
    const selected = ranked.length > 0 ? ranked : candidates.slice(0, 1);
    return {
      selectedIds: selected.map((candidate) => candidate.id),
      observation: `演示模式在“${step}”看到 ${candidates.length} 个候选：${candidates.slice(0, 5).map((candidate) => candidate.label).join("、")}。`,
      rationale: selected.length > 0
        ? `选择 ${selected.map((candidate) => candidate.label).join("、")}，因为它们与问题词或候选分数更接近。`
        : "没有足够候选可继续展开。",
    };
  }

  async *stream(prompt: string): AsyncGenerator<{ type: "content"; text: string }> {
    const response = `演示模型已收到请求：“${prompt.slice(0, 80)}”。配置 DeepSeek 密钥后，此窗口会显示真实的逐段输出。`;
    for (const part of response.match(/.{1,10}/gu) ?? []) {
      yield { type: "content", text: part };
    }
  }

  async test(): Promise<ModelTestResult> {
    return { ok: true, provider: this.name, message: "演示模型已启用；不会发送文档到云端。" };
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;

  constructor(private readonly config: AppConfig) {
    this.name = config.provider === "deepseek" ? "deepseek" : "openai-compatible";
  }

  get configured(): boolean {
    return Boolean(
      this.config.aiApiKey &&
      this.config.chatModel &&
      (this.config.embeddingProvider === "local" ||
        (this.config.embeddingApiKey && this.config.embeddingModel)),
    );
  }

  private async request<T>(baseUrl: string, apiKey: string | undefined, path: string, body: unknown): Promise<T> {
    if (!apiKey) throw new Error(this.config.provider === "deepseek" ? "未配置 DEEPSEEK_API_KEY" : "未配置 AI_API_KEY");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`模型服务请求失败 (${response.status}): ${text.slice(0, 240)}`);
    }
    return response.json() as Promise<T>;
  }

  private async repairMappingAuditJson(raw: string, parseError: unknown): Promise<MappingAuditReview> {
    const errorMessage = parseError instanceof Error ? parseError.message : "JSON parse failed";
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Repair the supplied malformed JSON into valid JSON that matches exactly this shape: " +
            '{"status":"clean|minor_issues|major_issues|failed","summary":"...","findings":[{"kind":"missing_source_meaning|unsupported_graph_claim|wrong_relation|chunk_boundary_loss|overgeneralization|other","severity":"low|medium|high","title":"...","description":"...","suggestion":"...","evidenceChunkIds":["..."],"nodeIds":["..."],"relationIds":["..."]}]}. ' +
            "Preserve the meaning of any recoverable fields. If a field is missing, choose a conservative valid value. Return JSON only.",
        },
        { role: "user", content: JSON.stringify({ parseError: errorMessage, malformedJson: raw.slice(0, 12000) }) },
      ],
      max_tokens: 1400,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const repaired = response.choices[0]?.message.content ?? "{}";
    return mappingAuditReviewSchema.parse(parseJsonModelObject(repaired));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.config.embeddingProvider === "local") return texts.map((text) => hashedEmbedding(text));
    if (!this.config.embeddingModel) throw new Error("未配置 AI_EMBEDDING_MODEL");
    const result = await this.request<{ data: Array<{ embedding: number[]; index: number }> }>(
      this.config.embeddingBaseUrl,
      this.config.embeddingApiKey,
      "/embeddings",
      { model: this.config.embeddingModel, input: texts },
    );
    return result.data.sort((left, right) => left.index - right.index).map((item) => item.embedding);
  }

  async extract(chunks: Chunk[], relatedChunks: Map<string, Chunk[]>): Promise<ExtractionOutput> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const evidence = chunks.map((chunk) => ({
      id: chunk.id,
      source: chunk.headingPath ?? (chunk.pageNumber ? `PDF page ${chunk.pageNumber}` : ""),
      text: chunk.text.slice(0, 2400),
      candidates: (relatedChunks.get(chunk.id) ?? []).map((candidate) => ({
        id: candidate.id,
        source: candidate.headingPath ?? (candidate.pageNumber ? `PDF page ${candidate.pageNumber}` : ""),
        text: candidate.text.slice(0, 1200),
      })),
    }));
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract a compact knowledge graph from evidence chunks. Return JSON with this shape: " +
            '{"nodes":[{"key":"n1","kind":"concept","title":"...","summary":"...","evidenceChunkIds":["..."],"aspects":["system"]}],' +
            '"relations":[{"sourceKey":"n1","targetKey":"n2","type":"supports","reason":"...","confidence":0.8,"evidenceChunkIds":["..."]}],' +
            '"themes":[{"title":"...","summary":"...","memberKeys":["n1","n2"],"evidenceChunkIds":["..."],"aspects":["system"]}]}. ' +
            "Node kind is concept or claim. Relation type must be supports, contradicts, explains, depends_on, example_of, or related_to. " +
            "Every node and theme must include an aspects array (it may be empty) chosen from person, operation, system, story, claim, conflict, time, other. " +
            "Create a small number of themes only when multiple nodes share a defensible higher-level subject; themes organize navigation and must cite evidence. " +
            "Candidate evidence may come from other documents and should be used to identify contradictions. " +
            "Every node and relation must cite evidenceChunkIds from supplied evidence or candidate ids; only create defensible relationships.",
        },
        { role: "user", content: JSON.stringify({ evidence }) },
      ],
      max_tokens: 4096,
    };
    if (this.config.provider === "deepseek") {
      body.thinking = { type: this.config.thinkingMode };
    }
    const response = await this.request<{
      choices: Array<{ message: { content: string } }>;
    }>(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", body);
    const raw = response.choices[0]?.message.content ?? "{}";
    const json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return extractionSchema.parse(json);
  }

  async precheckStatement(text: string, citations: Citation[]): Promise<StatementPrecheckOutput> {
    if (citations.length === 0) {
      return {
        status: "unsupported",
        reason: "尚未关联原文证据，无法验证陈述。",
        suggestions: ["补充直接支持该陈述及其关系判断的原文证据。"],
      };
    }
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const evidence = citations.map((citation) => ({
      document: citation.documentName,
      location: citation.pageNumber
        ? `page ${citation.pageNumber}`
        : `lines ${citation.startLine ?? "?"}-${citation.endLine ?? citation.startLine ?? "?"}`,
      heading: citation.headingPath,
      excerpt: citation.excerpt,
    }));
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Review whether the supplied source excerpts support the analysis statement and whether any asserted relationship between concepts or claims is justified. " +
            'Return JSON only: {"status":"supported|partially_supported|unsupported","reason":"...","suggestions":["..."]}. ' +
            "Use supported only when the statement and asserted relationship are directly justified by the excerpts. " +
            "When support is weak, missing, or the relationship appears irrelevant, provide up to three concise, actionable suggestions, such as what evidence is missing or which relationship needs reconsideration. " +
            "Return an empty suggestions array only when there is no meaningful improvement to recommend. Be conservative.",
        },
        { role: "user", content: JSON.stringify({ statement: text, evidence }) },
      ],
      max_tokens: 800,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    return statementPrecheckSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")));
  }

  async reconstructMapping(context: MappingAuditContext): Promise<string> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const evidence = context.chunks.map((chunk) => ({
      id: chunk.id,
      ordinal: chunk.ordinal,
      heading: chunk.headingPath,
      pageNumber: chunk.pageNumber,
      text: chunk.text.slice(0, 2400),
    }));
    const graph = {
      nodes: context.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        level: node.level,
        title: node.title,
        summary: node.summary,
        evidenceChunkIds: node.evidenceChunkIds,
      })),
      relations: context.relations.map((relation) => ({
        id: relation.id,
        type: relation.type,
        source: relation.sourceTitle,
        target: relation.targetTitle,
        reason: relation.reason,
        evidenceChunkIds: relation.evidenceChunkIds,
      })),
    };
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "Reconstruct the semantic outline of the original document section using only the supplied knowledge graph mapping. " +
            "Do not try to reproduce exact wording. Capture what the graph claims the source means, including important qualifiers, causal/argument links, and uncertainty. " +
            "Return plain text only, not JSON and not Markdown code fences.",
        },
        { role: "user", content: JSON.stringify({ document: context.documentName, evidence, graph, note: context.note ?? "" }) },
      ],
      max_tokens: 2400,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const reconstruction = modelText(response.choices[0]?.message.content ?? "");
    if (!reconstruction.trim()) throw new Error("语义重构模型没有返回可展示文本");
    return reconstruction.slice(0, 20000);
  }

  async auditMapping(reconstruction: string, originalChunks: Chunk[], graphContext: MappingAuditContext): Promise<MappingAuditReview> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const original = originalChunks.map((chunk) => ({
      id: chunk.id,
      ordinal: chunk.ordinal,
      heading: chunk.headingPath,
      pageNumber: chunk.pageNumber,
      text: chunk.text.slice(0, 2600),
    }));
    const graph = {
      nodes: graphContext.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        summary: node.summary,
        evidenceChunkIds: node.evidenceChunkIds,
      })),
      relations: graphContext.relations.map((relation) => ({
        id: relation.id,
        type: relation.type,
        sourceNodeId: relation.sourceNodeId,
        sourceTitle: relation.sourceTitle,
        targetNodeId: relation.targetNodeId,
        targetTitle: relation.targetTitle,
        reason: relation.reason,
        evidenceChunkIds: relation.evidenceChunkIds,
      })),
    };
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an auditor for chunking and knowledge-graph mapping quality. Compare the original chunks with the semantic reconstruction and graph mapping. " +
            "Find semantic divergence only: missing important source meaning, unsupported graph claims, wrong relation type or direction, overgeneralization, and meaning lost at chunk boundaries. " +
            "Do not penalize harmless wording changes. Prefer actionable findings with exact chunk, node, and relation ids when relevant. " +
            'Return JSON only: {"status":"clean|minor_issues|major_issues|failed","summary":"...","findings":[{"kind":"missing_source_meaning|unsupported_graph_claim|wrong_relation|chunk_boundary_loss|overgeneralization|other","severity":"low|medium|high","title":"...","description":"...","suggestion":"...","evidenceChunkIds":["..."],"nodeIds":["..."],"relationIds":["..."]}]}.',
        },
        { role: "user", content: JSON.stringify({ original, reconstruction, graph, note: graphContext.note ?? "" }) },
      ],
      max_tokens: 1800,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    try {
      return mappingAuditReviewSchema.parse(parseJsonModelObject(raw));
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      try {
        return await this.repairMappingAuditJson(raw, cause);
      } catch {
        return {
          status: "failed",
          summary: "审计模型返回的结构化 JSON 无法解析；已保留语义重构文本，请重新运行审计。",
          findings: [{
            kind: "other",
            severity: "medium",
            title: "审计结构化输出解析失败",
            description: `模型返回了不完整或未正确转义的 JSON：${cause.message}`,
            suggestion: "点击重新运行；如果反复出现，可缩短输入文档或检查当前模型的 JSON 输出稳定性。",
            evidenceChunkIds: originalChunks.slice(0, 3).map((chunk) => chunk.id),
            nodeIds: graphContext.nodes.slice(0, 3).map((node) => node.id),
            relationIds: graphContext.relations.slice(0, 3).map((relation) => relation.id),
          }],
        };
      }
    }
  }

  async answerPulse(question: string, context: PulseAnswerContext): Promise<PulseAnswerOutput> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Answer the user's question using only the supplied knowledge graph context. " +
            'Return JSON only: {"answer":"...","summary":"..."}. ' +
            "The answer should be concise, grounded in the chunks, nodes, and relations provided, and must mention uncertainty when evidence is thin. " +
            "The summary should briefly describe which graph areas were activated.",
        },
        { role: "user", content: JSON.stringify({ question, context }) },
      ],
      max_tokens: 1200,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    return pulseAnswerSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")));
  }

  async selectPulseNavigation(
    question: string,
    step: string,
    candidates: PulseNavigationCandidate[],
  ): Promise<PulseNavigationDecision> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Choose the next visible knowledge-graph node for a progressive retrieval pulse. " +
            'Return JSON only: {"selectedIds":["..."],"observation":"...","rationale":"...","rejectedCandidates":[{"id":"...","reason":"..."}]}. ' +
            "selectedIds must come from the supplied candidates and include one to three ids. " +
            "observation should state what information was visible at this step. " +
            "rationale should be a concise, user-facing navigation reason based only on visible candidate labels, summaries, relation labels, and relation reasons. " +
            "rejectedCandidates should briefly explain why up to four visible but unselected candidates were less useful than the selected ones. " +
            "Do not reveal hidden chain-of-thought or private scratchpad reasoning; provide an auditable explanation instead.",
        },
        { role: "user", content: JSON.stringify({ question, step, candidates }) },
      ],
      max_tokens: 700,
    };
    if (this.config.provider === "deepseek") body.thinking = { type: this.config.thinkingMode };
    const response = await this.request<{ choices: Array<{ message: { content: string } }> }>(
      this.config.aiBaseUrl,
      this.config.aiApiKey,
      "/chat/completions",
      body,
    );
    const raw = response.choices[0]?.message.content ?? "{}";
    const parsed = pulseNavigationDecisionSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")));
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const selectedIds = parsed.selectedIds.filter((id) => candidateIds.has(id)).slice(0, 3);
    if (selectedIds.length === 0 && candidates[0]) {
      return {
        selectedIds: [candidates[0].id],
        observation: parsed.observation,
        rationale: `${parsed.rationale}（模型返回的候选不在当前可见集合中，已回退到最高候选。）`,
      };
    }
    return { ...parsed, selectedIds };
  }

  async *stream(prompt: string): AsyncGenerator<{ type: "reasoning" | "content"; text: string }> {
    if (!this.config.chatModel) throw new Error("未配置 AI_CHAT_MODEL");
    if (!this.config.aiApiKey) throw new Error(this.config.provider === "deepseek" ? "未配置 DEEPSEEK_API_KEY" : "未配置 AI_API_KEY");
    const response = await fetch(`${this.config.aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.aiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.chatModel,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
        ...(this.config.provider === "deepseek" ? { thinking: { type: this.config.thinkingMode } } : {}),
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`模型服务请求失败 (${response.status}): ${text.slice(0, 240)}`);
    }
    if (!response.body) throw new Error("模型服务没有返回流式响应体");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const parts = buffered.split(/\r?\n\r?\n/);
      buffered = done ? "" : parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
          };
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.reasoning_content) yield { type: "reasoning", text: delta.reasoning_content };
          if (delta?.content) yield { type: "content", text: delta.content };
        }
      }
      if (done) break;
    }
  }

  async test(): Promise<ModelTestResult> {
    if (!this.configured) {
      return {
        ok: false,
        provider: this.name,
        message: this.config.provider === "deepseek"
          ? "请在 .env 中填写 DEEPSEEK_API_KEY；本地 embedding 已启用。"
          : "请在 .env 中配置 API 密钥以及聊天和 embedding 模型。",
      };
    }
    await this.request(this.config.aiBaseUrl, this.config.aiApiKey, "/chat/completions", {
      model: this.config.chatModel,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 8,
      ...(this.config.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
    });
    await this.embed(["AgentThinking connection test"]);
    return { ok: true, provider: this.name, message: "模型连接正常。" };
  }
}

export function createModelProvider(config: AppConfig): ModelProvider {
  return config.provider === "fake" ? new FakeModelProvider() : new OpenAICompatibleProvider(config);
}
