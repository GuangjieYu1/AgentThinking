import type { Chunk, TraversalChunkRole, TraversalSummaryIndicator } from "@agent-thinking/contracts";
import { hasNumericSignal, normalizeText } from "./utils.js";

export interface TableRoleClassification {
  role: TraversalChunkRole;
  indicator?: TraversalSummaryIndicator | undefined;
  confidence: number;
  method: "rule";
  reasons: string[];
}

const subtotalPattern = /(?:小计|subtotal)/i;
const finalTotalPattern = /(?:合计|总计|总额|总数|总规模|总募集|final\s*total|grand\s*total|total)/i;
const summaryPattern = /(?:合计|总计|小计|汇总|总额|余额合计|合\s*计|total|subtotal|summary)/i;
const listPattern = /^\s*(?:[-*+]\s+|\d+[.)、]\s+|[（(]?\d+[）)]\s+|[一二三四五六七八九十]+[、.)]\s+)/;
const headingPattern = /^(?:第?[一二三四五六七八九十\d]+[章节条部分、.．]\s*)?[^。！？!?]{2,60}$/;
const markdownTablePattern = /^\s*\|.+\|\s*$/m;
const markdownSeparatorPattern = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/m;

function pipeCellCount(text: string): number {
  const line = text.split(/\r?\n/).find((entry) => markdownTablePattern.test(entry));
  if (!line) return 0;
  return line.split("|").map((cell) => cell.trim()).filter(Boolean).length;
}

function looksLikeHeader(text: string, chunk: Chunk): boolean {
  const normalized = normalizeText(text);
  if (chunk.nodeType === "section" || chunk.nodeType === "document") return true;
  if (markdownSeparatorPattern.test(text)) return true;
  if (markdownTablePattern.test(text) && !hasNumericSignal(normalized)) return true;
  if (/[:：]\s*$/.test(normalized) && normalized.length <= 80) return true;
  return headingPattern.test(normalized) && !hasNumericSignal(normalized) && !/[。！？!?]$/.test(normalized);
}

function looksLikeTable(text: string): boolean {
  const normalized = normalizeText(text);
  return markdownTablePattern.test(text) || markdownSeparatorPattern.test(text) || pipeCellCount(text) >= 2 ||
    /(?:\t| {2,}).+(?:\t| {2,})/.test(normalized);
}

function looksLikeDataRow(text: string): boolean {
  const normalized = normalizeText(text);
  if (!hasNumericSignal(normalized)) return false;
  if (summaryPattern.test(normalized)) return false;
  if (markdownTablePattern.test(text)) return true;
  if (pipeCellCount(text) >= 2) return true;
  return /(?:\t| {2,}|，|,).*(?:\d|%|万|亿|元)/.test(normalized) || normalized.length <= 160;
}

function summaryIndicator(text: string): TraversalSummaryIndicator {
  const normalized = normalizeText(text);
  if (subtotalPattern.test(normalized)) return "subtotal";
  if (finalTotalPattern.test(normalized)) return /(?:最终|最终合计|final\s*total|grand\s*total)/i.test(normalized) ? "final_total" : "total";
  return "unknown_summary";
}

export class TableRoleAdapter {
  classify(chunk: Chunk): TableRoleClassification {
    const text = chunk.text;
    const normalized = normalizeText(text);
    const reasons: string[] = [];

    if (!normalized) {
      return { role: "unknown", confidence: 0.2, method: "rule", reasons: ["empty text"] };
    }

    if (summaryPattern.test(normalized) && hasNumericSignal(normalized)) {
      reasons.push("summary keyword with numeric signal");
      return { role: "summary", indicator: summaryIndicator(normalized), confidence: 0.88, method: "rule", reasons };
    }

    if (looksLikeDataRow(text)) {
      reasons.push("numeric tabular row signal");
      return { role: "data_row", confidence: looksLikeTable(text) ? 0.86 : 0.72, method: "rule", reasons };
    }

    if (looksLikeTable(text)) {
      reasons.push("table layout signal");
      return { role: "table", confidence: 0.74, method: "rule", reasons };
    }

    if (looksLikeHeader(text, chunk)) {
      reasons.push(chunk.nodeType === "section" ? "section node" : "heading-shaped text");
      return { role: "header", confidence: chunk.nodeType === "section" ? 0.9 : 0.76, method: "rule", reasons };
    }

    if (listPattern.test(text)) {
      reasons.push("list marker");
      return { role: "list_item", confidence: 0.78, method: "rule", reasons };
    }

    if (chunk.nodeType === "table") {
      reasons.push("table node type");
      return { role: "table", confidence: 0.76, method: "rule", reasons };
    }

    if (chunk.nodeType === "paragraph" || normalized.length > 0) {
      reasons.push("default paragraph");
      return { role: "paragraph", confidence: 0.64, method: "rule", reasons };
    }

    return { role: "unknown", confidence: 0.2, method: "rule", reasons: ["no role signal"] };
  }
}
