import { mkdir } from "node:fs/promises";
import type { OcrMode } from "@agent-thinking/contracts";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import type { SourceSection } from "../domain/chunker.js";
import type { AppConfig } from "../config.js";
import type { ModelProvider } from "./models.js";

export interface ParseOptions {
  buffer: Buffer;
  mediaType: string;
  ocrMode: OcrMode;
  config: AppConfig;
  model: ModelProvider;
  onOcrRequired: () => void;
}

export async function parseDocument(options: ParseOptions): Promise<SourceSection[]> {
  if (options.mediaType === "text/markdown" || options.mediaType === "text/plain") {
    return [{ text: options.buffer.toString("utf8") }];
  }
  return parsePdf(options);
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
        if (!options.model.ocrImage) throw new Error("配置的模型不支持云端 OCR");
        text = await options.model.ocrImage(`data:image/png;base64,${png.toString("base64")}`);
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
