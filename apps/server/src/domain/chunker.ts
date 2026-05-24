import type { Chunk } from "@agent-thinking/contracts";

export interface SourceSection {
  text: string;
  headingPath?: string | null;
  pageNumber?: number | null;
}

export interface PendingChunk extends Omit<Chunk, "id" | "libraryId" | "versionId"> {}

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

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) sections.push({ text: body, headingPath: headings.join(" / ") || null });
    buffer = [];
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const depth = heading[1]?.length ?? 1;
    headings.splice(depth - 1);
    headings[depth - 1] = heading[2] ?? "";
  }
  flush();
  return sections;
}

export function parseTextSections(text: string): SourceSection[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => ({ text: paragraph.trim() }))
    .filter((section) => section.text.length > 0);
}

