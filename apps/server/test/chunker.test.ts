import { describe, expect, it } from "vitest";
import { chunkSections, parseMarkdownSections } from "../src/domain/chunker.js";
import { contentHash, mediaTypeFor, validateFileName } from "../src/domain/files.js";

describe("document preparation", () => {
  it("retains markdown heading paths while chunking", () => {
    const sections = parseMarkdownSections("# Topic\nIntro\n## Detail\n" + "内容".repeat(100));
    const chunks = chunkSections(sections, { targetCharacters: 40, overlapCharacters: 5 });
    expect(chunks[0]?.headingPath).toBe("Topic");
    expect(chunks.at(-1)?.headingPath).toBe("Topic / Detail");
    expect(chunks.length).toBeGreaterThan(2);
  });

  it("accepts MVP formats and creates stable content hashes", () => {
    expect(() => validateFileName("report.pdf")).not.toThrow();
    expect(() => validateFileName("notes.doc")).not.toThrow();
    expect(() => validateFileName("notes.docx")).not.toThrow();
    expect(mediaTypeFor("readme.md")).toBe("text/markdown");
    expect(mediaTypeFor("legacy.doc")).toBe("application/msword");
    expect(mediaTypeFor("report.docx")).toContain("wordprocessingml");
    expect(contentHash(Buffer.from("same"))).toBe(contentHash(Buffer.from("same")));
  });
});
