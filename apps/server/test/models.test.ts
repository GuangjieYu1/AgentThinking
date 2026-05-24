import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chunk } from "@agent-thinking/contracts";
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
      startChar: 0,
      endChar: 4,
      text: "概念证据",
    };
    await provider.extract([chunk], new Map());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(request?.body as string) as Record<string, unknown>;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
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
});
