import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chunk, MappingAudit } from "@agent-thinking/contracts";
import { getConfig } from "../src/config.js";
import { OpenAICompatibleProvider } from "../src/services/models.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeepSeek model configuration", () => {
  const config = getConfig({
    provider: "deepseek",
    aiBaseUrl: "https://api.deepseek.com",
    aiApiKey: "deepseek-test-key",
    chatModel: "deepseek-v4-flash",
    thinkingMode: "disabled",
    embeddingProvider: "local",
  });

  it("generates local embeddings without calling an undocumented DeepSeek embeddings endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const embeddings = await provider.embed(["知识关系", "知识图谱"]);
    expect(embeddings[0]).toHaveLength(384);
    expect(embeddings[0]).not.toEqual(embeddings[1]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses DeepSeek V4 structured chat extraction with thinking disabled", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ nodes: [], relations: [] }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: null,
      pageNumber: null,
      startLine: null,
      endLine: null,
      blockId: null,
      startChar: 0,
      endChar: 4,
      text: "概念证据",
      aspects: [],
    };
    await provider.extract([chunk], new Map());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(request?.body as string) as Record<string, unknown>;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect((body.messages as Array<{ content: string }>)[0]!.content).toContain("Relation Governance Rules");
  });

  it("keeps full source text in AORI long-context extraction requests", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ nodes: [], relations: [], themes: [] }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const tailMarker = "AORI_TAIL_MARKER";
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: "Long",
      pageNumber: null,
      startLine: null,
      endLine: null,
      blockId: null,
      startChar: 0,
      endChar: 4000,
      text: `${"long-context ".repeat(260)}${tailMarker}`,
      aspects: [],
    };
    await provider.extract([chunk], new Map(), {
      aoriContext: {
        stage: "global_reading",
        groupId: "aori-global-1",
        documentName: "long.md",
        documentTokenEstimate: 1200,
        inputTokenEstimate: 1200,
        usedTokenEstimate: 1200,
        preservedRanges: ["Long"],
        omittedRanges: [],
        truncated: false,
        risk: "low",
        minTruncatedContextTokens: 10000,
        evidenceBindingMinContextTokens: 10000,
        allowSmallContextOnlyForQuoteLookup: true,
      },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as { messages: Array<{ content: string }>; max_tokens: number };
    expect(body.messages[0]!.content).toContain("AORI indexing mode");
    expect(body.messages[1]!.content).toContain(tailMarker);
    expect(body.max_tokens).toBe(12000);
  });

  it("sanitizes extracted nodes that omit optional-but-required arrays", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          nodes: [{ key: "n1", kind: "concept", title: "Node", summary: "", evidenceChunkIds: [] }],
          relations: [],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: null,
      pageNumber: null,
      startLine: null,
      endLine: null,
      blockId: null,
      startChar: 0,
      endChar: 4,
      text: "概念证据",
      aspects: [],
    };
    const extraction = await provider.extract([chunk], new Map());
    expect(extraction.nodes[0]?.aspects).toEqual(["other"]);
    expect(extraction.nodes[0]?.evidenceChunkIds).toEqual(["chunk-1"]);
  });

  it("repairs malformed extraction JSON and falls back without failing imports", async () => {
    const responses = [
      { choices: [{ message: { content: '{"nodes":[{"key":"n1","kind":"concept","title":"Broken"' } }] },
      { choices: [{ message: { content: JSON.stringify({
        nodes: [{
          key: "n1",
          kind: "concept",
          title: "修复节点",
          summary: "修复后的摘要",
          evidenceChunkIds: ["chunk-1", "unknown"],
          aspects: ["system", "bad"],
        }],
        relations: [],
        themes: [],
      }) } }] },
    ];
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: null,
      pageNumber: null,
      startLine: null,
      endLine: null,
      blockId: null,
      startChar: 0,
      endChar: 4,
      text: "概念证据",
      aspects: [],
    };
    const extraction = await provider.extract([chunk], new Map());
    expect(extraction.nodes[0]?.title).toBe("修复节点");
    expect(extraction.nodes[0]?.evidenceChunkIds).toEqual(["chunk-1"]);
    expect(extraction.nodes[0]?.aspects).toEqual(["system"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards streamed DeepSeek content and reasoning deltas", async () => {
    const upstream = [
      'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"回答"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ ...config, thinkingMode: "enabled" });
    const pieces = [];
    for await (const delta of provider.stream("测试")) pieces.push(delta);
    expect(pieces).toEqual([
      { type: "reasoning", text: "思考" },
      { type: "content", text: "回答" },
    ]);
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(request?.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("prechecks an analysis statement against supplied citations", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          status: "partially_supported",
          reason: "论据只支持部分结论。",
          suggestions: ["补充直接说明因果关系的证据。"],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const result = await provider.precheckStatement("材料支持结论。", [{
      versionId: "version-1",
      chunkId: "chunk-1",
      documentName: "source.md",
      mediaType: "text/markdown",
      headingPath: "证据",
      pageNumber: null,
      startLine: 1,
      endLine: 2,
      blockId: null,
      excerpt: "材料支持结论。",
    }]);
    expect(result.status).toBe("partially_supported");
    expect(result.suggestions).toEqual(["补充直接说明因果关系的证据。"]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as { messages: Array<{ content: string }> };
    expect(body.messages[1]!.content).toContain("材料支持结论");
    expect(body.messages[0]!.content).toContain("relationship");
  });

  it("reconstructs and audits mapping output with structured validation", async () => {
    const responses = [
      { choices: [{ message: { content: "semantic reconstruction" } }] },
      { choices: [{ message: { content: JSON.stringify({
        status: "minor_issues",
        summary: "one issue",
        findings: [{
          kind: "overgeneralization",
          severity: "low",
          title: "Check abstraction",
          description: "Node summary may be too broad.",
          suggestion: "Compare with the source chunk.",
          evidenceChunkIds: ["chunk-1"],
          nodeIds: ["node-1"],
          relationIds: [],
        }],
      }) } }] },
    ];
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: "Topic",
      pageNumber: null,
      startLine: 1,
      endLine: 2,
      blockId: null,
      startChar: 0,
      endChar: 8,
      text: "原文内容",
      aspects: [],
    };
    const context = {
      versionId: "version-1",
      documentName: "source.md",
      chunks: [chunk],
      nodes: [{
        id: "node-1",
        kind: "concept" as const,
        title: "Topic",
        summary: "summary",
        level: 1 as const,
        evidenceChunkIds: ["chunk-1"],
      }],
      relations: [],
    };
    const reconstruction = await provider.reconstructMapping(context);
    const audit = await provider.auditMapping(reconstruction, [chunk], context);
    expect(reconstruction).toBe("semantic reconstruction");
    expect(audit.status).toBe("minor_issues");
    expect(audit.findings[0]?.kind).toBe("overgeneralization");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reconstructionBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as { messages: Array<{ content: string }> };
    const auditBody = JSON.parse(fetchMock.mock.calls[1]![1]?.body as string) as { messages: Array<{ content: string }> };
    expect(reconstructionBody.messages[0]!.content).toContain("Simplified Chinese");
    expect(auditBody.messages[0]!.content).toContain("Simplified Chinese");
    expect(auditBody.messages[0]!.content).toContain("Semantic Coverage Rules");
  });

  it("runs dirty extraction relations through graph rules finalize path", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          nodes: [
            { key: "a", kind: "claim", title: "A", summary: "A", evidenceChunkIds: ["chunk-1"], aspects: ["claim"] },
            { key: "b", kind: "claim", title: "B", summary: "B", evidenceChunkIds: ["chunk-1"], aspects: ["claim"] },
          ],
          relations: [{
            sourceKey: "a",
            targetKey: "b",
            type: "causes",
            reason: "dirty relation",
            confidence: 2,
            evidenceChunkIds: ["chunk-1"],
          }],
          themes: [],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: "Topic",
      pageNumber: null,
      startLine: 1,
      endLine: 2,
      blockId: null,
      startChar: 0,
      endChar: 8,
      text: "source text",
      aspects: [],
    };
    const graphRuleResults: Array<{ traces: Array<{ action: string }> }> = [];
    const extraction = await provider.extract([chunk], new Map(), {
      onGraphRules: (result) => graphRuleResults.push(result),
    });
    expect(extraction.relations[0]?.type).toBe("related_to");
    expect(extraction.relations[0]?.confidence).toBeLessThanOrEqual(0.3);
    expect(extraction.relations[0]?.originalType).toBe("causes");
    expect(extraction.relations[0]?.originalConfidence).toBe(2);
    expect(graphRuleResults[0]?.traces.some((trace) => trace.action === "relation_type_downgraded")).toBe(true);
    expect(graphRuleResults[0]?.traces.some((trace) => trace.action === "confidence_normalized")).toBe(true);
  });

  it("adds graph evolution rules to rebuild prompts and finalizes rebuild output", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          nodes: [
            { key: "a", kind: "claim", title: "A", summary: "A", evidenceChunkIds: ["chunk-1"], aspects: ["claim"] },
            { key: "b", kind: "claim", title: "B", summary: "B", evidenceChunkIds: ["chunk-1"], aspects: ["claim"] },
          ],
          relations: [{
            sourceKey: "a",
            targetKey: "b",
            type: "related_to",
            reason: "weak",
            confidence: 0.95,
            evidenceChunkIds: ["chunk-1"],
          }],
          themes: [],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: "Topic",
      pageNumber: null,
      startLine: 1,
      endLine: 2,
      blockId: null,
      startChar: 0,
      endChar: 8,
      text: "source text",
      aspects: [],
    };
    const audit: MappingAudit = {
      id: "audit-1",
      libraryId: "library-1",
      versionId: "version-1",
      status: "minor_issues",
      summary: "summary",
      reconstruction: "reconstruction",
      findings: [],
      graphRebuildReport: "",
      graphRebuiltAt: null,
      createdAt: new Date().toISOString(),
    };
    const context = {
      versionId: "version-1",
      documentName: "source.md",
      chunks: [chunk],
      nodes: [],
      relations: [],
    };
    const extraction = await provider.rebuildGraphFromMappingAudit(audit, [chunk], context);
    expect(extraction.relations[0]?.confidence).toBe(0.6);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as { messages: Array<{ content: string }> };
    expect(body.messages[0]!.content).toContain("Graph Evolution Rules");
  });

  it("sanitizes overlong mapping audit text fields before validation", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          status: "minor_issues",
          summary: "s".repeat(1300),
          findings: [{
            kind: "overgeneralization",
            severity: "low",
            title: "t".repeat(120),
            description: "d".repeat(1600),
            suggestion: "x".repeat(700),
            evidenceChunkIds: ["chunk-1", 42, ""],
            nodeIds: ["node-1", null],
            relationIds: [false, "relation-1"],
          }],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: "Topic",
      pageNumber: null,
      startLine: 1,
      endLine: 2,
      blockId: null,
      startChar: 0,
      endChar: 8,
      text: "source text",
      aspects: [],
    };
    const audit = await provider.auditMapping("semantic reconstruction", [chunk], {
      versionId: "version-1",
      documentName: "source.md",
      chunks: [chunk],
      nodes: [{
        id: "node-1",
        kind: "concept" as const,
        title: "Topic",
        summary: "summary",
        level: 1 as const,
        evidenceChunkIds: ["chunk-1"],
      }],
      relations: [],
    });
    expect(audit.summary).toHaveLength(1000);
    expect(audit.findings[0]?.title.length).toBeLessThanOrEqual(80);
    expect(audit.findings[0]?.description.length).toBeLessThanOrEqual(800);
    expect(audit.findings[0]?.description).toContain("已截断");
    expect(audit.findings[0]?.suggestion.length).toBeLessThanOrEqual(400);
    expect(audit.findings[0]?.evidenceChunkIds).toEqual(["chunk-1"]);
    expect(audit.findings[0]?.nodeIds).toEqual(["node-1"]);
    expect(audit.findings[0]?.relationIds).toEqual(["relation-1"]);
  });

  it("repairs malformed mapping audit JSON instead of failing the whole audit", async () => {
    const responses = [
      { choices: [{ message: { content: '{"status":"minor_issues","summary":"partial","findings":[{"kind":"overgeneralization","severity":"low","title":"Broken' } }] },
      { choices: [{ message: { content: JSON.stringify({
        status: "minor_issues",
        summary: "repaired issue",
        findings: [{
          kind: "overgeneralization",
          severity: "low",
          title: "Repaired finding",
          description: "The original audit JSON was incomplete.",
          suggestion: "Review the affected source chunk.",
          evidenceChunkIds: ["chunk-1"],
          nodeIds: ["node-1"],
          relationIds: [],
        }],
      }) } }] },
    ];
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    const chunk: Chunk = {
      id: "chunk-1",
      libraryId: "library-1",
      versionId: "version-1",
      ordinal: 0,
      headingPath: "Topic",
      pageNumber: null,
      startLine: 1,
      endLine: 2,
      blockId: null,
      startChar: 0,
      endChar: 8,
      text: "source text",
      aspects: [],
    };
    const context = {
      versionId: "version-1",
      documentName: "source.md",
      chunks: [chunk],
      nodes: [{
        id: "node-1",
        kind: "concept" as const,
        title: "Topic",
        summary: "summary",
        level: 1 as const,
        evidenceChunkIds: ["chunk-1"],
      }],
      relations: [],
    };
    const audit = await provider.auditMapping("semantic reconstruction", [chunk], context);
    expect(audit.status).toBe("minor_issues");
    expect(audit.summary).toBe("repaired issue");
    expect(audit.findings[0]?.title).toBe("Repaired finding");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(fetchMock.mock.calls[1]![1]?.body as string) as { messages: Array<{ content: string }> };
    expect(repairBody.messages[0]!.content).toContain("Repair the supplied malformed JSON");
  });

  it("rejects mapping audit findings with invalid labels", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          status: "minor_issues",
          summary: "bad",
          findings: [{
            kind: "invented_kind",
            severity: "low",
            title: "bad",
            description: "bad",
            suggestion: "bad",
            evidenceChunkIds: [],
            nodeIds: [],
            relationIds: [],
          }],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider(config);
    await expect(provider.auditMapping("reconstruction", [], {
      versionId: "version-1",
      documentName: "source.md",
      chunks: [],
      nodes: [],
      relations: [],
    })).rejects.toThrow();
  });
});
