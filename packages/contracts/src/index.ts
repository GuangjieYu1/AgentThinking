import { z } from "zod";

export const abstractNodeKinds = ["concept", "claim"] as const;
export const aspectKinds = ["person", "operation", "system", "story", "claim", "conflict", "time", "other"] as const;
export const relationTypes = [
  "supports",
  "contradicts",
  "explains",
  "depends_on",
  "example_of",
  "related_to",
] as const;
export const relationStatuses = ["suggested", "accepted", "rejected", "manual"] as const;
export const statementStatuses = ["pending", "approved", "rejected"] as const;
export const statementPrecheckStatuses = [
  "not_checked",
  "supported",
  "partially_supported",
  "unsupported",
  "failed",
] as const;
export const pulseStatuses = ["unreviewed", "correct", "wrong"] as const;
export const pulseHitTargetTypes = ["node", "relation", "chunk"] as const;
export const pulsePathRoles = ["direct", "expanded", "bridge"] as const;
export const pulseInputModes = ["full", "progressive"] as const;
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
export type AspectKind = (typeof aspectKinds)[number];
export type AspectSource = "ai" | "manual";
export type FocusRole = "match" | "neighbor" | "bridge";
export type AbstractionLevel = 1 | 2;
export type GraphView = "detail" | "overview";
export type RelationType = (typeof relationTypes)[number];
export type RelationStatus = (typeof relationStatuses)[number];
export type StatementStatus = (typeof statementStatuses)[number];
export type StatementPrecheckStatus = (typeof statementPrecheckStatuses)[number];
export type PulseStatus = (typeof pulseStatuses)[number];
export type PulseHitTargetType = (typeof pulseHitTargetTypes)[number];
export type PulsePathRole = (typeof pulsePathRoles)[number];
export type PulseInputMode = (typeof pulseInputModes)[number];
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
  aspects: AspectKind[];
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
  level: AbstractionLevel;
  aspects: AspectKind[];
  aspectSource: AspectSource;
  memberCount: number;
  source: "ai" | "user";
  citations: Citation[];
  createdAt: string;
  updatedAt: string;
}

export interface AbstractionMembership {
  parentNodeId: string;
  childNodeId: string;
  status: "suggested" | "manual";
  reason: string;
  createdBy: "ai" | "user";
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
  | {
    id: string;
    nodeType: "abstract";
    data: AbstractNode;
    focusRole?: FocusRole;
    pulseScore?: number;
    pulseRole?: PulsePathRole;
    pulseStats?: PulseStats;
  }
  | {
    id: string;
    nodeType: "chunk";
    data: Chunk;
    focusRole?: FocusRole;
    pulseScore?: number;
    pulseRole?: PulsePathRole;
    pulseStats?: PulseStats;
  };

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: "relation" | "evidence" | "membership";
  relation?: Relation;
  aggregate?: {
    type: RelationType;
    count: number;
    relationIds: string[];
  };
  pulseScore?: number;
  pulseRole?: PulsePathRole;
  pulseStats?: PulseStats;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  aspectFilter?: {
    selected: AspectKind;
    anyLabeled: boolean;
    matchCount: number;
  };
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
}

export interface Pulse {
  id: string;
  libraryId: string;
  question: string;
  answer: string;
  summary: string;
  inputMode: PulseInputMode;
  status: PulseStatus;
  createdAt: string;
  reviewedAt: string | null;
}

export interface PulseHit {
  id: string;
  pulseId: string;
  libraryId: string;
  targetType: PulseHitTargetType;
  targetId: string;
  score: number;
  reason: string;
  pathRole: PulsePathRole;
  stepIndex: number | null;
  observation: string | null;
  rationale: string | null;
  label: string;
  excerpt: string | null;
}

export interface PulseStats {
  correctCount: number;
  wrongCount: number;
  lastCorrectAt: string | null;
  lastWrongAt: string | null;
}

export interface PulseTrace extends PulseStats {
  libraryId: string;
  targetType: "node" | "relation";
  targetId: string;
}

export interface PulseResponse {
  pulse: Pulse;
  hits: PulseHit[];
  graph: GraphResponse;
}

export interface PulseAnswerContext {
  mode?: PulseInputMode;
  navigationTrace?: Array<{
    stepIndex: number;
    targetType: PulseHitTargetType;
    label: string;
    observation: string;
    rationale: string;
  }>;
  chunks: Array<{ id: string; text: string; score: number; headingPath: string | null; pageNumber: number | null }>;
  nodes: Array<{ id: string; title: string; summary: string; score: number }>;
  relations: Array<{ id: string; type: RelationType; sourceTitle: string; targetTitle: string; reason: string; score: number }>;
}

export interface PulseAnswerOutput {
  answer: string;
  summary: string;
}

export interface PulseNavigationCandidate {
  id: string;
  label: string;
  summary: string;
  score: number;
  relationLabel?: string;
  relationReason?: string;
}

export interface PulseNavigationDecision {
  selectedIds: string[];
  observation: string;
  rationale: string;
}

export interface PublishedAnalysis {
  libraryId: string;
  path: string;
  content: string;
  includedVersionIds: string[];
  publishedAt: string;
}

export interface StatementPrecheck {
  status: StatementPrecheckStatus;
  reason: string | null;
  suggestions: string[];
  checkedAt: string | null;
  contentUpdatedAt: string | null;
}

export interface AnalysisStatement {
  id: string;
  libraryId: string;
  relationId: string;
  text: string;
  status: StatementStatus;
  relationType: RelationType;
  citations: Citation[];
  invalidatedReason: string | null;
  invalidatedAt: string | null;
  precheck: StatementPrecheck;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisDraft {
  libraryId: string;
  statements: AnalysisStatement[];
  summary: {
    pending: number;
    approved: number;
    rejected: number;
    invalidated: number;
  };
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

export const updateNodeAspectsSchema = z.object({
  aspects: z.array(z.enum(aspectKinds)),
});
export type UpdateNodeAspectsInput = z.infer<typeof updateNodeAspectsSchema>;

export const createPulseSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  mode: z.enum(pulseInputModes).optional().default("full"),
});
export type CreatePulseInput = z.infer<typeof createPulseSchema>;

export const reviewPulseSchema = z.object({
  status: z.enum(["correct", "wrong"]),
});
export type ReviewPulseInput = z.infer<typeof reviewPulseSchema>;

export const createRelationSchema = z.object({
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  type: z.enum(relationTypes),
  reason: z.string().trim().min(1).max(1000),
});

export const updateRelationSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
});

export const updateAnalysisStatementSchema = z.object({
  text: z.string().trim().min(1).max(3000).optional(),
  status: z.enum(statementStatuses).optional(),
}).refine((body) => body.text !== undefined || body.status !== undefined, "没有可更新的内容");

export const addStatementEvidenceSchema = z.object({
  chunkId: z.string().min(1),
});

export const evidenceQuerySchema = z.object({
  q: z.string().trim().max(1000).optional().default(""),
  versionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(30).optional().default(15),
});

export const statementPrecheckSchema = z.object({
  status: z.enum(["supported", "partially_supported", "unsupported"]),
  reason: z.string().trim().min(1).max(1000),
  suggestions: z.array(z.string().trim().min(1).max(500)).max(5).default([]),
});

export type StatementPrecheckOutput = z.infer<typeof statementPrecheckSchema>;

export const pulseAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
  summary: z.string().trim().min(1).max(1000),
});
export type PulseAnswerSchemaOutput = z.infer<typeof pulseAnswerSchema>;

export const pulseNavigationDecisionSchema = z.object({
  selectedIds: z.array(z.string().trim().min(1)).min(1).max(3),
  observation: z.string().trim().min(1).max(800),
  rationale: z.string().trim().min(1).max(800),
});
export type PulseNavigationDecisionSchemaOutput = z.infer<typeof pulseNavigationDecisionSchema>;

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
      aspects: z.array(z.enum(aspectKinds)),
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
  themes: z.array(
    z.object({
      title: z.string().trim().min(1).max(180),
      summary: z.string().trim().max(2000),
      memberKeys: z.array(z.string()).min(1),
      evidenceChunkIds: z.array(z.string()).default([]),
      aspects: z.array(z.enum(aspectKinds)),
    }),
  ).optional(),
});

export type ExtractionOutput = z.infer<typeof extractionSchema>;
