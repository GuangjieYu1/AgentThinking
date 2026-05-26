import { createHash } from "node:crypto";
import { extname } from "node:path";

const acceptedExtensions = new Set([".md", ".markdown", ".txt", ".pdf", ".doc", ".docx"]);

export function validateFileName(name: string): void {
  if (!acceptedExtensions.has(extname(name).toLowerCase())) {
    throw new Error("仅支持 Markdown、TXT、PDF 与 Word（DOC/DOCX）文件");
  }
}

export function mediaTypeFor(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".md":
    case ".markdown":
      return "text/markdown";
    default:
      return "text/plain";
  }
}

export function isWordMediaType(mediaType: string): boolean {
  return mediaType === "application/msword" ||
    mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

export function contentHash(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 180);
}
