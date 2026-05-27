import type { Chunk, Citation, ExtractionOutput, ModelTestResult, StatementPrecheckOutput } from "@agent-thinking/contracts";
import { extractionSchema, statementPrecheckSchema } from "@agent-thinking/contracts";
import type { AppConfig } from "../config.js";

export interface ModelProvider {
  readonly name: string;
  readonly configured: boolean;
  embed(texts: string[]): Promise<number[][]>;
  extract(chunks: Chunk[], relatedChunks: Map<string, Chunk[]>): Promise<ExtractionOutput>;
  precheckStatement(text: string, citations: Citation[]): Promise<StatementPrecheckOutput>;
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
      return {
        key: `n${index}`,
        kind: /因此|所以|conclusion|should|必须/i.test(chunk.text) ? "claim" as const : "concept" as const,
        title: chunk.headingPath || opening.slice(0, 44),
        summary: chunk.text.slice(0, 160),
        evidenceChunkIds: [chunk.id],
        aspects: [],
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
      aspects: [],
    }] : [];
    return { nodes, relations, themes };
  }

  async precheckStatement(_text: string, citations: Citation[]): Promise<StatementPrecheckOutput> {
    if (citations.length === 0) {
      return { status: "unsupported", reason: "尚未关联原文证据，无法验证陈述。" };
    }
    return { status: "supported", reason: "演示模式：该陈述已附带可定位来源，请由审核者核对原文后裁决。" };
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
            "Aspects are optional labels chosen from person, operation, system, story, claim, conflict, time, other. " +
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
      return { status: "unsupported", reason: "尚未关联原文证据，无法验证陈述。" };
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
            "Determine whether the supplied source excerpts support the analysis statement. " +
            'Return JSON only: {"status":"supported|partially_supported|unsupported","reason":"..."}. ' +
            "Use supported only when the statement is directly justified by the excerpts. Be conservative.",
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
