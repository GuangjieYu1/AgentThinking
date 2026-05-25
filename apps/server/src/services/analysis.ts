import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AnalysisStatement, Citation, PublishedAnalysis } from "@agent-thinking/contracts";
import type { AppConfig } from "../config.js";
import { AgentDatabase } from "../db.js";
import { safeFileName } from "../domain/files.js";

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function citationText(citation: Citation): string {
  const location = citation.pageNumber
    ? `第 ${citation.pageNumber} 页`
    : citation.startLine
      ? `第 ${citation.startLine}-${citation.endLine ?? citation.startLine} 行`
      : "原文片段";
  const heading = citation.headingPath ? ` / ${citation.headingPath}` : "";
  const anchor = citation.blockId ? ` ^${citation.blockId}` : "";
  const storedName = `${citation.versionId.slice(0, 8)}-${citation.documentName}`;
  return `[${citation.documentName} - ${location}${heading}${anchor}](sources/${encodeURIComponent(storedName)})：${citation.excerpt.replace(/\s+/g, " ").trim()}`;
}

function statementLines(statements: AnalysisStatement[]): string[] {
  return statements.map((statement) => {
    const citations = statement.citations.map((citation) => `\n  - ${citationText(citation)}`).join("");
    return `- ${statement.text} \`${statement.relationType}\`${citations}`;
  });
}

export class AnalysisPublisher {
  constructor(private readonly db: AgentDatabase, private readonly config: AppConfig) {}

  async publish(libraryId: string): Promise<PublishedAnalysis> {
    const library = this.db.getLibrary(libraryId);
    if (!library) throw new Error("知识库不存在");
    const draft = this.db.generateAnalysisDraft(libraryId);
    if (draft.summary.pending > 0) {
      throw new Error(`仍有待审核分析陈述（${draft.summary.pending} 条），请完成审核后再发布`);
    }
    const statements = this.db.getApprovedStatements(libraryId);
    const sources = this.db.listVersionSources(libraryId);
    const versionIds = sources.map((source) => source.version.id);
    const relations = statements.flatMap((statement) => {
      const relation = this.db.getRelation(statement.relationId);
      return relation ? [relation] : [];
    });
    const relationNodes = new Map(
      relations.flatMap((relation) => [relation.sourceNodeId, relation.targetNodeId])
        .map((id) => [id, this.db.getAbstractNode(id)]),
    );
    const generatedAt = new Date().toISOString();
    const regular = statements.filter((statement) => statement.relationType !== "contradicts");
    const conflicts = statements.filter((statement) => statement.relationType === "contradicts");
    const content = [
      "---",
      `library_id: ${quoteYaml(libraryId)}`,
      `library_name: ${quoteYaml(library.name)}`,
      `generated_at: ${quoteYaml(generatedAt)}`,
      'report_format: "agent-thinking-analysis-v1"',
      "included_versions:",
      ...versionIds.map((id) => `  - ${quoteYaml(id)}`),
      "---",
      "",
      `# ${library.name} - 分析报告`,
      "",
      "# 概念与命题",
      "",
      ...([...relationNodes.values()].flatMap((node) => node ? [
        `## ${node.kind === "claim" ? "命题" : "概念"}：${node.title}`,
        "",
        "该节点已出现在审核通过的分析陈述中，引用见下文对应条目。",
        "",
      ] : [])),
      "# 已审核关系",
      "",
      ...(regular.length ? statementLines(regular) : ["暂无已审核关系。"]),
      "",
      "# 已确认冲突",
      "",
      ...(conflicts.length ? statementLines(conflicts) : ["暂无已确认冲突。"]),
      "",
      "# 来源索引",
      "",
      ...sources.map((source) =>
        `- [${source.documentName}](sources/${encodeURIComponent(`${source.version.id.slice(0, 8)}-${source.documentName}`)}) - \`${source.version.contentHash}\``),
      "",
    ].join("\n");
    const path = join(this.config.analysisDir, libraryId, "analysis.md");
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
    return this.db.savePublishedAnalysis({
      libraryId,
      path,
      content,
      includedVersionIds: versionIds,
      publishedAt: generatedAt,
    });
  }

  async exportArchive(libraryId: string): Promise<Buffer> {
    const analysis = this.db.getPublishedAnalysis(libraryId);
    if (!analysis) throw new Error("请先发布分析笔记");
    const sources = this.db.listVersionSources(libraryId)
      .filter((source) => analysis.includedVersionIds.includes(source.version.id));
    const entries: Array<{ name: string; content: Buffer }> = [
      { name: "analysis.md", content: Buffer.from(analysis.content, "utf8") },
    ];
    for (const source of sources) {
      entries.push({
        name: `sources/${source.version.id.slice(0, 8)}-${safeFileName(basename(source.documentName))}`,
        content: await readFile(source.version.storagePath),
      });
    }
    return createZip(entries);
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const directoryParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.content);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(entry.content.length, 20);
    directory.writeUInt32LE(entry.content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    directoryParts.push(directory, name);
    offset += local.length + name.length + entry.content.length;
  }
  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}
