import type { Chunk } from "@agent-thinking/contracts";

export interface SourceSection {
  text: string;
  headingPath?: string | null;
  pageNumber?: number | null;
  startLine?: number | null;
  endLine?: number | null;
  blockId?: string | null;
}

export interface PendingChunk extends Omit<Chunk, "id" | "libraryId" | "versionId" | "startLine" | "endLine" | "blockId" | "aspects"> {
  startLine?: number | null;
  endLine?: number | null;
  blockId?: string | null;
}

export interface ChunkOptions {
  targetCharacters?: number;
  overlapCharacters?: number;
}

export function chunkSections(
  sections: SourceSection[],
  options: ChunkOptions = {},
): PendingChunk[] {
  const target = options.targetCharacters ?? 3200;
  const overlap = options.overlapCharacters ?? 400;
  const chunks: PendingChunk[] = [];
  let ordinal = 0;

  for (const section of sections) {
    const normalized = section.text.replace(/\r\n?/g, "\n").trim();
    if (!normalized) continue;

    let start = 0;
    while (start < normalized.length) {
      let end = Math.min(start + target, normalized.length);
      if (end < normalized.length) {
        const paragraphBreak = normalized.lastIndexOf("\n\n", end);
        const sentenceBreak = Math.max(
          normalized.lastIndexOf("。", end),
          normalized.lastIndexOf(". ", end),
          normalized.lastIndexOf("\n", end),
        );
        const naturalBreak = Math.max(paragraphBreak, sentenceBreak);
        if (naturalBreak > start + Math.floor(target * 0.55)) {
          end = naturalBreak + 1;
        }
      }

      const text = normalized.slice(start, end).trim();
      if (text) {
        chunks.push({
          ordinal,
          headingPath: section.headingPath ?? null,
          pageNumber: section.pageNumber ?? null,
          startLine: section.startLine == null
            ? null
            : section.startLine + normalized.slice(0, start).split("\n").length - 1,
          endLine: section.startLine == null
            ? null
            : section.startLine + normalized.slice(0, end).split("\n").length - 1,
          blockId: section.blockId ?? null,
          startChar: start,
          endChar: end,
          text,
        });
        ordinal += 1;
      }

      if (end >= normalized.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  }

  return chunks;
}

export function parseMarkdownSections(text: string): SourceSection[] {
  const sections: SourceSection[] = [];
  const headings: string[] = [];
  let buffer: string[] = [];
  let bufferStartLine = 1;

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) {
      const leadingBlankLines = buffer.findIndex((line) => line.trim() !== "");
      const startLine = bufferStartLine + Math.max(leadingBlankLines, 0);
      sections.push({
        text: body,
        headingPath: headings.join(" / ") || null,
        startLine,
        endLine: startLine + body.split("\n").length - 1,
        blockId: /\^([A-Za-z0-9_-]+)\s*$/.exec(body)?.[1] ?? null,
      });
    }
    buffer = [];
  };

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) {
      if (buffer.length === 0) bufferStartLine = index + 1;
      buffer.push(line);
      continue;
    }
    flush();
    const depth = heading[1]?.length ?? 1;
    headings.splice(depth - 1);
    headings[depth - 1] = heading[2] ?? "";
    bufferStartLine = index + 2;
  }
  flush();
  return sections;
}

export function parseTextSections(text: string): SourceSection[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const sections: SourceSection[] = [];
  const paragraphPattern = /(?:^|\n{2,})([\s\S]*?)(?=\n{2,}|$)/g;
  let match: RegExpExecArray | null;
  while ((match = paragraphPattern.exec(normalized)) !== null) {
    const raw = match[1] ?? "";
    const body = raw.trim();
    if (!body) continue;
    const textStart = match.index + (match[0].length - raw.length) + raw.indexOf(body);
    const startLine = normalized.slice(0, textStart).split("\n").length;
    sections.push({
      text: body,
      startLine,
      endLine: startLine + body.split("\n").length - 1,
    });
  }
  return sections;
}
