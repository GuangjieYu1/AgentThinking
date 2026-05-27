import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import type {
  AbstractNode,
  AbstractNodeKind,
  AspectKind,
  AnalysisDraft,
  AnalysisStatement,
  Citation,
  Chunk,
  Document,
  DocumentVersion,
  ExtractionOutput,
  GraphEdge,
  GraphNode,
  GraphResponse,
  IngestJob,
  JobStage,
  Library,
  LibrarySettings,
  OcrMode,
  Relation,
  RelationStatus,
  RelationType,
  SearchResult,
  StatementStatus,
  StatementPrecheckOutput,
  SourceLink,
  SourceMetadata,
  SourceStructure,
  PublishedAnalysis,
} from "@agent-thinking/contracts";
import type { PendingChunk } from "./domain/chunker.js";

type Row = Record<string, string | number | null | Uint8Array>;
const sqliteModuleName = ["node", "sqlite"].join(":");
const { DatabaseSync } = await import(sqliteModuleName) as typeof import("node:sqlite");

function now(): string {
  return new Date().toISOString();
}

function rows(statement: ReturnType<NativeDatabaseSync["prepare"]>, ...params: any[]): Row[] {
  return statement.all(...params) as unknown as Row[];
}

function row(statement: ReturnType<NativeDatabaseSync["prepare"]>, ...params: any[]): Row | undefined {
  return statement.get(...params) as unknown as Row | undefined;
}

function libraryFrom(r: Row): Library {
  return {
    id: String(r.id),
    name: String(r.name),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function chunkFrom(r: Row): Chunk {
  return {
    id: String(r.id),
    libraryId: String(r.library_id),
    versionId: String(r.version_id),
    ordinal: Number(r.ordinal),
    headingPath: r.heading_path === null ? null : String(r.heading_path),
    pageNumber: r.page_number === null ? null : Number(r.page_number),
    startLine: r.start_line === null ? null : Number(r.start_line),
    endLine: r.end_line === null ? null : Number(r.end_line),
    blockId: r.block_id === null ? null : String(r.block_id),
    startChar: Number(r.start_char),
    endChar: Number(r.end_char),
    text: String(r.text),
    aspects: parseAspects(r.aspects_json),
  };
}

function nodeFrom(r: Row): AbstractNode {
  return {
    id: String(r.id),
    libraryId: String(r.library_id),
    kind: String(r.kind) as AbstractNodeKind,
    title: String(r.title),
    summary: String(r.summary),
    level: Number(r.level ?? 1) === 2 ? 2 : 1,
    aspects: parseAspects(r.aspects_json),
    memberCount: Number(r.member_count ?? 0),
    source: String(r.source) as "ai" | "user",
    citations: [],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function parseAspects(value: Row[string] | undefined): AspectKind[] {
  if (typeof value !== "string") return [];
  try {
    return JSON.parse(value) as AspectKind[];
  } catch {
    return [];
  }
}

export class AgentDatabase {
  readonly sql: NativeDatabaseSync;

  constructor(dataDir: string, fileName = "agent-thinking.sqlite") {
    mkdirSync(dataDir, { recursive: true });
    this.sql = new DatabaseSync(join(dataDir, fileName), { allowExtension: true });
    this.sql.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.sql.close();
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_settings (
        library_id TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
        ocr_mode TEXT NOT NULL CHECK (ocr_mode IN ('local', 'cloud'))
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(library_id, name)
      );
      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
        created_at TEXT NOT NULL,
        UNIQUE(document_id, content_hash)
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        heading_path TEXT,
        page_number INTEGER,
        start_char INTEGER NOT NULL,
        end_char INTEGER NOT NULL,
        text TEXT NOT NULL,
        UNIQUE(version_id, ordinal)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED,
        text,
        heading_path
      );
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS abstract_nodes (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('concept', 'claim')),
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('ai', 'user')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS abstract_node_evidence (
        node_id TEXT NOT NULL REFERENCES abstract_nodes(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        PRIMARY KEY(node_id, chunk_id)
      );
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        source_node_id TEXT NOT NULL REFERENCES abstract_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES abstract_nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('supports','contradicts','explains','depends_on','example_of','related_to')),
        status TEXT NOT NULL CHECK (status IN ('suggested','accepted','rejected','manual')),
        reason TEXT NOT NULL,
        confidence REAL,
        created_by TEXT NOT NULL CHECK (created_by IN ('ai', 'user')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relation_evidence (
        relation_id TEXT NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        PRIMARY KEY(relation_id, chunk_id)
      );
      CREATE TABLE IF NOT EXISTS ingest_jobs (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        progress REAL NOT NULL,
        error TEXT,
        attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(library_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_library ON chunks(library_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_library ON abstract_nodes(library_id);
      CREATE INDEX IF NOT EXISTS idx_relations_library_status ON relations(library_id, status);
      CREATE INDEX IF NOT EXISTS idx_jobs_library ON ingest_jobs(library_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS source_metadata (
        version_id TEXT PRIMARY KEY REFERENCES document_versions(id) ON DELETE CASCADE,
        title TEXT,
        frontmatter_raw TEXT,
        frontmatter_json TEXT NOT NULL DEFAULT '{}',
        parsed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_links (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('markdown','wiki','embed','block','logseq')),
        raw TEXT NOT NULL,
        target TEXT NOT NULL,
        label TEXT,
        line INTEGER NOT NULL,
        resolved_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS published_analyses (
        library_id TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        included_version_ids_json TEXT NOT NULL,
        published_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_statements (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        relation_id TEXT NOT NULL UNIQUE REFERENCES relations(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
        invalidated_reason TEXT,
        invalidated_at TEXT,
        precheck_status TEXT NOT NULL DEFAULT 'not_checked',
        precheck_reason TEXT,
        precheck_checked_at TEXT,
        precheck_content_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_statement_evidence (
        statement_id TEXT NOT NULL REFERENCES analysis_statements(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        PRIMARY KEY(statement_id, chunk_id)
      );
      CREATE TABLE IF NOT EXISTS abstraction_memberships (
        parent_node_id TEXT NOT NULL REFERENCES abstract_nodes(id) ON DELETE CASCADE,
        child_node_id TEXT NOT NULL REFERENCES abstract_nodes(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('suggested','manual')),
        reason TEXT NOT NULL,
        created_by TEXT NOT NULL CHECK (created_by IN ('ai','user')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(parent_node_id, child_node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_links_version ON source_links(version_id);
      CREATE INDEX IF NOT EXISTS idx_statements_library_status ON analysis_statements(library_id, status);
      CREATE INDEX IF NOT EXISTS idx_abstraction_child ON abstraction_memberships(child_node_id);
    `);
    this.addColumn("chunks", "start_line", "INTEGER");
    this.addColumn("chunks", "end_line", "INTEGER");
    this.addColumn("chunks", "block_id", "TEXT");
    this.addColumn("chunks", "aspects_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("abstract_nodes", "level", "INTEGER NOT NULL DEFAULT 1");
    this.addColumn("abstract_nodes", "aspects_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("analysis_statements", "invalidated_reason", "TEXT");
    this.addColumn("analysis_statements", "invalidated_at", "TEXT");
    this.addColumn("analysis_statements", "precheck_status", "TEXT NOT NULL DEFAULT 'not_checked'");
    this.addColumn("analysis_statements", "precheck_reason", "TEXT");
    this.addColumn("analysis_statements", "precheck_checked_at", "TEXT");
    this.addColumn("analysis_statements", "precheck_content_updated_at", "TEXT");
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(now());
  }

  private addColumn(table: string, column: string, definition: string): void {
    const columns = rows(this.sql.prepare(`PRAGMA table_info(${table})`));
    if (!columns.some((entry) => String(entry.name) === column)) {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  listLibraries(): Library[] {
    return rows(this.sql.prepare("SELECT * FROM libraries ORDER BY updated_at DESC")).map(libraryFrom);
  }

  getLibrary(id: string): Library | undefined {
    const result = row(this.sql.prepare("SELECT * FROM libraries WHERE id = ?"), id);
    return result ? libraryFrom(result) : undefined;
  }

  createLibrary(name: string): Library {
    const id = randomUUID();
    const timestamp = now();
    this.sql.prepare(
      "INSERT INTO libraries (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(id, name, timestamp, timestamp);
    this.sql.prepare(
      "INSERT INTO library_settings (library_id, ocr_mode) VALUES (?, 'local')",
    ).run(id);
    return { id, name, createdAt: timestamp, updatedAt: timestamp };
  }

  deleteLibrary(id: string): boolean {
    return Number(this.sql.prepare("DELETE FROM libraries WHERE id = ?").run(id).changes) > 0;
  }

  getSettings(libraryId: string): LibrarySettings {
    const result = row(
      this.sql.prepare("SELECT library_id, ocr_mode FROM library_settings WHERE library_id = ?"),
      libraryId,
    );
    if (!result) throw new Error("知识库不存在");
    return { libraryId: String(result.library_id), ocrMode: String(result.ocr_mode) as OcrMode };
  }

  updateSettings(libraryId: string, ocrMode: OcrMode): LibrarySettings {
    const result = this.sql.prepare(
      "UPDATE library_settings SET ocr_mode = ? WHERE library_id = ?",
    ).run(ocrMode, libraryId);
    if (Number(result.changes) === 0) throw new Error("知识库不存在");
    return { libraryId, ocrMode };
  }

  createDocumentVersion(
    libraryId: string,
    name: string,
    mediaType: string,
    hash: string,
    storagePath: string,
  ): { version: DocumentVersion; duplicate: boolean } {
    let documentRow = row(
      this.sql.prepare("SELECT * FROM documents WHERE library_id = ? AND name = ?"),
      libraryId,
      name,
    );
    if (!documentRow) {
      const id = randomUUID();
      const timestamp = now();
      this.sql.prepare(
        "INSERT INTO documents (id, library_id, name, media_type, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, libraryId, name, mediaType, timestamp);
      documentRow = { id, library_id: libraryId, name, media_type: mediaType, created_at: timestamp };
    }
    const documentId = String(documentRow.id);
    const existing = row(
      this.sql.prepare(
        "SELECT * FROM document_versions WHERE document_id = ? AND content_hash = ?",
      ),
      documentId,
      hash,
    );
    if (existing) return { version: this.versionFrom(existing), duplicate: true };

    const id = randomUUID();
    const timestamp = now();
    this.sql.prepare(
      "INSERT INTO document_versions (id, document_id, content_hash, storage_path, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
    ).run(id, documentId, hash, storagePath, timestamp);
    return {
      version: {
        id,
        documentId,
        contentHash: hash,
        storagePath,
        status: "queued",
        createdAt: timestamp,
      },
      duplicate: false,
    };
  }

  private versionFrom(r: Row): DocumentVersion {
    return {
      id: String(r.id),
      documentId: String(r.document_id),
      contentHash: String(r.content_hash),
      storagePath: String(r.storage_path),
      status: String(r.status) as DocumentVersion["status"],
      createdAt: String(r.created_at),
    };
  }

  getVersion(id: string): DocumentVersion | undefined {
    const result = row(this.sql.prepare("SELECT * FROM document_versions WHERE id = ?"), id);
    return result ? this.versionFrom(result) : undefined;
  }

  getVersionSource(id: string): {
    version: DocumentVersion;
    documentId: string;
    documentName: string;
    libraryId: string;
    mediaType: string;
  } | undefined {
    const result = row(
      this.sql.prepare(`
        SELECT v.*, d.id AS source_document_id, d.name AS document_name, d.library_id, d.media_type
        FROM document_versions v JOIN documents d ON d.id = v.document_id
        WHERE v.id = ?
      `),
      id,
    );
    return result ? {
      version: this.versionFrom(result),
      documentId: String(result.source_document_id),
      documentName: String(result.document_name),
      libraryId: String(result.library_id),
      mediaType: String(result.media_type),
    } : undefined;
  }

  listDocuments(libraryId: string): Document[] {
    return rows(
      this.sql.prepare(`
        SELECT d.*, v.id AS v_id, v.document_id AS v_document_id, v.content_hash AS v_hash,
          v.storage_path AS v_path, v.status AS v_status, v.created_at AS v_created
        FROM documents d
        LEFT JOIN document_versions v ON v.id = (
          SELECT id FROM document_versions WHERE document_id = d.id ORDER BY created_at DESC LIMIT 1
        )
        WHERE d.library_id = ?
        ORDER BY d.created_at DESC
      `),
      libraryId,
    ).map((result) => {
      const document: Document = {
        id: String(result.id),
        libraryId: String(result.library_id),
        name: String(result.name),
        mediaType: String(result.media_type),
        createdAt: String(result.created_at),
      };
      if (result.v_id) {
        document.latestVersion = {
          id: String(result.v_id),
          documentId: String(result.v_document_id),
          contentHash: String(result.v_hash),
          storagePath: String(result.v_path),
          status: String(result.v_status) as DocumentVersion["status"],
          createdAt: String(result.v_created),
        };
      }
      return document;
    });
  }

  updateVersionStatus(id: string, status: DocumentVersion["status"]): void {
    this.sql.prepare("UPDATE document_versions SET status = ? WHERE id = ?").run(status, id);
  }

  saveSourceStructure(
    versionId: string,
    values: { title: string | null; frontmatterRaw: string | null; frontmatter: Record<string, string>; links: Array<Omit<SourceLink, "versionId" | "resolvedDocumentId">> },
  ): void {
    const source = this.getVersionSource(versionId);
    if (!source) throw new Error("导入版本不存在");
    this.sql.prepare(`
      INSERT INTO source_metadata (version_id, title, frontmatter_raw, frontmatter_json, parsed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(version_id) DO UPDATE SET
        title = excluded.title, frontmatter_raw = excluded.frontmatter_raw,
        frontmatter_json = excluded.frontmatter_json, parsed_at = excluded.parsed_at
    `).run(versionId, values.title, values.frontmatterRaw, JSON.stringify(values.frontmatter), now());
    this.sql.prepare("DELETE FROM source_links WHERE version_id = ?").run(versionId);
    const insert = this.sql.prepare(`
      INSERT INTO source_links (id, version_id, type, raw, target, label, line, resolved_document_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const resolveTarget = this.sql.prepare(
      "SELECT id FROM documents WHERE library_id = ? AND (name = ? OR name = ? OR name = ?) LIMIT 1",
    );
    for (const link of values.links) {
      const plainTarget = link.target.split("#")[0] ?? link.target;
      const resolved = row(resolveTarget, source.libraryId, plainTarget, `${plainTarget}.md`, `${plainTarget}.markdown`);
      insert.run(link.id, versionId, link.type, link.raw, link.target, link.label, link.line, resolved?.id ?? null);
    }
  }

  getSourceStructure(versionId: string): SourceStructure {
    const source = this.getVersionSource(versionId);
    if (!source) throw new Error("导入版本不存在");
    const metadataRow = row(this.sql.prepare("SELECT * FROM source_metadata WHERE version_id = ?"), versionId);
    const metadata: SourceMetadata | null = metadataRow ? {
      versionId,
      documentId: source.documentId,
      documentName: source.documentName,
      mediaType: source.mediaType,
      title: metadataRow.title === null ? null : String(metadataRow.title),
      frontmatterRaw: metadataRow.frontmatter_raw === null ? null : String(metadataRow.frontmatter_raw),
      frontmatter: JSON.parse(String(metadataRow.frontmatter_json)) as Record<string, string>,
      parsedAt: String(metadataRow.parsed_at),
    } : null;
    const links: SourceLink[] = rows(
      this.sql.prepare("SELECT * FROM source_links WHERE version_id = ? ORDER BY line, rowid"),
      versionId,
    ).map((entry) => ({
      id: String(entry.id),
      versionId,
      type: String(entry.type) as SourceLink["type"],
      raw: String(entry.raw),
      target: String(entry.target),
      label: entry.label === null ? null : String(entry.label),
      line: Number(entry.line),
      resolvedDocumentId: entry.resolved_document_id === null ? null : String(entry.resolved_document_id),
    }));
    const chunks = rows(
      this.sql.prepare("SELECT * FROM chunks WHERE version_id = ? ORDER BY ordinal"),
      versionId,
    ).map(chunkFrom);
    return { metadata, links, chunks };
  }

  createJob(libraryId: string, versionId: string): IngestJob {
    const job: IngestJob = {
      id: randomUUID(),
      libraryId,
      versionId,
      stage: "queued",
      progress: 0,
      error: null,
      attempts: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.sql.prepare(`
      INSERT INTO ingest_jobs
        (id, library_id, version_id, stage, progress, error, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.libraryId, job.versionId, job.stage, job.progress, job.error,
      job.attempts, job.createdAt, job.updatedAt,
    );
    return job;
  }

  getJob(id: string): IngestJob | undefined {
    const result = row(this.sql.prepare("SELECT * FROM ingest_jobs WHERE id = ?"), id);
    return result ? this.jobFrom(result) : undefined;
  }

  listJobs(libraryId: string): IngestJob[] {
    return rows(
      this.sql.prepare("SELECT * FROM ingest_jobs WHERE library_id = ? ORDER BY updated_at DESC LIMIT 100"),
      libraryId,
    ).map((result) => this.jobFrom(result));
  }

  deleteFailedJob(id: string): { storagePath: string } | undefined {
    const result = row(
      this.sql.prepare(`
        SELECT j.stage, j.version_id, v.document_id, v.storage_path
        FROM ingest_jobs j JOIN document_versions v ON v.id = j.version_id
        WHERE j.id = ?
      `),
      id,
    );
    if (!result) return undefined;
    if (String(result.stage) !== "failed") throw new Error("只有失败的任务可以删除");

    const versionId = String(result.version_id);
    const documentId = String(result.document_id);
    const storagePath = String(result.storage_path);
    this.sql.exec("BEGIN");
    try {
      this.clearGeneratedForVersion(versionId);
      for (const chunk of rows(this.sql.prepare("SELECT id FROM chunks WHERE version_id = ?"), versionId)) {
        this.sql.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?").run(String(chunk.id));
      }
      this.sql.prepare("DELETE FROM ingest_jobs WHERE id = ?").run(id);
      this.sql.prepare("DELETE FROM document_versions WHERE id = ?").run(versionId);
      this.sql.prepare(`
        DELETE FROM documents
        WHERE id = ? AND NOT EXISTS (
          SELECT 1 FROM document_versions WHERE document_id = ?
        )
      `).run(documentId, documentId);
      this.sql.exec("COMMIT");
      return { storagePath };
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  updateJob(id: string, stage: JobStage, progress: number, error: string | null = null): IngestJob {
    this.sql.prepare(`
      UPDATE ingest_jobs
      SET stage = ?, progress = ?, error = ?, attempts = attempts + CASE WHEN ? = 'parsing' THEN 1 ELSE 0 END, updated_at = ?
      WHERE id = ?
    `).run(stage, progress, error, stage, now(), id);
    const job = this.getJob(id);
    if (!job) throw new Error("处理任务不存在");
    return job;
  }

  private jobFrom(result: Row): IngestJob {
    return {
      id: String(result.id),
      libraryId: String(result.library_id),
      versionId: String(result.version_id),
      stage: String(result.stage) as JobStage,
      progress: Number(result.progress),
      error: result.error === null ? null : String(result.error),
      attempts: Number(result.attempts),
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at),
    };
  }

  replaceChunks(libraryId: string, versionId: string, pending: PendingChunk[]): Chunk[] {
    this.invalidateStatementsForVersion(versionId);
    this.clearGeneratedForVersion(versionId);
    const existing = rows(this.sql.prepare("SELECT id FROM chunks WHERE version_id = ?"), versionId);
    const deleteFts = this.sql.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
    for (const item of existing) deleteFts.run(String(item.id));
    this.sql.prepare("DELETE FROM chunks WHERE version_id = ?").run(versionId);
    const insert = this.sql.prepare(`
      INSERT INTO chunks
        (id, library_id, version_id, ordinal, heading_path, page_number, start_line, end_line, block_id, start_char, end_char, text, aspects_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.sql.prepare(
      "INSERT INTO chunks_fts (chunk_id, text, heading_path) VALUES (?, ?, ?)",
    );
    const result: Chunk[] = [];
    for (const item of pending) {
      const chunk: Chunk = {
        id: randomUUID(),
        libraryId,
        versionId,
        ...item,
        startLine: item.startLine ?? null,
        endLine: item.endLine ?? null,
        blockId: item.blockId ?? null,
        aspects: [],
      };
      insert.run(
        chunk.id, libraryId, versionId, chunk.ordinal, chunk.headingPath, chunk.pageNumber,
        chunk.startLine ?? null, chunk.endLine ?? null, chunk.blockId ?? null,
        chunk.startChar, chunk.endChar, chunk.text, JSON.stringify(chunk.aspects),
      );
      insertFts.run(chunk.id, chunk.text, chunk.headingPath ?? "");
      result.push(chunk);
    }
    return result;
  }

  private clearGeneratedForVersion(versionId: string): void {
    this.sql.prepare(`
      DELETE FROM relations
      WHERE created_by = 'ai' AND id IN (
        SELECT re.relation_id FROM relation_evidence re
        JOIN chunks c ON c.id = re.chunk_id
        WHERE c.version_id = ?
      )
    `).run(versionId);
    this.sql.prepare(`
      DELETE FROM abstract_node_evidence
      WHERE chunk_id IN (SELECT id FROM chunks WHERE version_id = ?)
    `).run(versionId);
    this.sql.prepare(`
      DELETE FROM abstract_nodes
      WHERE source = 'ai'
        AND NOT EXISTS (SELECT 1 FROM abstract_node_evidence e WHERE e.node_id = abstract_nodes.id)
    `).run();
  }

  private invalidateStatementsForVersion(versionId: string): void {
    const timestamp = now();
    this.sql.prepare(`
      UPDATE analysis_statements
      SET status = 'pending', invalidated_reason = '来源版本已重新分析，请重新核对引用',
        invalidated_at = ?, precheck_status = 'not_checked', precheck_reason = NULL,
        precheck_checked_at = NULL, precheck_content_updated_at = NULL, updated_at = ?
      WHERE id IN (
        SELECT se.statement_id FROM analysis_statement_evidence se
        JOIN chunks c ON c.id = se.chunk_id
        WHERE c.version_id = ?
      )
    `).run(timestamp, timestamp, versionId);
  }

  getChunk(id: string): Chunk | undefined {
    const result = row(this.sql.prepare("SELECT * FROM chunks WHERE id = ?"), id);
    return result ? chunkFrom(result) : undefined;
  }

  getChunksByIds(ids: string[]): Chunk[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return rows(this.sql.prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`), ...ids)
      .map(chunkFrom);
  }

  searchText(libraryId: string, query: string, limit: number): SearchResult[] {
    const match = query.split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    if (!match) return [];
    return rows(
      this.sql.prepare(`
        SELECT c.*, bm25(chunks_fts) AS rank
        FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
        WHERE chunks_fts MATCH ? AND c.library_id = ?
        ORDER BY rank LIMIT ?
      `),
      match,
      libraryId,
      limit,
    ).map((result) => ({ chunk: chunkFrom(result), score: -Number(result.rank) }));
  }

  listEvidenceChunks(libraryId: string, query: string, versionId: string | undefined, limit: number): SearchResult[] {
    if (query.trim() && !versionId) return this.searchText(libraryId, query, limit);
    const filters = ["library_id = ?"];
    const params: Array<string | number> = [libraryId];
    if (versionId) {
      filters.push("version_id = ?");
      params.push(versionId);
    }
    if (query.trim()) {
      filters.push("(text LIKE ? OR heading_path LIKE ?)");
      params.push(`%${query.trim()}%`, `%${query.trim()}%`);
    }
    params.push(limit);
    return rows(
      this.sql.prepare(`SELECT * FROM chunks WHERE ${filters.join(" AND ")} ORDER BY ordinal LIMIT ?`),
      ...params,
    ).map((entry) => ({ chunk: chunkFrom(entry), score: 1 }));
  }

  saveEmbedding(chunkId: string, dimensions: number, embedding: Uint8Array): void {
    this.sql.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, dimensions, embedding) VALUES (?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding
    `).run(chunkId, dimensions, embedding);
  }

  private citationsForChunkIds(ids: string[]): Citation[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const records = rows(this.sql.prepare(`
      SELECT c.*, d.name AS document_name, d.media_type
      FROM chunks c
      JOIN document_versions v ON v.id = c.version_id
      JOIN documents d ON d.id = v.document_id
      WHERE c.id IN (${placeholders})
    `), ...ids);
    const byId = new Map(records.map((result) => {
      const chunk = chunkFrom(result);
      return [chunk.id, {
        versionId: chunk.versionId,
        chunkId: chunk.id,
        documentName: String(result.document_name),
        mediaType: String(result.media_type),
        headingPath: chunk.headingPath,
        pageNumber: chunk.pageNumber,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        blockId: chunk.blockId,
        excerpt: chunk.text.slice(0, 280),
      } satisfies Citation];
    }));
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }

  private withNodeCitations(node: AbstractNode): AbstractNode {
    const evidenceIds = rows(
      this.sql.prepare("SELECT chunk_id FROM abstract_node_evidence WHERE node_id = ?"),
      node.id,
    ).map((item) => String(item.chunk_id));
    return { ...node, citations: this.citationsForChunkIds(evidenceIds) };
  }

  listEmbeddings(libraryId: string, dimensions: number): Array<{ chunk: Chunk; embedding: Uint8Array }> {
    return rows(
      this.sql.prepare(`
        SELECT c.*, e.embedding FROM chunk_embeddings e
        JOIN chunks c ON c.id = e.chunk_id
        WHERE c.library_id = ? AND e.dimensions = ?
      `),
      libraryId,
      dimensions,
    ).map((result) => ({
      chunk: chunkFrom(result),
      embedding: result.embedding as Uint8Array,
    }));
  }

  saveExtraction(libraryId: string, extraction: ExtractionOutput): void {
    const keyToId = new Map<string, string>();
    const findNode = this.sql.prepare(
      "SELECT * FROM abstract_nodes WHERE library_id = ? AND kind = ? AND level = ? AND title = ? COLLATE NOCASE LIMIT 1",
    );
    const insertNode = this.sql.prepare(`
      INSERT INTO abstract_nodes (id, library_id, kind, title, summary, level, aspects_json, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)
    `);
    const updateNodeAspects = this.sql.prepare(
      "UPDATE abstract_nodes SET aspects_json = ?, updated_at = ? WHERE id = ?",
    );
    const evidence = this.sql.prepare(
      "INSERT OR IGNORE INTO abstract_node_evidence (node_id, chunk_id) VALUES (?, ?)",
    );
    const findSuggestedRelation = this.sql.prepare(`
      SELECT id FROM relations
      WHERE library_id = ? AND source_node_id = ? AND target_node_id = ?
        AND type = ? AND status = 'suggested' AND created_by = 'ai'
      LIMIT 1
    `);
    const insertRelationEvidence = this.sql.prepare(
      "INSERT OR IGNORE INTO relation_evidence (relation_id, chunk_id) VALUES (?, ?)",
    );
    for (const extracted of extraction.nodes) {
      const existing = row(findNode, libraryId, extracted.kind, 1, extracted.title);
      const nodeId = existing ? String(existing.id) : randomUUID();
      if (!existing) {
        const timestamp = now();
        insertNode.run(
          nodeId, libraryId, extracted.kind, extracted.title, extracted.summary, 1,
          JSON.stringify(extracted.aspects ?? []), timestamp, timestamp,
        );
      } else if (extracted.aspects?.length) {
        const aspects = [...new Set([...parseAspects(existing.aspects_json), ...extracted.aspects])];
        updateNodeAspects.run(JSON.stringify(aspects), now(), nodeId);
      }
      keyToId.set(extracted.key, nodeId);
      for (const chunkId of extracted.evidenceChunkIds) evidence.run(nodeId, chunkId);
    }

    for (const extracted of extraction.relations) {
      const sourceNodeId = keyToId.get(extracted.sourceKey);
      const targetNodeId = keyToId.get(extracted.targetKey);
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) continue;
      const existing = row(findSuggestedRelation, libraryId, sourceNodeId, targetNodeId, extracted.type);
      const relationId = existing ? String(existing.id) : this.createRelation(libraryId, {
          sourceNodeId,
          targetNodeId,
          type: extracted.type,
          reason: extracted.reason,
          status: "suggested",
          confidence: extracted.confidence,
          createdBy: "ai",
        }).id;
      for (const chunkId of extracted.evidenceChunkIds) insertRelationEvidence.run(relationId, chunkId);
    }

    const insertMembership = this.sql.prepare(`
      INSERT OR IGNORE INTO abstraction_memberships
        (parent_node_id, child_node_id, status, reason, created_by, created_at, updated_at)
      VALUES (?, ?, 'suggested', ?, 'ai', ?, ?)
    `);
    for (const theme of extraction.themes ?? []) {
      const memberIds = theme.memberKeys.flatMap((key) => {
        const nodeId = keyToId.get(key);
        return nodeId ? [nodeId] : [];
      });
      if (memberIds.length === 0) continue;
      const existing = row(findNode, libraryId, "concept", 2, theme.title);
      const themeId = existing ? String(existing.id) : randomUUID();
      if (!existing) {
        const timestamp = now();
        insertNode.run(
          themeId, libraryId, "concept", theme.title, theme.summary, 2,
          JSON.stringify(theme.aspects ?? []), timestamp, timestamp,
        );
      } else if (theme.aspects?.length) {
        const aspects = [...new Set([...parseAspects(existing.aspects_json), ...theme.aspects])];
        updateNodeAspects.run(JSON.stringify(aspects), now(), themeId);
      }
      const themeEvidence = new Set(theme.evidenceChunkIds);
      for (const extracted of extraction.nodes) {
        if (theme.memberKeys.includes(extracted.key)) {
          for (const chunkId of extracted.evidenceChunkIds) themeEvidence.add(chunkId);
        }
      }
      for (const chunkId of themeEvidence) evidence.run(themeId, chunkId);
      const timestamp = now();
      for (const memberId of memberIds) {
        insertMembership.run(themeId, memberId, `AI 归纳为主题：${theme.title}`, timestamp, timestamp);
      }
    }
  }

  updateAbstractNode(id: string, values: { title?: string; summary?: string }): AbstractNode {
    const existing = row(this.sql.prepare("SELECT * FROM abstract_nodes WHERE id = ?"), id);
    if (!existing) throw new Error("抽象节点不存在");
    const title = values.title ?? String(existing.title);
    const summary = values.summary ?? String(existing.summary);
    this.sql.prepare(
      "UPDATE abstract_nodes SET title = ?, summary = ?, updated_at = ? WHERE id = ?",
    ).run(title, summary, now(), id);
    const updated = row(this.sql.prepare(`
      SELECT n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
      FROM abstract_nodes n
      WHERE n.id = ?
    `), id);
    return this.withNodeCitations(nodeFrom(updated as Row));
  }

  deleteAbstractNode(id: string): boolean {
    return Number(this.sql.prepare("DELETE FROM abstract_nodes WHERE id = ?").run(id).changes) > 0;
  }

  createRelation(
    libraryId: string,
    values: {
      sourceNodeId: string;
      targetNodeId: string;
      type: RelationType;
      reason: string;
      status?: RelationStatus;
      confidence?: number | null;
      createdBy?: "ai" | "user";
    },
  ): Relation {
    if (values.sourceNodeId === values.targetNodeId) throw new Error("关系两端不能是同一个节点");
    const endpointCount = row(
      this.sql.prepare(
        "SELECT COUNT(*) AS count FROM abstract_nodes WHERE library_id = ? AND id IN (?, ?)",
      ),
      libraryId,
      values.sourceNodeId,
      values.targetNodeId,
    );
    if (Number(endpointCount?.count ?? 0) !== 2) throw new Error("关系节点不属于当前知识库");
    const id = randomUUID();
    const timestamp = now();
    this.sql.prepare(`
      INSERT INTO relations
        (id, library_id, source_node_id, target_node_id, type, status, reason, confidence, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, libraryId, values.sourceNodeId, values.targetNodeId, values.type,
      values.status ?? "manual", values.reason, values.confidence ?? null,
      values.createdBy ?? "user", timestamp, timestamp,
    );
    return this.getRelation(id) as Relation;
  }

  getRelation(id: string): Relation | undefined {
    const result = row(this.sql.prepare("SELECT * FROM relations WHERE id = ?"), id);
    return result ? this.relationFrom(result) : undefined;
  }

  updateRelationStatus(id: string, status: "accepted" | "rejected"): Relation {
    const previous = this.getRelation(id);
    if (!previous) throw new Error("关系不存在");
    this.sql.prepare("UPDATE relations SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now(), id);
    if (previous.status !== status) {
      this.invalidateStatementForRelation(id, status === "rejected" ? "上游关系已被拒绝" : "上游关系已重新接受");
    }
    const relation = this.getRelation(id);
    return relation as Relation;
  }

  deleteRelation(id: string): boolean {
    return Number(this.sql.prepare("DELETE FROM relations WHERE id = ?").run(id).changes) > 0;
  }

  private relationFrom(result: Row): Relation {
    const evidence = rows(
      this.sql.prepare("SELECT chunk_id FROM relation_evidence WHERE relation_id = ?"),
      String(result.id),
    ).map((item) => String(item.chunk_id));
    return {
      id: String(result.id),
      libraryId: String(result.library_id),
      sourceNodeId: String(result.source_node_id),
      targetNodeId: String(result.target_node_id),
      type: String(result.type) as RelationType,
      status: String(result.status) as RelationStatus,
      reason: String(result.reason),
      confidence: result.confidence === null ? null : Number(result.confidence),
      createdBy: String(result.created_by) as "ai" | "user",
      evidenceChunkIds: evidence,
      citations: this.citationsForChunkIds(evidence),
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at),
    };
  }

  getGraph(
    libraryId: string,
    options: { centerId?: string; includeChunks?: boolean; status?: RelationStatus; type?: RelationType; limit?: number; view?: "detail" | "overview" },
  ): GraphResponse {
    if (options.view === "overview") return this.getOverviewGraph(libraryId, options);
    const limit = Math.min(Math.max(options.limit ?? 150, 1), 400);
    const filters = ["library_id = ?"];
    const params: unknown[] = [libraryId];
    let centerNodeIds: string[] = [];
    let centerThemeId: string | undefined;
    if (options.centerId) {
      const abstractCenter = row(
        this.sql.prepare("SELECT id, level FROM abstract_nodes WHERE id = ? AND library_id = ?"),
        options.centerId,
        libraryId,
      );
      if (abstractCenter) {
        if (Number(abstractCenter.level ?? 1) === 2) {
          centerThemeId = options.centerId;
          centerNodeIds = rows(
            this.sql.prepare("SELECT child_node_id FROM abstraction_memberships WHERE parent_node_id = ?"),
            options.centerId,
          ).map((result) => String(result.child_node_id));
        } else {
          centerNodeIds = [options.centerId];
        }
      } else {
        centerNodeIds = rows(
          this.sql.prepare(`
            SELECT e.node_id FROM abstract_node_evidence e
            JOIN chunks c ON c.id = e.chunk_id
            WHERE e.chunk_id = ? AND c.library_id = ?
          `),
          options.centerId,
          libraryId,
        ).map((result) => String(result.node_id));
      }
    }
    if (options.status) {
      filters.push("status = ?");
      params.push(options.status);
    } else {
      filters.push("status != 'rejected'");
    }
    if (options.type) {
      filters.push("type = ?");
      params.push(options.type);
    }
    if (options.centerId && centerNodeIds.length > 0) {
      const placeholders = centerNodeIds.map(() => "?").join(",");
      filters.push(`(source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))`);
      params.push(...centerNodeIds, ...centerNodeIds);
    }
    params.push(limit + 1);
    const relationRows = rows(
      this.sql.prepare(`SELECT * FROM relations WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`),
      ...params,
    );
    const truncated = relationRows.length > limit;
    const relationSlice = relationRows.slice(0, limit);
    const nodeIds = new Set<string>();
    for (const relation of relationSlice) {
      nodeIds.add(String(relation.source_node_id));
      nodeIds.add(String(relation.target_node_id));
    }
    for (const centerNodeId of centerNodeIds) nodeIds.add(centerNodeId);
    if (centerThemeId) nodeIds.add(centerThemeId);
    if (!options.centerId && nodeIds.size < limit) {
      for (const result of rows(
        this.sql.prepare("SELECT id FROM abstract_nodes WHERE library_id = ? AND level = 1 ORDER BY updated_at DESC LIMIT ?"),
        libraryId,
        limit - nodeIds.size,
      )) nodeIds.add(String(result.id));
    }
    const nodeRows = nodeIds.size
      ? rows(
          this.sql.prepare(`
            SELECT n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
            FROM abstract_nodes n WHERE n.id IN (${[...nodeIds].map(() => "?").join(",")})
          `),
          ...nodeIds,
        )
      : [];
    const graphNodes: GraphNode[] = nodeRows.map((result) => ({
      id: String(result.id),
      nodeType: "abstract",
      data: this.withNodeCitations(nodeFrom(result)),
    }));
    const graphEdges: GraphEdge[] = relationSlice.map((result) => ({
      id: String(result.id),
      source: String(result.source_node_id),
      target: String(result.target_node_id),
      edgeType: "relation",
      relation: this.relationFrom(result),
    }));
    if (centerThemeId) {
      for (const childId of centerNodeIds) {
        graphEdges.push({
          id: `membership:${centerThemeId}:${childId}`,
          source: centerThemeId,
          target: childId,
          edgeType: "membership",
        });
      }
    }

    if (options.includeChunks && nodeIds.size > 0) {
      const placeholders = [...nodeIds].map(() => "?").join(",");
      const links = rows(
        this.sql.prepare(`
          SELECT e.node_id, c.* FROM abstract_node_evidence e
          JOIN chunks c ON c.id = e.chunk_id
          WHERE e.node_id IN (${placeholders}) LIMIT ?
        `),
        ...nodeIds,
        limit,
      );
      const seenChunks = new Set<string>();
      for (const result of links) {
        const chunk = chunkFrom(result);
        if (!seenChunks.has(chunk.id)) {
          graphNodes.push({ id: chunk.id, nodeType: "chunk", data: chunk });
          seenChunks.add(chunk.id);
        }
        graphEdges.push({
          id: `evidence:${String(result.node_id)}:${chunk.id}`,
          source: String(result.node_id),
          target: chunk.id,
          edgeType: "evidence",
        });
      }
    }
    return { nodes: graphNodes, edges: graphEdges, truncated };
  }

  private getOverviewGraph(
    libraryId: string,
    options: { status?: RelationStatus; type?: RelationType; limit?: number },
  ): GraphResponse {
    const limit = Math.min(Math.max(options.limit ?? 150, 1), 400);
    const filters = ["library_id = ?"];
    const params: unknown[] = [libraryId];
    if (options.status) {
      filters.push("status = ?");
      params.push(options.status);
    } else {
      filters.push("status != 'rejected'");
    }
    if (options.type) {
      filters.push("type = ?");
      params.push(options.type);
    }
    const relationRows = rows(
      this.sql.prepare(`SELECT * FROM relations WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`),
      ...params,
      limit + 1,
    );
    const truncated = relationRows.length > limit;
    const relationSlice = relationRows.slice(0, limit);
    const parentByChild = new Map(
      rows(this.sql.prepare(`
        SELECT child_node_id, parent_node_id FROM abstraction_memberships
        JOIN abstract_nodes n ON n.id = parent_node_id
        WHERE n.library_id = ? ORDER BY n.updated_at DESC
      `), libraryId).map((entry) => [String(entry.child_node_id), String(entry.parent_node_id)]),
    );
    const nodeIds = new Set<string>(
      rows(this.sql.prepare("SELECT id FROM abstract_nodes WHERE library_id = ? AND level = 2"), libraryId)
        .map((entry) => String(entry.id)),
    );
    const aggregates = new Map<string, GraphEdge>();
    for (const result of relationSlice) {
      const originalSource = String(result.source_node_id);
      const originalTarget = String(result.target_node_id);
      const source = parentByChild.get(originalSource) ?? originalSource;
      const target = parentByChild.get(originalTarget) ?? originalTarget;
      nodeIds.add(source);
      nodeIds.add(target);
      if (source === target) continue;
      const type = String(result.type) as RelationType;
      const key = `${source}:${target}:${type}`;
      const current = aggregates.get(key);
      if (current?.aggregate) {
        current.aggregate.count += 1;
        current.aggregate.relationIds.push(String(result.id));
      } else {
        aggregates.set(key, {
          id: `aggregate:${key}`,
          source,
          target,
          edgeType: "relation",
          aggregate: { type, count: 1, relationIds: [String(result.id)] },
        });
      }
    }
    if (nodeIds.size === 0) {
      for (const result of rows(
        this.sql.prepare("SELECT id FROM abstract_nodes WHERE library_id = ? AND level = 1 ORDER BY updated_at DESC LIMIT ?"),
        libraryId,
        limit,
      )) nodeIds.add(String(result.id));
    }
    const graphNodes: GraphNode[] = nodeIds.size
      ? rows(
          this.sql.prepare(`
            SELECT n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
            FROM abstract_nodes n WHERE n.id IN (${[...nodeIds].map(() => "?").join(",")})
          `),
          ...nodeIds,
        ).map((result) => ({
          id: String(result.id),
          nodeType: "abstract",
          data: this.withNodeCitations(nodeFrom(result)),
        }))
      : [];
    return { nodes: graphNodes, edges: [...aggregates.values()], truncated };
  }

  listVersionSources(libraryId: string): Array<ReturnType<AgentDatabase["getVersionSource"]> & {}> {
    const ids = rows(this.sql.prepare(`
      SELECT v.id FROM document_versions v JOIN documents d ON d.id = v.document_id
      WHERE d.library_id = ? AND v.status = 'completed' ORDER BY d.name, v.created_at DESC
    `), libraryId).map((item) => String(item.id));
    return ids.flatMap((id) => {
      const source = this.getVersionSource(id);
      return source ? [source] : [];
    });
  }

  listPublishRelations(libraryId: string): Relation[] {
    return rows(this.sql.prepare(`
      SELECT * FROM relations WHERE library_id = ? AND status IN ('accepted', 'manual') ORDER BY updated_at DESC
    `), libraryId).map((entry) => this.relationFrom(entry));
  }

  generateAnalysisDraft(libraryId: string): AnalysisDraft {
    if (!this.getLibrary(libraryId)) throw new Error("知识库不存在");
    const relations = rows(this.sql.prepare(`
      SELECT * FROM relations WHERE library_id = ? AND status IN ('accepted', 'manual') ORDER BY updated_at DESC
    `), libraryId).map((entry) => this.relationFrom(entry));
    const existing = this.sql.prepare("SELECT id FROM analysis_statements WHERE relation_id = ?");
    const insert = this.sql.prepare(`
      INSERT INTO analysis_statements (id, library_id, relation_id, text, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `);
    const insertEvidence = this.sql.prepare(
      "INSERT OR IGNORE INTO analysis_statement_evidence (statement_id, chunk_id) VALUES (?, ?)",
    );
    for (const relation of relations) {
      if (row(existing, relation.id)) continue;
      const source = this.getAbstractNode(relation.sourceNodeId);
      const target = this.getAbstractNode(relation.targetNodeId);
      if (!source || !target) continue;
      const id = randomUUID();
      const timestamp = now();
      const text = `${source.title} ${relation.type} ${target.title}：${relation.reason}`;
      insert.run(id, libraryId, relation.id, text, timestamp, timestamp);
      for (const chunkId of relation.evidenceChunkIds) insertEvidence.run(id, chunkId);
    }
    return this.getAnalysisDraft(libraryId);
  }

  getAnalysisDraft(libraryId: string): AnalysisDraft {
    if (!this.getLibrary(libraryId)) throw new Error("知识库不存在");
    const statements = rows(this.sql.prepare(`
      SELECT s.*, r.type AS relation_type
      FROM analysis_statements s JOIN relations r ON r.id = s.relation_id
      WHERE s.library_id = ? AND r.status IN ('accepted', 'manual')
      ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, s.updated_at DESC
    `), libraryId).map((entry) => this.statementFrom(entry));
    return {
      libraryId,
      statements,
      summary: {
        pending: statements.filter((statement) => statement.status === "pending").length,
        approved: statements.filter((statement) => statement.status === "approved").length,
        rejected: statements.filter((statement) => statement.status === "rejected").length,
        invalidated: statements.filter((statement) => statement.status === "pending" && statement.invalidatedAt !== null).length,
      },
    };
  }

  getApprovedStatements(libraryId: string): AnalysisStatement[] {
    return rows(this.sql.prepare(`
      SELECT s.*, r.type AS relation_type
      FROM analysis_statements s JOIN relations r ON r.id = s.relation_id
      WHERE s.library_id = ? AND s.status = 'approved' AND r.status IN ('accepted', 'manual')
      ORDER BY s.updated_at DESC
    `), libraryId).map((entry) => this.statementFrom(entry));
  }

  updateAnalysisStatement(
    id: string,
    values: { text?: string; status?: StatementStatus },
  ): AnalysisStatement {
    const existing = row(this.sql.prepare(`
      SELECT s.*, r.type AS relation_type FROM analysis_statements s
      JOIN relations r ON r.id = s.relation_id WHERE s.id = ?
    `), id);
    if (!existing) throw new Error("分析陈述不存在");
    const nextText = values.text ?? String(existing.text);
    const textChanged = values.text !== undefined && nextText !== String(existing.text);
    const citations = this.statementFrom(existing).citations;
    if (values.status === "approved" && citations.length === 0) throw new Error("批准陈述前必须关联至少一条原文证据");
    const resetReview = textChanged;
    const nextStatus = resetReview ? "pending" : (values.status ?? String(existing.status));
    const timestamp = now();
    this.sql.prepare(`
      UPDATE analysis_statements
      SET text = ?, status = ?, updated_at = ?,
        invalidated_reason = CASE WHEN ? THEN '陈述文本已修改，请重新核对引用' ELSE invalidated_reason END,
        invalidated_at = CASE WHEN ? THEN ? ELSE invalidated_at END,
        precheck_status = CASE WHEN ? THEN 'not_checked' ELSE precheck_status END,
        precheck_reason = CASE WHEN ? THEN NULL ELSE precheck_reason END,
        precheck_checked_at = CASE WHEN ? THEN NULL ELSE precheck_checked_at END,
        precheck_content_updated_at = CASE WHEN ? THEN NULL ELSE precheck_content_updated_at END
      WHERE id = ?
    `).run(
      nextText, nextStatus, timestamp,
      resetReview ? 1 : 0, resetReview ? 1 : 0, timestamp,
      resetReview ? 1 : 0, resetReview ? 1 : 0, resetReview ? 1 : 0, resetReview ? 1 : 0,
      id,
    );
    return this.getAnalysisStatement(id) as AnalysisStatement;
  }

  addStatementEvidence(statementId: string, chunkId: string): AnalysisStatement {
    const statement = this.getAnalysisStatement(statementId);
    if (!statement) throw new Error("分析陈述不存在");
    const chunk = this.getChunk(chunkId);
    if (!chunk || chunk.libraryId !== statement.libraryId) throw new Error("证据片段不属于当前知识库");
    const inserted = this.sql.prepare(
      "INSERT OR IGNORE INTO analysis_statement_evidence (statement_id, chunk_id) VALUES (?, ?)",
    ).run(statementId, chunkId);
    if (Number(inserted.changes) > 0) this.invalidateStatementForRelation(statement.relationId, "证据引用已修改，请重新审核陈述");
    return this.getAnalysisStatement(statementId) as AnalysisStatement;
  }

  deleteStatementEvidence(statementId: string, chunkId: string): AnalysisStatement {
    const statement = this.getAnalysisStatement(statementId);
    if (!statement) throw new Error("分析陈述不存在");
    const deleted = this.sql.prepare("DELETE FROM analysis_statement_evidence WHERE statement_id = ? AND chunk_id = ?")
      .run(statementId, chunkId);
    if (Number(deleted.changes) > 0) this.invalidateStatementForRelation(statement.relationId, "证据引用已修改，请重新审核陈述");
    return this.getAnalysisStatement(statementId) as AnalysisStatement;
  }

  getAnalysisStatement(id: string): AnalysisStatement | undefined {
    const result = row(this.sql.prepare(`
      SELECT s.*, r.type AS relation_type FROM analysis_statements s
      JOIN relations r ON r.id = s.relation_id WHERE s.id = ?
    `), id);
    return result ? this.statementFrom(result) : undefined;
  }

  private statementFrom(result: Row): AnalysisStatement {
    const evidenceIds = rows(
      this.sql.prepare("SELECT chunk_id FROM analysis_statement_evidence WHERE statement_id = ?"),
      String(result.id),
    ).map((entry) => String(entry.chunk_id));
    return {
      id: String(result.id),
      libraryId: String(result.library_id),
      relationId: String(result.relation_id),
      text: String(result.text),
      status: String(result.status) as StatementStatus,
      relationType: String(result.relation_type) as RelationType,
      citations: this.citationsForChunkIds(evidenceIds),
      invalidatedReason: result.invalidated_reason === null ? null : String(result.invalidated_reason),
      invalidatedAt: result.invalidated_at === null ? null : String(result.invalidated_at),
      precheck: {
        status: (result.precheck_status === null ? "not_checked" : String(result.precheck_status)) as AnalysisStatement["precheck"]["status"],
        reason: result.precheck_reason === null ? null : String(result.precheck_reason),
        checkedAt: result.precheck_checked_at === null ? null : String(result.precheck_checked_at),
        contentUpdatedAt: result.precheck_content_updated_at === null ? null : String(result.precheck_content_updated_at),
      },
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at),
    };
  }

  saveStatementPrecheck(id: string, result: StatementPrecheckOutput): AnalysisStatement {
    const statement = this.getAnalysisStatement(id);
    if (!statement) throw new Error("分析陈述不存在");
    const timestamp = now();
    this.sql.prepare(`
      UPDATE analysis_statements
      SET precheck_status = ?, precheck_reason = ?, precheck_checked_at = ?,
        precheck_content_updated_at = ?
      WHERE id = ?
    `).run(result.status, result.reason, timestamp, statement.updatedAt, id);
    return this.getAnalysisStatement(id) as AnalysisStatement;
  }

  failStatementPrecheck(id: string, reason: string): AnalysisStatement {
    const statement = this.getAnalysisStatement(id);
    if (!statement) throw new Error("分析陈述不存在");
    this.sql.prepare(`
      UPDATE analysis_statements
      SET precheck_status = 'failed', precheck_reason = ?, precheck_checked_at = ?,
        precheck_content_updated_at = ?
      WHERE id = ?
    `).run(reason, now(), statement.updatedAt, id);
    return this.getAnalysisStatement(id) as AnalysisStatement;
  }

  private invalidateStatementForRelation(relationId: string, reason: string): void {
    const timestamp = now();
    this.sql.prepare(`
      UPDATE analysis_statements
      SET status = 'pending', invalidated_reason = ?, invalidated_at = ?,
        precheck_status = 'not_checked', precheck_reason = NULL,
        precheck_checked_at = NULL, precheck_content_updated_at = NULL, updated_at = ?
      WHERE relation_id = ?
    `).run(reason, timestamp, timestamp, relationId);
  }

  getAbstractNode(id: string): AbstractNode | undefined {
    const result = row(this.sql.prepare("SELECT * FROM abstract_nodes WHERE id = ?"), id);
    return result ? this.withNodeCitations(nodeFrom(result)) : undefined;
  }

  savePublishedAnalysis(value: PublishedAnalysis): PublishedAnalysis {
    this.sql.prepare(`
      INSERT INTO published_analyses (library_id, path, content, included_version_ids_json, published_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(library_id) DO UPDATE SET path = excluded.path, content = excluded.content,
        included_version_ids_json = excluded.included_version_ids_json, published_at = excluded.published_at
    `).run(value.libraryId, value.path, value.content, JSON.stringify(value.includedVersionIds), value.publishedAt);
    return value;
  }

  getPublishedAnalysis(libraryId: string): PublishedAnalysis | undefined {
    const result = row(this.sql.prepare("SELECT * FROM published_analyses WHERE library_id = ?"), libraryId);
    return result ? {
      libraryId,
      path: String(result.path),
      content: String(result.content),
      includedVersionIds: JSON.parse(String(result.included_version_ids_json)) as string[],
      publishedAt: String(result.published_at),
    } : undefined;
  }
}
