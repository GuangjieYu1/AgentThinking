import { randomUUID } from "node:crypto";
import type {
  DocumentTreeNode,
  DocumentTreeNodeType,
  ParentChildChunk,
  SummaryTreeLevel,
  SummaryTreeNode,
} from "@agent-thinking/contracts";
import type { PendingChunk, SourceSection } from "./chunker.js";

export interface PendingDocumentIndex {
  treeNodes: DocumentTreeNode[];
  chunks: Array<PendingChunk & {
    localKey: string;
    parentLocalKey?: string | undefined;
    documentTreeNodeId: string;
    nodeType: DocumentTreeNodeType;
    childOrdinal?: number | null | undefined;
    parentOrdinal?: number | null | undefined;
  }>;
  parentChildLinks: Array<{
    childLocalKey: string;
    parentLocalKey: string;
    documentTreeNodeId: string;
  }>;
  summaryNodes: SummaryTreeNode[];
}

interface BuildOptions {
  libraryId: string;
  documentId: string;
  versionId: string;
  documentName: string;
  sections: SourceSection[];
}

type MutableTreeNode = Omit<DocumentTreeNode, "childrenIds" | "sourceChunkIds"> & {
  childrenIds: string[];
  sourceChunkIds: string[];
};

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function summarize(text: string, fallback: string, max = 280): string {
  const normalized = normalizeText(text);
  if (!normalized) return fallback;
  const first = normalized.split(/(?<=[。！？.!?])\s+|\n+/, 1)[0]?.trim() || normalized;
  return first.length <= max ? first : `${first.slice(0, max - 3)}...`;
}

function splitParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return paragraphs.length > 0 ? paragraphs : [normalized];
}

function splitSentences(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const matches = normalized.match(/[^。！？.!?；;]+[。！？.!?；;]?/g) ?? [normalized];
  return matches.map((part) => part.trim()).filter(Boolean);
}

function headingParts(path: string | null | undefined, fallback: string): string[] {
  const parts = (path ?? "").split("/").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [fallback];
}

function lineOffset(section: SourceSection, paragraphIndex: number, paragraph: string): { startLine: number | null; endLine: number | null } {
  if (section.startLine == null) return { startLine: null, endLine: null };
  const startLine = section.startLine + paragraphIndex;
  return { startLine, endLine: startLine + paragraph.split("\n").length - 1 };
}

export function buildDocumentIndex(options: BuildOptions): PendingDocumentIndex {
  const nodes: MutableTreeNode[] = [];
  const chunks: PendingDocumentIndex["chunks"] = [];
  const parentChildLinks: PendingDocumentIndex["parentChildLinks"] = [];
  const summaryNodes: SummaryTreeNode[] = [];
  const allText = options.sections.map((section) => section.text).join("\n\n");
  let nodeOrdinal = 0;
  let chunkOrdinal = 0;

  const createNode = (
    nodeType: DocumentTreeNodeType,
    parentId: string | null,
    level: number,
    headingPathValue: string[],
    text: string,
  ): MutableTreeNode => {
    const node: MutableTreeNode = {
      id: randomUUID(),
      libraryId: options.libraryId,
      documentId: options.documentId,
      versionId: options.versionId,
      nodeType,
      parentId,
      childrenIds: [],
      ordinal: nodeOrdinal,
      level,
      headingPath: headingPathValue,
      text: normalizeText(text),
      summary: summarize(text, nodeType),
      prevId: null,
      nextId: null,
      sourceChunkIds: [],
    };
    nodeOrdinal += 1;
    nodes.push(node);
    if (parentId) nodes.find((candidate) => candidate.id === parentId)?.childrenIds.push(node.id);
    return node;
  };

  const documentNode = createNode("document", null, 0, [options.documentName], allText);
  const sectionByPath = new Map<string, MutableTreeNode>();
  const sequenceNodes: MutableTreeNode[] = [];

  for (const [sectionIndex, section] of options.sections.entries()) {
    const parts = headingParts(section.headingPath, section.pageNumber ? `Page ${section.pageNumber}` : `Section ${sectionIndex + 1}`);
    let parent = documentNode;
    let sectionNode: MutableTreeNode | undefined;
    for (let depth = 0; depth < parts.length; depth += 1) {
      const key = parts.slice(0, depth + 1).join(" / ");
      let existing = sectionByPath.get(key);
      if (!existing) {
        existing = createNode("section", parent.id, depth + 1, parts.slice(0, depth + 1), depth === parts.length - 1 ? section.text : "");
        sectionByPath.set(key, existing);
      } else if (depth === parts.length - 1 && !existing.text) {
        existing.text = normalizeText(section.text);
        existing.summary = summarize(section.text, existing.headingPath.at(-1) ?? "section");
      }
      parent = existing;
      sectionNode = existing;
    }
    sectionNode ??= createNode("unknown", documentNode.id, 1, parts, section.text);
    sequenceNodes.push(sectionNode);

    const parentLocalKey = `parent:${sectionNode.id}`;
    chunks.push({
      localKey: parentLocalKey,
      ordinal: chunkOrdinal,
      headingPath: section.headingPath ?? sectionNode.headingPath.join(" / "),
      pageNumber: section.pageNumber ?? null,
      startLine: section.startLine ?? null,
      endLine: section.endLine ?? null,
      blockId: section.blockId ?? null,
      startChar: 0,
      endChar: normalizeText(section.text).length,
      text: normalizeText(section.text),
      documentTreeNodeId: sectionNode.id,
      nodeType: "section",
      childOrdinal: null,
      parentOrdinal: chunkOrdinal,
    });
    sectionNode.sourceChunkIds.push(parentLocalKey);
    const parentOrdinal = chunkOrdinal;
    chunkOrdinal += 1;

    const paragraphs = splitParagraphs(section.text);
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      const paragraphNode = createNode("paragraph", sectionNode.id, sectionNode.level + 1, sectionNode.headingPath, paragraph);
      sequenceNodes.push(paragraphNode);
      const lines = lineOffset(section, paragraphIndex, paragraph);
      const childLocalKey = `child:${paragraphNode.id}`;
      chunks.push({
        localKey: childLocalKey,
        parentLocalKey,
        ordinal: chunkOrdinal,
        headingPath: section.headingPath ?? sectionNode.headingPath.join(" / "),
        pageNumber: section.pageNumber ?? null,
        startLine: lines.startLine,
        endLine: lines.endLine,
        blockId: section.blockId ?? null,
        startChar: 0,
        endChar: normalizeText(paragraph).length,
        text: normalizeText(paragraph),
        documentTreeNodeId: paragraphNode.id,
        nodeType: "paragraph",
        childOrdinal: paragraphIndex,
        parentOrdinal,
      });
      paragraphNode.sourceChunkIds.push(childLocalKey);
      parentChildLinks.push({ childLocalKey, parentLocalKey, documentTreeNodeId: paragraphNode.id });
      chunkOrdinal += 1;

      for (const sentence of splitSentences(paragraph)) {
        const sentenceNode = createNode("sentence", paragraphNode.id, paragraphNode.level + 1, paragraphNode.headingPath, sentence);
        sequenceNodes.push(sentenceNode);
      }
    }
  }

  for (let index = 0; index < sequenceNodes.length; index += 1) {
    sequenceNodes[index]!.prevId = sequenceNodes[index - 1]?.id ?? null;
    sequenceNodes[index]!.nextId = sequenceNodes[index + 1]?.id ?? null;
  }

  const summariesByNode = new Map<string, SummaryTreeNode>();
  const createSummary = (node: MutableTreeNode, level: SummaryTreeLevel, parentSummaryId: string | null): SummaryTreeNode => {
    const summary: SummaryTreeNode = {
      id: randomUUID(),
      versionId: options.versionId,
      level,
      sourceNodeIds: [node.id],
      summary: node.summary || summarize(node.text, level),
      embeddingId: null,
      parentSummaryId,
      childSummaryIds: [],
    };
    summariesByNode.set(node.id, summary);
    summaryNodes.push(summary);
    return summary;
  };
  const documentSummary = createSummary(documentNode, "document", null);
  for (const sectionNode of nodes.filter((node) => node.nodeType === "section")) {
    const sectionSummary = createSummary(sectionNode, "section", documentSummary.id);
    documentSummary.childSummaryIds.push(sectionSummary.id);
  }
  for (const paragraphNode of nodes.filter((node) => node.nodeType === "paragraph")) {
    const parentSummary = paragraphNode.parentId ? summariesByNode.get(paragraphNode.parentId) : undefined;
    const paragraphSummary = createSummary(paragraphNode, "paragraph", parentSummary?.id ?? documentSummary.id);
    (parentSummary ?? documentSummary).childSummaryIds.push(paragraphSummary.id);
  }

  return { treeNodes: nodes, chunks, parentChildLinks, summaryNodes };
}
