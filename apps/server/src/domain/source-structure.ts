import { randomUUID } from "node:crypto";
import type { SourceLink, SourceLinkType } from "@agent-thinking/contracts";
import { parseMarkdownSections, type SourceSection } from "./chunker.js";

export interface ParsedSourceStructure {
  title: string | null;
  frontmatterRaw: string | null;
  frontmatter: Record<string, string>;
  links: Array<Omit<SourceLink, "versionId" | "resolvedDocumentId">>;
  sections: SourceSection[];
}

function parseFrontmatter(text: string): {
  body: string;
  raw: string | null;
  values: Record<string, string>;
  removedLines: number;
} {
  const normalized = text.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return { body: normalized, raw: null, values: {}, removedLines: 0 };
  const raw = match[1] ?? "";
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (entry) values[entry[1]!] = entry[2]!.replace(/^["']|["']$/g, "");
  }
  const prefix = match[0];
  return {
    body: normalized.slice(prefix.length),
    raw,
    values,
    removedLines: prefix.split("\n").length - 1,
  };
}

function pushLinks(
  links: ParsedSourceStructure["links"],
  line: string,
  lineNumber: number,
  pattern: RegExp,
  type: SourceLinkType,
  targetIndex: number,
  labelIndex?: number,
): void {
  for (const match of line.matchAll(pattern)) {
    links.push({
      id: randomUUID(),
      type,
      raw: match[0],
      target: match[targetIndex] ?? "",
      label: labelIndex === undefined ? null : match[labelIndex] ?? null,
      line: lineNumber,
    });
  }
}

export function parseMarkdownStructure(text: string): ParsedSourceStructure {
  const parsed = parseFrontmatter(text);
  const links: ParsedSourceStructure["links"] = [];
  const lines = parsed.body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + parsed.removedLines + 1;
    pushLinks(links, line, lineNumber, /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, "markdown", 2, 1);
    pushLinks(links, line, lineNumber, /!\[\[([^\]|#]+(?:#[^\]|]+)?)(?:\|([^\]]+))?\]\]/g, "embed", 1, 2);
    pushLinks(links, line, lineNumber, /(?<!!)\[\[([^\]|#]+(?:#[^\]|]+)?)(?:\|([^\]]+))?\]\]/g, "wiki", 1, 2);
    pushLinks(links, line, lineNumber, /\(\(([A-Za-z0-9_-]+)\)\)/g, "logseq", 1);
    pushLinks(links, line, lineNumber, /\^([A-Za-z0-9_-]+)\s*$/g, "block", 1);
  }
  const sections = parseMarkdownSections(parsed.body).map((section) => ({
    ...section,
    startLine: section.startLine == null ? null : section.startLine + parsed.removedLines,
    endLine: section.endLine == null ? null : section.endLine + parsed.removedLines,
  }));
  const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(parsed.body)?.[1]?.trim() ?? null;
  return {
    title: parsed.values.title ?? heading,
    frontmatterRaw: parsed.raw,
    frontmatter: parsed.values,
    links,
    sections,
  };
}

