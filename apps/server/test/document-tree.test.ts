import { describe, expect, it } from "vitest";
import { buildDocumentIndex } from "../src/domain/document-tree.js";

describe("document tree indexing", () => {
  it("builds document, section, paragraph, and sentence nodes with links", () => {
    const index = buildDocumentIndex({
      libraryId: "library",
      documentId: "document",
      versionId: "version",
      documentName: "notes.md",
      sections: [{
        headingPath: "Topic / Detail",
        text: "第一段。第二句。\n\nSecond paragraph has evidence.",
        pageNumber: null,
        startLine: 1,
      }],
    });

    expect(index.treeNodes.map((node) => node.nodeType)).toEqual(expect.arrayContaining([
      "document",
      "section",
      "paragraph",
      "sentence",
    ]));
    const paragraph = index.treeNodes.find((node) => node.nodeType === "paragraph");
    expect(paragraph?.parentId).toBeTruthy();
    expect(paragraph?.headingPath).toEqual(["Topic", "Detail"]);
    expect(paragraph?.prevId || paragraph?.nextId).toBeTruthy();

    const childChunk = index.chunks.find((chunk) => chunk.nodeType === "paragraph");
    const parentChunk = index.chunks.find((chunk) => chunk.nodeType === "section");
    expect(childChunk?.parentLocalKey).toBe(parentChunk?.localKey);
    expect(index.parentChildLinks[0]).toMatchObject({
      childLocalKey: childChunk?.localKey,
      parentLocalKey: parentChunk?.localKey,
      documentTreeNodeId: childChunk?.documentTreeNodeId,
    });

    expect(index.summaryNodes.map((node) => node.level)).toEqual(expect.arrayContaining([
      "paragraph",
      "section",
      "document",
    ]));
  });
});
