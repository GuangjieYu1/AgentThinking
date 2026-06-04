import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import { aspectKinds } from "@agent-thinking/contracts";
import type {
  AbstractNode,
  AbstractNodeKind,
  AoriDocumentIndex,
  AoriDocumentResponse,
  Aspect,
  AspectKind,
  AspectItem,
  AspectRelation,
  AuthUser,
  AnalysisDraft,
  AnalysisStatement,
  Citation,
  Chunk,
  ContextUnit,
  ContextUnitQualityReport,
  ClosureReport,
  Document,
  DocumentRelationLexicon,
  DocumentTreeNode,
  DocumentTreeNodeType,
  DocumentVersion,
  DocumentUnderstanding,
  EvidencePack,
  ExtractionOutput,
  GraphEdge,
  GraphNode,
  GraphResponse,
  FocusRole,
  IndexBuildRecord,
  IndexBuildStatus,
  IndexingPerformanceReport,
  IndexProfileStatus,
  IndexStrategy,
  IndexingRationaleTrace,
  IngestJob,
  JobStage,
  Library,
  LibrarySettings,
  MappingAudit,
  MappingAuditFinding,
  MappingAuditMetrics,
  MappingAuditResult,
  OcrMode,
  Pulse,
  PulseHit,
  PulseInputMode,
  PulseHitTargetType,
  PulsePathRole,
  PulseResponse,
  PulseStats,
  PulseStatus,
  ParentChildChunk,
  Relation,
  RelationStatus,
  RelationType,
  ReflectiveIndexReport,
  SearchResult,
  SummaryTreeLevel,
  SummaryTreeNode,
  StatementStatus,
  StatementPrecheckOutput,
  SourceLink,
  SourceMetadata,
  SourceStructure,
  PublishedAnalysis,
  RetrievalUnit,
  SelfQuestion,
} from "@agent-thinking/contracts";
import type { PendingChunk } from "./domain/chunker.js";
import type { PendingDocumentIndex } from "./domain/document-tree.js";
import type { MappingAuditContext, MappingAuditNodeContext, MappingAuditRelationContext } from "./services/models.js";

type Row = Record<string, string | number | null | Uint8Array>;
export type PendingPulseHit = Omit<PulseHit, "id" | "pulseId" | "libraryId">;
const sqliteModuleName = ["node", "sqlite"].join(":");
const { DatabaseSync } = await import(sqliteModuleName) as typeof import("node:sqlite");

function now(): string {
  return new Date().toISOString();
}

function sessionExpiry(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const expectedBuffer = Buffer.from(expected, "base64url");
  const actualBuffer = scryptSync(password, salt, expectedBuffer.length);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
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

function authUserFrom(r: Row): AuthUser {
  return {
    id: String(r.id),
    username: String(r.username),
    createdAt: String(r.created_at),
  };
}

function chunkFrom(r: Row): Chunk {
  return {
    id: String(r.id),
    libraryId: String(r.library_id),
    versionId: String(r.version_id),
    parentChunkId: r.parent_chunk_id === null || r.parent_chunk_id === undefined ? null : String(r.parent_chunk_id),
    documentTreeNodeId: r.document_tree_node_id === null || r.document_tree_node_id === undefined ? null : String(r.document_tree_node_id),
    childOrdinal: r.child_ordinal === null || r.child_ordinal === undefined ? null : Number(r.child_ordinal),
    parentOrdinal: r.parent_ordinal === null || r.parent_ordinal === undefined ? null : Number(r.parent_ordinal),
    nodeType: r.node_type === null || r.node_type === undefined ? null : String(r.node_type) as DocumentTreeNodeType,
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

function documentTreeNodeFrom(r: Row): DocumentTreeNode {
  return {
    id: String(r.id),
    libraryId: String(r.library_id),
    documentId: String(r.document_id),
    versionId: String(r.version_id),
    nodeType: String(r.node_type) as DocumentTreeNode["nodeType"],
    parentId: r.parent_id === null ? null : String(r.parent_id),
    childrenIds: parseTextList(r.children_ids_json),
    ordinal: Number(r.ordinal),
    level: Number(r.level),
    headingPath: parseTextList(r.heading_path_json),
    text: String(r.text),
    summary: String(r.summary),
    prevId: r.prev_id === null ? null : String(r.prev_id),
    nextId: r.next_id === null ? null : String(r.next_id),
    sourceChunkIds: parseTextList(r.source_chunk_ids_json),
  };
}

function summaryTreeNodeFrom(r: Row): SummaryTreeNode {
  return {
    id: String(r.id),
    versionId: String(r.version_id),
    level: String(r.level) as SummaryTreeLevel,
    sourceNodeIds: parseTextList(r.source_node_ids_json),
    summary: String(r.summary),
    embeddingId: r.embedding_id === null ? null : String(r.embedding_id),
    parentSummaryId: r.parent_summary_id === null ? null : String(r.parent_summary_id),
    childSummaryIds: parseTextList(r.child_summary_ids_json),
  };
}

function indexBuildFrom(r: Row): IndexBuildRecord {
  return {
    buildId: String(r.build_id),
    versionId: String(r.version_id),
    profile: String(r.profile) as IndexBuildRecord["profile"],
    status: String(r.status) as IndexBuildStatus,
    startedAt: String(r.started_at),
    ...(r.finished_at === null || r.finished_at === undefined ? {} : { finishedAt: String(r.finished_at) }),
    ...(r.error_message === null || r.error_message === undefined ? {} : { errorMessage: String(r.error_message) }),
    ...(r.error_stack === null || r.error_stack === undefined ? {} : { errorStack: String(r.error_stack) }),
    ...(r.context_unit_count === null || r.context_unit_count === undefined ? {} : { contextUnitCount: Number(r.context_unit_count) }),
    ...(r.retrieval_unit_count === null || r.retrieval_unit_count === undefined ? {} : { retrievalUnitCount: Number(r.retrieval_unit_count) }),
    ...(r.vector_count === null || r.vector_count === undefined ? {} : { vectorCount: Number(r.vector_count) }),
    ...(r.summary_vector_count === null || r.summary_vector_count === undefined ? {} : { summaryVectorCount: Number(r.summary_vector_count) }),
    ...(r.quality_report_json === null || r.quality_report_json === undefined ? {} : { qualityReportJson: String(r.quality_report_json) }),
    ...(r.performance_report_json === null || r.performance_report_json === undefined ? {} : { performanceReportJson: String(r.performance_report_json) }),
    indexerVersion: String(r.indexer_version),
    schemaVersion: Number(r.schema_version),
  };
}

function contextUnitFrom(r: Row): ContextUnit {
  return {
    id: String(r.id),
    stableKey: String(r.stable_key),
    buildId: String(r.build_id),
    versionId: String(r.version_id),
    sourceNodeIds: parseTextList(r.source_node_ids_json),
    primarySourceNodeId: r.primary_source_node_id === null ? null : String(r.primary_source_node_id),
    sourceRange: JSON.parse(String(r.source_range_json)) as ContextUnit["sourceRange"],
    headingPath: parseTextList(r.heading_path_json),
    displayHeadingPath: parseTextList(r.display_heading_path_json),
    ordinal: Number(r.ordinal),
    ordinalInPrimarySource: r.ordinal_in_primary_source === null || r.ordinal_in_primary_source === undefined ? undefined : Number(r.ordinal_in_primary_source),
    text: String(r.text),
    blocks: JSON.parse(String(r.blocks_json)) as ContextUnit["blocks"],
    retrievalUnitIds: parseTextList(r.retrieval_unit_ids_json),
    estimatedTokens: r.estimated_tokens === null || r.estimated_tokens === undefined ? undefined : Number(r.estimated_tokens),
    boundaryReason: String(r.boundary_reason),
  };
}

function retrievalUnitFrom(r: Row): RetrievalUnit {
  return {
    id: String(r.id),
    stableKey: String(r.stable_key),
    buildId: String(r.build_id),
    versionId: String(r.version_id),
    contextUnitId: String(r.context_unit_id),
    text: String(r.text),
    headingPath: parseTextList(r.heading_path_json),
    ordinal: Number(r.ordinal),
    startChar: r.start_char === null || r.start_char === undefined ? null : Number(r.start_char),
    endChar: r.end_char === null || r.end_char === undefined ? null : Number(r.end_char),
    startLine: r.start_line === null || r.start_line === undefined ? null : Number(r.start_line),
    endLine: r.end_line === null || r.end_line === undefined ? null : Number(r.end_line),
    pageNumber: r.page_number === null || r.page_number === undefined ? null : Number(r.page_number),
    estimatedTokens: r.estimated_tokens === null || r.estimated_tokens === undefined ? undefined : Number(r.estimated_tokens),
  };
}

function nodeFrom(r: Row): AbstractNode {
  const manualAspects = r.manual_aspects_json === null || r.manual_aspects_json === undefined
    ? null
    : parseAspects(r.manual_aspects_json);
  return {
    id: String(r.id),
    libraryId: String(r.library_id),
    kind: String(r.kind) as AbstractNodeKind,
    title: String(r.title),
    summary: String(r.summary),
    level: Number(r.level ?? 1) === 2 ? 2 : 1,
    aspects: manualAspects ?? parseAspects(r.aspects_json),
    aspectSource: manualAspects === null ? "ai" : "manual",
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
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeAspects(parsed.filter(
      (entry): entry is AspectKind => typeof entry === "string" && aspectKinds.includes(entry as AspectKind),
    ));
  } catch {
    return [];
  }
}

function normalizeAspects(aspects: readonly AspectKind[]): AspectKind[] {
  const selected = new Set(aspects);
  return aspectKinds.filter((aspect) => selected.has(aspect));
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function searchTokens(query: string): string[] {
  return normalizeSearchText(query).split(" ").filter(Boolean);
}

function scoreChunkMatch(chunk: Chunk, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;
  const tokens = searchTokens(query);
  const title = normalizeSearchText(chunk.headingPath ?? `chunk ${chunk.ordinal + 1}`);
  const text = normalizeSearchText(chunk.text);
  const preview = text.slice(0, 1200);
  let score = 0;

  if (title === normalizedQuery) score += 1;
  else if (title.startsWith(normalizedQuery)) score += 0.88;
  else if (title.includes(normalizedQuery)) score += 0.78;
  if (preview.includes(normalizedQuery)) score += 0.44;

  if (tokens.length > 0) {
    const titleHits = tokens.filter((token) => title.includes(token)).length;
    const textHits = tokens.filter((token) => preview.includes(token)).length;
    score += (titleHits / tokens.length) * 0.34;
    score += (textHits / tokens.length) * 0.18;
  }

  const earlyTextHit = preview.indexOf(normalizedQuery);
  if (earlyTextHit >= 0) score += Math.max(0.02, 0.08 - earlyTextHit / 16000);
  return Math.min(1, score);
}

function parseTextList(value: Row[string] | undefined): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonValue<T>(value: Row[string] | undefined, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeIndexStrategy(value: unknown): IndexStrategy {
  return value === "aspect_oriented_reflective" ? "aspect_oriented_reflective" : "bottom_up_evidence";
}

function sqliteBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseMappingAuditFindings(value: Row[string] | undefined): MappingAuditFinding[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (
        typeof entry !== "object" || entry === null
        || typeof (entry as MappingAuditFinding).kind !== "string"
        || typeof (entry as MappingAuditFinding).severity !== "string"
        || typeof (entry as MappingAuditFinding).title !== "string"
      ) return [];
      const finding = entry as Partial<MappingAuditFinding>;
      return [{
        kind: String(finding.kind) as MappingAuditFinding["kind"],
        severity: String(finding.severity) as MappingAuditFinding["severity"],
        ...(typeof finding.ruleCategory === "string" ? { ruleCategory: finding.ruleCategory as MappingAuditFinding["ruleCategory"] } : {}),
        title: String(finding.title),
        description: typeof finding.description === "string" ? finding.description : "",
        suggestion: typeof finding.suggestion === "string" ? finding.suggestion : "",
        evidenceChunkIds: Array.isArray(finding.evidenceChunkIds) ? finding.evidenceChunkIds.filter((id): id is string => typeof id === "string") : [],
        nodeIds: Array.isArray(finding.nodeIds) ? finding.nodeIds.filter((id): id is string => typeof id === "string") : [],
        relationIds: Array.isArray(finding.relationIds) ? finding.relationIds.filter((id): id is string => typeof id === "string") : [],
        userComment: typeof finding.userComment === "string" ? finding.userComment : "",
        status: typeof finding.status === "string" ? finding.status : "open",
        ...(typeof finding.resolutionNote === "string" ? { resolutionNote: finding.resolutionNote } : {}),
        ...(typeof finding.fixedByRebuildId === "string" ? { fixedByRebuildId: finding.fixedByRebuildId } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function parseMappingAuditMetrics(value: Row[string] | undefined): MappingAuditMetrics | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as MappingAuditMetrics;
  } catch {
    return undefined;
  }
}

function mappingAuditFrom(r: Row): MappingAudit {
  const metrics = parseMappingAuditMetrics(r.metrics_json);
  return {
    id: String(r.id),
    libraryId: String(r.library_id),
    versionId: String(r.version_id),
    status: String(r.status) as MappingAudit["status"],
    summary: String(r.summary),
    reconstruction: String(r.reconstruction),
    findings: parseMappingAuditFindings(r.findings_json),
    ...(metrics ? { metrics } : {}),
    graphRebuildReport: r.graph_rebuild_report === null ? "" : String(r.graph_rebuild_report ?? ""),
    graphRebuiltAt: r.graph_rebuilt_at === null ? null : String(r.graph_rebuilt_at),
    createdAt: String(r.created_at),
  };
}

function pulseFrom(r: Row): Pulse {
  return {
    id: String(r.id),
    libraryId: String(r.library_id),
    question: String(r.question),
    answer: String(r.answer),
    summary: String(r.summary),
    inputMode: String(r.input_mode ?? "full") as PulseInputMode,
    status: String(r.status) as PulseStatus,
    createdAt: String(r.created_at),
    reviewedAt: r.reviewed_at === null ? null : String(r.reviewed_at),
  };
}

function pulseHitFrom(r: Row): PulseHit {
  return {
    id: String(r.id),
    pulseId: String(r.pulse_id),
    libraryId: String(r.library_id),
    targetType: String(r.target_type) as PulseHitTargetType,
    targetId: String(r.target_id),
    score: Number(r.score),
    reason: String(r.reason),
    pathRole: String(r.path_role) as PulsePathRole,
    stepIndex: r.step_index === null || r.step_index === undefined ? null : Number(r.step_index),
    observation: r.observation === null || r.observation === undefined ? null : String(r.observation),
    rationale: r.rationale === null || r.rationale === undefined ? null : String(r.rationale),
    label: String(r.label),
    excerpt: r.excerpt === null ? null : String(r.excerpt),
  };
}

function pulseStatsFrom(r: Row | undefined): PulseStats | undefined {
  if (!r) return undefined;
  return {
    correctCount: Number(r.correct_count ?? 0),
    wrongCount: Number(r.wrong_count ?? 0),
    lastCorrectAt: r.last_correct_at === null ? null : String(r.last_correct_at),
    lastWrongAt: r.last_wrong_at === null ? null : String(r.last_wrong_at),
  };
}

function emptyPulseStats(): PulseStats {
  return { correctCount: 0, wrongCount: 0, lastCorrectAt: null, lastWrongAt: null };
}

function combinePulseStats(values: Array<PulseStats | undefined>): PulseStats | undefined {
  const combined = values.reduce<PulseStats>((current, stats) => {
    if (!stats) return current;
    return {
      correctCount: current.correctCount + stats.correctCount,
      wrongCount: current.wrongCount + stats.wrongCount,
      lastCorrectAt: [current.lastCorrectAt, stats.lastCorrectAt].filter(Boolean).sort().at(-1) ?? null,
      lastWrongAt: [current.lastWrongAt, stats.lastWrongAt].filter(Boolean).sort().at(-1) ?? null,
    };
  }, emptyPulseStats());
  return combined.correctCount || combined.wrongCount ? combined : undefined;
}

export class AgentDatabase {
  readonly sql: NativeDatabaseSync;

  constructor(dataDir: string, fileName = "agent-thinking.sqlite") {
    mkdirSync(dataDir, { recursive: true });
    this.sql = new DatabaseSync(join(dataDir, fileName), { allowExtension: true });
    this.sql.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
    this.markStaleIndexBuildsAbandoned();
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS index_builds (
        build_id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        profile TEXT NOT NULL CHECK (profile IN ('v1','v2')),
        status TEXT NOT NULL CHECK (status IN ('building','ready','failed','partial','abandoned')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_message TEXT,
        error_stack TEXT,
        context_unit_count INTEGER,
        retrieval_unit_count INTEGER,
        vector_count INTEGER,
        summary_vector_count INTEGER,
        quality_report_json TEXT,
        performance_report_json TEXT,
        indexer_version TEXT NOT NULL,
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_units (
        id TEXT PRIMARY KEY,
        stable_key TEXT NOT NULL,
        build_id TEXT NOT NULL REFERENCES index_builds(build_id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        source_node_ids_json TEXT NOT NULL DEFAULT '[]',
        primary_source_node_id TEXT,
        source_range_json TEXT NOT NULL,
        heading_path_json TEXT NOT NULL DEFAULT '[]',
        display_heading_path_json TEXT NOT NULL DEFAULT '[]',
        ordinal INTEGER NOT NULL,
        ordinal_in_primary_source INTEGER,
        text TEXT NOT NULL,
        blocks_json TEXT NOT NULL DEFAULT '[]',
        retrieval_unit_ids_json TEXT NOT NULL DEFAULT '[]',
        estimated_tokens INTEGER,
        boundary_reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retrieval_units (
        id TEXT PRIMARY KEY,
        stable_key TEXT NOT NULL,
        build_id TEXT NOT NULL REFERENCES index_builds(build_id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        context_unit_id TEXT NOT NULL REFERENCES context_units(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        heading_path_json TEXT NOT NULL DEFAULT '[]',
        ordinal INTEGER NOT NULL,
        start_char INTEGER,
        end_char INTEGER,
        start_line INTEGER,
        end_line INTEGER,
        page_number INTEGER,
        estimated_tokens INTEGER
      );
      CREATE TABLE IF NOT EXISTS vector_records (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        build_id TEXT NOT NULL,
        index_schema_version INTEGER NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('legacy_chunk','retrieval_unit','summary_node','context_unit_optional')),
        target_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        UNIQUE(build_id, target_type, target_id)
      );
      CREATE TABLE IF NOT EXISTS document_tree_nodes (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        node_type TEXT NOT NULL,
        parent_id TEXT,
        children_ids_json TEXT NOT NULL DEFAULT '[]',
        ordinal INTEGER NOT NULL,
        level INTEGER NOT NULL,
        heading_path_json TEXT NOT NULL DEFAULT '[]',
        text TEXT NOT NULL,
        summary TEXT NOT NULL,
        prev_id TEXT,
        next_id TEXT,
        source_chunk_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS parent_child_chunks (
        child_chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        parent_chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        document_tree_node_id TEXT NOT NULL REFERENCES document_tree_nodes(id) ON DELETE CASCADE,
        child_text TEXT NOT NULL,
        parent_text TEXT NOT NULL,
        child_ordinal INTEGER NOT NULL,
        parent_ordinal INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS summary_tree_nodes (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        source_node_ids_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL,
        embedding_id TEXT,
        parent_summary_id TEXT,
        child_summary_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS summary_embeddings (
        summary_id TEXT PRIMARY KEY REFERENCES summary_tree_nodes(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
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
      CREATE TABLE IF NOT EXISTS aori_documents (
        version_id TEXT PRIMARY KEY REFERENCES document_versions(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        document_name TEXT NOT NULL,
        understanding_json TEXT NOT NULL,
        reflective_report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aori_aspects (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        central_question TEXT NOT NULL,
        item_ids_json TEXT NOT NULL DEFAULT '[]',
        relation_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS aori_aspect_items (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        aspect_id TEXT NOT NULL REFERENCES aori_aspects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_node_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_chunk_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS aori_aspect_relations (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        aspect_id TEXT NOT NULL REFERENCES aori_aspects(id) ON DELETE CASCADE,
        source_item_id TEXT NOT NULL REFERENCES aori_aspect_items(id) ON DELETE CASCADE,
        target_item_id TEXT NOT NULL REFERENCES aori_aspect_items(id) ON DELETE CASCADE,
        relation_name TEXT NOT NULL,
        base_relation TEXT NOT NULL CHECK (base_relation IN ('supports','contradicts','explains','depends_on','example_of','related_to')),
        relation_text_in_source TEXT,
        normalized_relation TEXT,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_chunk_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS aori_relation_lexicon (
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        relation_name TEXT NOT NULL,
        base_relation TEXT NOT NULL CHECK (base_relation IN ('supports','contradicts','explains','depends_on','example_of','related_to')),
        source_examples_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(version_id, relation_name)
      );
      CREATE TABLE IF NOT EXISTS aori_closure_reports (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        aspect_id TEXT REFERENCES aori_aspects(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('closed','open','partial')),
        item_count INTEGER NOT NULL,
        relation_count INTEGER NOT NULL,
        gaps_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aori_self_questions (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        answer TEXT,
        evidence_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('answered','gap','unchecked'))
      );
      CREATE TABLE IF NOT EXISTS aori_indexing_rationale (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        input_token_estimate INTEGER NOT NULL,
        used_token_estimate INTEGER NOT NULL,
        omitted_ranges_json TEXT NOT NULL DEFAULT '[]',
        preserved_ranges_json TEXT NOT NULL DEFAULT '[]',
        risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
        created_at TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_aori_documents_library ON aori_documents(library_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_aori_aspects_version ON aori_aspects(version_id);
      CREATE INDEX IF NOT EXISTS idx_aori_items_version ON aori_aspect_items(version_id);
      CREATE INDEX IF NOT EXISTS idx_aori_relations_version ON aori_aspect_relations(version_id);
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
        precheck_suggestions_json TEXT NOT NULL DEFAULT '[]',
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
      CREATE TABLE IF NOT EXISTS mapping_audits (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('clean','minor_issues','major_issues','failed')),
        summary TEXT NOT NULL,
        reconstruction TEXT NOT NULL,
        findings_json TEXT NOT NULL DEFAULT '[]',
        metrics_json TEXT,
        graph_rebuild_report TEXT NOT NULL DEFAULT '',
        graph_rebuilt_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mapping_audits_library ON mapping_audits(library_id, created_at DESC);
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
      CREATE TABLE IF NOT EXISTS abstract_node_aspect_contributions (
        node_id TEXT NOT NULL REFERENCES abstract_nodes(id) ON DELETE CASCADE,
        analyzed_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        aspects_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(node_id, analyzed_version_id)
      );
      CREATE TABLE IF NOT EXISTS pulses (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_pack_json TEXT,
        input_mode TEXT NOT NULL DEFAULT 'full' CHECK (input_mode IN ('full','progressive')),
        status TEXT NOT NULL CHECK (status IN ('unreviewed','correct','wrong')),
        reviewed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulse_hits (
        id TEXT PRIMARY KEY,
        pulse_id TEXT NOT NULL REFERENCES pulses(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('node','relation','chunk')),
        target_id TEXT NOT NULL,
        score REAL NOT NULL,
        reason TEXT NOT NULL,
        path_role TEXT NOT NULL CHECK (path_role IN ('direct','expanded','bridge')),
        step_index INTEGER,
        observation TEXT,
        rationale TEXT,
        label TEXT NOT NULL,
        excerpt TEXT
      );
      CREATE TABLE IF NOT EXISTS pulse_traces (
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('node','relation')),
        target_id TEXT NOT NULL,
        correct_count INTEGER NOT NULL DEFAULT 0,
        wrong_count INTEGER NOT NULL DEFAULT 0,
        last_correct_at TEXT,
        last_wrong_at TEXT,
        PRIMARY KEY(library_id, target_type, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_links_version ON source_links(version_id);
      CREATE INDEX IF NOT EXISTS idx_statements_library_status ON analysis_statements(library_id, status);
      CREATE INDEX IF NOT EXISTS idx_abstraction_child ON abstraction_memberships(child_node_id);
      CREATE INDEX IF NOT EXISTS idx_aspect_contributions_version ON abstract_node_aspect_contributions(analyzed_version_id);
      CREATE INDEX IF NOT EXISTS idx_pulses_library_created ON pulses(library_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pulse_hits_pulse ON pulse_hits(pulse_id);
      CREATE INDEX IF NOT EXISTS idx_pulse_traces_library ON pulse_traces(library_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_document_tree_library ON document_tree_nodes(library_id, version_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_document_tree_parent ON document_tree_nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_summary_tree_version ON summary_tree_nodes(version_id);
      CREATE INDEX IF NOT EXISTS idx_summary_embeddings_library ON summary_embeddings(library_id);
      CREATE INDEX IF NOT EXISTS idx_index_builds_version_profile ON index_builds(version_id, profile, status);
      CREATE INDEX IF NOT EXISTS idx_context_units_build ON context_units(build_id, version_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_context_units_source ON context_units(primary_source_node_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_units_build ON retrieval_units(build_id, version_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_retrieval_units_context ON retrieval_units(context_unit_id);
      CREATE INDEX IF NOT EXISTS idx_vector_records_target ON vector_records(library_id, build_id, target_type, dimensions);
    `);
    this.addColumn("libraries", "owner_user_id", "TEXT REFERENCES users(id) ON DELETE CASCADE");
    this.addColumn("chunks", "start_line", "INTEGER");
    this.addColumn("chunks", "end_line", "INTEGER");
    this.addColumn("chunks", "block_id", "TEXT");
    this.addColumn("chunks", "aspects_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("chunks", "parent_chunk_id", "TEXT REFERENCES chunks(id) ON DELETE SET NULL");
    this.addColumn("chunks", "document_tree_node_id", "TEXT");
    this.addColumn("chunks", "child_ordinal", "INTEGER");
    this.addColumn("chunks", "parent_ordinal", "INTEGER");
    this.addColumn("chunks", "node_type", "TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_chunks_tree_node ON chunks(document_tree_node_id)");
    this.addColumn("abstract_nodes", "level", "INTEGER NOT NULL DEFAULT 1");
    this.addColumn("abstract_nodes", "aspects_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("abstract_nodes", "manual_aspects_json", "TEXT");
    this.addColumn("analysis_statements", "invalidated_reason", "TEXT");
    this.addColumn("analysis_statements", "invalidated_at", "TEXT");
    this.addColumn("analysis_statements", "precheck_status", "TEXT NOT NULL DEFAULT 'not_checked'");
    this.addColumn("analysis_statements", "precheck_reason", "TEXT");
    this.addColumn("analysis_statements", "precheck_suggestions_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("analysis_statements", "precheck_checked_at", "TEXT");
    this.addColumn("analysis_statements", "precheck_content_updated_at", "TEXT");
    this.addColumn("pulses", "input_mode", "TEXT NOT NULL DEFAULT 'full'");
    this.addColumn("pulses", "evidence_pack_json", "TEXT");
    this.addColumn("document_versions", "index_schema_version", "INTEGER NOT NULL DEFAULT 1");
    this.addColumn("document_versions", "latest_ready_v1_build_id", "TEXT");
    this.addColumn("document_versions", "latest_ready_v2_build_id", "TEXT");
    this.addColumn("document_versions", "active_index_profile", "TEXT NOT NULL DEFAULT 'v1'");
    this.addColumn("document_versions", "index_warnings_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("document_versions", "index_strategy", "TEXT NOT NULL DEFAULT 'bottom_up_evidence'");
    this.addColumn("document_versions", "record_indexing_rationale", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("ingest_jobs", "index_strategy", "TEXT NOT NULL DEFAULT 'bottom_up_evidence'");
    this.addColumn("ingest_jobs", "record_indexing_rationale", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("pulse_hits", "step_index", "INTEGER");
    this.addColumn("pulse_hits", "observation", "TEXT");
    this.addColumn("pulse_hits", "rationale", "TEXT");
    this.addColumn("mapping_audits", "metrics_json", "TEXT");
    this.addColumn("mapping_audits", "graph_rebuild_report", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("mapping_audits", "graph_rebuilt_at", "TEXT");
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)").run(now());
    if (!row(this.sql.prepare("SELECT version FROM schema_migrations WHERE version = 6"))) {
      this.sql.prepare(`
        INSERT OR IGNORE INTO abstract_node_aspect_contributions (node_id, analyzed_version_id, aspects_json)
        SELECT DISTINCT n.id, c.version_id, n.aspects_json
        FROM abstract_nodes n
        JOIN abstract_node_evidence e ON e.node_id = n.id
        JOIN chunks c ON c.id = e.chunk_id
        WHERE n.aspects_json IS NOT NULL AND n.aspects_json != '[]'
      `).run();
      this.sql.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)").run(now());
    }
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)").run(now());
    this.sql.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (9, ?)").run(now());
  }

  private addColumn(table: string, column: string, definition: string): void {
    const columns = rows(this.sql.prepare(`PRAGMA table_info(${table})`));
    if (!columns.some((entry) => String(entry.name) === column)) {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createUser(username: string, password: string): AuthUser {
    const trimmed = username.trim();
    const existing = row(this.sql.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE"), trimmed);
    if (existing) throw new Error("用户名已存在");
    const id = randomUUID();
    const timestamp = now();
    this.sql.prepare(`
      INSERT INTO users (id, username, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, trimmed, hashPassword(password), timestamp, timestamp);
    return { id, username: trimmed, createdAt: timestamp };
  }

  verifyUser(username: string, password: string): AuthUser | undefined {
    const result = row(this.sql.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"), username.trim());
    if (!result || !verifyPassword(password, String(result.password_hash))) return undefined;
    return authUserFrom(result);
  }

  createSession(userId: string, days: number): string {
    const token = randomBytes(32).toString("base64url");
    const timestamp = now();
    this.sql.prepare(`
      INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(tokenHash(token), userId, timestamp, sessionExpiry(days));
    return token;
  }

  getUserForSession(token: string | undefined): AuthUser | undefined {
    if (!token) return undefined;
    const result = row(
      this.sql.prepare(`
        SELECT u.*
        FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
      `),
      tokenHash(token),
      now(),
    );
    return result ? authUserFrom(result) : undefined;
  }

  deleteSession(token: string | undefined): void {
    if (!token) return;
    this.sql.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  listLibraries(ownerUserId?: string): Library[] {
    if (ownerUserId) {
      return rows(
        this.sql.prepare("SELECT * FROM libraries WHERE owner_user_id = ? ORDER BY updated_at DESC"),
        ownerUserId,
      ).map(libraryFrom);
    }
    return rows(this.sql.prepare("SELECT * FROM libraries ORDER BY updated_at DESC")).map(libraryFrom);
  }

  getLibrary(id: string): Library | undefined {
    const result = row(this.sql.prepare("SELECT * FROM libraries WHERE id = ?"), id);
    return result ? libraryFrom(result) : undefined;
  }

  getLibraryOwnerUserId(id: string): string | null | undefined {
    const result = row(this.sql.prepare("SELECT owner_user_id FROM libraries WHERE id = ?"), id);
    if (!result) return undefined;
    return result.owner_user_id === null ? null : String(result.owner_user_id);
  }

  getLibraryIdForNode(nodeId: string): string | undefined {
    const result = row(this.sql.prepare("SELECT library_id FROM abstract_nodes WHERE id = ?"), nodeId);
    return result ? String(result.library_id) : undefined;
  }

  getLibraryIdForRelation(relationId: string): string | undefined {
    const result = row(this.sql.prepare("SELECT library_id FROM relations WHERE id = ?"), relationId);
    return result ? String(result.library_id) : undefined;
  }

  getLibraryIdForStatement(statementId: string): string | undefined {
    const result = row(this.sql.prepare("SELECT library_id FROM analysis_statements WHERE id = ?"), statementId);
    return result ? String(result.library_id) : undefined;
  }

  getLibraryIdForChunk(chunkId: string): string | undefined {
    const result = row(this.sql.prepare("SELECT library_id FROM chunks WHERE id = ?"), chunkId);
    return result ? String(result.library_id) : undefined;
  }

  createLibrary(name: string, ownerUserId?: string): Library {
    const id = randomUUID();
    const timestamp = now();
    this.sql.prepare(
      "INSERT INTO libraries (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, name, ownerUserId ?? null, timestamp, timestamp);
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
    options: { indexStrategy?: IndexStrategy; recordIndexingRationale?: boolean } = {},
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
    const indexStrategy = normalizeIndexStrategy(options.indexStrategy);
    const recordIndexingRationale = Boolean(options.recordIndexingRationale);
    this.sql.prepare(
      `INSERT INTO document_versions
        (id, document_id, content_hash, storage_path, status, index_strategy, record_indexing_rationale, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(id, documentId, hash, storagePath, indexStrategy, recordIndexingRationale ? 1 : 0, timestamp);
    return {
      version: {
        id,
        documentId,
        contentHash: hash,
        storagePath,
        status: "queued",
        indexStrategy,
        recordIndexingRationale,
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
      indexStrategy: normalizeIndexStrategy(r.index_strategy),
      recordIndexingRationale: sqliteBoolean(r.record_indexing_rationale),
      indexSchemaVersion: Number(r.index_schema_version ?? 1) === 2 ? 2 : 1,
      latestReadyV1BuildId: r.latest_ready_v1_build_id === null || r.latest_ready_v1_build_id === undefined ? null : String(r.latest_ready_v1_build_id),
      latestReadyV2BuildId: r.latest_ready_v2_build_id === null || r.latest_ready_v2_build_id === undefined ? null : String(r.latest_ready_v2_build_id),
      activeIndexProfile: String(r.active_index_profile ?? "v1") === "v2" ? "v2" : "v1",
      indexWarnings: parseTextList(r.index_warnings_json),
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
          v.storage_path AS v_path, v.status AS v_status, v.index_strategy AS v_index_strategy,
          v.record_indexing_rationale AS v_record_indexing_rationale,
          v.index_schema_version AS v_index_schema_version,
          v.latest_ready_v1_build_id AS v_latest_ready_v1_build_id,
          v.latest_ready_v2_build_id AS v_latest_ready_v2_build_id,
          v.active_index_profile AS v_active_index_profile,
          v.index_warnings_json AS v_index_warnings_json,
          v.created_at AS v_created
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
          indexStrategy: normalizeIndexStrategy(result.v_index_strategy),
          recordIndexingRationale: sqliteBoolean(result.v_record_indexing_rationale),
          indexSchemaVersion: Number(result.v_index_schema_version ?? 1) === 2 ? 2 : 1,
          latestReadyV1BuildId: result.v_latest_ready_v1_build_id === null || result.v_latest_ready_v1_build_id === undefined ? null : String(result.v_latest_ready_v1_build_id),
          latestReadyV2BuildId: result.v_latest_ready_v2_build_id === null || result.v_latest_ready_v2_build_id === undefined ? null : String(result.v_latest_ready_v2_build_id),
          activeIndexProfile: String(result.v_active_index_profile ?? "v1") === "v2" ? "v2" : "v1",
          indexWarnings: parseTextList(result.v_index_warnings_json),
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

  getMappingAuditContext(versionId: string): MappingAuditContext | undefined {
    const source = this.getVersionSource(versionId);
    if (!source) return undefined;
    const chunks = rows(
      this.sql.prepare("SELECT * FROM chunks WHERE version_id = ? ORDER BY ordinal"),
      versionId,
    ).map(chunkFrom);
    const nodeRows = rows(
      this.sql.prepare(`
        SELECT DISTINCT n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
        FROM abstract_nodes n
        JOIN abstract_node_evidence e ON e.node_id = n.id
        JOIN chunks c ON c.id = e.chunk_id
        WHERE n.library_id = ? AND n.source = 'ai' AND c.version_id = ?
        ORDER BY n.level, n.updated_at DESC
      `),
      source.libraryId,
      versionId,
    );
    const nodes: MappingAuditNodeContext[] = nodeRows.map((entry) => {
      const node = nodeFrom(entry);
      const evidenceChunkIds = rows(
        this.sql.prepare(`
          SELECT e.chunk_id FROM abstract_node_evidence e
          JOIN chunks c ON c.id = e.chunk_id
          WHERE e.node_id = ? AND c.version_id = ?
          ORDER BY c.ordinal
        `),
        node.id,
        versionId,
      ).map((result) => String(result.chunk_id));
      return {
        id: node.id,
        kind: node.kind,
        title: node.title,
        summary: node.summary,
        level: node.level,
        evidenceChunkIds,
      };
    });

    const versionNodeIds = nodes.map((node) => node.id);
    const relationConditions = ["rc.version_id = ?"];
    const relationParams: unknown[] = [source.libraryId, versionId];
    if (versionNodeIds.length > 0) {
      const placeholders = versionNodeIds.map(() => "?").join(",");
      relationConditions.push(`r.source_node_id IN (${placeholders}) OR r.target_node_id IN (${placeholders})`);
      relationParams.push(...versionNodeIds, ...versionNodeIds);
    }
    const relationRows = rows(
      this.sql.prepare(`
        SELECT DISTINCT r.*
        FROM relations r
        LEFT JOIN relation_evidence re ON re.relation_id = r.id
        LEFT JOIN chunks rc ON rc.id = re.chunk_id
        WHERE r.library_id = ? AND r.created_by = 'ai' AND r.status != 'rejected'
          AND (${relationConditions.join(" OR ")})
        ORDER BY r.updated_at DESC
      `),
      ...relationParams,
    );
    const endpointIds = [...new Set(relationRows.flatMap((entry) => [String(entry.source_node_id), String(entry.target_node_id)]))];
    const endpointTitles = new Map<string, string>();
    if (endpointIds.length > 0) {
      const placeholders = endpointIds.map(() => "?").join(",");
      for (const entry of rows(
        this.sql.prepare(`SELECT id, title FROM abstract_nodes WHERE id IN (${placeholders})`),
        ...endpointIds,
      )) {
        endpointTitles.set(String(entry.id), String(entry.title));
      }
    }
    const relations: MappingAuditRelationContext[] = relationRows.map((entry) => {
      const relation = this.relationFrom(entry);
      const evidenceChunkIds = rows(
        this.sql.prepare(`
          SELECT re.chunk_id FROM relation_evidence re
          JOIN chunks c ON c.id = re.chunk_id
          WHERE re.relation_id = ? AND c.version_id = ?
          ORDER BY c.ordinal
        `),
        relation.id,
        versionId,
      ).map((result) => String(result.chunk_id));
      return {
        id: relation.id,
        type: relation.type,
        sourceNodeId: relation.sourceNodeId,
        sourceTitle: endpointTitles.get(relation.sourceNodeId) ?? "未知节点",
        targetNodeId: relation.targetNodeId,
        targetTitle: endpointTitles.get(relation.targetNodeId) ?? "未知节点",
        reason: relation.reason,
        confidence: relation.confidence,
        evidenceChunkIds,
      };
    });

    return {
      versionId,
      documentName: source.documentName,
      chunks,
      nodes,
      relations,
      note: "Only AI-generated nodes and non-rejected AI relations are included. User-created graph edits are excluded from mapping quality judgment.",
    };
  }

  saveMappingAudit(libraryId: string, versionId: string, result: MappingAuditResult): MappingAudit {
    const id = randomUUID();
    const createdAt = now();
    this.sql.prepare(`
      INSERT INTO mapping_audits
        (id, library_id, version_id, status, summary, reconstruction, findings_json, metrics_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version_id) DO UPDATE SET
        id = excluded.id,
        library_id = excluded.library_id,
        status = excluded.status,
        summary = excluded.summary,
        reconstruction = excluded.reconstruction,
        findings_json = excluded.findings_json,
        metrics_json = excluded.metrics_json,
        graph_rebuild_report = '',
        graph_rebuilt_at = NULL,
        created_at = excluded.created_at
    `).run(
      id,
      libraryId,
      versionId,
      result.status,
      result.summary,
      result.reconstruction,
      JSON.stringify(result.findings),
      result.metrics ? JSON.stringify(result.metrics) : null,
      createdAt,
    );
    return this.getMappingAudit(versionId) as MappingAudit;
  }

  saveMappingAuditGraphRebuildReport(versionId: string, report: string): MappingAudit {
    const rebuiltAt = now();
    this.sql.prepare(`
      UPDATE mapping_audits
      SET graph_rebuild_report = ?, graph_rebuilt_at = ?
      WHERE version_id = ?
    `).run(report, rebuiltAt, versionId);
    return this.getMappingAudit(versionId) as MappingAudit;
  }

  updateMappingAuditFindingComment(versionId: string, findingIndex: number, userComment: string): MappingAudit {
    const audit = this.getMappingAudit(versionId);
    if (!audit) throw new Error("尚未运行映射审计");
    if (!Number.isInteger(findingIndex) || findingIndex < 0 || findingIndex >= audit.findings.length) {
      throw new Error("审计发现不存在");
    }
    const findings = audit.findings.map((finding, index) => (
      index === findingIndex ? { ...finding, userComment } : finding
    ));
    this.sql.prepare(`
      UPDATE mapping_audits
      SET findings_json = ?, graph_rebuild_report = '', graph_rebuilt_at = NULL
      WHERE version_id = ?
    `).run(JSON.stringify(findings), versionId);
    return this.getMappingAudit(versionId) as MappingAudit;
  }

  getMappingAudit(versionId: string): MappingAudit | undefined {
    const result = row(this.sql.prepare("SELECT * FROM mapping_audits WHERE version_id = ?"), versionId);
    return result ? mappingAuditFrom(result) : undefined;
  }

  createJob(
    libraryId: string,
    versionId: string,
    options: { indexStrategy?: IndexStrategy; recordIndexingRationale?: boolean } = {},
  ): IngestJob {
    const version = this.getVersion(versionId);
    const indexStrategy = normalizeIndexStrategy(options.indexStrategy ?? version?.indexStrategy);
    const recordIndexingRationale = options.recordIndexingRationale ?? version?.recordIndexingRationale ?? false;
    const job: IngestJob = {
      id: randomUUID(),
      libraryId,
      versionId,
      indexStrategy,
      recordIndexingRationale,
      stage: "queued",
      progress: 0,
      error: null,
      attempts: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.sql.prepare(`
      INSERT INTO ingest_jobs
        (id, library_id, version_id, index_strategy, record_indexing_rationale, stage, progress, error, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.libraryId, job.versionId, job.indexStrategy, job.recordIndexingRationale ? 1 : 0, job.stage, job.progress, job.error,
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
      indexStrategy: normalizeIndexStrategy(result.index_strategy),
      recordIndexingRationale: sqliteBoolean(result.record_indexing_rationale),
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
        (id, library_id, version_id, parent_chunk_id, document_tree_node_id, child_ordinal, parent_ordinal, node_type,
          ordinal, heading_path, page_number, start_line, end_line, block_id, start_char, end_char, text, aspects_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.sql.prepare(
      "INSERT INTO chunks_fts (chunk_id, text, heading_path) VALUES (?, ?, ?)",
    );
    const result: Chunk[] = [];
    const localToChunk = new Map<string, Chunk>();
    const pendingByChunkId = new Map<string, PendingChunk & { localKey?: string; parentLocalKey?: string }>();
    for (const item of pending) {
      const chunk: Chunk = {
        id: randomUUID(),
        libraryId,
        versionId,
        ...item,
        startLine: item.startLine ?? null,
        endLine: item.endLine ?? null,
        blockId: item.blockId ?? null,
        parentChunkId: item.parentChunkId ?? null,
        documentTreeNodeId: item.documentTreeNodeId ?? null,
        childOrdinal: item.childOrdinal ?? null,
        parentOrdinal: item.parentOrdinal ?? null,
        nodeType: item.nodeType ?? null,
        aspects: [],
      };
      insert.run(
        chunk.id, libraryId, versionId, chunk.parentChunkId ?? null, chunk.documentTreeNodeId ?? null,
        chunk.childOrdinal ?? null, chunk.parentOrdinal ?? null, chunk.nodeType ?? null,
        chunk.ordinal, chunk.headingPath, chunk.pageNumber,
        chunk.startLine ?? null, chunk.endLine ?? null, chunk.blockId ?? null,
        chunk.startChar, chunk.endChar, chunk.text, JSON.stringify(chunk.aspects),
      );
      insertFts.run(chunk.id, chunk.text, chunk.headingPath ?? "");
      result.push(chunk);
      const localKey = (item as { localKey?: string }).localKey;
      if (localKey) localToChunk.set(localKey, chunk);
      pendingByChunkId.set(chunk.id, item as PendingChunk & { localKey?: string; parentLocalKey?: string });
    }
    const updateParent = this.sql.prepare("UPDATE chunks SET parent_chunk_id = ? WHERE id = ?");
    for (const chunk of result) {
      const item = pendingByChunkId.get(chunk.id);
      const parentLocalKey = item?.parentLocalKey;
      if (!parentLocalKey) continue;
      const parent = localToChunk.get(parentLocalKey);
      if (!parent) continue;
      updateParent.run(parent.id, chunk.id);
      chunk.parentChunkId = parent.id;
    }
    return result;
  }

  saveDocumentIndex(index: PendingDocumentIndex, chunks: Chunk[]): void {
    const chunkByLocalKey = new Map<string, Chunk>();
    for (const pending of index.chunks) {
      const chunk = chunks.find((candidate) => candidate.ordinal === pending.ordinal);
      if (chunk) chunkByLocalKey.set(pending.localKey, chunk);
    }
    const sourceIdsFor = (nodeId: string): string[] => {
      const localIds = index.chunks
        .filter((chunk) => chunk.documentTreeNodeId === nodeId)
        .flatMap((chunk) => chunkByLocalKey.get(chunk.localKey)?.id ?? []);
      return [...new Set(localIds)];
    };
    const insertNode = this.sql.prepare(`
      INSERT INTO document_tree_nodes
        (id, library_id, document_id, version_id, node_type, parent_id, children_ids_json, ordinal, level,
          heading_path_json, text, summary, prev_id, next_id, source_chunk_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const node of index.treeNodes) {
      insertNode.run(
        node.id,
        node.libraryId,
        node.documentId,
        node.versionId,
        node.nodeType,
        node.parentId,
        JSON.stringify(node.childrenIds),
        node.ordinal,
        node.level,
        JSON.stringify(node.headingPath),
        node.text,
        node.summary,
        node.prevId,
        node.nextId,
        JSON.stringify(sourceIdsFor(node.id)),
      );
    }
    const insertLink = this.sql.prepare(`
      INSERT OR REPLACE INTO parent_child_chunks
        (child_chunk_id, parent_chunk_id, document_tree_node_id, child_text, parent_text, child_ordinal, parent_ordinal)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const link of index.parentChildLinks) {
      const child = chunkByLocalKey.get(link.childLocalKey);
      const parent = chunkByLocalKey.get(link.parentLocalKey);
      if (!child || !parent) continue;
      insertLink.run(
        child.id,
        parent.id,
        link.documentTreeNodeId,
        child.text,
        parent.text,
        child.childOrdinal ?? child.ordinal,
        parent.ordinal,
      );
    }
    const insertSummary = this.sql.prepare(`
      INSERT INTO summary_tree_nodes
        (id, version_id, level, source_node_ids_json, summary, embedding_id, parent_summary_id, child_summary_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const summary of index.summaryNodes) {
      insertSummary.run(
        summary.id,
        summary.versionId,
        summary.level,
        JSON.stringify(summary.sourceNodeIds),
        summary.summary,
        summary.embeddingId ?? summary.id,
        summary.parentSummaryId,
        JSON.stringify(summary.childSummaryIds),
      );
    }
  }

  createIndexBuild(versionId: string, profile: "v1" | "v2", indexerVersion = "graphrag-v6"): IndexBuildRecord {
    const buildId = randomUUID();
    const timestamp = now();
    this.sql.prepare(`
      INSERT INTO index_builds
        (build_id, version_id, profile, status, started_at, indexer_version, schema_version)
      VALUES (?, ?, ?, 'building', ?, ?, ?)
    `).run(buildId, versionId, profile, timestamp, indexerVersion, profile === "v2" ? 2 : 1);
    return this.getIndexBuild(buildId) as IndexBuildRecord;
  }

  getIndexBuild(buildId: string): IndexBuildRecord | undefined {
    const result = row(this.sql.prepare("SELECT * FROM index_builds WHERE build_id = ?"), buildId);
    return result ? indexBuildFrom(result) : undefined;
  }

  listIndexBuilds(versionId: string): IndexBuildRecord[] {
    return rows(
      this.sql.prepare("SELECT * FROM index_builds WHERE version_id = ? ORDER BY started_at DESC LIMIT 20"),
      versionId,
    ).map(indexBuildFrom);
  }

  markStaleIndexBuildsAbandoned(olderThanMs = 60 * 60 * 1000): number {
    const threshold = new Date(Date.now() - olderThanMs).toISOString();
    return Number(this.sql.prepare(`
      UPDATE index_builds
      SET status = 'abandoned', finished_at = ?, error_message = COALESCE(error_message, 'Build abandoned during startup recovery.')
      WHERE status = 'building' AND started_at < ?
    `).run(now(), threshold).changes);
  }

  saveContextIndex(
    buildId: string,
    contextUnits: ContextUnit[],
    retrievalUnits: RetrievalUnit[],
    qualityReport: ContextUnitQualityReport,
    performanceReport: IndexingPerformanceReport,
  ): void {
    const build = this.getIndexBuild(buildId);
    if (!build) throw new Error("index build 不存在");
    if (build.status !== "building") throw new Error("只有 building 状态的 index build 可以写入");
    const insertContext = this.sql.prepare(`
      INSERT INTO context_units
        (id, stable_key, build_id, version_id, source_node_ids_json, primary_source_node_id, source_range_json,
          heading_path_json, display_heading_path_json, ordinal, ordinal_in_primary_source, text, blocks_json,
          retrieval_unit_ids_json, estimated_tokens, boundary_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRetrieval = this.sql.prepare(`
      INSERT INTO retrieval_units
        (id, stable_key, build_id, version_id, context_unit_id, text, heading_path_json, ordinal,
          start_char, end_char, start_line, end_line, page_number, estimated_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.sql.exec("BEGIN");
    try {
      this.sql.prepare("DELETE FROM retrieval_units WHERE build_id = ?").run(buildId);
      this.sql.prepare("DELETE FROM context_units WHERE build_id = ?").run(buildId);
      for (const unit of contextUnits) {
        insertContext.run(
          unit.id,
          unit.stableKey,
          unit.buildId,
          unit.versionId,
          JSON.stringify(unit.sourceNodeIds),
          unit.primarySourceNodeId ?? null,
          JSON.stringify(unit.sourceRange),
          JSON.stringify(unit.headingPath),
          JSON.stringify(unit.displayHeadingPath),
          unit.ordinal,
          unit.ordinalInPrimarySource ?? null,
          unit.text,
          JSON.stringify(unit.blocks),
          JSON.stringify(unit.retrievalUnitIds),
          unit.estimatedTokens ?? null,
          unit.boundaryReason,
        );
      }
      for (const unit of retrievalUnits) {
        insertRetrieval.run(
          unit.id,
          unit.stableKey,
          unit.buildId,
          unit.versionId,
          unit.contextUnitId,
          unit.text,
          JSON.stringify(unit.headingPath),
          unit.ordinal,
          unit.startChar ?? null,
          unit.endChar ?? null,
          unit.startLine ?? null,
          unit.endLine ?? null,
          unit.pageNumber ?? null,
          unit.estimatedTokens ?? null,
        );
      }
      this.sql.prepare(`
        UPDATE index_builds
        SET context_unit_count = ?, retrieval_unit_count = ?, quality_report_json = ?, performance_report_json = ?
        WHERE build_id = ?
      `).run(contextUnits.length, retrievalUnits.length, JSON.stringify(qualityReport), JSON.stringify(performanceReport), buildId);
      this.sql.exec("COMMIT");
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  markIndexBuildReady(buildId: string, counts: { vectorCount?: number; summaryVectorCount?: number } = {}): IndexBuildRecord {
    const build = this.getIndexBuild(buildId);
    if (build && build.status !== "building") throw new Error("Only building index builds can be marked ready.");
    if (!build) throw new Error("index build 不存在");
    const timestamp = now();
    this.sql.exec("BEGIN");
    try {
      this.sql.prepare(`
        UPDATE index_builds
        SET status = 'ready', finished_at = ?, vector_count = COALESCE(?, vector_count), summary_vector_count = COALESCE(?, summary_vector_count)
        WHERE build_id = ?
      `).run(timestamp, counts.vectorCount ?? null, counts.summaryVectorCount ?? null, buildId);
      if (build.profile === "v1") {
        this.sql.prepare(`
          UPDATE document_versions
          SET latest_ready_v1_build_id = ?, active_index_profile = CASE WHEN active_index_profile = 'v2' THEN active_index_profile ELSE 'v1' END
          WHERE id = ?
        `).run(buildId, build.versionId);
      } else {
        this.sql.prepare(`
          UPDATE document_versions
          SET latest_ready_v2_build_id = ?, index_schema_version = 2, active_index_profile = 'v2'
          WHERE id = ?
        `).run(buildId, build.versionId);
      }
      this.sql.exec("COMMIT");
      return this.getIndexBuild(buildId) as IndexBuildRecord;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  markIndexBuildFailed(buildId: string, error: unknown, status: "failed" | "partial" | "abandoned" = "failed"): IndexBuildRecord | undefined {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const build = this.getIndexBuild(buildId);
    this.sql.prepare(`
      UPDATE index_builds
      SET status = ?, finished_at = ?, error_message = ?, error_stack = ?
      WHERE build_id = ?
    `).run(status, now(), message, stack ?? null, buildId);
    if (build) {
      const version = this.getVersion(build.versionId);
      const warnings = [...new Set([...(version?.indexWarnings ?? []), `${build.profile} index build ${status}: ${message}`])];
      this.sql.prepare("UPDATE document_versions SET index_warnings_json = ? WHERE id = ?")
        .run(JSON.stringify(warnings), build.versionId);
    }
    return this.getIndexBuild(buildId);
  }

  getReadyContextUnits(versionId: string): ContextUnit[] {
    const buildId = this.getVersion(versionId)?.latestReadyV2BuildId;
    if (!buildId) return [];
    const build = this.getIndexBuild(buildId);
    if (build?.status !== "ready") return [];
    return rows(
      this.sql.prepare("SELECT * FROM context_units WHERE build_id = ? ORDER BY ordinal"),
      buildId,
    ).map(contextUnitFrom);
  }

  getReadyRetrievalUnits(versionId: string): RetrievalUnit[] {
    const buildId = this.getVersion(versionId)?.latestReadyV2BuildId;
    if (!buildId) return [];
    const build = this.getIndexBuild(buildId);
    if (build?.status !== "ready") return [];
    return rows(
      this.sql.prepare("SELECT * FROM retrieval_units WHERE build_id = ? ORDER BY ordinal"),
      buildId,
    ).map(retrievalUnitFrom);
  }

  getContextUnitsByIds(ids: string[]): ContextUnit[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return rows(
      this.sql.prepare(`SELECT * FROM context_units WHERE id IN (${placeholders}) ORDER BY ordinal`),
      ...ids,
    ).map(contextUnitFrom);
  }

  getRetrievalUnitsByIds(ids: string[]): RetrievalUnit[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return rows(
      this.sql.prepare(`SELECT * FROM retrieval_units WHERE id IN (${placeholders}) ORDER BY ordinal`),
      ...ids,
    ).map(retrievalUnitFrom);
  }

  getReadyContextUnitsForLibrary(libraryId: string): ContextUnit[] {
    return rows(
      this.sql.prepare(`
        SELECT cu.* FROM context_units cu
        JOIN document_versions v ON v.id = cu.version_id AND v.latest_ready_v2_build_id = cu.build_id
        JOIN index_builds b ON b.build_id = cu.build_id AND b.status = 'ready'
        JOIN documents d ON d.id = v.document_id
        WHERE d.library_id = ?
        ORDER BY v.created_at, cu.ordinal
      `),
      libraryId,
    ).map(contextUnitFrom);
  }

  getReadyRetrievalUnitsForLibrary(libraryId: string): RetrievalUnit[] {
    return rows(
      this.sql.prepare(`
        SELECT ru.* FROM retrieval_units ru
        JOIN document_versions v ON v.id = ru.version_id AND v.latest_ready_v2_build_id = ru.build_id
        JOIN index_builds b ON b.build_id = ru.build_id AND b.status = 'ready'
        JOIN documents d ON d.id = v.document_id
        WHERE d.library_id = ?
        ORDER BY v.created_at, ru.ordinal
      `),
      libraryId,
    ).map(retrievalUnitFrom);
  }

  searchRetrievalUnitsText(libraryId: string, query: string, limit = 12): Array<{ unit: RetrievalUnit; score: number }> {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return [];
    const tokens = searchTokens(query);
    const candidates = this.getReadyRetrievalUnitsForLibrary(libraryId);
    return candidates
      .map((unit) => {
        const text = normalizeSearchText(unit.text);
        const heading = normalizeSearchText(unit.headingPath.join(" / "));
        let score = text.includes(normalizedQuery) ? 0.55 : 0;
        if (heading.includes(normalizedQuery)) score += 0.35;
        if (tokens.length > 0) {
          const hits = tokens.filter((token) => text.includes(token) || heading.includes(token)).length;
          score += (hits / tokens.length) * 0.45;
        }
        return { unit, score: Math.min(1, score) };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.unit.ordinal - right.unit.ordinal)
      .slice(0, limit);
  }

  getContextUnitsBySourceNodeId(sourceNodeId: string): ContextUnit[] {
    return rows(
      this.sql.prepare(`
        SELECT cu.* FROM context_units cu
        JOIN index_builds b ON b.build_id = cu.build_id
        JOIN document_versions v ON v.latest_ready_v2_build_id = cu.build_id
        WHERE b.status = 'ready' AND (cu.primary_source_node_id = ? OR cu.source_node_ids_json LIKE ?)
        ORDER BY cu.ordinal
      `),
      sourceNodeId,
      `%"${sourceNodeId}"%`,
    ).map(contextUnitFrom);
  }

  getSourceNodesForContextUnit(contextUnitId: string): DocumentTreeNode[] {
    const unit = row(this.sql.prepare("SELECT source_node_ids_json FROM context_units WHERE id = ?"), contextUnitId);
    return this.getDocumentTreeNodesByIds(parseTextList(unit?.source_node_ids_json));
  }

  getIndexProfileStatus(versionId: string): IndexProfileStatus {
    const version = this.getVersion(versionId);
    const builds = this.listIndexBuilds(versionId);
    const latestV1 = version?.latestReadyV1BuildId ? this.getIndexBuild(version.latestReadyV1BuildId) : undefined;
    const latestV2 = version?.latestReadyV2BuildId ? this.getIndexBuild(version.latestReadyV2BuildId) : undefined;
    const latestStatus = (profile: "v1" | "v2", ready: IndexBuildRecord | undefined): IndexProfileStatus["v1"] => {
      if (ready?.status === "ready") return "ready";
      return builds.find((build) => build.profile === profile)?.status ?? "not_started";
    };
    const lastV2Error = builds.find((build) => build.profile === "v2" && build.errorMessage)?.errorMessage;
    return {
      v1: latestStatus("v1", latestV1),
      v2: latestStatus("v2", latestV2),
      activeProfile: version?.activeIndexProfile ?? "v1",
      latestReadyV1BuildId: version?.latestReadyV1BuildId ?? null,
      latestReadyV2BuildId: version?.latestReadyV2BuildId ?? null,
      warnings: version?.indexWarnings ?? [],
      lastV1BuildAt: builds.find((build) => build.profile === "v1")?.startedAt,
      lastV2BuildAt: builds.find((build) => build.profile === "v2")?.startedAt,
      ...(lastV2Error ? { lastV2Error } : {}),
    };
  }

  getV2IndexHealth(versionId: string): {
    status: IndexProfileStatus;
    buildId?: string | undefined;
    retrievalUnitCount: number;
    contextUnitCount: number;
    vectorCount: number;
    summaryVectorCount: number;
    qualityReport?: ContextUnitQualityReport | undefined;
    performanceReport?: IndexingPerformanceReport | undefined;
    buildHistory: Array<{ buildId: string; status: string; startedAt: string; finishedAt?: string | undefined; errorMessage?: string | undefined }>;
    warnings: string[];
  } {
    const status = this.getIndexProfileStatus(versionId);
    const build = status.latestReadyV2BuildId ? this.getIndexBuild(status.latestReadyV2BuildId) : undefined;
    return {
      status,
      ...(build ? { buildId: build.buildId } : {}),
      retrievalUnitCount: build?.retrievalUnitCount ?? 0,
      contextUnitCount: build?.contextUnitCount ?? 0,
      vectorCount: build?.vectorCount ?? 0,
      summaryVectorCount: build?.summaryVectorCount ?? 0,
      ...(build?.qualityReportJson ? { qualityReport: JSON.parse(build.qualityReportJson) as ContextUnitQualityReport } : {}),
      ...(build?.performanceReportJson ? { performanceReport: JSON.parse(build.performanceReportJson) as IndexingPerformanceReport } : {}),
      buildHistory: this.listIndexBuilds(versionId).map((entry) => ({
        buildId: entry.buildId,
        status: entry.status,
        startedAt: entry.startedAt,
        ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}),
        ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
      })),
      warnings: status.warnings,
    };
  }

  getIndexStatusReport(versionId: string): {
    versionId: string;
    activeIndexProfile: "v1" | "v2";
    latestReadyV1BuildId: string | null;
    latestReadyV2BuildId: string | null;
    chunkCount: number;
    contextUnitCount: number;
    retrievalUnitCount: number;
    chunkVectorCount: number;
    retrievalUnitVectorCount: number;
    summaryVectorCount: number;
    qualityReport?: ContextUnitQualityReport | undefined;
    warnings: string[];
  } {
    const version = this.getVersion(versionId);
    if (!version) throw new Error("导入版本不存在");
    const v2Health = this.getV2IndexHealth(versionId);
    const chunkCount = Number(row(this.sql.prepare("SELECT COUNT(*) AS count FROM chunks WHERE version_id = ?"), versionId)?.count ?? 0);
    const chunkVectorCount = Number(row(this.sql.prepare(`
      SELECT COUNT(*) AS count FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.version_id = ?
    `), versionId)?.count ?? 0);
    return {
      versionId,
      activeIndexProfile: version.activeIndexProfile ?? "v1",
      latestReadyV1BuildId: version.latestReadyV1BuildId ?? null,
      latestReadyV2BuildId: version.latestReadyV2BuildId ?? null,
      chunkCount,
      contextUnitCount: v2Health.contextUnitCount,
      retrievalUnitCount: v2Health.retrievalUnitCount,
      chunkVectorCount,
      retrievalUnitVectorCount: version.latestReadyV2BuildId ? this.countVectorRecords(version.latestReadyV2BuildId, "retrieval_unit") : 0,
      summaryVectorCount: version.latestReadyV2BuildId ? this.countVectorRecords(version.latestReadyV2BuildId, "summary_node") : 0,
      ...(v2Health.qualityReport ? { qualityReport: v2Health.qualityReport } : {}),
      warnings: v2Health.warnings,
    };
  }

  getDocumentTreeForVersion(versionId: string): DocumentTreeNode[] {
    return rows(
      this.sql.prepare("SELECT * FROM document_tree_nodes WHERE version_id = ? ORDER BY ordinal"),
      versionId,
    ).map(documentTreeNodeFrom);
  }

  getDocumentTreeForLibrary(libraryId: string): DocumentTreeNode[] {
    return rows(
      this.sql.prepare("SELECT * FROM document_tree_nodes WHERE library_id = ? ORDER BY version_id, ordinal"),
      libraryId,
    ).map(documentTreeNodeFrom);
  }

  getDocumentTreeNodesByIds(ids: string[]): DocumentTreeNode[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const order = new Map(ids.map((id, index) => [id, index]));
    return rows(this.sql.prepare(`SELECT * FROM document_tree_nodes WHERE id IN (${placeholders})`), ...ids)
      .map(documentTreeNodeFrom)
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  }

  searchDocumentTreeNodes(libraryId: string, query: string, limit = 20): DocumentTreeNode[] {
    const normalized = normalizeSearchText(query);
    if (!normalized) return [];
    const tokens = searchTokens(query).slice(0, 6);
    const likeTerms = [normalized, ...tokens];
    const filters = likeTerms.flatMap(() => ["text LIKE ?", "summary LIKE ?"]);
    const params = likeTerms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    return rows(
      this.sql.prepare(`
        SELECT * FROM document_tree_nodes
        WHERE library_id = ? AND (${filters.join(" OR ")})
        ORDER BY level, ordinal LIMIT ?
      `),
      libraryId,
      ...params,
      Math.max(1, Math.min(limit, 100)),
    ).map(documentTreeNodeFrom);
  }

  getSectionSubtree(sectionId: string): DocumentTreeNode[] {
    const root = row(this.sql.prepare("SELECT * FROM document_tree_nodes WHERE id = ?"), sectionId);
    if (!root) return [];
    const versionId = String(root.version_id);
    const all = this.getDocumentTreeForVersion(versionId);
    const byParent = new Map<string | null, DocumentTreeNode[]>();
    for (const node of all) {
      const group = byParent.get(node.parentId) ?? [];
      group.push(node);
      byParent.set(node.parentId, group);
    }
    const result: DocumentTreeNode[] = [];
    const visit = (node: DocumentTreeNode) => {
      result.push(node);
      for (const child of byParent.get(node.id) ?? []) visit(child);
    };
    visit(documentTreeNodeFrom(root));
    return result;
  }

  getSiblingTreeNodes(nodeId: string, window = 3): DocumentTreeNode[] {
    const node = row(this.sql.prepare("SELECT * FROM document_tree_nodes WHERE id = ?"), nodeId);
    if (!node) return [];
    return rows(
      this.sql.prepare(`
        SELECT * FROM document_tree_nodes
        WHERE version_id = ? AND parent_id IS ? AND ordinal BETWEEN ? AND ?
        ORDER BY ordinal
      `),
      String(node.version_id),
      node.parent_id,
      Number(node.ordinal) - Math.max(1, window),
      Number(node.ordinal) + Math.max(1, window),
    ).map(documentTreeNodeFrom);
  }

  getRemainingTreeNodesAfter(nodeId: string, limit = 24): DocumentTreeNode[] {
    const node = row(this.sql.prepare("SELECT * FROM document_tree_nodes WHERE id = ?"), nodeId);
    if (!node) return [];
    return rows(
      this.sql.prepare(`
        SELECT * FROM document_tree_nodes
        WHERE version_id = ? AND ordinal > ?
        ORDER BY ordinal LIMIT ?
      `),
      String(node.version_id),
      Number(node.ordinal),
      Math.max(1, Math.min(limit, 100)),
    ).map(documentTreeNodeFrom);
  }

  getParentChildChunks(childChunkIds: string[]): ParentChildChunk[] {
    if (childChunkIds.length === 0) return [];
    const placeholders = childChunkIds.map(() => "?").join(",");
    return rows(
      this.sql.prepare(`SELECT * FROM parent_child_chunks WHERE child_chunk_id IN (${placeholders})`),
      ...childChunkIds,
    ).map((entry) => ({
      childChunkId: String(entry.child_chunk_id),
      parentChunkId: String(entry.parent_chunk_id),
      documentTreeNodeId: String(entry.document_tree_node_id),
      childText: String(entry.child_text),
      parentText: String(entry.parent_text),
      childOrdinal: Number(entry.child_ordinal),
      parentOrdinal: Number(entry.parent_ordinal),
    }));
  }

  private clearAoriForVersion(versionId: string): void {
    this.sql.prepare("DELETE FROM aori_indexing_rationale WHERE version_id = ?").run(versionId);
    this.sql.prepare("DELETE FROM aori_self_questions WHERE version_id = ?").run(versionId);
    this.sql.prepare("DELETE FROM aori_closure_reports WHERE version_id = ?").run(versionId);
    this.sql.prepare("DELETE FROM aori_relation_lexicon WHERE version_id = ?").run(versionId);
    this.sql.prepare("DELETE FROM aori_aspect_relations WHERE version_id = ?").run(versionId);
    this.sql.prepare("DELETE FROM aori_aspect_items WHERE version_id = ?").run(versionId);
    this.sql.prepare("DELETE FROM aori_aspects WHERE version_id = ?").run(versionId);
    this.sql.prepare("DELETE FROM aori_documents WHERE version_id = ?").run(versionId);
  }

  saveAoriDocumentIndex(index: AoriDocumentIndex): void {
    const timestamp = index.createdAt || now();
    this.sql.exec("BEGIN");
    try {
      this.clearAoriForVersion(index.versionId);
      this.sql.prepare(`
        INSERT INTO aori_documents
          (version_id, library_id, document_id, document_name, understanding_json, reflective_report_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        index.versionId,
        index.libraryId,
        index.documentId,
        index.documentName,
        JSON.stringify(index.understanding),
        JSON.stringify(index.reflectiveReport),
        timestamp,
      );
      const insertAspect = this.sql.prepare(`
        INSERT INTO aori_aspects
          (id, version_id, title, summary, central_question, item_ids_json, relation_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertItem = this.sql.prepare(`
        INSERT INTO aori_aspect_items
          (id, version_id, aspect_id, title, summary, source_node_ids_json, evidence_chunk_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRelation = this.sql.prepare(`
        INSERT INTO aori_aspect_relations
          (id, version_id, aspect_id, source_item_id, target_item_id, relation_name, base_relation,
            relation_text_in_source, normalized_relation, reason, confidence, evidence_chunk_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertClosure = this.sql.prepare(`
        INSERT INTO aori_closure_reports
          (id, version_id, aspect_id, status, item_count, relation_count, gaps_json, warnings_json, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const aspect of index.aspects) {
        insertAspect.run(
          aspect.id,
          index.versionId,
          aspect.title,
          aspect.summary,
          aspect.centralQuestion,
          JSON.stringify(aspect.itemIds),
          JSON.stringify(aspect.relationIds),
        );
        for (const item of aspect.items) {
          insertItem.run(
            item.id,
            index.versionId,
            aspect.id,
            item.title,
            item.summary,
            JSON.stringify(item.sourceNodeIds),
            JSON.stringify(item.evidenceChunkIds),
          );
        }
        for (const relation of aspect.relations) {
          insertRelation.run(
            relation.id,
            index.versionId,
            aspect.id,
            relation.sourceItemId,
            relation.targetItemId,
            relation.relationName,
            relation.baseRelation,
            relation.relationTextInSource ?? null,
            relation.normalizedRelation ?? null,
            relation.reason,
            relation.confidence,
            JSON.stringify(relation.evidenceChunkIds),
          );
        }
        const report = aspect.closureReport;
        insertClosure.run(
          report.id,
          index.versionId,
          report.aspectId ?? aspect.id,
          report.status,
          report.itemCount,
          report.relationCount,
          JSON.stringify(report.gaps),
          JSON.stringify(report.warnings),
          report.checkedAt,
        );
      }
      const globalReports = index.closureReports.filter((report) => !report.aspectId);
      for (const report of globalReports) {
        insertClosure.run(
          report.id,
          index.versionId,
          null,
          report.status,
          report.itemCount,
          report.relationCount,
          JSON.stringify(report.gaps),
          JSON.stringify(report.warnings),
          report.checkedAt,
        );
      }
      const insertLexicon = this.sql.prepare(`
        INSERT INTO aori_relation_lexicon
          (version_id, relation_name, base_relation, source_examples_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const entry of index.relationLexicon.entries) {
        insertLexicon.run(index.versionId, entry.relationName, entry.baseRelation, JSON.stringify(entry.sourceExamples));
      }
      const insertQuestion = this.sql.prepare(`
        INSERT INTO aori_self_questions
          (id, version_id, question, answer, evidence_chunk_ids_json, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const question of index.selfQuestions) {
        insertQuestion.run(
          question.id,
          index.versionId,
          question.question,
          question.answer ?? null,
          JSON.stringify(question.evidenceChunkIds),
          question.status,
        );
      }
      const insertRationale = this.sql.prepare(`
        INSERT INTO aori_indexing_rationale
          (id, version_id, stage, decision_type, summary, input_token_estimate, used_token_estimate,
            omitted_ranges_json, preserved_ranges_json, risk, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const trace of index.rationaleTrace) {
        insertRationale.run(
          trace.id ?? randomUUID(),
          index.versionId,
          trace.stage,
          trace.decisionType,
          trace.summary,
          trace.inputTokenEstimate,
          trace.usedTokenEstimate,
          JSON.stringify(trace.omittedRanges),
          JSON.stringify(trace.preservedRanges),
          trace.risk,
          trace.createdAt ?? timestamp,
        );
      }
      this.sql.exec("COMMIT");
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  getAoriDocumentIndex(versionId: string): AoriDocumentResponse {
    const source = this.getVersionSource(versionId);
    if (!source) return { available: false, message: "导入版本不存在" };
    if (source.version.indexStrategy !== "aspect_oriented_reflective") {
      return { available: false, message: "该文档未使用切面式反思索引", indexStrategy: source.version.indexStrategy };
    }
    const doc = row(this.sql.prepare("SELECT * FROM aori_documents WHERE version_id = ?"), versionId);
    if (!doc) return { available: false, message: "AORI 产物尚未生成", indexStrategy: source.version.indexStrategy };

    const items = rows(this.sql.prepare("SELECT * FROM aori_aspect_items WHERE version_id = ?"), versionId)
      .map((entry): AspectItem => ({
        id: String(entry.id),
        versionId,
        aspectId: String(entry.aspect_id),
        title: String(entry.title),
        summary: String(entry.summary),
        sourceNodeIds: parseTextList(entry.source_node_ids_json),
        evidenceChunkIds: parseTextList(entry.evidence_chunk_ids_json),
      }));
    const relations = rows(this.sql.prepare("SELECT * FROM aori_aspect_relations WHERE version_id = ?"), versionId)
      .map((entry): AspectRelation => ({
        id: String(entry.id),
        versionId,
        aspectId: String(entry.aspect_id),
        sourceItemId: String(entry.source_item_id),
        targetItemId: String(entry.target_item_id),
        relationName: String(entry.relation_name),
        baseRelation: String(entry.base_relation) as RelationType,
        ...(entry.relation_text_in_source === null ? {} : { relationTextInSource: String(entry.relation_text_in_source) }),
        ...(entry.normalized_relation === null ? {} : { normalizedRelation: String(entry.normalized_relation) }),
        reason: String(entry.reason),
        confidence: Number(entry.confidence),
        evidenceChunkIds: parseTextList(entry.evidence_chunk_ids_json),
      }));
    const closureReports = rows(this.sql.prepare("SELECT * FROM aori_closure_reports WHERE version_id = ?"), versionId)
      .map((entry): ClosureReport => ({
        id: String(entry.id),
        versionId,
        aspectId: entry.aspect_id === null || entry.aspect_id === undefined ? null : String(entry.aspect_id),
        status: String(entry.status) as ClosureReport["status"],
        itemCount: Number(entry.item_count),
        relationCount: Number(entry.relation_count),
        gaps: parseJsonValue(entry.gaps_json, []),
        warnings: parseTextList(entry.warnings_json),
        checkedAt: String(entry.checked_at),
      }));
    const itemByAspect = new Map<string, AspectItem[]>();
    for (const item of items) {
      const group = itemByAspect.get(item.aspectId) ?? [];
      group.push(item);
      itemByAspect.set(item.aspectId, group);
    }
    const relationByAspect = new Map<string, AspectRelation[]>();
    for (const relation of relations) {
      const group = relationByAspect.get(relation.aspectId) ?? [];
      group.push(relation);
      relationByAspect.set(relation.aspectId, group);
    }
    const closureByAspect = new Map(closureReports.flatMap((report) => report.aspectId ? [[report.aspectId, report]] : []));
    const aspects = rows(this.sql.prepare("SELECT * FROM aori_aspects WHERE version_id = ? ORDER BY rowid"), versionId)
      .map((entry): Aspect => {
        const aspectItems = itemByAspect.get(String(entry.id)) ?? [];
        const aspectRelations = relationByAspect.get(String(entry.id)) ?? [];
        const closureReport = closureByAspect.get(String(entry.id)) ?? {
          id: `closure-missing-${String(entry.id)}`,
          versionId,
          aspectId: String(entry.id),
          status: "open" as const,
          itemCount: aspectItems.length,
          relationCount: aspectRelations.length,
          gaps: [],
          warnings: ["closure report missing"],
          checkedAt: String(doc.created_at),
        };
        return {
          id: String(entry.id),
          versionId,
          title: String(entry.title),
          summary: String(entry.summary),
          centralQuestion: String(entry.central_question),
          itemIds: parseTextList(entry.item_ids_json),
          relationIds: parseTextList(entry.relation_ids_json),
          items: aspectItems,
          relations: aspectRelations,
          closureReport,
        };
      });
    const relationLexicon: DocumentRelationLexicon = {
      versionId,
      entries: rows(this.sql.prepare("SELECT * FROM aori_relation_lexicon WHERE version_id = ? ORDER BY relation_name"), versionId)
        .map((entry) => ({
          relationName: String(entry.relation_name),
          baseRelation: String(entry.base_relation) as RelationType,
          sourceExamples: parseJsonValue(entry.source_examples_json, []),
        })),
    };
    const selfQuestions = rows(this.sql.prepare("SELECT * FROM aori_self_questions WHERE version_id = ? ORDER BY rowid"), versionId)
      .map((entry): SelfQuestion => ({
        id: String(entry.id),
        versionId,
        question: String(entry.question),
        ...(entry.answer === null || entry.answer === undefined ? {} : { answer: String(entry.answer) }),
        evidenceChunkIds: parseTextList(entry.evidence_chunk_ids_json),
        status: String(entry.status) as SelfQuestion["status"],
      }));
    const rationaleTrace = rows(this.sql.prepare("SELECT * FROM aori_indexing_rationale WHERE version_id = ? ORDER BY rowid"), versionId)
      .map((entry): IndexingRationaleTrace => ({
        id: String(entry.id),
        versionId,
        stage: String(entry.stage) as IndexingRationaleTrace["stage"],
        decisionType: String(entry.decision_type) as IndexingRationaleTrace["decisionType"],
        summary: String(entry.summary),
        inputTokenEstimate: Number(entry.input_token_estimate),
        usedTokenEstimate: Number(entry.used_token_estimate),
        omittedRanges: parseTextList(entry.omitted_ranges_json),
        preservedRanges: parseTextList(entry.preserved_ranges_json),
        risk: String(entry.risk) as IndexingRationaleTrace["risk"],
        createdAt: String(entry.created_at),
      }));

    return {
      available: true,
      versionId,
      libraryId: source.libraryId,
      documentId: source.documentId,
      documentName: source.documentName,
      createdAt: String(doc.created_at),
      understanding: parseJsonValue<DocumentUnderstanding>(doc.understanding_json, {
        versionId,
        summary: "",
        centralQuestion: "",
        evidenceChunkIds: [],
      }),
      aspects,
      relationLexicon,
      closureReports,
      selfQuestions,
      reflectiveReport: parseJsonValue<ReflectiveIndexReport>(doc.reflective_report_json, {
        summary: "",
        completenessRisk: "none",
        warnings: [],
        truncationCount: 0,
      }),
      rationaleTrace,
    };
  }

  listAoriDocumentIndexes(libraryId: string): AoriDocumentIndex[] {
    const versionIds = rows(
      this.sql.prepare("SELECT version_id FROM aori_documents WHERE library_id = ? ORDER BY created_at DESC"),
      libraryId,
    ).map((entry) => String(entry.version_id));
    return versionIds.flatMap((versionId) => {
      const result = this.getAoriDocumentIndex(versionId);
      return result.available ? [result] : [];
    });
  }

  private clearGeneratedForVersion(versionId: string): void {
    this.clearAoriForVersion(versionId);
    this.sql.prepare("DELETE FROM summary_embeddings WHERE summary_id IN (SELECT id FROM summary_tree_nodes WHERE version_id = ?)").run(versionId);
    this.sql.prepare("DELETE FROM summary_tree_nodes WHERE version_id = ?").run(versionId);
    this.sql.prepare("DELETE FROM parent_child_chunks WHERE child_chunk_id IN (SELECT id FROM chunks WHERE version_id = ?)").run(versionId);
    this.sql.prepare("DELETE FROM document_tree_nodes WHERE version_id = ?").run(versionId);
    const contributionNodes = rows(
      this.sql.prepare("SELECT node_id FROM abstract_node_aspect_contributions WHERE analyzed_version_id = ?"),
      versionId,
    ).map((entry) => String(entry.node_id));
    this.sql.prepare("DELETE FROM abstract_node_aspect_contributions WHERE analyzed_version_id = ?").run(versionId);
    this.refreshAiAspects(contributionNodes);
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
        AND manual_aspects_json IS NULL
        AND NOT EXISTS (SELECT 1 FROM abstract_node_evidence e WHERE e.node_id = abstract_nodes.id)
    `).run();
  }

  private mergeAspectContribution(nodeId: string, analyzedVersionId: string, aspects: AspectKind[]): void {
    const current = row(
      this.sql.prepare("SELECT aspects_json FROM abstract_node_aspect_contributions WHERE node_id = ? AND analyzed_version_id = ?"),
      nodeId,
      analyzedVersionId,
    );
    const merged = normalizeAspects([...parseAspects(current?.aspects_json), ...aspects]);
    this.sql.prepare(`
      INSERT INTO abstract_node_aspect_contributions (node_id, analyzed_version_id, aspects_json)
      VALUES (?, ?, ?)
      ON CONFLICT(node_id, analyzed_version_id) DO UPDATE SET aspects_json = excluded.aspects_json
    `).run(nodeId, analyzedVersionId, JSON.stringify(merged));
    this.refreshAiAspects([nodeId]);
  }

  private refreshAiAspects(nodeIds: Iterable<string>): void {
    const update = this.sql.prepare("UPDATE abstract_nodes SET aspects_json = ?, updated_at = ? WHERE id = ?");
    for (const nodeId of new Set(nodeIds)) {
      const aspects = normalizeAspects(
        rows(
          this.sql.prepare("SELECT aspects_json FROM abstract_node_aspect_contributions WHERE node_id = ?"),
          nodeId,
        ).flatMap((entry) => parseAspects(entry.aspects_json)),
      );
      update.run(JSON.stringify(aspects), now(), nodeId);
    }
  }

  private invalidateStatementsForVersion(versionId: string): void {
    const timestamp = now();
    this.sql.prepare(`
      UPDATE analysis_statements
      SET status = 'pending', invalidated_reason = '来源版本已重新分析，请重新核对引用',
        invalidated_at = ?, precheck_status = 'not_checked', precheck_reason = NULL, precheck_suggestions_json = '[]',
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
    const order = new Map(ids.map((id, index) => [id, index]));
    return rows(this.sql.prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`), ...ids)
      .map(chunkFrom)
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  }

  getNeighborChunks(chunkIds: string[], window: number): Chunk[] {
    if (chunkIds.length === 0) return [];
    const seeds = this.getChunksByIds(chunkIds);
    const seen = new Set<string>();
    const result: Chunk[] = [];
    const boundedWindow = Math.min(Math.max(Math.trunc(window), 0), 8);
    for (const seed of seeds) {
      for (const chunk of rows(
        this.sql.prepare(`
          SELECT * FROM chunks
          WHERE library_id = ? AND version_id = ? AND ordinal BETWEEN ? AND ?
          ORDER BY ordinal
        `),
        seed.libraryId,
        seed.versionId,
        Math.max(0, seed.ordinal - boundedWindow),
        seed.ordinal + boundedWindow,
      ).map(chunkFrom)) {
        if (seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        result.push(chunk);
      }
    }
    return result;
  }

  getSameSectionChunks(chunkIds: string[], limit = 30): Chunk[] {
    if (chunkIds.length === 0) return [];
    const seeds = this.getChunksByIds(chunkIds);
    const seen = new Set<string>();
    const result: Chunk[] = [];
    for (const seed of seeds) {
      const sectionLimit = Math.max(1, Math.min(limit, 80));
      const sectionRows = seed.headingPath
        ? rows(
          this.sql.prepare(`
            SELECT * FROM chunks
            WHERE library_id = ? AND version_id = ? AND heading_path = ?
            ORDER BY ordinal LIMIT ?
          `),
          seed.libraryId,
          seed.versionId,
          seed.headingPath,
          sectionLimit,
        )
        : rows(
          this.sql.prepare(`
            SELECT * FROM chunks
            WHERE library_id = ? AND version_id = ?
            ORDER BY ordinal LIMIT ?
          `),
          seed.libraryId,
          seed.versionId,
          sectionLimit,
        );
      for (const chunk of sectionRows.map(chunkFrom)) {
        if (seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        result.push(chunk);
      }
    }
    return result.slice(0, Math.max(1, Math.min(limit, 80)));
  }

  getRemainingChunksAfter(versionId: string, chunkId: string, limit = 12): Chunk[] {
    const seed = this.getChunk(chunkId);
    if (!seed || seed.versionId !== versionId) return [];
    return rows(
      this.sql.prepare(`
        SELECT * FROM chunks
        WHERE library_id = ? AND version_id = ? AND ordinal > ?
        ORDER BY ordinal LIMIT ?
      `),
      seed.libraryId,
      versionId,
      seed.ordinal,
      Math.max(1, Math.min(Math.trunc(limit), 80)),
    ).map(chunkFrom);
  }

  getDocumentOutlineForLibrary(libraryId: string, versionId?: string): Array<{
    versionId: string;
    documentName: string;
    headingPath: string | null;
    chunkCount: number;
    firstOrdinal: number;
    lastOrdinal: number;
  }> {
    const filters = ["c.library_id = ?"];
    const params: Array<string | number> = [libraryId];
    if (versionId) {
      filters.push("c.version_id = ?");
      params.push(versionId);
    }
    return rows(
      this.sql.prepare(`
        SELECT c.version_id, d.name AS document_name, c.heading_path,
          COUNT(*) AS chunk_count, MIN(c.ordinal) AS first_ordinal, MAX(c.ordinal) AS last_ordinal
        FROM chunks c
        JOIN document_versions v ON v.id = c.version_id
        JOIN documents d ON d.id = v.document_id
        WHERE ${filters.join(" AND ")}
        GROUP BY c.version_id, d.name, c.heading_path
        ORDER BY d.name, first_ordinal
        LIMIT 200
      `),
      ...params,
    ).map((entry) => ({
      versionId: String(entry.version_id),
      documentName: String(entry.document_name),
      headingPath: entry.heading_path === null ? null : String(entry.heading_path),
      chunkCount: Number(entry.chunk_count),
      firstOrdinal: Number(entry.first_ordinal),
      lastOrdinal: Number(entry.last_ordinal),
    }));
  }

  searchText(libraryId: string, query: string, limit: number): SearchResult[] {
    const match = query.split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    if (!match) return [];
    return rows(
      this.sql.prepare(`
        SELECT c.*, bm25(chunks_fts) AS rank
        FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
        WHERE chunks_fts MATCH ? AND c.library_id = ?
          AND (c.node_type IS NULL OR c.node_type IN ('paragraph','sentence','unknown'))
        ORDER BY rank LIMIT ?
      `),
      match,
      libraryId,
      limit,
    ).map((result) => ({ chunk: chunkFrom(result), score: -Number(result.rank) }));
  }

  searchChunksFuzzy(libraryId: string, query: string, limit: number): SearchResult[] {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return [];
    const tokens = searchTokens(query);
    const likeTerms = [normalizedQuery, ...tokens].slice(0, 6);
    const filters = likeTerms.flatMap(() => ["heading_path LIKE ?", "text LIKE ?"]);
    const params = likeTerms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    const candidates = rows(
      this.sql.prepare(`
        SELECT * FROM chunks
        WHERE library_id = ? AND (${filters.join(" OR ")})
          AND (node_type IS NULL OR node_type IN ('paragraph','sentence','unknown'))
        ORDER BY ordinal LIMIT ?
      `),
      libraryId,
      ...params,
      Math.max(limit * 6, 80),
    ).map(chunkFrom);
    return candidates
      .map((chunk) => ({ chunk, score: scoreChunkMatch(chunk, query) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal)
      .slice(0, limit);
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

  searchAbstractNodes(libraryId: string, query: string, limit: number): Array<{ node: AbstractNode; score: number; reason: string }> {
    const terms = query.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    return rows(
      this.sql.prepare(`
        SELECT n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
        FROM abstract_nodes n WHERE n.library_id = ? ORDER BY n.updated_at DESC LIMIT 400
      `),
      libraryId,
    ).flatMap((entry) => {
      const node = this.withNodeCitations(nodeFrom(entry));
      const title = node.title.normalize("NFKC").toLowerCase();
      const summary = node.summary.normalize("NFKC").toLowerCase();
      const titleMatches = terms.filter((term) => title.includes(term)).length;
      const summaryMatches = terms.filter((term) => summary.includes(term)).length;
      if (titleMatches + summaryMatches === 0) return [];
      const score = Math.min(1, titleMatches * 0.42 + summaryMatches * 0.18 + (title.includes(query.toLowerCase()) ? 0.2 : 0));
      return [{
        node,
        score: Math.max(score, titleMatches > 0 ? 0.72 : 0.55),
        reason: titleMatches > 0 ? "节点标题匹配问题关键词" : "节点摘要匹配问题关键词",
      }];
    }).sort((left, right) => right.score - left.score).slice(0, limit);
  }

  getNodesForChunks(libraryId: string, chunkIds: string[]): Map<string, AbstractNode[]> {
    const result = new Map<string, AbstractNode[]>();
    if (chunkIds.length === 0) return result;
    const placeholders = chunkIds.map(() => "?").join(",");
    for (const entry of rows(
      this.sql.prepare(`
        SELECT e.chunk_id, n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
        FROM abstract_node_evidence e
        JOIN abstract_nodes n ON n.id = e.node_id
        WHERE n.library_id = ? AND e.chunk_id IN (${placeholders})
      `),
      libraryId,
      ...chunkIds,
    )) {
      const chunkId = String(entry.chunk_id);
      const nodes = result.get(chunkId) ?? [];
      nodes.push(this.withNodeCitations(nodeFrom(entry)));
      result.set(chunkId, nodes);
    }
    return result;
  }

  listPulseRootNodes(libraryId: string, limit: number): AbstractNode[] {
    const themes = rows(
      this.sql.prepare(`
        SELECT n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
        FROM abstract_nodes n
        WHERE n.library_id = ? AND n.level = 2
        ORDER BY member_count DESC, n.updated_at DESC
        LIMIT ?
      `),
      libraryId,
      limit,
    ).map((entry) => this.withNodeCitations(nodeFrom(entry)));
    if (themes.length > 0) return themes;
    return rows(
      this.sql.prepare(`
        SELECT n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
        FROM abstract_nodes n
        WHERE n.library_id = ? AND n.level = 1
        ORDER BY n.updated_at DESC
        LIMIT ?
      `),
      libraryId,
      limit,
    ).map((entry) => this.withNodeCitations(nodeFrom(entry)));
  }

  getAbstractionChildren(parentNodeIds: string[]): Map<string, AbstractNode[]> {
    const result = new Map<string, AbstractNode[]>();
    if (parentNodeIds.length === 0) return result;
    const placeholders = parentNodeIds.map(() => "?").join(",");
    for (const entry of rows(
      this.sql.prepare(`
        SELECT m.parent_node_id, n.*, (SELECT COUNT(*) FROM abstraction_memberships child WHERE child.parent_node_id = n.id) AS member_count
        FROM abstraction_memberships m
        JOIN abstract_nodes n ON n.id = m.child_node_id
        WHERE m.parent_node_id IN (${placeholders})
        ORDER BY n.updated_at DESC
      `),
      ...parentNodeIds,
    )) {
      const parentId = String(entry.parent_node_id);
      const children = result.get(parentId) ?? [];
      children.push(this.withNodeCitations(nodeFrom(entry)));
      result.set(parentId, children);
    }
    return result;
  }

  getNodeEvidenceChunks(nodeId: string, limit: number): Chunk[] {
    return rows(
      this.sql.prepare(`
        SELECT c.* FROM abstract_node_evidence e
        JOIN chunks c ON c.id = e.chunk_id
        WHERE e.node_id = ?
        ORDER BY c.ordinal
        LIMIT ?
      `),
      nodeId,
      limit,
    ).map(chunkFrom);
  }

  getIncidentRelations(libraryId: string, nodeIds: string[]): Relation[] {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => "?").join(",");
    return rows(
      this.sql.prepare(`
        SELECT * FROM relations
        WHERE library_id = ? AND status != 'rejected'
          AND (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))
        ORDER BY updated_at DESC
      `),
      libraryId,
      ...nodeIds,
      ...nodeIds,
    ).map((entry) => this.relationFrom(entry));
  }

  saveEmbedding(chunkId: string, dimensions: number, embedding: Uint8Array): void {
    this.sql.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, dimensions, embedding) VALUES (?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding
    `).run(chunkId, dimensions, embedding);
    const chunk = this.getChunk(chunkId);
    if (chunk) {
      const buildId = this.getVersion(chunk.versionId)?.latestReadyV1BuildId ?? `legacy-v1:${chunk.versionId}`;
      this.saveVectorRecord(chunk.libraryId, chunk.versionId, buildId, 1, "legacy_chunk", chunk.id, dimensions, embedding);
    }
  }

  saveSummaryEmbedding(libraryId: string, summaryId: string, dimensions: number, embedding: Uint8Array): void {
    this.sql.prepare(`
      INSERT INTO summary_embeddings (summary_id, library_id, dimensions, embedding) VALUES (?, ?, ?, ?)
      ON CONFLICT(summary_id) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding
    `).run(summaryId, libraryId, dimensions, embedding);
    this.sql.prepare("UPDATE summary_tree_nodes SET embedding_id = ? WHERE id = ?").run(summaryId, summaryId);
  }

  saveVectorRecord(
    libraryId: string,
    versionId: string,
    buildId: string,
    indexSchemaVersion: 1 | 2,
    targetType: "legacy_chunk" | "retrieval_unit" | "summary_node" | "context_unit_optional",
    targetId: string,
    dimensions: number,
    embedding: Uint8Array,
  ): void {
    this.sql.prepare(`
      INSERT INTO vector_records
        (id, library_id, version_id, build_id, index_schema_version, target_type, target_id, dimensions, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(build_id, target_type, target_id) DO UPDATE SET
        dimensions = excluded.dimensions,
        embedding = excluded.embedding
    `).run(
      `${buildId}:${targetType}:${targetId}`,
      libraryId,
      versionId,
      buildId,
      indexSchemaVersion,
      targetType,
      targetId,
      dimensions,
      embedding,
    );
  }

  listVectorRecords(
    libraryId: string,
    buildId: string,
    targetType: "legacy_chunk" | "retrieval_unit" | "summary_node" | "context_unit_optional",
    dimensions: number,
  ): Array<{ targetId: string; embedding: Uint8Array }> {
    return rows(
      this.sql.prepare(`
        SELECT target_id, embedding FROM vector_records
        WHERE library_id = ? AND build_id = ? AND target_type = ? AND dimensions = ?
      `),
      libraryId,
      buildId,
      targetType,
      dimensions,
    ).map((result) => ({
      targetId: String(result.target_id),
      embedding: result.embedding as Uint8Array,
    }));
  }

  countVectorRecords(buildId: string, targetType?: "legacy_chunk" | "retrieval_unit" | "summary_node" | "context_unit_optional"): number {
    if (targetType) {
      return Number(row(
        this.sql.prepare("SELECT COUNT(*) AS count FROM vector_records WHERE build_id = ? AND target_type = ?"),
        buildId,
        targetType,
      )?.count ?? 0);
    }
    return Number(row(this.sql.prepare("SELECT COUNT(*) AS count FROM vector_records WHERE build_id = ?"), buildId)?.count ?? 0);
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
    return {
      ...node,
      citations: this.citationsForChunkIds(evidenceIds),
      evidenceNodeIds: this.treeNodeIdsForChunks(evidenceIds),
    };
  }

  private treeNodeIdsForChunks(chunkIds: string[]): string[] {
    if (chunkIds.length === 0) return [];
    const placeholders = chunkIds.map(() => "?").join(",");
    return [...new Set(rows(
      this.sql.prepare(`SELECT document_tree_node_id FROM chunks WHERE id IN (${placeholders}) AND document_tree_node_id IS NOT NULL`),
      ...chunkIds,
    ).map((entry) => String(entry.document_tree_node_id)))];
  }

  listEmbeddings(libraryId: string, dimensions: number): Array<{ chunk: Chunk; embedding: Uint8Array }> {
    return rows(
      this.sql.prepare(`
        SELECT c.*, e.embedding FROM chunk_embeddings e
        JOIN chunks c ON c.id = e.chunk_id
        WHERE c.library_id = ? AND e.dimensions = ?
          AND (c.node_type IS NULL OR c.node_type IN ('paragraph','sentence','unknown'))
      `),
      libraryId,
      dimensions,
    ).map((result) => ({
      chunk: chunkFrom(result),
      embedding: result.embedding as Uint8Array,
    }));
  }

  listSummaryEmbeddings(libraryId: string, dimensions: number): Array<{ summary: SummaryTreeNode; embedding: Uint8Array }> {
    return rows(
      this.sql.prepare(`
        SELECT s.*, e.embedding FROM summary_embeddings e
        JOIN summary_tree_nodes s ON s.id = e.summary_id
        WHERE e.library_id = ? AND e.dimensions = ?
      `),
      libraryId,
      dimensions,
    ).map((result) => ({
      summary: summaryTreeNodeFrom(result),
      embedding: result.embedding as Uint8Array,
    }));
  }

  getSummaryTreeForVersion(versionId: string): SummaryTreeNode[] {
    return rows(
      this.sql.prepare("SELECT * FROM summary_tree_nodes WHERE version_id = ? ORDER BY CASE level WHEN 'document' THEN 0 WHEN 'section' THEN 1 WHEN 'paragraph' THEN 2 ELSE 3 END, rowid"),
      versionId,
    ).map(summaryTreeNodeFrom);
  }

  getSummaryTreeForLibrary(libraryId: string): SummaryTreeNode[] {
    return rows(
      this.sql.prepare(`
        SELECT s.* FROM summary_tree_nodes s
        JOIN document_versions v ON v.id = s.version_id
        JOIN documents d ON d.id = v.document_id
        WHERE d.library_id = ?
        ORDER BY s.version_id, CASE s.level WHEN 'document' THEN 0 WHEN 'section' THEN 1 WHEN 'paragraph' THEN 2 ELSE 3 END, s.rowid
      `),
      libraryId,
    ).map(summaryTreeNodeFrom);
  }

  searchSummaryTree(libraryId: string, query: string, limit = 12): SummaryTreeNode[] {
    const normalized = normalizeSearchText(query);
    if (!normalized) return [];
    const tokens = searchTokens(query).slice(0, 6);
    const likeTerms = [normalized, ...tokens];
    const filters = likeTerms.map(() => "s.summary LIKE ?");
    const params = likeTerms.map((term) => `%${term}%`);
    return rows(
      this.sql.prepare(`
        SELECT s.* FROM summary_tree_nodes s
        JOIN document_versions v ON v.id = s.version_id
        JOIN documents d ON d.id = v.document_id
        WHERE d.library_id = ? AND (${filters.join(" OR ")})
        ORDER BY CASE s.level WHEN 'document' THEN 0 WHEN 'section' THEN 1 WHEN 'paragraph' THEN 2 ELSE 3 END
        LIMIT ?
      `),
      libraryId,
      ...params,
      Math.max(1, Math.min(limit, 50)),
    ).map(summaryTreeNodeFrom);
  }

  saveExtraction(
    libraryId: string,
    extraction: ExtractionOutput,
    analyzedVersionId?: string,
    options: { updateExistingAi?: boolean } = {},
  ): void {
    const keyToId = new Map<string, string>();
    const findNode = this.sql.prepare(
      "SELECT * FROM abstract_nodes WHERE library_id = ? AND kind = ? AND level = ? AND title = ? COLLATE NOCASE LIMIT 1",
    );
    const insertNode = this.sql.prepare(`
      INSERT INTO abstract_nodes (id, library_id, kind, title, summary, level, aspects_json, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)
    `);
    const updateAiNodeAspects = this.sql.prepare(
      "UPDATE abstract_nodes SET aspects_json = ?, updated_at = ? WHERE id = ?",
    );
    const updateAiNodeSummary = this.sql.prepare(
      "UPDATE abstract_nodes SET summary = ?, updated_at = ? WHERE id = ? AND source = 'ai'",
    );
    const getAiNodeAspects = this.sql.prepare("SELECT aspects_json FROM abstract_nodes WHERE id = ?");
    const saveAiAspects = (nodeId: string, aspects: AspectKind[]) => {
      if (analyzedVersionId) {
        this.mergeAspectContribution(nodeId, analyzedVersionId, aspects);
      } else {
        const current = row(getAiNodeAspects, nodeId);
        const merged = normalizeAspects([...parseAspects(current?.aspects_json), ...aspects]);
        updateAiNodeAspects.run(JSON.stringify(merged), now(), nodeId);
      }
    };
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
          JSON.stringify([]), timestamp, timestamp,
        );
      } else if (options.updateExistingAi) {
        updateAiNodeSummary.run(extracted.summary, now(), nodeId);
      }
      saveAiAspects(nodeId, extracted.aspects);
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
      if (existing && options.updateExistingAi) {
        this.sql.prepare("UPDATE relations SET reason = ?, confidence = ?, updated_at = ? WHERE id = ? AND created_by = 'ai' AND status = 'suggested'")
          .run(extracted.reason, extracted.confidence, now(), relationId);
      }
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
          JSON.stringify([]), timestamp, timestamp,
        );
      } else if (options.updateExistingAi) {
        updateAiNodeSummary.run(theme.summary, now(), themeId);
      }
      saveAiAspects(themeId, theme.aspects);
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

  addNodeEvidence(nodeId: string, chunkId: string): AbstractNode {
    const nodeLibraryId = this.getLibraryIdForNode(nodeId);
    const chunkLibraryId = this.getLibraryIdForChunk(chunkId);
    if (!nodeLibraryId) throw new Error("抽象节点不存在");
    if (!chunkLibraryId) throw new Error("证据 chunk 不存在");
    if (nodeLibraryId !== chunkLibraryId) throw new Error("证据 chunk 不属于当前知识库");
    this.sql.prepare("INSERT OR IGNORE INTO abstract_node_evidence (node_id, chunk_id) VALUES (?, ?)")
      .run(nodeId, chunkId);
    this.sql.prepare("UPDATE abstract_nodes SET updated_at = ? WHERE id = ?").run(now(), nodeId);
    return this.getAbstractNode(nodeId) as AbstractNode;
  }

  removeNodeEvidence(nodeId: string, chunkId: string): AbstractNode {
    const nodeLibraryId = this.getLibraryIdForNode(nodeId);
    if (!nodeLibraryId) throw new Error("抽象节点不存在");
    this.sql.prepare("DELETE FROM abstract_node_evidence WHERE node_id = ? AND chunk_id = ?").run(nodeId, chunkId);
    this.sql.prepare("UPDATE abstract_nodes SET updated_at = ? WHERE id = ?").run(now(), nodeId);
    return this.getAbstractNode(nodeId) as AbstractNode;
  }

  updateNodeAspects(id: string, aspects: AspectKind[]): AbstractNode {
    const existing = row(this.sql.prepare("SELECT id FROM abstract_nodes WHERE id = ?"), id);
    if (!existing) throw new Error("抽象节点不存在");
    this.sql.prepare("UPDATE abstract_nodes SET manual_aspects_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify([...new Set(aspects)]), now(), id);
    return this.getAbstractNode(id) as AbstractNode;
  }

  resetNodeAspects(id: string): AbstractNode {
    const existing = row(this.sql.prepare("SELECT id FROM abstract_nodes WHERE id = ?"), id);
    if (!existing) throw new Error("抽象节点不存在");
    this.sql.prepare("UPDATE abstract_nodes SET manual_aspects_json = NULL, updated_at = ? WHERE id = ?")
      .run(now(), id);
    return this.getAbstractNode(id) as AbstractNode;
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

  updateRelation(
    id: string,
    values: { status?: "accepted" | "rejected"; type?: RelationType; reason?: string; confidence?: number | null },
  ): Relation {
    const previous = this.getRelation(id);
    if (!previous) throw new Error("关系不存在");
    const next = {
      status: values.status ?? previous.status,
      type: values.type ?? previous.type,
      reason: values.reason ?? previous.reason,
      confidence: values.confidence !== undefined ? values.confidence : previous.confidence,
    };
    this.sql.prepare("UPDATE relations SET status = ?, type = ?, reason = ?, confidence = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.type, next.reason, next.confidence, now(), id);
    const statusChanged = values.status !== undefined && previous.status !== values.status;
    const contentChanged =
      (values.type !== undefined && previous.type !== values.type)
      || (values.reason !== undefined && previous.reason !== values.reason)
      || (values.confidence !== undefined && previous.confidence !== values.confidence);
    if (statusChanged || contentChanged) {
      this.invalidateStatementForRelation(
        id,
        statusChanged && next.status === "rejected" ? "上游关系已被拒绝" : "上游关系已被修改",
      );
    }
    return this.getRelation(id) as Relation;
  }

  updateRelationStatus(id: string, status: "accepted" | "rejected"): Relation {
    return this.updateRelation(id, { status });
  }

  addRelationEvidence(relationId: string, chunkId: string): Relation {
    const relationLibraryId = this.getLibraryIdForRelation(relationId);
    const chunkLibraryId = this.getLibraryIdForChunk(chunkId);
    if (!relationLibraryId) throw new Error("关系不存在");
    if (!chunkLibraryId) throw new Error("证据 chunk 不存在");
    if (relationLibraryId !== chunkLibraryId) throw new Error("证据 chunk 不属于当前知识库");
    this.sql.prepare("INSERT OR IGNORE INTO relation_evidence (relation_id, chunk_id) VALUES (?, ?)")
      .run(relationId, chunkId);
    this.sql.prepare("UPDATE relations SET updated_at = ? WHERE id = ?").run(now(), relationId);
    this.invalidateStatementForRelation(relationId, "关系证据已变更");
    return this.getRelation(relationId) as Relation;
  }

  removeRelationEvidence(relationId: string, chunkId: string): Relation {
    const relationLibraryId = this.getLibraryIdForRelation(relationId);
    if (!relationLibraryId) throw new Error("关系不存在");
    this.sql.prepare("DELETE FROM relation_evidence WHERE relation_id = ? AND chunk_id = ?").run(relationId, chunkId);
    this.sql.prepare("UPDATE relations SET updated_at = ? WHERE id = ?").run(now(), relationId);
    this.invalidateStatementForRelation(relationId, "关系证据已变更");
    return this.getRelation(relationId) as Relation;
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
      evidenceNodeIds: this.treeNodeIdsForChunks(evidence),
      citations: this.citationsForChunkIds(evidence),
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at),
    };
  }

  createPulse(
    libraryId: string,
    question: string,
    answer: string,
    summary: string,
    inputMode: PulseInputMode,
    hits: PendingPulseHit[],
    evidencePack?: EvidencePack,
  ): Pulse {
    const id = randomUUID();
    const timestamp = now();
    this.sql.exec("BEGIN");
    try {
      this.sql.prepare(`
        INSERT INTO pulses (id, library_id, question, answer, summary, evidence_pack_json, input_mode, status, reviewed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'unreviewed', NULL, ?)
      `).run(id, libraryId, question, answer, summary, evidencePack ? JSON.stringify(evidencePack) : null, inputMode, timestamp);
      const insertHit = this.sql.prepare(`
        INSERT INTO pulse_hits
          (id, pulse_id, library_id, target_type, target_id, score, reason, path_role, step_index, observation, rationale, label, excerpt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const hit of hits) {
        insertHit.run(
          randomUUID(), id, libraryId, hit.targetType, hit.targetId, hit.score,
          hit.reason, hit.pathRole, hit.stepIndex ?? null, hit.observation ?? null, hit.rationale ?? null,
          hit.label, hit.excerpt ?? null,
        );
      }
      this.sql.exec("COMMIT");
      return this.getPulse(id) as Pulse;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  listPulses(libraryId: string): Pulse[] {
    return rows(
      this.sql.prepare("SELECT * FROM pulses WHERE library_id = ? ORDER BY created_at DESC LIMIT 50"),
      libraryId,
    ).map(pulseFrom);
  }

  clearPulses(libraryId: string): number {
    const count = Number(row(this.sql.prepare("SELECT COUNT(*) AS count FROM pulses WHERE library_id = ?"), libraryId)?.count ?? 0);
    this.sql.exec("BEGIN");
    try {
      this.sql.prepare(`
        DELETE FROM pulse_hits
        WHERE pulse_id IN (SELECT id FROM pulses WHERE library_id = ?)
      `).run(libraryId);
      this.sql.prepare("DELETE FROM pulses WHERE library_id = ?").run(libraryId);
      this.sql.prepare("DELETE FROM pulse_traces WHERE library_id = ?").run(libraryId);
      this.sql.exec("COMMIT");
      return count;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  getPulse(id: string): Pulse | undefined {
    const result = row(this.sql.prepare("SELECT * FROM pulses WHERE id = ?"), id);
    return result ? pulseFrom(result) : undefined;
  }

  getPulseHits(pulseId: string): PulseHit[] {
    return rows(
      this.sql.prepare("SELECT * FROM pulse_hits WHERE pulse_id = ? ORDER BY score DESC, rowid"),
      pulseId,
    ).map(pulseHitFrom);
  }

  getPulseEvidencePack(pulseId: string): EvidencePack | undefined {
    const result = row(this.sql.prepare("SELECT evidence_pack_json FROM pulses WHERE id = ?"), pulseId);
    if (typeof result?.evidence_pack_json !== "string" || !result.evidence_pack_json.trim()) return undefined;
    try {
      return JSON.parse(result.evidence_pack_json) as EvidencePack;
    } catch {
      return undefined;
    }
  }

  getPulseResponse(libraryId: string, pulseId: string): PulseResponse | undefined {
    const pulse = this.getPulse(pulseId);
    if (!pulse || pulse.libraryId !== libraryId) return undefined;
    return {
      pulse,
      hits: this.getPulseHits(pulseId),
      graph: this.getGraph(libraryId, { pulseId, pulseStats: true }),
      ...(this.getPulseEvidencePack(pulseId) ? { evidencePack: this.getPulseEvidencePack(pulseId) } : {}),
    };
  }

  reviewPulse(id: string, status: "correct" | "wrong"): Pulse {
    const pulse = this.getPulse(id);
    if (!pulse) throw new Error("脉冲不存在");
    const reviewedAt = now();
    this.sql.exec("BEGIN");
    try {
      this.sql.prepare("UPDATE pulses SET status = ?, reviewed_at = ? WHERE id = ?").run(status, reviewedAt, id);
      const targets = rows(
        this.sql.prepare(`
          SELECT DISTINCT target_type, target_id FROM pulse_hits
          WHERE pulse_id = ? AND target_type IN ('node','relation')
        `),
        id,
      ).map((entry) => ({
        targetType: String(entry.target_type) as "node" | "relation",
        targetId: String(entry.target_id),
      }));
      for (const target of targets) this.refreshPulseTraceTarget(pulse.libraryId, target.targetType, target.targetId);
      this.sql.exec("COMMIT");
      return this.getPulse(id) as Pulse;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  private refreshPulseTraceTarget(libraryId: string, targetType: "node" | "relation", targetId: string): void {
    const correct = row(
      this.sql.prepare(`
        SELECT COUNT(DISTINCT p.id) AS count, MAX(p.reviewed_at) AS last_at
        FROM pulse_hits h JOIN pulses p ON p.id = h.pulse_id
        WHERE h.library_id = ? AND h.target_type = ? AND h.target_id = ? AND p.status = 'correct'
      `),
      libraryId,
      targetType,
      targetId,
    );
    const wrong = row(
      this.sql.prepare(`
        SELECT COUNT(DISTINCT p.id) AS count, MAX(p.reviewed_at) AS last_at
        FROM pulse_hits h JOIN pulses p ON p.id = h.pulse_id
        WHERE h.library_id = ? AND h.target_type = ? AND h.target_id = ? AND p.status = 'wrong'
      `),
      libraryId,
      targetType,
      targetId,
    );
    const correctCount = Number(correct?.count ?? 0);
    const wrongCount = Number(wrong?.count ?? 0);
    if (correctCount === 0 && wrongCount === 0) {
      this.sql.prepare("DELETE FROM pulse_traces WHERE library_id = ? AND target_type = ? AND target_id = ?")
        .run(libraryId, targetType, targetId);
      return;
    }
    this.sql.prepare(`
      INSERT INTO pulse_traces
        (library_id, target_type, target_id, correct_count, wrong_count, last_correct_at, last_wrong_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(library_id, target_type, target_id) DO UPDATE SET
        correct_count = excluded.correct_count,
        wrong_count = excluded.wrong_count,
        last_correct_at = excluded.last_correct_at,
        last_wrong_at = excluded.last_wrong_at
    `).run(
      libraryId, targetType, targetId, correctCount, wrongCount,
      correctCount > 0 && correct?.last_at !== null ? String(correct?.last_at) : null,
      wrongCount > 0 && wrong?.last_at !== null ? String(wrong?.last_at) : null,
    );
  }

  getGraph(
    libraryId: string,
    options: {
      centerId?: string;
      includeChunks?: boolean;
      status?: RelationStatus;
      type?: RelationType;
      limit?: number;
      view?: "detail" | "overview";
      aspect?: AspectKind;
      pulseId?: string;
      pulseStats?: boolean;
    },
  ): GraphResponse {
    if (options.view === "overview") {
      const graph = this.getOverviewGraph(libraryId, options);
      const focused = options.aspect ? this.focusGraph(libraryId, graph, options.aspect) : graph;
      return this.decorateGraphWithPulse(libraryId, focused, options);
    }
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
    const graph = { nodes: graphNodes, edges: graphEdges, truncated };
    const focused = options.aspect ? this.focusGraph(libraryId, graph, options.aspect) : graph;
    return this.decorateGraphWithPulse(libraryId, focused, options);
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

  private focusGraph(libraryId: string, graph: GraphResponse, aspect: AspectKind): GraphResponse {
    const abstractNodes = graph.nodes.filter((node) => node.nodeType === "abstract");
    const anyLabeled = rows(
      this.sql.prepare("SELECT aspects_json, manual_aspects_json FROM abstract_nodes WHERE library_id = ?"),
      libraryId,
    ).some((entry) => {
      const effective = entry.manual_aspects_json === null ? entry.aspects_json : entry.manual_aspects_json;
      return parseAspects(effective).length > 0;
    });
    const matches = new Set(
      abstractNodes.filter((node) => node.data.aspects.includes(aspect)).map((node) => node.id),
    );
    const retainedEdges = graph.edges.filter((edge) => matches.has(edge.source) || matches.has(edge.target));
    const adjacentMatches = new Map<string, Set<string>>();
    for (const edge of retainedEdges) {
      if (matches.has(edge.source) && !matches.has(edge.target)) {
        const linked = adjacentMatches.get(edge.target) ?? new Set<string>();
        linked.add(edge.source);
        adjacentMatches.set(edge.target, linked);
      }
      if (matches.has(edge.target) && !matches.has(edge.source)) {
        const linked = adjacentMatches.get(edge.source) ?? new Set<string>();
        linked.add(edge.target);
        adjacentMatches.set(edge.source, linked);
      }
    }
    const retainedIds = new Set(matches);
    for (const edge of retainedEdges) {
      retainedIds.add(edge.source);
      retainedIds.add(edge.target);
    }
    const nodes = graph.nodes.flatMap((node) => {
      if (!retainedIds.has(node.id)) return [];
      const focusRole: FocusRole = matches.has(node.id)
        ? "match"
        : (adjacentMatches.get(node.id)?.size ?? 0) > 1 ? "bridge" : "neighbor";
      return [{ ...node, focusRole }];
    });
    return {
      ...graph,
      nodes,
      edges: retainedEdges,
      aspectFilter: { selected: aspect, anyLabeled, matchCount: matches.size },
    };
  }

  private decorateGraphWithPulse(
    libraryId: string,
    graph: GraphResponse,
    options: { pulseId?: string; pulseStats?: boolean },
  ): GraphResponse {
    if (!options.pulseId && !options.pulseStats) return graph;
    const nodes = [...graph.nodes];
    const edges = [...graph.edges];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

    const addNode = (node: GraphNode) => {
      if (nodeById.has(node.id)) return;
      nodeById.set(node.id, node);
      nodes.push(node);
    };
    const addEdge = (edge: GraphEdge) => {
      if (edgeById.has(edge.id)) return;
      edgeById.set(edge.id, edge);
      edges.push(edge);
    };

    const pulseHits = options.pulseId ? this.getPulseHits(options.pulseId).filter((hit) => hit.libraryId === libraryId) : [];
    const hitByTarget = new Map<string, PulseHit>();
    for (const hit of pulseHits) {
      const key = `${hit.targetType}:${hit.targetId}`;
      const previous = hitByTarget.get(key);
      if (!previous || hit.score > previous.score) hitByTarget.set(key, hit);
    }

    if (pulseHits.length > 0) {
      for (const hit of pulseHits) {
        if (hit.targetType === "node") {
          const node = this.getAbstractNode(hit.targetId);
          if (node && node.libraryId === libraryId) addNode({ id: node.id, nodeType: "abstract", data: node });
        } else if (hit.targetType === "chunk") {
          const chunk = this.getChunk(hit.targetId);
          if (chunk && chunk.libraryId === libraryId) {
            addNode({ id: chunk.id, nodeType: "chunk", data: chunk });
            const linked = this.getNodesForChunks(libraryId, [chunk.id]).get(chunk.id) ?? [];
            for (const node of linked) {
              addNode({ id: node.id, nodeType: "abstract", data: node });
              addEdge({ id: `evidence:${node.id}:${chunk.id}`, source: node.id, target: chunk.id, edgeType: "evidence" });
            }
          }
        } else {
          const relation = this.getRelation(hit.targetId);
          if (relation && relation.libraryId === libraryId) {
            const source = this.getAbstractNode(relation.sourceNodeId);
            const target = this.getAbstractNode(relation.targetNodeId);
            if (source) addNode({ id: source.id, nodeType: "abstract", data: source });
            if (target) addNode({ id: target.id, nodeType: "abstract", data: target });
            const representedByAggregate = edges.some((edge) => edge.aggregate?.relationIds.includes(relation.id));
            if (!representedByAggregate) {
              addEdge({
                id: relation.id,
                source: relation.sourceNodeId,
                target: relation.targetNodeId,
                edgeType: "relation",
                relation,
              });
            }
          }
        }
      }
    }

    const abstractNodeIds = nodes.flatMap((node) => node.nodeType === "abstract" ? [node.id] : []);
    if (abstractNodeIds.length > 1) {
      const placeholders = abstractNodeIds.map(() => "?").join(",");
      for (const membership of rows(
        this.sql.prepare(`
          SELECT parent_node_id, child_node_id FROM abstraction_memberships
          WHERE parent_node_id IN (${placeholders}) AND child_node_id IN (${placeholders})
        `),
        ...abstractNodeIds,
        ...abstractNodeIds,
      )) {
        const parentId = String(membership.parent_node_id);
        const childId = String(membership.child_node_id);
        addEdge({
          id: `membership:${parentId}:${childId}`,
          source: parentId,
          target: childId,
          edgeType: "membership",
        });
      }
    }

    const traceRows = options.pulseStats
      ? rows(this.sql.prepare("SELECT * FROM pulse_traces WHERE library_id = ?"), libraryId)
      : [];
    const statsByTarget = new Map(traceRows.map((entry) => [`${String(entry.target_type)}:${String(entry.target_id)}`, pulseStatsFrom(entry)]));
    const decorateNode = (node: GraphNode): GraphNode => {
      const hit = hitByTarget.get(`${node.nodeType === "abstract" ? "node" : "chunk"}:${node.id}`);
      const stats = node.nodeType === "abstract" ? statsByTarget.get(`node:${node.id}`) : undefined;
      return {
        ...node,
        ...(hit ? { pulseScore: hit.score, pulseRole: hit.pathRole } : {}),
        ...(stats ? { pulseStats: stats } : {}),
      } as GraphNode;
    };
    const decorateEdge = (edge: GraphEdge): GraphEdge => {
      const relationIds = edge.aggregate?.relationIds ?? (edge.relation ? [edge.relation.id] : []);
      const hit = relationIds
        .map((relationId) => hitByTarget.get(`relation:${relationId}`))
        .filter((entry): entry is PulseHit => Boolean(entry))
        .sort((left, right) => right.score - left.score)[0];
      const stats = combinePulseStats(relationIds.map((relationId) => statsByTarget.get(`relation:${relationId}`)));
      return {
        ...edge,
        ...(hit ? { pulseScore: hit.score, pulseRole: hit.pathRole } : {}),
        ...(stats ? { pulseStats: stats } : {}),
      };
    };
    return {
      ...graph,
      nodes: nodes.map(decorateNode),
      edges: edges.map(decorateEdge),
    };
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
        precheck_suggestions_json = CASE WHEN ? THEN '[]' ELSE precheck_suggestions_json END,
        precheck_checked_at = CASE WHEN ? THEN NULL ELSE precheck_checked_at END,
        precheck_content_updated_at = CASE WHEN ? THEN NULL ELSE precheck_content_updated_at END
      WHERE id = ?
    `).run(
      nextText, nextStatus, timestamp,
      resetReview ? 1 : 0, resetReview ? 1 : 0, timestamp,
      resetReview ? 1 : 0, resetReview ? 1 : 0, resetReview ? 1 : 0, resetReview ? 1 : 0, resetReview ? 1 : 0,
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
        suggestions: parseTextList(result.precheck_suggestions_json),
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
      SET precheck_status = ?, precheck_reason = ?, precheck_suggestions_json = ?, precheck_checked_at = ?,
        precheck_content_updated_at = ?
      WHERE id = ?
    `).run(result.status, result.reason, JSON.stringify(result.suggestions), timestamp, statement.updatedAt, id);
    return this.getAnalysisStatement(id) as AnalysisStatement;
  }

  failStatementPrecheck(id: string, reason: string): AnalysisStatement {
    const statement = this.getAnalysisStatement(id);
    if (!statement) throw new Error("分析陈述不存在");
    this.sql.prepare(`
      UPDATE analysis_statements
      SET precheck_status = 'failed', precheck_reason = ?, precheck_suggestions_json = '[]', precheck_checked_at = ?,
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
        precheck_status = 'not_checked', precheck_reason = NULL, precheck_suggestions_json = '[]',
        precheck_checked_at = NULL, precheck_content_updated_at = NULL, updated_at = ?
      WHERE relation_id = ?
    `).run(reason, timestamp, timestamp, relationId);
  }

  getAbstractNode(id: string): AbstractNode | undefined {
    const result = row(this.sql.prepare(`
      SELECT n.*, (SELECT COUNT(*) FROM abstraction_memberships m WHERE m.parent_node_id = n.id) AS member_count
      FROM abstract_nodes n WHERE n.id = ?
    `), id);
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
