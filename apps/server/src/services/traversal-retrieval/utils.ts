import type { Chunk } from "@agent-thinking/contracts";

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function previewText(value: string, maxLength = 40): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trimEnd();
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

export function chunkLabel(chunk: Chunk): string {
  return chunk.headingPath ?? (chunk.pageNumber ? `PDF page ${chunk.pageNumber}` : `chunk ${chunk.ordinal + 1}`);
}

export function hasNumericSignal(text: string): boolean {
  return /(?:[-+]?[\d,]+(?:\.\d+)?%?|\d+(?:\.\d+)?\s*(?:万|亿|万元|亿元|千元|元|%))/.test(text);
}

export function tokenize(text: string): string[] {
  const normalized = normalizeText(text).toLowerCase();
  const latin = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjkRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const cjk = cjkRuns.flatMap((run) => {
    const chars = [...run];
    return [
      ...chars,
      ...chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`),
    ];
  });
  return [...latin, ...cjk].filter((token) => token.length > 0);
}

export function termOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

export function sameHeadingPath(left: Chunk, right: Chunk): boolean {
  return normalizeText(left.headingPath) === normalizeText(right.headingPath);
}

export function sameVersion(left: Chunk, right: Chunk): boolean {
  return left.libraryId === right.libraryId && left.versionId === right.versionId;
}

export function byOrdinal(left: Chunk, right: Chunk): number {
  return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}

export function chunkDistance(left: Chunk, right: Chunk): number {
  if (!sameVersion(left, right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left.ordinal - right.ordinal);
}
