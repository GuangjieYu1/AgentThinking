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
export const indexProfiles = ["v1", "v2", "dual"] as const;
export const activeIndexProfiles = ["v1", "v2"] as const;
export const indexBuildStatuses = ["building", "ready", "failed", "partial", "abandoned"] as const;
export const indexProfileStatuses = ["not_started", ...indexBuildStatuses] as const;
export const vectorTargetTypes = ["legacy_chunk", "retrieval_unit", "summary_node", "context_unit_optional"] as const;
export const quoteMatchLevels = ["exact", "normalized", "fuzzy", "not_found"] as const;
export const contextBlockTypes = ["paragraph", "list_item", "table", "heading", "unknown"] as const;
export const genericEvidenceRoles = [
  "declared_total",
  "stated_total",
  "itemized_value",
  "component_value",
  "source_value",
  "normalized_value",
  "derived_value",
  "approximate_value",
  "excluded_value",
  "disputed_value",
  "background_value",
  "unexpanded_value",
  "supporting_claim",
  "contradicting_claim",
  "contextual_fact",
] as const;
export const answerModes = ["evidence_heavy", "citation_supported", "summary_answer"] as const;
export const documentTreeNodeTypes = ["document", "section", "paragraph", "sentence", "table", "unknown"] as const;
export const summaryTreeLevels = ["paragraph", "section", "document", "cluster"] as const;
export const mappingAuditStatuses = ["clean", "minor_issues", "major_issues", "failed"] as const;
export const mappingAuditFindingKinds = [
  "missing_source_meaning",
  "unsupported_graph_claim",
  "wrong_relation",
  "chunk_boundary_loss",
  "overgeneralization",
  "other",
] as const;
export const mappingAuditSeverities = ["low", "medium", "high"] as const;
export const graphRuleCategories = [
  "graph_validity",
  "relation_algebra",
  "semantic_coverage",
  "graph_evolution",
] as const;
export const graphRuleDecisions = ["kept", "downgraded", "excluded_from_graph", "needs_review"] as const;
export const graphRuleActions = [
  "relation_type_validated",
  "relation_type_downgraded",
  "dangling_relation_dropped",
  "self_loop_dropped",
  "evidence_validated",
  "invalid_evidence_filtered",
  "strong_relation_without_evidence_dropped",
  "confidence_normalized",
  "related_to_confidence_capped",
  "duplicate_relation_merged",
  "weak_relation_removed_by_strong_relation",
  "conflicting_relation_marked_review",
  "composition_review_flagged",
  "isolated_node_flagged",
  "semantic_coverage_gap_flagged",
  "rebuild_local_change_recorded",
  "rebuild_rule_quick_audit_flagged",
] as const;
export const mappingAuditFindingStatuses = ["open", "accepted", "dismissed", "fixed"] as const;
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
export type IndexProfile = (typeof indexProfiles)[number];
export type ActiveIndexProfile = (typeof activeIndexProfiles)[number];
export type IndexBuildStatus = (typeof indexBuildStatuses)[number];
export type IndexProfileBuildStatus = (typeof indexProfileStatuses)[number];
export type VectorTargetType = (typeof vectorTargetTypes)[number];
export type QuoteMatchLevel = (typeof quoteMatchLevels)[number];
export type ContextBlockType = (typeof contextBlockTypes)[number];
export type GenericEvidenceRole = (typeof genericEvidenceRoles)[number];
export type AnswerMode = (typeof answerModes)[number];
export type DocumentTreeNodeType = (typeof documentTreeNodeTypes)[number];
export type SummaryTreeLevel = (typeof summaryTreeLevels)[number];
export type MappingAuditStatus = (typeof mappingAuditStatuses)[number];
export type MappingAuditFindingKind = (typeof mappingAuditFindingKinds)[number];
export type MappingAuditSeverity = (typeof mappingAuditSeverities)[number];
export type GraphRuleCategory = (typeof graphRuleCategories)[number];
export type GraphRuleDecision = (typeof graphRuleDecisions)[number];
export type LegacyGraphRuleDecision = GraphRuleDecision | "dropped";
export type GraphRuleAction = (typeof graphRuleActions)[number];
export type MappingAuditFindingStatus = (typeof mappingAuditFindingStatuses)[number];
export type JobStage = (typeof jobStages)[number];
export type OcrMode = (typeof ocrModes)[number];

export interface Library {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUser {
  id: string;
  username: string;
  createdAt: string;
}

export interface AuthSession {
  authRequired: boolean;
  user: AuthUser | null;
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
  indexSchemaVersion?: 1 | 2 | undefined;
  latestReadyV1BuildId?: string | null | undefined;
  latestReadyV2BuildId?: string | null | undefined;
  activeIndexProfile?: ActiveIndexProfile | undefined;
  indexWarnings?: string[] | undefined;
  createdAt: string;
}

export interface IndexBuildRecord {
  buildId: string;
  versionId: string;
  profile: ActiveIndexProfile;
  status: IndexBuildStatus;
  startedAt: string;
  finishedAt?: string | undefined;
  errorMessage?: string | undefined;
  errorStack?: string | undefined;
  contextUnitCount?: number | undefined;
  retrievalUnitCount?: number | undefined;
  vectorCount?: number | undefined;
  summaryVectorCount?: number | undefined;
  qualityReportJson?: string | undefined;
  performanceReportJson?: string | undefined;
  indexerVersion: string;
  schemaVersion: number;
}

export interface IndexProfileStatus {
  v1: IndexProfileBuildStatus;
  v2: IndexProfileBuildStatus;
  activeProfile: ActiveIndexProfile;
  latestReadyV1BuildId?: string | null | undefined;
  latestReadyV2BuildId?: string | null | undefined;
  warnings: string[];
  lastV1BuildAt?: string | undefined;
  lastV2BuildAt?: string | undefined;
  lastV2Error?: string | undefined;
}

export interface Chunk {
  id: string;
  libraryId: string;
  versionId: string;
  parentChunkId?: string | null;
  documentTreeNodeId?: string | null;
  childOrdinal?: number | null;
  parentOrdinal?: number | null;
  nodeType?: DocumentTreeNodeType | null;
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

export interface DocumentTreeNode {
  id: string;
  libraryId: string;
  documentId: string;
  versionId: string;
  nodeType: DocumentTreeNodeType;
  parentId: string | null;
  childrenIds: string[];
  ordinal: number;
  level: number;
  headingPath: string[];
  text: string;
  summary: string;
  prevId: string | null;
  nextId: string | null;
  sourceChunkIds: string[];
}

export interface ParentChildChunk {
  childChunkId: string;
  parentChunkId: string;
  documentTreeNodeId: string;
  childText: string;
  parentText: string;
  childOrdinal: number;
  parentOrdinal: number;
}

export interface SourceRange {
  startSourceNodeId: string;
  endSourceNodeId: string;
  startChar: number;
  endChar: number;
}

export interface ContextBlock {
  blockId: string;
  type: ContextBlockType;
  startChar: number;
  endChar: number;
  sourceNodeId?: string | undefined;
  ordinal: number;
  textPreview?: string | undefined;
  tableFormat?: "markdown" | "html" | "csv" | "plain" | undefined;
  rawTableTextRef?: string | undefined;
}

export interface ContextUnit {
  id: string;
  stableKey: string;
  buildId: string;
  versionId: string;
  sourceNodeIds: string[];
  primarySourceNodeId?: string | null | undefined;
  sourceRange: SourceRange;
  headingPath: string[];
  displayHeadingPath: string[];
  ordinal: number;
  ordinalInPrimarySource?: number | undefined;
  text: string;
  blocks: ContextBlock[];
  retrievalUnitIds: string[];
  estimatedTokens?: number | undefined;
  boundaryReason: string;
}

export interface RetrievalUnit {
  id: string;
  stableKey: string;
  buildId: string;
  versionId: string;
  contextUnitId: string;
  text: string;
  headingPath: string[];
  ordinal: number;
  startChar?: number | null | undefined;
  endChar?: number | null | undefined;
  startLine?: number | null | undefined;
  endLine?: number | null | undefined;
  pageNumber?: number | null | undefined;
  estimatedTokens?: number | undefined;
}

export interface ContextUnitQualityReport {
  contextUnitCount: number;
  retrievalUnitCount: number;
  avgContextChars: number;
  avgRetrievalChars: number;
  p50ContextChars: number;
  p90ContextChars: number;
  maxContextChars: number;
  avgRetrievalPerContext: number;
  p90RetrievalPerContext: number;
  boundaryReasonDistribution: Record<string, number>;
  strongBoundaryViolations: Array<{ contextUnitId: string; reason: string }>;
  overBudgetContextUnits: Array<{ contextUnitId: string; estimatedTokens: number; budget: number }>;
  suspiciousTinyContextUnits: string[];
  suspiciousHugeRetrievalUnits: string[];
  generatedAt: string;
}

export interface IndexingPerformanceReport {
  parseTimeMs?: number | undefined;
  v1IndexTimeMs?: number | undefined;
  v2ContextBuildTimeMs?: number | undefined;
  v2RetrievalBuildTimeMs?: number | undefined;
  embeddingTimeMs?: number | undefined;
  vectorWriteTimeMs?: number | undefined;
  dbSizeDeltaBytes?: number | undefined;
  contextUnitCount: number;
  retrievalUnitCount: number;
  vectorCount: number;
}

export interface V2IndexHealth {
  status: IndexProfileStatus;
  buildId?: string | undefined;
  retrievalUnitCount: number;
  contextUnitCount: number;
  vectorCount: number;
  summaryVectorCount: number;
  qualityReport?: ContextUnitQualityReport | undefined;
  performanceReport?: IndexingPerformanceReport | undefined;
  buildHistory: Array<{
    buildId: string;
    status: string;
    startedAt: string;
    finishedAt?: string | undefined;
    errorMessage?: string | undefined;
  }>;
  warnings: string[];
}

export interface SummaryTreeNode {
  id: string;
  versionId: string;
  level: SummaryTreeLevel;
  sourceNodeIds: string[];
  summary: string;
  embeddingId: string | null;
  parentSummaryId: string | null;
  childSummaryIds: string[];
}

export interface EvidenceCitation {
  chunkId: string;
  treeNodeId: string | null;
  quote: string;
  headingPath: string[] | string | null;
  pageNumber: number | null;
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
  documentTree?: DocumentTreeNode[] | undefined;
  summaryTree?: SummaryTreeNode[] | undefined;
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
  evidenceNodeIds?: string[] | undefined;
  citationLocators?: CitationLocator[] | undefined;
  evidenceContextUnitIds?: string[] | undefined;
  graphExtractorVersion?: string | undefined;
  promptVersion?: string | undefined;
  validatorVersion?: string | undefined;
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
  evidenceNodeIds?: string[] | undefined;
  citationLocators?: CitationLocator[] | undefined;
  evidenceContextUnitIds?: string[] | undefined;
  graphExtractorVersion?: string | undefined;
  promptVersion?: string | undefined;
  validatorVersion?: string | undefined;
  ruleWarnings?: string[] | undefined;
  ruleDecision?: GraphRuleDecision | undefined;
  originalType?: string | undefined;
  originalConfidence?: number | undefined;
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

export interface PulseStreamHit {
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

export interface PulseNavigationRejection {
  id: string;
  reason: string;
}

export interface PulseStreamRejectedCandidate extends PulseNavigationRejection {
  label: string;
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
  evidencePack?: EvidencePack | undefined;
}

export type PulseStreamEvent =
  | { type: "start"; mode: PulseInputMode; question: string }
  | { type: "stage"; message: string }
  | {
    type: "candidates";
    stepIndex: number;
    fromNodeIds: string[];
    fromLabels: string[];
    candidates: PulseNavigationCandidate[];
  }
  | {
    type: "decision";
    stepIndex: number;
    selected: PulseNavigationCandidate[];
    rejected: PulseStreamRejectedCandidate[];
    observation: string;
    rationale: string;
  }
  | {
    type: "backtrack";
    stepIndex: number;
    fromNodeId: string;
    fromLabel: string;
    toNodeId?: string;
    toLabel?: string;
    reason: string;
  }
  | { type: "hit"; hit: PulseStreamHit }
  | { type: "answer"; answer: string; summary: string }
  | { type: "done"; response: PulseResponse }
  | { type: "error"; message: string };

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

export type PulseQuestionType =
  | "normal"
  | "exhaustive_list"
  | "numerical_aggregation"
  | "timeline"
  | "entity_relation"
  | "causal_explanation"
  | "claim_support"
  | "summary"
  | "critique"
  | "comparison"
  | "mixed";

export type PulseEvidenceTool =
  | "semanticSearchChildChunks"
  | "fullTextSearchChildChunks"
  | "retrieveParentChunks"
  | "retrieveDocumentTreeNodes"
  | "retrieveSectionSubtree"
  | "retrieveSiblingNodes"
  | "retrieveRemainingNodesAfter"
  | "retrieveSummaryTree"
  | "graphSearch"
  | "graphExpand"
  | "retrieveEvidenceForGraphNodes"
  | "buildEvidencePack"
  | "semanticSearch"
  | "fullTextSearch"
  | "readChunks"
  | "readNeighborChunks"
  | "readSameSectionChunks"
  | "readRemainingChunksAfter"
  | "getDocumentOutline"
  | "getChunkEvidenceAround"
  | "getGraphContext";

export type PulseEvidenceType = "fact" | "amount" | "date" | "entity_relation" | "claim" | "quote" | "timeline_event" | "table_value" | "other";

export interface TokenBudget {
  maxInputTokens: number;
  reservedForSystem: number;
  reservedForQuestion: number;
  reservedForInstructions: number;
  reservedForEvidenceJson: number;
  reservedForOutput: number;
  reservedForVerification?: number | undefined;
  availableForContext: number;
}

export interface ModelContextProfile {
  provider: string;
  model: string;
  maxInputTokens: number;
  preferredContextTokens: number;
  strategy: "long-context" | "retrieval-compact";
  allowDocumentPack: boolean;
  allowSectionPack: boolean;
  allowMultiContextUnitPack: boolean;
  compactExcerptTokens?: number | undefined;
  tokenBudget: TokenBudget;
}

export interface PipelineVersion {
  indexerVersion: string;
  contextUnitBuilderVersion: string;
  retrievalUnitBuilderVersion: string;
  packBuilderVersion: string;
  evidenceExtractorVersion: string;
  validatorVersion: string;
  promptVersion: string;
}

export interface CitationLocator {
  versionId: string;
  contextUnitId: string;
  contextUnitStableKey?: string | undefined;
  retrievalUnitId?: string | null | undefined;
  sourceNodeId?: string | null | undefined;
  quote: string;
  normalizedQuote: string;
  quoteHash: string;
  locatorHash: string;
  occurrenceIndex?: number | undefined;
  beforeText?: string | undefined;
  afterText?: string | undefined;
  startChar?: number | null | undefined;
  endChar?: number | null | undefined;
  pageNumber?: number | null | undefined;
  startLine?: number | null | undefined;
  endLine?: number | null | undefined;
  matchLevel?: QuoteMatchLevel | undefined;
  validationWarnings?: string[] | undefined;
}

export interface NumericStructuredValue {
  originalText: string;
  originalUnit?: string | undefined;
  originalValue?: number | undefined;
  normalizedValue?: number | undefined;
  normalizedUnit?: string | undefined;
  approximate: boolean;
  lowerBound?: number | undefined;
  upperBound?: number | undefined;
  exactForAggregation: boolean;
  valueKind?: "money" | "count" | "percentage" | "date_duration" | "measurement" | "other" | undefined;
  sourceEntity?: string | undefined;
  targetEntity?: string | undefined;
  normalizationWarnings?: string[] | undefined;
}

export interface PulseQuestionPlan {
  questionType: PulseQuestionType;
  requiresExhaustiveEvidence: boolean;
  requiresStructuredEvidence: boolean;
  requiresNumericalReconciliation: boolean;
  requiresSourceQuotes: boolean;
  requiresTimelineCompleteness: boolean;
  requiresEntityCoverage: boolean;
  allowedPartialAnswer: boolean;
  answerMustExposeGaps: boolean;
  evidenceTargets: string[];
  keyEntities: string[];
  expectedEvidenceTypes: string[];
  riskLevel: "low" | "medium" | "high";
  reasoning: string;
}

export interface PulseEvidenceStep {
  tool: PulseEvidenceTool;
  query?: string | undefined;
  basedOnChunkIds?: string[] | undefined;
  basedOnNodeIds?: string[] | undefined;
  purpose: string;
  expectedResult: string;
}

export interface PulseEvidencePlan {
  objective: string;
  steps: PulseEvidenceStep[];
  stopCondition: string;
  expectedEvidenceShape: string;
  maxIterations: number;
}

export interface PulseEvidenceRow {
  rowId: string;
  evidenceType: PulseEvidenceType;
  claimText: string;
  structuredValue?: unknown;
  sourceEntity?: string | undefined;
  targetEntity?: string | undefined;
  relationType?: string | undefined;
  evidenceChunkId: string;
  treeNodeId?: string | null | undefined;
  evidenceQuote: string;
  role?: GenericEvidenceRole | string | undefined;
  contextUnitId?: string | undefined;
  retrievalUnitId?: string | null | undefined;
  citation?: CitationLocator | undefined;
  documentId?: string | undefined;
  versionId?: string | undefined;
  headingPath?: string[] | undefined;
  confidence: number;
  countedInAnswer?: boolean | undefined;
  countedInAggregation?: boolean | undefined;
  dedupeKey?: string | undefined;
  warnings?: string[] | undefined;
}

export interface RetrievalTrace {
  stepIndex: number;
  tool: PulseEvidenceTool;
  purpose: string;
  query?: string | undefined;
  inputIds: string[];
  outputIds: string[];
  newEvidenceRowCount: number;
  status: "success" | "empty" | "error" | "skipped";
}

export interface EvidencePack {
  id: string;
  question: string;
  evidencePackSchemaVersion?: 1 | 2 | undefined;
  pipeline?: {
    indexProfile: ActiveIndexProfile;
    packBuilder: "legacy" | "v2";
    model: string;
    promptVersion: string;
  } | undefined;
  pipelineVersion?: PipelineVersion | undefined;
  answerMode?: AnswerMode | undefined;
  answerModeReason?: string | undefined;
  answerModeOverridden?: boolean | undefined;
  contextUnits?: ContextUnit[] | undefined;
  retrievalUnits?: RetrievalUnit[] | undefined;
  treeNodes: DocumentTreeNode[];
  parentChunks: ParentChildChunk[];
  semanticNodes: AbstractNode[];
  semanticRelations: Relation[];
  summaryNodes: SummaryTreeNode[];
  evidenceRows: PulseEvidenceRow[];
  citations: EvidenceCitation[];
  gaps: PulseEvidenceGap[];
  retrievalTrace: RetrievalTrace[];
  reconciliation?: PulseEvidenceReconciliation | undefined;
}

export interface PulseEvidenceGap {
  type:
    | "missing_itemized_evidence"
    | "declared_total_without_breakdown"
    | "sum_mismatch"
    | "missing_source_quote"
    | "missing_entity_coverage"
    | "timeline_gap"
    | "unsupported_claim"
    | "other";
  description: string;
  suggestedQueries: string[];
  severity: "low" | "medium" | "high";
}

export interface PulseEvidenceReconciliation {
  declaredTotal?: number | undefined;
  itemizedSum?: number | undefined;
  exactItemizedSum?: number | undefined;
  approximateItemizedLower?: number | undefined;
  approximateItemizedUpper?: number | undefined;
  difference?: number | undefined;
  unit?: string | undefined;
  closed: boolean;
  explanation: string;
  warnings?: string[] | undefined;
}

export interface PulseEvidenceStatus {
  sufficient: boolean;
  status: "sufficient" | "insufficient_context" | "needs_gap_retrieval" | "failed_reconciliation" | "partial_answer_only";
  gaps: PulseEvidenceGap[];
  reasoning: string;
  reconciliation?: PulseEvidenceReconciliation | undefined;
}

export interface PulseEvidenceMemory {
  question: string;
  questionPlan: PulseQuestionPlan;
  collectedChunks: Array<{ id: string; versionId: string; text: string; headingPath: string | null; pageNumber: number | null; ordinal: number; parentChunkId?: string | null; documentTreeNodeId?: string | null; nodeType?: DocumentTreeNodeType | null }>;
  graphNodes: Array<{ id: string; title: string; summary: string }>;
  graphRelations: Array<{ id: string; type: RelationType; sourceTitle: string; targetTitle: string; reason: string }>;
  treeNodes?: DocumentTreeNode[] | undefined;
  parentChunks?: ParentChildChunk[] | undefined;
  summaryNodes?: SummaryTreeNode[] | undefined;
  evidenceRows: PulseEvidenceRow[];
  citedChunkIds: string[];
  retrievalHistory: Array<{ tool: PulseEvidenceTool; query?: string | undefined; chunkIds: string[]; purpose: string }>;
  retrievalTrace?: RetrievalTrace[] | undefined;
  currentFindings: string[];
  gaps: PulseEvidenceGap[];
  sufficiencyHistory: PulseEvidenceStatus[];
}

export interface PulseVerificationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  rewriteInstructions?: string | undefined;
}

export interface PulseAnswerOutput {
  answer: string;
  summary: string;
  evidenceStatus?: PulseEvidenceStatus | undefined;
  diagnostics?: {
    questionPlan?: PulseQuestionPlan | undefined;
    retrievalSteps?: PulseEvidenceStep[] | undefined;
    citedChunkIds?: string[] | undefined;
    warnings?: string[] | undefined;
  } | undefined;
  evidenceRows?: PulseEvidenceRow[] | undefined;
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
  rejectedCandidates?: PulseNavigationRejection[];
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

export interface MappingAuditFinding {
  kind: MappingAuditFindingKind;
  severity: MappingAuditSeverity;
  ruleCategory?: GraphRuleCategory | undefined;
  title: string;
  description: string;
  suggestion: string;
  evidenceChunkIds: string[];
  nodeIds: string[];
  relationIds: string[];
  userComment: string;
  status?: MappingAuditFindingStatus | undefined;
  resolutionNote?: string | undefined;
  fixedByRebuildId?: string | undefined;
}

export interface MappingAuditMetrics {
  chunkCount?: number;
  nodeCount?: number;
  relationCount?: number;
  findingCount?: number;
  highSeverityCount?: number;
  mediumSeverityCount?: number;
  lowSeverityCount?: number;
  missingSourceMeaningCount?: number;
  unsupportedGraphClaimCount?: number;
  wrongRelationCount?: number;
  chunkBoundaryLossCount?: number;
  overgeneralizationCount?: number;
  coverageScore?: number;
  unsupportedClaimRate?: number;
  wrongRelationRate?: number;
}

export interface MappingAudit {
  id: string;
  libraryId: string;
  versionId: string;
  status: MappingAuditStatus;
  summary: string;
  reconstruction: string;
  findings: MappingAuditFinding[];
  metrics?: MappingAuditMetrics | undefined;
  graphRebuildReport: string;
  graphRebuiltAt: string | null;
  createdAt: string;
}

export interface GraphRuleTrace {
  traceId: string;
  batchId?: string | undefined;
  sequence?: number | undefined;
  stage?: GraphRuleStage | undefined;
  ruleId?: string | undefined;
  category: GraphRuleCategory;
  action: GraphRuleAction;
  targetType?: "relation" | "node" | "chunk" | "graph" | "answer" | undefined;
  targetId?: string | undefined;
  before?: unknown;
  after?: unknown;
  severity?: "low" | "medium" | "high" | undefined;
  relationTempId?: string | undefined;
  relationId?: string | undefined;
  nodeId?: string | undefined;
  sourceKey?: string | undefined;
  targetKey?: string | undefined;
  originalType?: string | undefined;
  finalType?: string | undefined;
  originalConfidence?: number | undefined;
  finalConfidence?: number | undefined;
  decision: GraphRuleDecision;
  warnings: string[];
  reason: string;
  evidenceChunkIds: string[];
  timestamp: string;
}

export interface GraphRulesSummary {
  totalRelations: number;
  keptCount: number;
  downgradedCount: number;
  excludedCount: number;
  droppedCount: number;
  reviewCount: number;
  warningCount: number;
  categoryCounts: Record<GraphRuleCategory, number>;
}

export type GraphRuleStage = "extraction" | "mapping_audit" | "rebuild";

export interface LibraryStreamEventBase {
  libraryId: string;
  versionId?: string | undefined;
  documentId?: string | undefined;
  jobId?: string | undefined;
  stage?: GraphRuleStage | undefined;
  createdAt: string;
}

export interface GraphRuleTraceEvent extends LibraryStreamEventBase {
  type: "graph_rule_trace" | "graph_rebuild_rule_trace";
  traces: GraphRuleTrace[];
  summary: GraphRulesSummary;
}

export interface GraphRuleSummaryEvent extends LibraryStreamEventBase {
  type: "graph_rule_summary" | "graph_rebuild_summary";
  summary: GraphRulesSummary;
}

export interface GraphCandidateBatchReadyEvent extends LibraryStreamEventBase {
  type: "graph_candidate_batch_ready";
  batchIndex: number;
  totalBatches: number;
  nodeCount: number;
  relationCount: number;
  themeCount: number;
  summary: GraphRulesSummary;
}

export type LibraryStreamEvent =
  | { type: "connected" }
  | { type: "job"; job: IngestJob }
  | GraphRuleTraceEvent
  | GraphRuleSummaryEvent
  | GraphCandidateBatchReadyEvent;

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

export const registerSchema = z.object({
  username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_-]+$/, "用户名只能包含字母、数字、下划线和连字符"),
  password: z.string().min(8).max(200),
  registrationKey: z.string().trim().min(1).max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(40),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

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
  status: z.enum(["accepted", "rejected"]).optional(),
  type: z.enum(relationTypes).optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
}).refine(
  (body) => body.status !== undefined || body.type !== undefined || body.reason !== undefined || body.confidence !== undefined,
  "没有可更新的内容",
);

export const addGraphEvidenceSchema = z.object({
  chunkId: z.string().min(1),
});

export const updateMappingAuditFindingCommentSchema = z.object({
  userComment: z.string().trim().max(1200),
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

export const mappingAuditFindingSchema = z.object({
  kind: z.enum(mappingAuditFindingKinds),
  severity: z.enum(mappingAuditSeverities),
  ruleCategory: z.enum(graphRuleCategories).optional(),
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(1200),
  suggestion: z.string().trim().min(1).max(800),
  evidenceChunkIds: z.array(z.string()).default([]),
  nodeIds: z.array(z.string()).default([]),
  relationIds: z.array(z.string()).default([]),
  userComment: z.string().trim().max(1200).default(""),
  status: z.enum(mappingAuditFindingStatuses).optional(),
  resolutionNote: z.string().trim().max(1200).optional(),
  fixedByRebuildId: z.string().trim().max(200).optional(),
});

export const mappingAuditMetricsSchema = z.object({
  chunkCount: z.number().nonnegative().optional(),
  nodeCount: z.number().nonnegative().optional(),
  relationCount: z.number().nonnegative().optional(),
  findingCount: z.number().nonnegative().optional(),
  highSeverityCount: z.number().nonnegative().optional(),
  mediumSeverityCount: z.number().nonnegative().optional(),
  lowSeverityCount: z.number().nonnegative().optional(),
  missingSourceMeaningCount: z.number().nonnegative().optional(),
  unsupportedGraphClaimCount: z.number().nonnegative().optional(),
  wrongRelationCount: z.number().nonnegative().optional(),
  chunkBoundaryLossCount: z.number().nonnegative().optional(),
  overgeneralizationCount: z.number().nonnegative().optional(),
  coverageScore: z.number().min(0).max(1).optional(),
  unsupportedClaimRate: z.number().min(0).max(1).optional(),
  wrongRelationRate: z.number().min(0).max(1).optional(),
});

export const mappingAuditResultSchema = z.object({
  status: z.enum(mappingAuditStatuses),
  summary: z.string().trim().min(1).max(2000),
  reconstruction: z.string().trim().max(20000),
  findings: z.array(mappingAuditFindingSchema).default([]),
  metrics: mappingAuditMetricsSchema.optional(),
});

export type MappingAuditResult = z.infer<typeof mappingAuditResultSchema>;

export const citationLocatorSchema = z.object({
  versionId: z.string().trim().min(1),
  contextUnitId: z.string().trim().min(1),
  contextUnitStableKey: z.string().trim().min(1).optional(),
  retrievalUnitId: z.string().trim().min(1).nullable().optional(),
  sourceNodeId: z.string().trim().min(1).nullable().optional(),
  quote: z.string().trim().min(1).max(1200),
  normalizedQuote: z.string().trim().min(1).max(1200),
  quoteHash: z.string().trim().min(1),
  locatorHash: z.string().trim().min(1),
  occurrenceIndex: z.coerce.number().int().min(0).optional(),
  beforeText: z.string().max(500).optional(),
  afterText: z.string().max(500).optional(),
  startChar: z.number().int().min(0).nullable().optional(),
  endChar: z.number().int().min(0).nullable().optional(),
  pageNumber: z.number().int().min(1).nullable().optional(),
  startLine: z.number().int().min(1).nullable().optional(),
  endLine: z.number().int().min(1).nullable().optional(),
  matchLevel: z.enum(quoteMatchLevels).optional(),
  validationWarnings: z.array(z.string().trim().min(1).max(300)).optional(),
});

export const pulseQuestionPlanSchema = z.object({
  questionType: z.enum(["normal", "exhaustive_list", "numerical_aggregation", "timeline", "entity_relation", "causal_explanation", "claim_support", "summary", "critique", "comparison", "mixed"]),
  requiresExhaustiveEvidence: z.boolean(),
  requiresStructuredEvidence: z.boolean(),
  requiresNumericalReconciliation: z.boolean(),
  requiresSourceQuotes: z.boolean(),
  requiresTimelineCompleteness: z.boolean(),
  requiresEntityCoverage: z.boolean(),
  allowedPartialAnswer: z.boolean(),
  answerMustExposeGaps: z.boolean(),
  evidenceTargets: z.array(z.string().trim().min(1)).default([]),
  keyEntities: z.array(z.string().trim().min(1)).default([]),
  expectedEvidenceTypes: z.array(z.string().trim().min(1)).default([]),
  riskLevel: z.enum(["low", "medium", "high"]),
  reasoning: z.string().trim().min(1).max(2000),
});

export const pulseEvidenceToolValues = [
  "semanticSearchChildChunks",
  "fullTextSearchChildChunks",
  "retrieveParentChunks",
  "retrieveDocumentTreeNodes",
  "retrieveSectionSubtree",
  "retrieveSiblingNodes",
  "retrieveRemainingNodesAfter",
  "retrieveSummaryTree",
  "graphSearch",
  "graphExpand",
  "retrieveEvidenceForGraphNodes",
  "buildEvidencePack",
  "semanticSearch",
  "fullTextSearch",
  "readChunks",
  "readNeighborChunks",
  "readSameSectionChunks",
  "readRemainingChunksAfter",
  "getDocumentOutline",
  "getChunkEvidenceAround",
  "getGraphContext",
] as const;

export const pulseEvidenceStepSchema = z.object({
  tool: z.enum(pulseEvidenceToolValues),
  query: z.string().trim().max(1000).optional(),
  basedOnChunkIds: z.array(z.string().trim().min(1)).optional(),
  basedOnNodeIds: z.array(z.string().trim().min(1)).optional(),
  purpose: z.string().trim().min(1).max(1000),
  expectedResult: z.string().trim().min(1).max(1000),
});

export const pulseEvidencePlanSchema = z.object({
  objective: z.string().trim().min(1).max(1000),
  steps: z.array(pulseEvidenceStepSchema).default([]),
  stopCondition: z.string().trim().min(1).max(1000),
  expectedEvidenceShape: z.string().trim().min(1).max(1000),
  maxIterations: z.coerce.number().int().min(1).max(6).default(2),
});

export const pulseEvidenceRowSchema = z.object({
  rowId: z.string().trim().min(1),
  evidenceType: z.enum(["fact", "amount", "date", "entity_relation", "claim", "quote", "timeline_event", "table_value", "other"]),
  claimText: z.string().trim().min(1).max(2000),
  structuredValue: z.unknown().optional(),
  sourceEntity: z.string().trim().max(300).optional(),
  targetEntity: z.string().trim().max(300).optional(),
  relationType: z.string().trim().max(120).optional(),
  evidenceChunkId: z.string().trim().min(1),
  treeNodeId: z.string().trim().min(1).nullable().optional(),
  evidenceQuote: z.string().trim().min(1).max(1200),
  role: z.string().trim().max(120).optional(),
  contextUnitId: z.string().trim().min(1).optional(),
  retrievalUnitId: z.string().trim().min(1).nullable().optional(),
  citation: citationLocatorSchema.optional(),
  documentId: z.string().trim().min(1).optional(),
  versionId: z.string().trim().min(1).optional(),
  headingPath: z.array(z.string()).optional(),
  confidence: z.coerce.number().min(0).max(1),
  countedInAnswer: z.boolean().optional(),
  countedInAggregation: z.boolean().optional(),
  dedupeKey: z.string().trim().max(300).optional(),
  warnings: z.array(z.string().trim().min(1).max(300)).optional(),
});

export const pulseEvidenceGapSchema = z.object({
  type: z.enum(["missing_itemized_evidence", "declared_total_without_breakdown", "sum_mismatch", "missing_source_quote", "missing_entity_coverage", "timeline_gap", "unsupported_claim", "other"]),
  description: z.string().trim().min(1).max(1200),
  suggestedQueries: z.array(z.string().trim().min(1).max(500)).default([]),
  severity: z.enum(["low", "medium", "high"]),
});

export const pulseEvidenceStatusSchema = z.object({
  sufficient: z.boolean(),
  status: z.enum(["sufficient", "insufficient_context", "needs_gap_retrieval", "failed_reconciliation", "partial_answer_only"]),
  gaps: z.array(pulseEvidenceGapSchema).default([]),
  reasoning: z.string().trim().min(1).max(2000),
  reconciliation: z.object({
    declaredTotal: z.number().optional(),
    itemizedSum: z.number().optional(),
    exactItemizedSum: z.number().optional(),
    approximateItemizedLower: z.number().optional(),
    approximateItemizedUpper: z.number().optional(),
    difference: z.number().optional(),
    unit: z.string().optional(),
    closed: z.boolean(),
    explanation: z.string().trim().min(1).max(1000),
    warnings: z.array(z.string().trim().min(1).max(300)).optional(),
  }).optional(),
});

export const pulseAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
  summary: z.string().trim().min(1).max(1000),
  evidenceStatus: pulseEvidenceStatusSchema.optional(),
  diagnostics: z.object({
    questionPlan: pulseQuestionPlanSchema.optional(),
    retrievalSteps: z.array(pulseEvidenceStepSchema).optional(),
    citedChunkIds: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  }).optional(),
  evidenceRows: z.array(pulseEvidenceRowSchema).optional(),
});
export type PulseAnswerSchemaOutput = z.infer<typeof pulseAnswerSchema>;

export const pulseNavigationDecisionSchema = z.object({
  selectedIds: z.array(z.string().trim().min(1)).min(1).max(3),
  observation: z.string().trim().min(1).max(800),
  rationale: z.string().trim().min(1).max(800),
  rejectedCandidates: z.array(z.object({
    id: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(500),
  })).max(8).default([]),
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
      sourceChunkIds: z.array(z.string()).optional(),
      evidenceNodeIds: z.array(z.string()).optional(),
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
      sourceChunkIds: z.array(z.string()).optional(),
      evidenceNodeIds: z.array(z.string()).optional(),
      ruleWarnings: z.array(z.string().trim().min(1).max(300)).optional(),
      ruleDecision: z.preprocess((value) => value === "dropped" ? "excluded_from_graph" : value, z.enum(graphRuleDecisions)).optional(),
      originalType: z.string().trim().min(1).max(80).optional(),
      originalConfidence: z.number().optional(),
    }),
  ),
  themes: z.array(
    z.object({
      title: z.string().trim().min(1).max(180),
      summary: z.string().trim().max(2000),
      memberKeys: z.array(z.string()).min(1),
      evidenceChunkIds: z.array(z.string()).default([]),
      sourceChunkIds: z.array(z.string()).optional(),
      evidenceNodeIds: z.array(z.string()).optional(),
      aspects: z.array(z.enum(aspectKinds)),
    }),
  ).optional(),
});

export type ExtractionOutput = z.infer<typeof extractionSchema>;
