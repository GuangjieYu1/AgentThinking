import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../src/services/models.js";
import { getConfig } from "../src/config.js";
import { parseDocument } from "../src/services/parser.js";

let pageText = "";
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: pageText }] }),
        getViewport: () => ({ width: 20, height: 20 }),
        render: () => ({ promise: Promise.resolve() }),
      }),
      destroy: async () => undefined,
    }),
  }),
}));

const recognize = vi.fn(async () => ({ data: { text: "本地 OCR 内容" } }));
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize, terminate: async () => undefined }),
}));

function model(ocrText = "云端 OCR 内容"): ModelProvider {
  return {
    name: "test",
    configured: true,
    embed: async () => [],
    extract: async () => ({ nodes: [], relations: [] }),
    stream: async function* () { yield { type: "content", text: "ok" }; },
    ocrImage: async () => ocrText,
    test: async () => ({ ok: true, provider: "test", message: "ok" }),
  };
}

describe("PDF parsing and OCR", () => {
  const config = getConfig({ dataDir: "./data/test", ocrCacheDir: "./data/test/ocr", provider: "fake" });

  it("uses embedded PDF text without OCR when text is available", async () => {
    pageText = "This document includes enough embedded readable PDF text.";
    const onOcrRequired = vi.fn();
    const sections = await parseDocument({
      buffer: Buffer.from("pdf"),
      mediaType: "application/pdf",
      ocrMode: "local",
      config,
      model: model(),
      onOcrRequired,
    });
    expect(sections[0]?.text).toContain("embedded readable");
    expect(onOcrRequired).not.toHaveBeenCalled();
  });

  it("supports both local and cloud OCR for image-only pages", async () => {
    pageText = "";
    const local = await parseDocument({
      buffer: Buffer.from("pdf"),
      mediaType: "application/pdf",
      ocrMode: "local",
      config,
      model: model(),
      onOcrRequired: () => undefined,
    });
    const cloud = await parseDocument({
      buffer: Buffer.from("pdf"),
      mediaType: "application/pdf",
      ocrMode: "cloud",
      config,
      model: model(),
      onOcrRequired: () => undefined,
    });
    expect(local[0]?.text).toBe("本地 OCR 内容");
    expect(cloud[0]?.text).toBe("云端 OCR 内容");
    expect(recognize).toHaveBeenCalled();
  });
});
