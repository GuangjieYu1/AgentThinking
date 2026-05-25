import { z } from "zod";

export const abstractNodeKinds = ["concept", "claim"] as const;
export const relationTypes = [
  "supports",
  "contradicts",
  "explains",
  "depends_on",
  "example_of",
  "related_to",
] as const;
export const relationStatuses = ["suggested", "accepted", "rejected", "manual"] as const;
export const jobStages = [
  "queued",
  "parsing",
  "ocr",
  "chunking",
  "embedding",
  "extracting",
  "indexing",
  "completed",
  "failed",
] as const;
export const ocrModes = ["local", "cloud"] as const;

export type AbstractNodeKind = (typeof abstractNodeKinds)[number];
export type RelationType = (typeof relationTypes)[number];
export type RelationStatus = (typeof relationStatuses)[number];
export type JobStage = (typeof jobStages)[number];
export type OcrMode = (typeof ocrModes)[number];

export interface Library {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface LibrarySettings {
  libraryId: string;
  ocrMode: OcrMode;
}

export interface Document {
  id: string;
  libraryId: string;
  name: string;
  mediaType: string;
  createdAt: string;
  latestVersion?: DocumentVersion;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  contentHash: string;
  storagePath: string;
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
}

export interface Chunk {
  id: string;
  libraryId: string;
  versionId: string;
  ordinal: number;
  headingPath: string | null;
  pageNumber: number | null;
  startLine: number | null;
  endLine: number | null;
  blockId: string | null;
  startChar: number;
  endChar: number;
  text: string;
}

export interface Citation {
  versionId: string;
  chunkId: string;
  documentName: string;
  mediaType: string;
  headingPath: string | null;
  pageNumber: number | null;
  startLine: number | null;
  endLine: number | null;
  blockId: string | null;
  excerpt: string;
}

export type SourceLinkType = "markdown" | "wiki" | "embed" | "block" | "logseq";

export interface SourceLink {
  id: string;
  versionId: string;
  type: SourceLinkType;
  raw: string;
  target: string;
  label: string | null;
  line: number;
  resolvedDocumentId: string | null;
}

export interface SourceMetadata {
  versionId: string;
  documentId: string;
  documentName: string;
  mediaType: string;
  title: string | null;
  frontmatterRaw: string | null;
  frontmatter: Record<string, string>;
  parsedAt: string;
}

export interface SourceStructure {
  metadata: SourceMetadata | null;
  links: SourceLink[];
  chunks: Chunk[];
}

export interface AbstractNode {
  id: string;
  libraryId: string;
  kind: AbstractNodeKind;
  title: string;
  summary: string;
  source: "ai" | "user";
  citations: Citation[];
  createdAt: string;
  updatedAt: string;
}

export interface Relation {
  id: string;
  libraryId: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: RelationType;
  status: RelationStatus;
  reason: string;
  confidence: number | null;
  createdBy: "ai" | "user";
  evidenceChunkIds: string[];
  citations: Citation[];
  createdAt: string;
  updatedAt: string;
}

export interface IngestJob {
  id: string;
  libraryId: string;
  versionId: string;
  stage: JobStage;
  progress: number;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export type GraphNode =
  | { id: string; nodeType: "abstract"; data: AbstractNode }
  | { id: string; nodeType: "chunk"; data: Chunk };

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: "relation" | "evidence";
  relation?: Relation;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
}

export interface PublishedAnalysis {
  libraryId: string;
  path: string;
  content: string;
  includedVersionIds: string[];
  publishedAt: string;
}

export interface ModelTestResult {
  ok: boolean;
  provider: string;
  message: string;
}

export type ModelStreamEvent =
  | { type: "start"; provider: string }
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export const createLibrarySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const updateLibrarySettingsSchema = z.object({
  ocrMode: z.enum(ocrModes),
});

export const updateAbstractNodeSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  summary: z.string().trim().max(2000).optional(),
});

export const createRelationSchema = z.object({
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  type: z.enum(relationTypes),
  reason: z.string().trim().min(1).max(1000),
});

export const updateRelationSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
});

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(30).default(10),
});

export const modelStreamSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
});

export const extractionSchema = z.object({
  nodes: z.array(
    z.object({
      key: z.string().min(1).max(80),
      kind: z.enum(abstractNodeKinds),
      title: z.string().trim().min(1).max(180),
      summary: z.string().trim().max(2000),
      evidenceChunkIds: z.array(z.string()).default([]),
    }),
  ),
  relations: z.array(
    z.object({
      sourceKey: z.string(),
      targetKey: z.string(),
      type: z.enum(relationTypes),
      reason: z.string().trim().min(1).max(1000),
      confidence: z.number().min(0).max(1),
      evidenceChunkIds: z.array(z.string()).default([]),
    }),
  ),
});

export type ExtractionOutput = z.infer<typeof extractionSchema>;
