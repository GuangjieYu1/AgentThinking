import { describe, expect, it } from "vitest";
import { chunkSections } from "../src/domain/chunker.js";
import { parseMarkdownStructure } from "../src/domain/source-structure.js";

describe("markdown source structure", () => {
  it("retains frontmatter, links, block references, and citation lines", () => {
    const parsed = parseMarkdownStructure([
      "---",
      "title: Evidence Note",
      "author: Ada",
      "---",
      "# Topic",
      "See [paper](paper.pdf), [[Related Note]], and ![[Figure#p1]].",
      "A supported paragraph. ^proof",
      "Reference ((abc-123)).",
    ].join("\n"));
    const chunks = chunkSections(parsed.sections);

    expect(parsed.title).toBe("Evidence Note");
    expect(parsed.frontmatter).toEqual({ title: "Evidence Note", author: "Ada" });
    expect(parsed.links.map((link) => link.type)).toEqual(["markdown", "embed", "wiki", "block", "logseq"]);
    expect(parsed.links[0]?.line).toBe(6);
    expect(chunks[0]?.headingPath).toBe("Topic");
    expect(chunks[0]?.startLine).toBe(6);
    expect(chunks[0]?.endLine).toBe(8);
  });
});
