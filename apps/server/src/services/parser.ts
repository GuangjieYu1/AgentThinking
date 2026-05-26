import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import type { OcrMode } from "@agent-thinking/contracts";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import type { SourceSection } from "../domain/chunker.js";
import { isWordMediaType } from "../domain/files.js";
import type { AppConfig } from "../config.js";
import type { ModelProvider } from "./models.js";
import { recognizeAliyunImage } from "./aliyun-ocr.js";

interface ExtractedWordDocument {
  getBody(): string;
}

type WordExtractorInstance = {
  extract(source: Buffer): Promise<ExtractedWordDocument>;
};

type MimeDocument = {
  html?: string | false;
  text?: string;
};

const require = createRequire(import.meta.url);
const WordExtractor = require("word-extractor") as new () => WordExtractorInstance;
const { simpleParser } = require("mailparser") as {
  simpleParser(source: Buffer): Promise<MimeDocument>;
};
const { convert: htmlToText } = require("html-to-text") as {
  convert(html: string, options?: { wordwrap?: false }): string;
};

export interface ParseOptions {
  buffer: Buffer;
  mediaType: string;
  ocrMode: OcrMode;
  config: AppConfig;
  model: ModelProvider;
  cloudOcr?: (image: Buffer) => Promise<string>;
  onOcrRequired: () => void;
}

export async function parseDocument(options: ParseOptions): Promise<SourceSection[]> {
  if (options.mediaType === "text/markdown" || options.mediaType === "text/plain") {
    return [{ text: options.buffer.toString("utf8") }];
  }
  if (isWordMediaType(options.mediaType)) return parseWord(options.buffer);
  return parsePdf(options);
}

async function parseWord(buffer: Buffer): Promise<SourceSection[]> {
  if (looksLikeMimeHtml(buffer)) {
    const parsed = await simpleParser(buffer);
    return extractedTextSection(parsed.text ??
      (typeof parsed.html === "string" ? htmlToText(parsed.html, { wordwrap: false }) : ""));
  }
  if (looksLikeHtml(buffer)) {
    return extractedTextSection(htmlToText(buffer.toString("utf8"), { wordwrap: false }));
  }
  const extracted = await new WordExtractor().extract(buffer);
  return extractedTextSection(extracted.getBody());
}

function extractedTextSection(value: string): SourceSection[] {
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("Word 文档中没有可处理的文本内容");
  return [{ text }];
}

function looksLikeMimeHtml(buffer: Buffer): boolean {
  const header = buffer.subarray(0, 1024).toString("latin1").toLowerCase();
  return header.includes("mime-version:") &&
    header.includes("content-type: multipart/") &&
    header.includes("boundary=");
}

function looksLikeHtml(buffer: Buffer): boolean {
  const opening = buffer.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  return opening.startsWith("<!doctype html") || opening.startsWith("<html");
}

async function parsePdf(options: ParseOptions): Promise<SourceSection[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(options.buffer) }).promise;
  const sections: SourceSection[] = [];
  let localWorker: Awaited<ReturnType<typeof createWorker>> | undefined;

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const extracted = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      if (extracted.replace(/\s/g, "").length >= 20) {
        sections.push({ text: extracted, pageNumber });
        continue;
      }

      options.onOcrRequired();
      const png = await renderPage(page);
      let text: string;
      if (options.ocrMode === "cloud") {
        if (options.config.ocrProvider !== "aliyun") throw new Error("云端 OCR 需要配置 OCR_PROVIDER=aliyun");
        text = options.cloudOcr
          ? await options.cloudOcr(png)
          : await recognizeAliyunImage(png, options.config);
      } else {
        await mkdir(options.config.ocrCacheDir, { recursive: true });
        localWorker ??= await createWorker(["eng", "chi_sim"], undefined, {
          cachePath: options.config.ocrCacheDir,
        });
        const result = await localWorker.recognize(png);
        text = result.data.text;
      }
      if (text.trim()) sections.push({ text: text.trim(), pageNumber });
    }
  } finally {
    if (localWorker) await localWorker.terminate();
    await document.destroy();
  }
  return sections;
}

async function renderPage(page: any): Promise<Buffer> {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toBuffer("image/png");
}
