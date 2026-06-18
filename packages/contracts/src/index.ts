import { z } from "zod";

export const abstractNodeKinds = ["concept", "claim"] as const;
export const aspectKinds = [
  "entity",
  "person",
  "organization",
  "place",
  "object",
  "event",
  "timeline",
  "causality",
  "state_change",
  "amount",
  "evidence",
  "argument",
  "claim",
  "counterargument",
  "finding",
  "conflict",
  "method",
  "experiment",
  "result",
  "limitation",
  "system",
  "operation",
  "story",
  "question",
  "gap",
  "other",
] as const;
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
export const indexStrategies = ["bottom_up_evidence", "aspect_oriented_reflective"] as const;
export const indexProfiles = ["v1", "v2", "dual"] as const;
export const activeIndexProfiles = ["v1", "v2"] as const;
export const indexBuildStatuses = ["building", "ready", "failed", "partial", "abandoned"] as const;
export const indexProfileStatuses = ["not_started", ...indexBuildStatuses] as const;
export const vectorTargetTypes = ["legacy_chunk", "retrieval_unit", "summary_node", "context_unit_optional"] as const;
export const quoteMatchLevels = ["exact", "normalized", "fuzzy", "not_found"] as const;
export const contextBlockTypes = ["paragraph", "list_item", "table", "heading", "unknown"] as const;
export const genericEvidenceRoles = [
  "direct_fact",
  "background_fact",
  "contextual_fact",
  "authority_finding",
  "allegation",
  "defense_argument",
  "counterargument",
  "court_response",
  "witness_testimony",
  "documentary_evidence",
  "physical_evidence",
  "expert_opinion",
  "declared_total",
  "stated_total",
  "itemized_value",
  "component_value",
  "offset_value",
  "repayment_value",
  "excluded_value",
  "approximate_value",
  "foreign_currency_value",
  "converted_value",
  "derived_value",
  "event_candidate",
  "countable_event",
  "duplicate_observation",
  "reaction",
  "hearsay_or_reported_event",
  "external_view_event",
  "scope_boundary",
  "sentencing_fact",
  "procedural_fact",
  "gap_candidate",
  "gap_refuted",
  "source_value",
  "normalized_value",
  "disputed_value",
  "background_value",
  "unexpanded_value",
  "supporting_claim",
  "contradicting_claim",
] as const;
export const evidenceAuthorities = [
  "court_finding",
  "prosecution_claim",
  "defense_argument",
  "witness",
  "documentary_record",
  "narrator",
  "character_perspective",
  "news_report",
  "model_inferred",
  "unknown",
] as const;
export const evidenceUsages = [
  "answer_core",
  "supporting_detail",
  "counterpoint",
  "excluded_from_answer",
  "gap_verification",
  "background_only",
] as const;
export const evidenceStatuses = ["supported", "partially_supported", "unsupported", "disputed"] as const;
export const closureStatuses = ["closed", "partial", "open"] as const;
export const semanticReviewRisks = ["low", "medium", "high"] as const;
export const questionTaskTypes = [
  "summary",
  "fact_lookup",
  "exhaustive_list",
  "numeric_reconciliation",
  "timeline",
  "entity_relation",
  "claim_support",
  "argument_comparison",
  "event_count",
  "scope_classification",
  "mixed",
] as const;
export const expectedAnswerShapes = [
  "summary",
  "single_fact",
  "table",
  "list",
  "timeline",
  "numeric_table",
  "event_table",
  "argument_map",
] as const;
export const retrievalTaskPurposes = [
  "find_direct_facts",
  "find_itemized_components",
  "find_offsets_or_exclusions",
  "find_authority_finding",
  "find_counterargument",
  "find_supporting_evidence",
  "find_scope_boundary",
  "find_possible_duplicates",
  "find_perspective_or_speaker",
  "find_gap_verification",
] as const;
export const retrievalTaskContexts = [
  "aori_aspect",
  "retrieval_unit",
  "context_unit",
  "section",
  "same_section",
  "remaining_after",
  "document_outline",
] as const;
export const retrievalTaskOutputs = [
  "evidence_rows",
  "amount_components",
  "event_candidates",
  "argument_pairs",
  "authority_scope",
  "gap_evidence",
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
export const aoriIndexingStages = [
  "global_reading",
  "aspect_proposal",
  "node_binding",
  "relation_extraction",
  "closure_check",
] as const;
export const aoriContextDecisionTypes = [
  "context_selection",
  "context_truncation",
  "rationale_not_generated",
  "rationale_save_failed",
] as const;
export const aoriRiskLevels = ["low", "medium", "high"] as const;
export const aoriGraphScopes = ["document", "library"] as const;
export const aoriGraphViewModes = ["layer", "tree", "network"] as const;
export const aoriTraversalNodeTypes = [
  "library_root",
  "document",
  "aspect",
  "aspect_item",
  "relation",
  "self_question",
  "gap",
] as const;
export const libraryEntityAlignmentDecisions = ["same", "new", "ambiguous"] as const;
export const libraryAspectAlignmentDecisions = ["map_to_existing", "new_aspect", "subaspect", "ambiguous"] as const;
export const libraryRelationAlignmentDecisions = ["map_to_existing", "new_relation", "abstract_under_family", "ambiguous"] as const;
export const libraryRelationAssertionStatuses = ["active", "superseded", "contradicted", "uncertain"] as const;
export const evidenceTableTypes = [
  "AmountFactTable",
  "EventFactTable",
  "ArgumentFactTable",
  "TimelineFactTable",
  "EntityRelationTable",
  "CrossDocumentComparisonTable",
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
export const benchmarkSuites = ["kilt", "crag", "ragbench", "crud_rag", "ragas", "ares"] as const;
export const benchmarkRunKinds = ["dataset", "scoring"] as const;
export const benchmarkProviderModes = ["configured", "fake"] as const;
export const benchmarkReviewVerdicts = ["aligned", "partial", "mismatch"] as const;
export const benchmarkSourceExpectationRoles = ["included", "excluded", "uncertain", "background"] as const;
export const benchmarkSourceAnswerRoles = ["included", "excluded", "uncertain", "not_mentioned"] as const;

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
export type IndexStrategy = (typeof indexStrategies)[number];
export type IndexProfile = (typeof indexProfiles)[number];
export type ActiveIndexProfile = (typeof activeIndexProfiles)[number];
export type IndexBuildStatus = (typeof indexBuildStatuses)[number];
export type IndexProfileBuildStatus = (typeof indexProfileStatuses)[number];
export type VectorTargetType = (typeof vectorTargetTypes)[number];
export type QuoteMatchLevel = (typeof quoteMatchLevels)[number];
export type ContextBlockType = (typeof contextBlockTypes)[number];
export type GenericEvidenceRole = (typeof genericEvidenceRoles)[number];
export type EvidenceAuthority = (typeof evidenceAuthorities)[number];
export type EvidenceUsage = (typeof evidenceUsages)[number];
export type EvidenceStatus = (typeof evidenceStatuses)[number];
export type ClosureStatus = (typeof closureStatuses)[number];
export type SemanticReviewRisk = (typeof semanticReviewRisks)[number];
export type QuestionTaskType = (typeof questionTaskTypes)[number];
export type ExpectedAnswerShape = (typeof expectedAnswerShapes)[number];
export type RetrievalTaskPurpose = (typeof retrievalTaskPurposes)[number];
export type RetrievalTaskContext = (typeof retrievalTaskContexts)[number];
export type RetrievalTaskOutput = (typeof retrievalTaskOutputs)[number];
export type AnswerMode = (typeof answerModes)[number];
export type DocumentTreeNodeType = (typeof documentTreeNodeTypes)[number];
export type SummaryTreeLevel = (typeof summaryTreeLevels)[number];
export type MappingAuditStatus = (typeof mappingAuditStatuses)[number];
export type MappingAuditFindingKind = (typeof mappingAuditFindingKinds)[number];
export type MappingAuditSeverity = (typeof mappingAuditSeverities)[number];
export type GraphRuleCategory = (typeof graphRuleCategories)[number];
export type AoriIndexingStage = (typeof aoriIndexingStages)[number];
export type AoriContextDecisionType = (typeof aoriContextDecisionTypes)[number];
export type AoriRiskLevel = (typeof aoriRiskLevels)[number];
export type AoriGraphScope = (typeof aoriGraphScopes)[number];
export type AoriGraphViewMode = (typeof aoriGraphViewModes)[number];
export type AoriTraversalNodeType = (typeof aoriTraversalNodeTypes)[number];
export type LibraryEntityAlignmentDecision = (typeof libraryEntityAlignmentDecisions)[number];
export type LibraryAspectAlignmentDecision = (typeof libraryAspectAlignmentDecisions)[number];
export type LibraryRelationAlignmentDecision = (typeof libraryRelationAlignmentDecisions)[number];
export type LibraryRelationAssertionStatus = (typeof libraryRelationAssertionStatuses)[number];
export type EvidenceTableType = (typeof evidenceTableTypes)[number];
export type GraphRuleDecision = (typeof graphRuleDecisions)[number];
export type LegacyGraphRuleDecision = GraphRuleDecision | "dropped";
export type GraphRuleAction = (typeof graphRuleActions)[number];
export type MappingAuditFindingStatus = (typeof mappingAuditFindingStatuses)[number];
export type JobStage = (typeof jobStages)[number];
export type OcrMode = (typeof ocrModes)[number];
export type BenchmarkSuite = (typeof benchmarkSuites)[number];
export type BenchmarkRunKind = (typeof benchmarkRunKinds)[number];
export type BenchmarkProviderMode = (typeof benchmarkProviderModes)[number];
export type BenchmarkReviewVerdict = (typeof benchmarkReviewVerdicts)[number];
export type BenchmarkSourceExpectationRole = (typeof benchmarkSourceExpectationRoles)[number];
export type BenchmarkSourceAnswerRole = (typeof benchmarkSourceAnswerRoles)[number];

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

export interface GlobalSettings {
  deepseekApiKey: string;
  aiBaseUrl: string;
  aiChatModel: string;
}

export interface GlobalSettingsView {
  deepseekApiKey: string;
  aiBaseUrl: string;
  aiChatModel: string;
}

export interface Document {
  id: string;
  libraryId: string;
  name: string;
  mediaType: string;
  createdAt: string;
  versions?: DocumentVersion[];
  latestVersion?: DocumentVersion;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  contentHash: string;
  storagePath: string;
  status: "queued" | "processing" | "completed" | "failed";
  indexStrategy: IndexStrategy;
  recordIndexingRationale: boolean;
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
  aoriContextPolicy?: AoriContextPolicy | undefined;
  aoriRationaleTrace?: AoriIndexingRationale[] | undefined;
  reflectiveIndexReport?: ReflectiveIndexReport | undefined;
  generatedAt: string;
}

export interface AoriContextPolicy {
  modelContextTokens: number;
  globalReadMaxInputTokens: number;
  minTruncatedContextTokens: number;
  evidenceBindingMinContextTokens: number;
  allowSmallContextOnlyForQuoteLookup: boolean;
}

export interface AoriIndexingRationale {
  stage: AoriIndexingStage;
  decisionType: AoriContextDecisionType;
  summary: string;
  inputTokenEstimate: number;
  usedTokenEstimate: number;
  omittedRanges: string[];
  preservedRanges: string[];
  risk: AoriRiskLevel;
}

export interface ReflectiveIndexReport {
  summary: string;
  completenessRisk: "none" | AoriRiskLevel;
  warnings: string[];
  truncationCount: number;
}

export interface IndexingRationaleTrace extends AoriIndexingRationale {
  id?: string | undefined;
  versionId?: string | undefined;
  createdAt?: string | undefined;
}

export interface AoriRationaleDebug {
  rationaleRequested: boolean;
  rationaleGenerated: boolean;
  rationaleSaved: boolean;
  rationaleCount: number;
  rationaleMissingReason: string | null;
}

export interface SourceRef {
  documentId?: string | undefined;
  versionId?: string | undefined;
  chunkId?: string | undefined;
  quote?: string | undefined;
  headingPath?: string | string[] | null | undefined;
  pageNumber?: number | null | undefined;
  reason?: string | undefined;
}

export interface DocumentUnderstanding {
  versionId: string;
  summary: string;
  centralQuestion: string;
  centralNodeTitle?: string | undefined;
  evidenceChunkIds: string[];
  evidenceStatus?: EvidenceStatus | undefined;
  closureStatus?: ClosureStatus | undefined;
  classificationRationale?: string | undefined;
  confidence?: number | undefined;
}

export interface AoriGapItem {
  id: string;
  aspectId?: string | null | undefined;
  description: string;
  severity: "low" | "medium" | "high";
  evidenceChunkIds: string[];
}

export interface ClosureReport {
  id: string;
  versionId: string;
  aspectId?: string | null | undefined;
  status: "closed" | "open" | "partial";
  itemCount: number;
  relationCount: number;
  gaps: AoriGapItem[];
  warnings: string[];
  checkedAt: string;
}

export interface AspectItem {
  id: string;
  versionId: string;
  aspectId: string;
  title: string;
  summary: string;
  sourceNodeIds: string[];
  evidenceChunkIds: string[];
  evidenceStatus: EvidenceStatus;
  closureStatus: ClosureStatus;
  fallbackOnly: boolean;
  classificationRationale: string;
  confidence: number;
}

export interface AspectRelation {
  id: string;
  versionId: string;
  aspectId: string;
  sourceItemId: string;
  targetItemId: string;
  relationName: string;
  domainRelation: string;
  baseRelation: RelationType;
  relationTextInSource?: string | undefined;
  normalizedRelation?: string | undefined;
  reason: string;
  confidence: number;
  evidenceChunkIds: string[];
  evidenceStatus: EvidenceStatus;
  closureStatus: ClosureStatus;
}

export interface Aspect {
  id: string;
  versionId: string;
  kind: AspectKind;
  domainKind: string;
  title: string;
  summary: string;
  centralQuestion: string;
  classificationRationale: string;
  confidence: number;
  evidenceStatus: EvidenceStatus;
  closureStatus: ClosureStatus;
  itemIds: string[];
  relationIds: string[];
  items: AspectItem[];
  relations: AspectRelation[];
  closureReport: ClosureReport;
}

export interface DocumentRelationLexiconEntry {
  relationName: string;
  domainRelation?: string | undefined;
  normalizedMeaning?: string | undefined;
  baseRelation: RelationType;
  confidence?: number | undefined;
  sourceExamples: Array<{
    relationId: string;
    evidenceChunkId: string;
    quote: string;
  }>;
}

export interface DocumentRelationLexicon {
  versionId: string;
  entries: DocumentRelationLexiconEntry[];
}

export interface SelfQuestion {
  id: string;
  versionId: string;
  question: string;
  answer?: string | undefined;
  evidenceChunkIds: string[];
  status: "answered" | "gap" | "unchecked";
}

export const semanticUnitKinds = [
  "table",
  "metric",
  "event",
  "causal_chain",
  "reconciliation",
  "negative_fact",
] as const;
export type SemanticUnitKind = (typeof semanticUnitKinds)[number];
export type SemanticUnitReflectionStatus = "ok" | "needs_review" | "conflicting" | "incomplete";

export interface SemanticUnitBase {
  id: string;
  kind: SemanticUnitKind;
  libraryId: string;
  documentId: string;
  versionId: string;
  title?: string | undefined;
  summary: string;
  sourceChunkIds: string[];
  sourceNodeIds?: string[] | undefined;
  confidence: number;
  reflectionStatus: SemanticUnitReflectionStatus;
  reflectionNotes?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SemanticUnitDraftBase {
  id?: string | undefined;
  kind: SemanticUnitKind;
  title?: string | undefined;
  summary: string;
  sourceChunkIds: string[];
  sourceNodeIds?: string[] | undefined;
  confidence: number;
  reflectionStatus: SemanticUnitReflectionStatus;
  reflectionNotes?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TableColumn {
  name: string;
  normalizedName?: string | undefined;
  unit?: string | undefined;
  semanticRole?: "label" | "metric" | "date" | "status" | "description" | "total" | "unknown" | undefined;
}

export interface TableCell {
  raw: string;
  value?: number | string | boolean | undefined;
  unit?: string | undefined;
  normalizedValue?: number | string | boolean | undefined;
}

export interface TableRow {
  id: string;
  ordinal: number;
  cells: Record<string, TableCell>;
  sourceChunkIds: string[];
}

export interface TableSemanticUnit extends SemanticUnitBase {
  kind: "table";
  tableTitle: string;
  sectionTitle?: string | undefined;
  columns: TableColumn[];
  rows: TableRow[];
  unitHints: string[];
  tableRole:
    | "financial_metric_table"
    | "status_table"
    | "change_table"
    | "composition_table"
    | "schedule_table"
    | "risk_table"
    | "unknown";
}

export interface TableSemanticUnitDraft extends SemanticUnitDraftBase {
  kind: "table";
  tableTitle: string;
  sectionTitle?: string | undefined;
  columns: TableColumn[];
  rows: TableRow[];
  unitHints: string[];
  tableRole:
    | "financial_metric_table"
    | "status_table"
    | "change_table"
    | "composition_table"
    | "schedule_table"
    | "risk_table"
    | "unknown";
}

export interface MetricSemanticUnit extends SemanticUnitBase {
  kind: "metric";
  metricName: string;
  tableId?: string | undefined;
  tableTitle?: string | undefined;
  columnName?: string | undefined;
  unit?: string | undefined;
  metricRole:
    | "balance"
    | "amount"
    | "change"
    | "planned"
    | "actual"
    | "remaining"
    | "total"
    | "ratio"
    | "status"
    | "unknown";
  aggregationAllowed: boolean;
  aggregationType?: "sum" | "count" | "average" | "none" | undefined;
}

export interface MetricSemanticUnitDraft extends SemanticUnitDraftBase {
  kind: "metric";
  metricName: string;
  tableId?: string | undefined;
  tableTitle?: string | undefined;
  columnName?: string | undefined;
  unit?: string | undefined;
  metricRole:
    | "balance"
    | "amount"
    | "change"
    | "planned"
    | "actual"
    | "remaining"
    | "total"
    | "ratio"
    | "status"
    | "unknown";
  aggregationAllowed: boolean;
  aggregationType?: "sum" | "count" | "average" | "none" | undefined;
}

export interface EventSemanticUnit extends SemanticUnitBase {
  kind: "event";
  eventName: string;
  eventCategory:
    | "policy_change"
    | "error_correction"
    | "contract_obligation"
    | "risk_event"
    | "approval_event"
    | "status_change"
    | "business_event"
    | "unknown";
  affectedItems: string[];
  sourceSectionTitle: string;
  excludes?: string[] | undefined;
}

export interface EventSemanticUnitDraft extends SemanticUnitDraftBase {
  kind: "event";
  eventName: string;
  eventCategory:
    | "policy_change"
    | "error_correction"
    | "contract_obligation"
    | "risk_event"
    | "approval_event"
    | "status_change"
    | "business_event"
    | "unknown";
  affectedItems: string[];
  sourceSectionTitle: string;
  excludes?: string[] | undefined;
}

export interface CausalChainSemanticUnit extends SemanticUnitBase {
  kind: "causal_chain";
  cause: string;
  mechanism?: string | undefined;
  effects: Array<{
    item: string;
    direction: "increase" | "decrease" | "reclassify" | "no_effect" | "unknown";
    amount?: number | undefined;
    unit?: string | undefined;
  }>;
  relatedEventId?: string | undefined;
  relatedTableIds?: string[] | undefined;
}

export interface CausalChainSemanticUnitDraft extends SemanticUnitDraftBase {
  kind: "causal_chain";
  cause: string;
  mechanism?: string | undefined;
  effects: Array<{
    item: string;
    direction: "increase" | "decrease" | "reclassify" | "no_effect" | "unknown";
    amount?: number | undefined;
    unit?: string | undefined;
  }>;
  relatedEventId?: string | undefined;
  relatedTableIds?: string[] | undefined;
}

export interface ReconciliationSemanticUnit extends SemanticUnitBase {
  kind: "reconciliation";
  name: string;
  sourceTableId?: string | undefined;
  sourceEventId?: string | undefined;
  formulaType: "sum" | "delta" | "reclassification" | "beginning_plus_changes_equals_ending";
  items: Array<{
    label: string;
    value: number;
    unit: string;
    sign: 1 | -1;
    sourceRowId?: string | undefined;
    sourceCellId?: string | undefined;
  }>;
  computedTotal: number;
  reportedTotal?: number | undefined;
  diff?: number | undefined;
  closed: boolean;
}

export interface ReconciliationSemanticUnitDraft extends SemanticUnitDraftBase {
  kind: "reconciliation";
  name: string;
  sourceTableId?: string | undefined;
  sourceEventId?: string | undefined;
  formulaType: "sum" | "delta" | "reclassification" | "beginning_plus_changes_equals_ending";
  items: Array<{
    label: string;
    value: number;
    unit: string;
    sign: 1 | -1;
    sourceRowId?: string | undefined;
    sourceCellId?: string | undefined;
  }>;
  computedTotal: number;
  reportedTotal?: number | undefined;
  diff?: number | undefined;
  closed: boolean;
}

export interface NegativeFactSemanticUnit extends SemanticUnitBase {
  kind: "negative_fact";
  target: string;
  predicate: string;
  scope: string;
  statement: string;
  certainty: "explicit" | "implicit";
}

export interface NegativeFactSemanticUnitDraft extends SemanticUnitDraftBase {
  kind: "negative_fact";
  target: string;
  predicate: string;
  scope: string;
  statement: string;
  certainty: "explicit" | "implicit";
}

export type SemanticUnit =
  | TableSemanticUnit
  | MetricSemanticUnit
  | EventSemanticUnit
  | CausalChainSemanticUnit
  | ReconciliationSemanticUnit
  | NegativeFactSemanticUnit;

export type SemanticUnitDraft =
  | TableSemanticUnitDraft
  | MetricSemanticUnitDraft
  | EventSemanticUnitDraft
  | CausalChainSemanticUnitDraft
  | ReconciliationSemanticUnitDraft
  | NegativeFactSemanticUnitDraft;

export interface ReflectiveFinding {
  id: string;
  semanticUnitId: string;
  findingType:
    | "incomplete_table"
    | "unit_mismatch"
    | "event_boundary_conflict"
    | "calculation_not_closed"
    | "ambiguous_scope"
    | "overlap_with_other_aspect"
    | "insufficient_source_evidence";
  severity: "low" | "medium" | "high";
  message: string;
}

export interface ReflectiveFindingDraft {
  id?: string | undefined;
  semanticUnitId: string;
  findingType: ReflectiveFinding["findingType"];
  severity: ReflectiveFinding["severity"];
  message: string;
}

export interface AoriDocumentIndex {
  available: true;
  versionId: string;
  libraryId: string;
  documentId: string;
  documentName: string;
  createdAt: string;
  understanding: DocumentUnderstanding;
  aspects: Aspect[];
  relationLexicon: DocumentRelationLexicon;
  closureReports: ClosureReport[];
  selfQuestions: SelfQuestion[];
  semanticUnits: SemanticUnit[];
  reflectiveFindings: ReflectiveFinding[];
  reflectiveReport: ReflectiveIndexReport;
  rationaleTrace: IndexingRationaleTrace[];
  rationaleDebug: AoriRationaleDebug;
}

export interface AoriUnavailable {
  available: false;
  message: string;
  indexStrategy?: IndexStrategy | undefined;
}

export type AoriDocumentResponse = AoriDocumentIndex | AoriUnavailable;

export interface AoriDocumentCatalogEntry {
  versionId: string;
  documentId: string;
  documentName: string;
  createdAt: string;
  indexStrategy: IndexStrategy;
  rationaleRequested: boolean;
}

export interface LibraryEntity {
  id: string;
  libraryId: string;
  canonicalName: string;
  aliases: string[];
  entityType: string;
  summary: string;
  firstSeenDocumentId: string;
  evidenceRefs: SourceRef[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryAspect {
  id: string;
  libraryId: string;
  title: string;
  kind: AspectKind;
  domainKind: string;
  summary: string;
  relatedDocumentAspectIds: string[];
  parentAspectId?: string | null | undefined;
  evidenceRefs: SourceRef[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryRelationLexiconEntry {
  id: string;
  libraryId: string;
  domainRelation: string;
  relationFamily: string;
  normalizedMeaning: string;
  examples: SourceRef[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryRelationAssertion {
  id: string;
  libraryId: string;
  sourceEntityId?: string | null | undefined;
  targetEntityId?: string | null | undefined;
  sourceAspectId?: string | null | undefined;
  targetAspectId?: string | null | undefined;
  domainRelation: string;
  relationFamily: string;
  assertionText: string;
  documentId: string;
  versionId: string;
  documentAspectId?: string | null | undefined;
  documentItemId?: string | null | undefined;
  documentRelationId?: string | null | undefined;
  timeScope?: string | null | undefined;
  chapterScope?: string | null | undefined;
  procedureStage?: string | null | undefined;
  evidenceChunkIds: string[];
  quote?: string | null | undefined;
  confidence: number;
  status: LibraryRelationAssertionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryRelation {
  id: string;
  libraryId: string;
  sourceId: string;
  targetId: string;
  aggregateRelation: string;
  relationFamily: string;
  summary: string;
  assertionIds: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntityAlignment {
  documentEntityName: string;
  libraryEntityId?: string | null | undefined;
  decision: LibraryEntityAlignmentDecision;
  reason: string;
  evidenceChunkIds: string[];
  confidence: number;
}

export interface AspectAlignment {
  documentAspectId: string;
  libraryAspectId?: string | null | undefined;
  decision: LibraryAspectAlignmentDecision;
  reason: string;
  confidence: number;
}

export interface RelationAlignment {
  documentRelation: string;
  libraryRelationId?: string | null | undefined;
  decision: LibraryRelationAlignmentDecision;
  relationFamily?: string | undefined;
  reason: string;
  confidence: number;
}

export interface RelationAssertionDraft {
  sourceEntityId?: string | null | undefined;
  targetEntityId?: string | null | undefined;
  sourceAspectId?: string | null | undefined;
  targetAspectId?: string | null | undefined;
  domainRelation: string;
  relationFamily: string;
  assertionText: string;
  documentAspectId?: string | null | undefined;
  documentItemId?: string | null | undefined;
  documentRelationId?: string | null | undefined;
  evidenceChunkIds: string[];
  quote?: string | null | undefined;
  confidence: number;
}

export interface AggregateUpdate {
  sourceId: string;
  targetId: string;
  aggregateRelation: string;
  relationFamily: string;
  assertionIds: string[];
  summary: string;
  confidence: number;
}

export interface LibraryMergePlan {
  id: string;
  libraryId: string;
  documentId: string;
  versionId: string;
  documentRelationToLibrary: {
    relationType: string;
    domainRelation: string;
    explanation: string;
    confidence: number;
  };
  entityAlignments: EntityAlignment[];
  aspectAlignments: AspectAlignment[];
  relationAlignments: RelationAlignment[];
  assertionsToAdd: RelationAssertionDraft[];
  aggregateUpdates: AggregateUpdate[];
  unresolvedQuestions: string[];
  applied: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryAoriProfile {
  available: true;
  libraryId: string;
  summary: string;
  entities: LibraryEntity[];
  aspects: LibraryAspect[];
  relationLexicon: LibraryRelationLexiconEntry[];
  assertions: LibraryRelationAssertion[];
  relations: LibraryRelation[];
  documentRelations: Array<{
    id: string;
    libraryId: string;
    documentId: string;
    versionId: string;
    relationType: string;
    domainRelation: string;
    explanation: string;
    confidence: number;
    createdAt: string;
  }>;
  mergePlans: LibraryMergePlan[];
  createdAt: string;
  updatedAt: string;
}

export interface LibraryAoriUnavailable {
  available: false;
  libraryId: string;
  message: string;
}

export type LibraryAoriResponse = LibraryAoriProfile | LibraryAoriUnavailable;

export interface AoriTraversalRelation {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  summary?: string | undefined;
  chunkIds: string[];
  confidence?: number | undefined;
}

export interface AoriTraversalNode {
  id: string;
  type: AoriTraversalNodeType;
  title: string;
  summary: string;
  documentId?: string | undefined;
  versionId?: string | undefined;
  aspectId?: string | undefined;
  aspectKind?: AspectKind | undefined;
  domainKind?: string | undefined;
  itemId?: string | undefined;
  parentIds: string[];
  childIds: string[];
  relationIds: string[];
  chunkIds: string[];
  closureStatus?: string | undefined;
  evidenceStatus?: string | undefined;
  confidence?: number | undefined;
}

export interface AoriTraversalMap {
  libraryId: string;
  globalSummary: string;
  centralQuestion?: string | undefined;
  rootNodes: AoriTraversalNode[];
  nodesById: Record<string, AoriTraversalNode>;
  relations: AoriTraversalRelation[];
  documentCards: Array<{
    documentId: string;
    versionId: string;
    documentName: string;
    summary: string;
    centralQuestion?: string | undefined;
  }>;
}

export type AoriSkillName =
  | "facet_count"
  | "facet_sum"
  | "argument_response"
  | "timeline"
  | "normal_traversal";

export interface AoriSkillRoute {
  skill: AoriSkillName;
  targetAspects: Array<{
    aspectId: string;
    title: string;
    reason: string;
  }>;
  requiredFields: string[];
  operationPlan: string;
  confidence: number;
  reason: string;
  ambiguity: string[];
}

export interface AoriSkillRouterInput {
  question: string;
  globalSummary: string;
  documentCards: AoriTraversalMap["documentCards"];
  aspects: Array<{
    aspectId: string;
    title: string;
    kind: string;
    domainKind: string;
    summary: string;
    centralQuestion?: string | undefined;
    itemCount: number;
  }>;
  relationLexicon?: Array<{
    domainRelation: string;
    relationFamily?: string | undefined;
    summary?: string | undefined;
  }> | undefined;
  selfQuestions?: Array<{
    question: string;
    answer?: string | undefined;
    status: string;
  }> | undefined;
}

export interface FacetFieldValue {
  value: unknown;
  confidence: number;
  evidenceChunkIds: string[];
  quote?: string | undefined;
}

export interface FacetFactRow {
  rowId: string;
  itemId: string;
  itemTitle: string;
  itemSummary: string;
  fields: Record<string, FacetFieldValue>;
  evidenceChunkIds: string[];
}

export interface FacetFactTable {
  aspectId: string;
  aspectTitle: string;
  rows: FacetFactRow[];
}

export interface FacetCountOperation {
  countTarget: "person" | "organization" | "source_group" | "event" | "unknown";
  filters: Array<{
    field: string;
    operator: "overlaps_time" | "equals" | "contains" | "exists";
    value: string;
  }>;
  dedupeBy: string[];
  countPolicy: string;
}

export interface FacetTimeFilterResult {
  match: "include" | "exclude" | "uncertain";
  reason: string;
}

export interface FacetCountResult {
  countPolicy: string;
  included: Array<{
    key: string;
    displayName: string;
    type: "person" | "organization" | "source_group" | "event" | "unknown";
    rowIds: string[];
    evidenceChunkIds: string[];
    quotes: string[];
    reason: string;
  }>;
  excluded: Array<{
    displayName: string;
    rowIds: string[];
    reason: string;
  }>;
  uncertain: Array<{
    displayName: string;
    rowIds: string[];
    reason: string;
  }>;
  finalCount: number;
}

export interface FacetFactRowExtractionInput {
  question: string;
  aspectTitle: string;
  requiredFields: string[];
  item: {
    id: string;
    title: string;
    summary: string;
  };
  chunks: Array<{
    id: string;
    text: string;
  }>;
}

export interface FacetCountOperationPlanInput {
  question: string;
  route: AoriSkillRoute;
  tablePreview: Array<{
    itemTitle: string;
    itemSummary: string;
  }>;
}

export interface FacetTimeFilterInput {
  question: string;
  filterValue: string;
  rowTimeValue: unknown;
  rowText: string;
}

export interface FacetCountDedupeInput {
  question: string;
  operation: FacetCountOperation;
  rows: FacetFactRow[];
  timeFilterResults?: Record<string, FacetTimeFilterResult> | undefined;
}

export interface FacetCountAnswerInput {
  question: string;
  route: AoriSkillRoute;
  table: FacetFactTable;
  operation: FacetCountOperation;
  result: FacetCountResult;
}

export interface DemandAnswerPlan {
  answerGoal: string;
  targetScope: {
    documentIds?: string[] | undefined;
    aspectIds?: string[] | undefined;
    nodeIds?: string[] | undefined;
    reason: string;
  };
  requiredRecords: Array<{
    recordName: string;
    source: "aspect_items" | "relations" | "chunks" | "document_summary";
    aspectId?: string | undefined;
    fields: Array<{
      name: string;
      description: string;
      required: boolean;
    }>;
    coverage: "single" | "some" | "all";
  }>;
  answerPolicy: {
    mustCiteSourceChunks: boolean;
    allowPartialAnswer: boolean;
    exposeUncertainty: boolean;
    whatCountsAsInsufficient: string;
  };
  reason: string;
  confidence: number;
}

export interface DemandAnswerPlanInput {
  question: string;
  globalSummary: string;
  documentCards: AoriTraversalMap["documentCards"];
  aspects: Array<{
    aspectId: string;
    title: string;
    kind: string;
    domainKind: string;
    summary: string;
    itemCount: number;
    items?: Array<{
      nodeId: string;
      itemId?: string | undefined;
      title: string;
      summary: string;
      chunkCount: number;
    }> | undefined;
  }>;
  relationLexicon?: Array<{
    domainRelation: string;
    summary?: string | undefined;
  }> | undefined;
}

export interface EvidenceRecordField {
  value: unknown;
  chunkId: string;
  confidence: number;
  evidenceChunkIds: string[];
  quote: string;
  uncertainty?: string | undefined;
}

export interface EvidenceRecord {
  recordId: string;
  recordName: string;
  sourceNodeId?: string | undefined;
  sourceAspectId?: string | undefined;
  sourceItemId?: string | undefined;
  fields: Record<string, EvidenceRecordField>;
  evidenceChunkIds: string[];
}

export interface DemandEvidenceRecordExtractionInput {
  question: string;
  recordSpec: DemandAnswerPlan["requiredRecords"][number];
  sourceItem: {
    id: string;
    title: string;
    summary: string;
  };
  chunks: Array<{
    id: string;
    text: string;
  }>;
}

export interface DemandAnswerSynthesisInput {
  question: string;
  plan: DemandAnswerPlan;
  records: EvidenceRecord[];
}

export interface BfsExpansionInput {
  question: string;
  globalSummary: string;
  currentDepth: number;
  currentLayer: Array<{
    nodeId: string;
    title: string;
    type: string;
    summary: string;
    closureStatus?: string | undefined;
    evidenceStatus?: string | undefined;
    childCount: number;
    chunkCount: number;
  }>;
  relationsAmongCurrentLayer: Array<{
    sourceNodeId: string;
    targetNodeId: string;
    label: string;
    summary?: string | undefined;
  }>;
}

export interface BfsExpansionDecision {
  decisions: Array<{
    nodeId: string;
    decision: "need" | "maybe" | "skip";
    answerRelevant: boolean;
    shouldCollectChunks: boolean;
    reason: string;
  }>;
  stopTraversal: boolean;
  stopReason?: string | undefined;
}

export interface DfsStepInput {
  question: string;
  globalSummary: string;
  currentNode: {
    nodeId: string;
    title: string;
    type: string;
    summary: string;
    chunkCount: number;
    childCount: number;
  };
  path: Array<{
    nodeId: string;
    title: string;
    relation?: string | undefined;
    summary: string;
    reason: string;
  }>;
  candidates: Array<{
    nodeId: string;
    title: string;
    type: string;
    summary: string;
    relationFromCurrent?: string | undefined;
    childCount: number;
    chunkCount: number;
  }>;
}

export interface DfsStepDecision {
  selectedNextNodeIds: string[];
  recordCurrentChunks: boolean;
  backtrack: boolean;
  stopTraversal: boolean;
  reason: string;
}

export interface ChunkEvidencePack {
  question: string;
  mode: "bfs_full" | "dfs_pulse";
  selectedChunks: Array<{
    chunkId: string;
    sourceNodeId?: string | undefined;
    documentId?: string | undefined;
    versionId?: string | undefined;
    path: Array<{
      nodeId: string;
      title: string;
      relation?: string | undefined;
      summary: string;
      decision: "need" | "maybe" | "selected";
      reason: string;
    }>;
    retrievalSummary: string;
    relevanceReason: string;
    confidence: number;
  }>;
  skippedNodes: Array<{
    nodeId: string;
    title: string;
    reason: string;
  }>;
  unresolvedQuestions: string[];
  diagnostics: {
    visitedNodeCount: number;
    selectedChunkCount: number;
    stoppedReason?: string | undefined;
  };
}

export interface ChunkSummaryInput {
  question: string;
  chunkId: string;
  chunkText: string;
  retrievalTrace: {
    sourceNodeId?: string | undefined;
    path: ChunkEvidencePack["selectedChunks"][number]["path"];
    retrievalSummary: string;
    relevanceReason: string;
  };
}

export interface ChunkAnswerSummary {
  chunkId: string;
  relevant: boolean;
  shortSummary: string;
  supportedFacts: string[];
  unsupportedClaims: string[];
  keyQuotes: string[];
  confidence: number;
  usage?: "answer_core" | "supporting_detail" | "background_only" | "irrelevant" | undefined;
}

export interface FinalAnswerFromChunksInput {
  question: string;
  evidencePack: ChunkEvidencePack;
  chunkSummaries: ChunkAnswerSummary[];
  chunks: Array<{
    id: string;
    text: string;
    documentId: string;
    versionId: string;
  }>;
}

export interface AoriGraphNode {
  id: string;
  type:
    | "document_center"
    | "aspect"
    | "aspect_item"
    | "relation"
    | "gap"
    | "self_question"
    | "source_chunk"
    | "warning"
    | "library_center"
    | "entity"
    | "library_aspect"
    | "relation_assertion"
    | "document"
    | "evidence"
    | "aggregate_relation";
  label: string;
  summary?: string | undefined;
  aspectId?: string | undefined;
  itemId?: string | undefined;
  relationId?: string | undefined;
  assertionId?: string | undefined;
  entityId?: string | undefined;
  documentId?: string | undefined;
  chunkId?: string | undefined;
  kind?: AspectKind | undefined;
  domainKind?: string | undefined;
  evidenceStatus?: EvidenceStatus | undefined;
  closureStatus?: ClosureStatus | undefined;
  fallbackOnly?: boolean | undefined;
  confidence?: number | undefined;
}

export interface AoriGraphEdge {
  id: string;
  source: string;
  target: string;
  type:
    | "contains"
    | "relates"
    | "evidence"
    | "has_gap"
    | "asks"
    | "warning"
    | "has_aspect"
    | "contains_item"
    | "asserts_relation"
    | "evidence_for"
    | "same_as"
    | "updates"
    | "challenges"
    | "responds_to"
    | "aggregate_relation";
  label: string;
  baseRelation?: RelationType | undefined;
  domainRelation?: string | undefined;
  assertionIds?: string[] | undefined;
  evidenceStatus?: EvidenceStatus | undefined;
  closureStatus?: ClosureStatus | undefined;
  confidence?: number | undefined;
}

export interface AoriGraphGroup {
  id: string;
  label: string;
  aspectId: string;
  kind: AspectKind;
  domainKind: string;
  nodeIds: string[];
  evidenceStatus: EvidenceStatus;
  closureStatus: ClosureStatus;
}

export interface AoriLayoutHints {
  mode: "overview" | "detail" | "hybrid";
  scope?: AoriGraphScope | undefined;
  viewMode?: AoriGraphViewMode | undefined;
  centerNodeId: string;
  layers: Record<string, number>;
  collapsedNodeIds: string[];
}

export interface AoriGraphDiagnostics {
  hasAori: boolean;
  aspectCount: number;
  itemCount: number;
  relationCount: number;
  aspectKindDistribution: Record<string, number>;
  domainKindTopK: Array<{ label: string; count: number }>;
  domainRelationTopK: Array<{ label: string; count: number }>;
  closureDistribution: Record<string, number>;
  unsupportedItemCount: number;
  fallbackOnlyItemCount: number;
  isolatedItemCount: number;
  legacyProjectionOtherRatio: number;
  warnings: string[];
}

export interface AoriGraphView {
  versionId: string;
  documentId: string;
  centerNode: AoriGraphNode;
  groups: AoriGraphGroup[];
  nodes: AoriGraphNode[];
  edges: AoriGraphEdge[];
  layoutHints: AoriLayoutHints;
  diagnostics: AoriGraphDiagnostics;
}

export interface AoriDocumentDraft {
  understanding: Omit<DocumentUnderstanding, "versionId">;
  aspects: Array<{
    kind: AspectKind;
    domainKind: string;
    title: string;
    summary: string;
    centralQuestion: string;
    classificationRationale: string;
    confidence: number;
    closureStatus?: ClosureStatus | undefined;
    items: Array<{
      key: string;
      title: string;
      summary: string;
      evidenceChunkIds: string[];
      sourceNodeIds?: string[] | undefined;
      evidenceStatus?: EvidenceStatus | undefined;
      closureStatus?: ClosureStatus | undefined;
      fallbackOnly?: boolean | undefined;
      classificationRationale?: string | undefined;
      confidence?: number | undefined;
    }>;
    relations: Array<{
      sourceKey: string;
      targetKey: string;
      domainRelation?: string | undefined;
      relationTextInSource?: string | undefined;
      normalizedRelation?: string | undefined;
      baseRelation: RelationType;
      reason: string;
      confidence: number;
      evidenceChunkIds: string[];
      evidenceStatus?: EvidenceStatus | undefined;
      closureStatus?: ClosureStatus | undefined;
    }>;
    gaps?: Array<{
      description: string;
      severity: "low" | "medium" | "high";
      evidenceChunkIds?: string[] | undefined;
    }> | undefined;
  }>;
  semanticUnits?: SemanticUnitDraft[] | undefined;
  reflectiveFindings?: ReflectiveFindingDraft[] | undefined;
  selfQuestions: Array<{
    question: string;
    answer?: string | undefined;
    evidenceChunkIds: string[];
    status: "answered" | "gap" | "unchecked";
  }>;
  reflectiveReport: ReflectiveIndexReport;
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
  indexStrategy: IndexStrategy;
  recordIndexingRationale: boolean;
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
  metrics?: PulseMetrics | undefined;
}

export interface PulseMetrics {
  durationMs: number;
  startedAt: string;
  completedAt: string;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number | undefined;
  promptCacheMissTokens?: number | undefined;
  promptCacheHitRate?: number | undefined;
  modelUsageCalls?: ModelUsageCall[] | undefined;
}

export interface ModelUsageMetrics {
  model: string;
  path: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number | undefined;
  promptCacheMissTokens?: number | undefined;
}

export interface ModelUsageCall extends ModelUsageMetrics {
  sequence: number;
  recordedAt: string;
  promptCacheHitRate?: number | undefined;
}

export interface ModelUsageMetricsCollector {
  onModelUsage(metrics: ModelUsageMetrics): void;
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
  | { type: "model_usage"; message: string; payload: ModelUsageCall }
  | {
    type:
      | "library_route_started"
      | "document_selected"
      | "question_task_generated"
      | "aspect_selected"
      | "library_relation_selected"
      | "assertion_selected"
      | "aori_evidence_bound"
      | "fallback_retrieval_started"
      | "evidence_table_built"
      | "closure_checked"
      | "answer_synthesized"
      | "aori_traversal_started"
      | "bfs_layer_started"
      | "bfs_node_decision"
      | "bfs_node_expanded"
      | "bfs_chunk_collected"
      | "bfs_layer_finished"
      | "dfs_node_entered"
      | "dfs_candidate_selected"
      | "dfs_chunk_found"
      | "dfs_backtrack"
      | "chunk_summary_started"
      | "chunk_summary_finished"
      | "final_answer_started"
      | "final_answer_finished"
      | "skill_route_generated"
      | "skill_execution_started"
      | "facet_table_build_started"
      | "facet_row_extracted"
      | "facet_table_build_finished"
      | "facet_operation_planned"
      | "facet_filter_applied"
      | "facet_dedupe_finished"
      | "skill_answer_synthesized"
      | "demand_plan_generated"
      | "demand_records_started"
      | "demand_record_extracted"
      | "demand_answer_synthesized";
    message: string;
    payload?: unknown;
  }
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

export type QuestionType =
  | "numeric_aggregation"
  | "concept_boundary"
  | "event_effect"
  | "negative_fact"
  | "exhaustive_list"
  | "general_qa";

export interface SemanticTarget {
  questionType: QuestionType;
  targetDescription: string;
  constraints: {
    aggregation?: "sum" | "count" | "average" | "compare" | "none" | undefined;
    unit?: string | undefined;
    timeScope?: string | undefined;
    requireCompleteSet?: boolean | undefined;
  };
  rawQuestion: string;
}

export interface AspectCandidate {
  aspectId: string;
  aspectKind: SemanticUnitKind;
  title: string;
  summary: string;
  metadata: Record<string, unknown>;
  sourceChunkIds: string[];
  retrievalScore: number;
}

export interface AspectCandidateDecision {
  aspectId: string;
  decision: "selected" | "rejected";
  reason: string;
  confidence: number;
}

export interface QuestionAspectPlan {
  questionType: QuestionType;
  target: SemanticTarget;
  selectedAspects: AspectCandidateDecision[];
  rejectedAspects: AspectCandidateDecision[];
  execution: {
    strategy: "deterministic_numeric" | "table_exhaustive" | "event_boundary" | "negative_fact" | "concept_boundary" | "fallback_demand";
    aggregation?: "sum" | "count" | "average" | "compare" | "none" | undefined;
    unit?: string | undefined;
    requireCompleteEvidence: boolean;
  };
  confidence: number;
}

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
  | "getGraphContext"
  | "routeAoriSkill"
  | "extractFacetFactRows"
  | "planFacetCountOperation"
  | "applyFacetCountFilters"
  | "dedupeFacetCountRows"
  | "synthesizeFacetCountAnswer"
  | "planDemandAnswer"
  | "extractEvidenceRecords"
  | "synthesizeDemandAnswer";

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
  answerScope?: AnswerScope | undefined;
  riskLevel: "low" | "medium" | "high";
  reasoning: string;
}

export interface QuestionTask {
  question: string;
  taskType: QuestionTaskType;
  targetSubjects: string[];
  targetObjects: string[];
  expectedAnswerShape: ExpectedAnswerShape;
  requiredEvidenceRoles: GenericEvidenceRole[];
  exclusionRoles: GenericEvidenceRole[];
  ambiguityNotes: string[];
  needsDedupe: boolean;
  needsReconciliation: boolean;
  needsPerspectiveOrAuthority: boolean;
  mustExposeGaps: boolean;
  rationale: string;
  confidence: number;
}

export interface QuestionTaskFrame {
  userQuestion: string;
  taskIntent: {
    shortName: string;
    naturalLanguageGoal: string;
    whyThisIsTheGoal: string;
  };
  answerContract: {
    expectedForm: string;
    mustInclude: string[];
    mustExclude: string[];
    uncertaintyPolicy: string;
  };
  scopeContract: {
    targetSubjects: string[];
    targetObjects: string[];
    includedAspects: string[];
    excludedAspects: string[];
    boundaryQuestions: string[];
  };
  evidenceContract: {
    requiredEvidenceKinds: string[];
    requiredAuthorityKinds: string[];
    sourceBindingRequired: boolean;
    quoteRequired: boolean;
  };
  operationPlan: Array<{
    name: string;
    purpose: string;
    inputNeeded: string[];
    outputExpected: string;
  }>;
  riskAssessment: {
    ambiguity: string[];
    likelyFailureModes: string[];
    verificationNeeded: string[];
  };
  confidence: number;
  legacyTaskType?: QuestionTaskType | undefined;
}

export interface RoutePlan {
  routeType: string;
  selectedDocuments: Array<{
    documentId: string;
    versionId: string;
    role: string;
    reason: string;
  }>;
  excludedDocuments: Array<{
    documentId: string;
    reason: string;
  }>;
  selectedLibraryAspects: string[];
  selectedLibraryEntities: string[];
  selectedLibraryRelations: string[];
  selectedAssertions: string[];
  crossDocumentOperations: string[];
  ambiguity: string[];
  confidence: number;
}

export interface RetrievalTask {
  id: string;
  purpose: RetrievalTaskPurpose;
  query: string;
  targetRoles: GenericEvidenceRole[];
  excludeRoles?: GenericEvidenceRole[] | undefined;
  requiredContext: RetrievalTaskContext;
  expectedOutput: RetrievalTaskOutput;
  rationale: string;
}

export interface SemanticClassificationReview {
  itemId: string;
  accepted: boolean;
  correctedLabel?: string | undefined;
  reason: string;
  requiredAdditionalEvidence?: string[] | undefined;
  risk: SemanticReviewRisk;
}

export interface AnswerScope {
  question: string;
  answerShape: "summary" | "list" | "comparison" | "timeline" | "evidence" | "relation" | "numeric" | "mixed";
  targetLabels: string[];
  aspectIds: string[];
  aspectItemIds: string[];
  themeNodeIds: string[];
  centerNodeIds: string[];
  summaryNodeIds: string[];
  versionIds: string[];
  reasoning: string;
}

export interface ScopeClosureReport {
  status: "closed" | "open" | "partial";
  answerScope: AnswerScope;
  nodeIds: string[];
  relationIds: string[];
  chunkIds: string[];
  aspectIds: string[];
  aspectItemIds: string[];
  aspectRelationIds: string[];
  gaps: PulseEvidenceGap[];
  warnings: string[];
  generatedAt: string;
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
  authority?: EvidenceAuthority | undefined;
  usage?: EvidenceUsage | undefined;
  classificationRationale?: string | undefined;
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
  actualIndexProfile?: ActiveIndexProfile | undefined;
  targetType?: VectorTargetType | "legacy_chunk" | undefined;
  buildId?: string | undefined;
  outputRetrievalUnitIds?: string[] | undefined;
  fallbackReason?: string | undefined;
  newEvidenceRowCount: number;
  status: "success" | "empty" | "error" | "skipped";
}

export interface EvidencePack {
  id: string;
  question: string;
  evidencePackSchemaVersion?: 1 | 2 | undefined;
  pipeline?: {
    indexProfile: ActiveIndexProfile;
    packBuilder: "legacy" | "v2" | "aori_traversal" | "aori_skill" | "aori_demand" | "aori_semantic";
    model: string;
    promptVersion: string;
  } | undefined;
  pipelineVersion?: PipelineVersion | undefined;
  answerMode?: AnswerMode | undefined;
  answerModeReason?: string | undefined;
  answerModeOverridden?: boolean | undefined;
  questionPlan?: PulseQuestionPlan | undefined;
  questionTask?: QuestionTask | undefined;
  questionTaskFrame?: QuestionTaskFrame | undefined;
  routePlan?: RoutePlan | undefined;
  selectedLibraryAspects?: LibraryAspect[] | undefined;
  selectedDocumentAori?: AoriDocumentIndex[] | undefined;
  selectedAssertions?: LibraryRelationAssertion[] | undefined;
  fallbackRetrieval?: RetrievalTrace[] | undefined;
  evidenceTables?: EvidenceTable[] | undefined;
  closureChecks?: Array<{ id: string; status: ClosureStatus; summary: string; gapIds: string[] }> | undefined;
  verifiedGaps?: PulseEvidenceGap[] | undefined;
  refutedGaps?: PulseEvidenceGap[] | undefined;
  answerInputs?: string[] | undefined;
  chunkEvidencePack?: ChunkEvidencePack | undefined;
  chunkSummaries?: ChunkAnswerSummary[] | undefined;
  answerScope?: AnswerScope | undefined;
  scopeClosureReport?: ScopeClosureReport | undefined;
  semanticClassificationReviews?: SemanticClassificationReview[] | undefined;
  usageGateRejectedRows?: Array<{ rowId: string; reason: string }> | undefined;
  finalAnswerInputs?: string[] | undefined;
  usedIndexProfile?: ActiveIndexProfile | undefined;
  sufficiencyHistory?: PulseEvidenceStatus[] | undefined;
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
  diagnostics?: Record<string, unknown> | undefined;
}

export interface EvidenceTable {
  id: string;
  type: EvidenceTableType;
  title: string;
  rows: PulseEvidenceRow[];
  sourceAssertionIds?: string[] | undefined;
  sourceAspectIds?: string[] | undefined;
  sourceDocumentIds?: string[] | undefined;
  closureStatus: ClosureStatus;
  gaps: PulseEvidenceGap[];
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
  questionTask?: QuestionTask | undefined;
  questionTaskFrame?: QuestionTaskFrame | undefined;
  routePlan?: RoutePlan | undefined;
  selectedLibraryAspects?: LibraryAspect[] | undefined;
  selectedDocumentAori?: AoriDocumentIndex[] | undefined;
  selectedAssertions?: LibraryRelationAssertion[] | undefined;
  fallbackRetrieval?: RetrievalTrace[] | undefined;
  evidenceTables?: EvidenceTable[] | undefined;
  closureChecks?: Array<{ id: string; status: ClosureStatus; summary: string; gapIds: string[] }> | undefined;
  verifiedGaps?: PulseEvidenceGap[] | undefined;
  refutedGaps?: PulseEvidenceGap[] | undefined;
  answerInputs?: string[] | undefined;
  retrievalTasks?: RetrievalTask[] | undefined;
  semanticClassificationReviews?: SemanticClassificationReview[] | undefined;
  usageGateRejectedRows?: Array<{ rowId: string; reason: string }> | undefined;
  finalAnswerInputs?: string[] | undefined;
  answerScope?: AnswerScope | undefined;
  scopeClosureReport?: ScopeClosureReport | undefined;
  collectedChunks: Array<{ id: string; versionId: string; text: string; headingPath: string | null; pageNumber: number | null; ordinal: number; parentChunkId?: string | null; documentTreeNodeId?: string | null; nodeType?: DocumentTreeNodeType | null }>;
  legacyChunks?: Array<{ id: string; versionId: string; text: string; headingPath: string | null; pageNumber: number | null; ordinal: number; parentChunkId?: string | null; documentTreeNodeId?: string | null; nodeType?: DocumentTreeNodeType | null }> | undefined;
  contextUnits?: ContextUnit[] | undefined;
  retrievalUnits?: RetrievalUnit[] | undefined;
  contextBlocks?: ContextBlock[] | undefined;
  usedIndexProfile?: ActiveIndexProfile | undefined;
  graphNodes: Array<{ id: string; title: string; summary: string }>;
  graphRelations: Array<{ id: string; type: RelationType; sourceTitle: string; targetTitle: string; reason: string }>;
  aoriAspects?: Aspect[] | undefined;
  aoriAspectItems?: AspectItem[] | undefined;
  aoriAspectRelations?: AspectRelation[] | undefined;
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

export interface NumericAnswerVerification {
  passed: boolean;
  computedTotal: number;
  answerTotal?: number | undefined;
  issues: string[];
}

export interface PulseAnswerOutput {
  answer: string;
  summary: string;
  evidenceStatus?: PulseEvidenceStatus | undefined;
  diagnostics?: {
    questionPlan?: PulseQuestionPlan | undefined;
    questionTask?: QuestionTask | undefined;
    questionTaskFrame?: QuestionTaskFrame | undefined;
    routePlan?: RoutePlan | undefined;
    selectedAssertions?: LibraryRelationAssertion[] | undefined;
    evidenceTables?: EvidenceTable[] | undefined;
    closureChecks?: Array<{ id: string; status: ClosureStatus; summary: string; gapIds: string[] }> | undefined;
    verifiedGaps?: PulseEvidenceGap[] | undefined;
    refutedGaps?: PulseEvidenceGap[] | undefined;
    retrievalTasks?: RetrievalTask[] | undefined;
    semanticClassificationReviews?: SemanticClassificationReview[] | undefined;
    usageGateRejectedRows?: Array<{ rowId: string; reason: string }> | undefined;
    finalAnswerInputs?: string[] | undefined;
    answerScope?: AnswerScope | undefined;
    scopeClosureReport?: ScopeClosureReport | undefined;
    retrievalSteps?: PulseEvidenceStep[] | undefined;
    citedChunkIds?: string[] | undefined;
    warnings?: string[] | undefined;
    answerPipeline?: "aori_demand" | "aori_skill" | "aori_traversal" | "aori_semantic" | undefined;
    selectedSkill?: AoriSkillName | undefined;
    skillRoute?: AoriSkillRoute | undefined;
    targetAspects?: AoriSkillRoute["targetAspects"] | undefined;
    questionAspectPlan?: QuestionAspectPlan | undefined;
    semanticUnitsUsed?: SemanticUnit[] | undefined;
    calculatorResult?: unknown;
    answerVerification?: NumericAnswerVerification | undefined;
    fallbackReason?: string | undefined;
    demandPlan?: DemandAnswerPlan | undefined;
    evidenceRecords?: EvidenceRecord[] | undefined;
    facetFactTable?: FacetFactTable | undefined;
    facetOperation?: unknown;
    facetResult?: unknown;
    argumentResult?: unknown;
    timelineResult?: unknown;
    structuredResult?: unknown;
    sourceChunkIds?: string[] | undefined;
    fallbackTraversalUsed?: boolean | undefined;
    skillRouteFallback?: boolean | undefined;
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

export interface BenchmarkSuiteCatalogEntry {
  suite: BenchmarkSuite;
  label: string;
  kind: BenchmarkRunKind;
  focus: string[];
}

export interface BenchmarkScenarioCatalogEntry {
  name: string;
  benchmarkSuites: BenchmarkSuite[];
  language: "en" | "zh";
  question: string;
}

export interface BenchmarkCatalog {
  suites: BenchmarkSuiteCatalogEntry[];
  scenarios: BenchmarkScenarioCatalogEntry[];
}

export interface BenchmarkSourceItem {
  title: string;
  text: string;
  summary?: string | undefined;
}

export interface BenchmarkEvidenceRecordFieldTrace {
  fieldName: string;
  value?: unknown;
  chunkId?: string | undefined;
  evidenceChunkIds: string[];
  quote?: string | undefined;
}

export interface BenchmarkEvidenceRecordTrace {
  recordName: string;
  evidenceChunkIds: string[];
  fields: BenchmarkEvidenceRecordFieldTrace[];
}

export interface BenchmarkSemanticUnitTrace {
  id: string;
  kind: SemanticUnitKind;
  title?: string | undefined;
  confidence?: number | undefined;
  reflectionStatus?: SemanticUnitReflectionStatus | undefined;
}

export interface BenchmarkSemanticTrace {
  questionAspectPlan?: QuestionAspectPlan | undefined;
  semanticUnitsUsed: BenchmarkSemanticUnitTrace[];
  calculatorResult?: unknown;
  answerVerification?: NumericAnswerVerification | undefined;
  fallbackReason?: string | undefined;
}

export interface BenchmarkEvidenceTrace {
  citationChunkIds: string[];
  selectedChunkIds: string[];
  evidenceRecordChunkIds: string[];
  citations: EvidenceCitation[];
  evidenceRecords: BenchmarkEvidenceRecordTrace[];
  semanticTrace?: BenchmarkSemanticTrace | undefined;
}

export interface BenchmarkAnswerReviewDifference {
  aspect: string;
  expected: string;
  actual: string;
  impact: string;
}

export interface BenchmarkAnswerReviewSourceComparison {
  sourceTitle: string;
  sourceTextExcerpt: string;
  expectedRole: BenchmarkSourceExpectationRole;
  actualRole: BenchmarkSourceAnswerRole;
  note: string;
}

export interface BenchmarkAnswerReview {
  verdict: BenchmarkReviewVerdict;
  summary: string;
  expectedAnswerSummary: string;
  actualAnswerSummary: string;
  matchedExpected: string[];
  missingExpected: string[];
  unexpectedAnswerPoints: string[];
  differences: BenchmarkAnswerReviewDifference[];
  sourceComparisons: BenchmarkAnswerReviewSourceComparison[];
  improvementActions: string[];
}

export interface BenchmarkRunRecord {
  scenario: string;
  suites: BenchmarkSuite[];
  language: "en" | "zh";
  iteration: number;
  question: string;
  sourceItems?: BenchmarkSourceItem[] | undefined;
  evidenceTrace?: BenchmarkEvidenceTrace | undefined;
  testsetAnswers?: string[] | undefined;
  expectedAnswerIncludes: string[];
  expectedAnswerExcludes: string[];
  actualAnswer: string;
  actualSummary: string;
  answerReview?: BenchmarkAnswerReview | undefined;
  strictPass: boolean;
  structuralPass: boolean;
  answerCoverage: number;
  answerMisses: string[];
  answerExcludesViolated: string[];
  citationRecall: number;
  citationPrecision: number;
  gapPrecision: number;
  ragasFaithfulness: number;
  ragasAnswerRelevancy: number;
  ragasContextPrecision: number;
  ragasContextRecall: number;
  aresAnswerFaithfulness: number;
  aresAnswerRelevance: number;
  aresContextRelevance: number;
  durationMs: number;
  wallClockMs: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  promptCacheHitRate?: number | undefined;
}

export interface BenchmarkScenarioSummary {
  scenario: string;
  runs: number;
  strictPassRate: number;
  structuralPassRate: number;
  avgAnswerCoverage: number;
  avgCitationRecall: number;
  avgCitationPrecision: number;
  avgGapPrecision: number;
  avgRagasFaithfulness: number;
  avgRagasAnswerRelevancy: number;
  avgRagasContextPrecision: number;
  avgRagasContextRecall: number;
  avgAresAnswerFaithfulness: number;
  avgAresAnswerRelevance: number;
  avgAresContextRelevance: number;
  avgDurationMs: number;
  avgWallClockMs: number;
  avgModelCalls: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
  avgTotalTokens: number;
  avgPromptCacheHitTokens: number;
  avgPromptCacheMissTokens: number;
  avgPromptCacheHitRate?: number | undefined;
  latestAnswerMisses: string[];
  latestAnswerExcludesViolated: string[];
}

export interface BenchmarkSuiteSummary {
  suite: BenchmarkSuite;
  label: string;
  kind: BenchmarkRunKind;
  runs: number;
  strictPassRate: number;
  structuralPassRate: number;
  avgAnswerCoverage: number;
  avgCitationRecall: number;
  avgCitationPrecision: number;
  avgGapPrecision: number;
  avgRagasFaithfulness: number;
  avgRagasAnswerRelevancy: number;
  avgRagasContextPrecision: number;
  avgRagasContextRecall: number;
  avgAresAnswerFaithfulness: number;
  avgAresAnswerRelevance: number;
  avgAresContextRelevance: number;
  avgDurationMs: number;
  avgTotalTokens: number;
}

export interface BenchmarkOverallSummary {
  runs: number;
  strictPassRate: number;
  structuralPassRate: number;
  avgAnswerCoverage: number;
  avgCitationRecall: number;
  avgCitationPrecision: number;
  avgGapPrecision: number;
  avgRagasFaithfulness: number;
  avgRagasAnswerRelevancy: number;
  avgRagasContextPrecision: number;
  avgRagasContextRecall: number;
  avgAresAnswerFaithfulness: number;
  avgAresAnswerRelevance: number;
  avgAresContextRelevance: number;
  avgDurationMs: number;
  avgWallClockMs: number;
  avgTotalTokens: number;
  avgPromptCacheHitRate?: number | undefined;
}

export interface BenchmarkRunResult {
  id: string;
  path: string;
  createdAt: string;
  label?: string | undefined;
  libraryId?: string | undefined;
  methodology: {
    benchmarkTarget: string;
    benchmarkAssumption: string;
    caveat: string;
  };
  providerMode: BenchmarkProviderMode;
  providerLabel: string;
  mode: PulseInputMode;
  iterations: number;
  requestedSuites: BenchmarkSuite[];
  requestedScenarios: string[];
  benchmarkSuites: BenchmarkSuiteSummary[];
  scenarioSummaries: BenchmarkScenarioSummary[];
  overall: BenchmarkOverallSummary;
  records: BenchmarkRunRecord[];
}

export interface BenchmarkRunListEntry {
  id: string;
  path: string;
  createdAt: string;
  label?: string | undefined;
  libraryId?: string | undefined;
  providerMode: BenchmarkProviderMode;
  providerLabel: string;
  mode: PulseInputMode;
  iterations: number;
  requestedSuites: BenchmarkSuite[];
  requestedScenarios: string[];
  benchmarkSuites: BenchmarkSuite[];
  languages: Array<"en" | "zh">;
  overall: BenchmarkOverallSummary;
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

export const createBenchmarkRunSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  provider: z.enum(benchmarkProviderModes).default("configured"),
  mode: z.enum(pulseInputModes).default("full"),
  iterations: z.coerce.number().int().min(1).max(5).default(1),
  suites: z.array(z.enum(benchmarkSuites)).max(benchmarkSuites.length).default([]),
  scenarioNames: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
});
export type CreateBenchmarkRunInput = z.infer<typeof createBenchmarkRunSchema>;

export const benchmarkAnswerReviewSchema = z.object({
  verdict: z.enum(benchmarkReviewVerdicts),
  summary: z.string().trim().min(1).max(1200),
  expectedAnswerSummary: z.string().trim().min(1).max(1200),
  actualAnswerSummary: z.string().trim().min(1).max(1200),
  matchedExpected: z.array(z.string().trim().min(1).max(400)).max(20),
  missingExpected: z.array(z.string().trim().min(1).max(400)).max(20),
  unexpectedAnswerPoints: z.array(z.string().trim().min(1).max(400)).max(20),
  differences: z.array(z.object({
    aspect: z.string().trim().min(1).max(120),
    expected: z.string().trim().min(1).max(600),
    actual: z.string().trim().min(1).max(600),
    impact: z.string().trim().min(1).max(800),
  })).max(12),
  sourceComparisons: z.array(z.object({
    sourceTitle: z.string().trim().min(1).max(200),
    sourceTextExcerpt: z.string().trim().min(1).max(800),
    expectedRole: z.enum(benchmarkSourceExpectationRoles),
    actualRole: z.enum(benchmarkSourceAnswerRoles),
    note: z.string().trim().min(1).max(800),
  })).max(30),
  improvementActions: z.array(z.string().trim().min(1).max(500)).max(10),
});
export type BenchmarkAnswerReviewOutput = z.infer<typeof benchmarkAnswerReviewSchema>;

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

export const updateGlobalSettingsSchema = z.object({
  deepseekApiKey: z.string().trim().optional(),
  aiBaseUrl: z.string().trim().optional(),
  aiChatModel: z.string().trim().optional(),
});
export type UpdateGlobalSettingsInput = z.infer<typeof updateGlobalSettingsSchema>;

export const indexStrategySchema = z.enum(indexStrategies);

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

export const answerScopeSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  answerShape: z.enum(["summary", "list", "comparison", "timeline", "evidence", "relation", "numeric", "mixed"]),
  targetLabels: z.array(z.string().trim().min(1).max(200)).default([]),
  aspectIds: z.array(z.string().trim().min(1)).default([]),
  aspectItemIds: z.array(z.string().trim().min(1)).default([]),
  themeNodeIds: z.array(z.string().trim().min(1)).default([]),
  centerNodeIds: z.array(z.string().trim().min(1)).default([]),
  summaryNodeIds: z.array(z.string().trim().min(1)).default([]),
  versionIds: z.array(z.string().trim().min(1)).default([]),
  reasoning: z.string().trim().min(1).max(2000),
});

export const questionTaskSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  taskType: z.enum(questionTaskTypes),
  targetSubjects: z.array(z.string().trim().min(1).max(200)).default([]),
  targetObjects: z.array(z.string().trim().min(1).max(200)).default([]),
  expectedAnswerShape: z.enum(expectedAnswerShapes),
  requiredEvidenceRoles: z.array(z.enum(genericEvidenceRoles)).default([]),
  exclusionRoles: z.array(z.enum(genericEvidenceRoles)).default([]),
  ambiguityNotes: z.array(z.string().trim().min(1).max(500)).default([]),
  needsDedupe: z.boolean(),
  needsReconciliation: z.boolean(),
  needsPerspectiveOrAuthority: z.boolean(),
  mustExposeGaps: z.boolean(),
  rationale: z.string().trim().min(1).max(2000),
  confidence: z.coerce.number().min(0).max(1),
});

export const retrievalTaskSchema = z.object({
  id: z.string().trim().min(1).max(120),
  purpose: z.enum(retrievalTaskPurposes),
  query: z.string().trim().max(1000).default(""),
  targetRoles: z.array(z.enum(genericEvidenceRoles)).default([]),
  excludeRoles: z.array(z.enum(genericEvidenceRoles)).optional(),
  requiredContext: z.enum(retrievalTaskContexts),
  expectedOutput: z.enum(retrievalTaskOutputs),
  rationale: z.string().trim().min(1).max(1200),
});

export const semanticClassificationReviewSchema = z.object({
  itemId: z.string().trim().min(1),
  accepted: z.boolean(),
  correctedLabel: z.string().trim().min(1).max(120).optional(),
  reason: z.string().trim().min(1).max(1000),
  requiredAdditionalEvidence: z.array(z.string().trim().min(1).max(500)).optional(),
  risk: z.enum(semanticReviewRisks),
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
  answerScope: answerScopeSchema.optional(),
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
  "planDemandAnswer",
  "extractEvidenceRecords",
  "synthesizeDemandAnswer",
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
  authority: z.enum(evidenceAuthorities).optional(),
  usage: z.enum(evidenceUsages).optional(),
  classificationRationale: z.string().trim().max(1000).optional(),
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

export const scopeClosureReportSchema = z.object({
  status: z.enum(["closed", "open", "partial"]),
  answerScope: answerScopeSchema,
  nodeIds: z.array(z.string().trim().min(1)).default([]),
  relationIds: z.array(z.string().trim().min(1)).default([]),
  chunkIds: z.array(z.string().trim().min(1)).default([]),
  aspectIds: z.array(z.string().trim().min(1)).default([]),
  aspectItemIds: z.array(z.string().trim().min(1)).default([]),
  aspectRelationIds: z.array(z.string().trim().min(1)).default([]),
  gaps: z.array(pulseEvidenceGapSchema).default([]),
  warnings: z.array(z.string().trim().min(1).max(500)).default([]),
  generatedAt: z.string().trim().min(1),
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
    questionTask: questionTaskSchema.optional(),
    retrievalTasks: z.array(retrievalTaskSchema).optional(),
    semanticClassificationReviews: z.array(semanticClassificationReviewSchema).optional(),
    usageGateRejectedRows: z.array(z.object({
      rowId: z.string().trim().min(1),
      reason: z.string().trim().min(1).max(500),
    })).optional(),
    finalAnswerInputs: z.array(z.string().trim().min(1).max(500)).optional(),
    answerScope: answerScopeSchema.optional(),
    scopeClosureReport: scopeClosureReportSchema.optional(),
    retrievalSteps: z.array(pulseEvidenceStepSchema).optional(),
    citedChunkIds: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  }).passthrough().optional(),
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

export const reflectiveIndexReportSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  completenessRisk: z.enum(["none", ...aoriRiskLevels]),
  warnings: z.array(z.string().trim().min(1).max(500)).default([]),
  truncationCount: z.coerce.number().int().min(0).default(0),
});

export const aoriDocumentDraftSchema = z.object({
  understanding: z.object({
    summary: z.string().trim().min(1).max(4000),
    centralQuestion: z.string().trim().min(1).max(1000),
    centralNodeTitle: z.string().trim().min(1).max(240).optional(),
    evidenceChunkIds: z.array(z.string().trim().min(1)).default([]),
    evidenceStatus: z.enum(evidenceStatuses).optional(),
    closureStatus: z.enum(closureStatuses).optional(),
    classificationRationale: z.string().trim().max(1000).optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
  }),
  aspects: z.array(z.object({
    kind: z.enum(aspectKinds).default("other"),
    domainKind: z.string().trim().min(1).max(120).default("unknown"),
    title: z.string().trim().min(1).max(240),
    summary: z.string().trim().min(1).max(3000),
    centralQuestion: z.string().trim().min(1).max(1000),
    classificationRationale: z.string().trim().min(1).max(1000).default("Model did not provide an aspect classification rationale."),
    confidence: z.coerce.number().min(0).max(1).default(0.3),
    closureStatus: z.enum(closureStatuses).optional(),
    items: z.array(z.object({
      key: z.string().trim().min(1).max(100),
      title: z.string().trim().min(1).max(240),
      summary: z.string().trim().min(1).max(2000),
      evidenceChunkIds: z.array(z.string().trim().min(1)).default([]),
      sourceNodeIds: z.array(z.string().trim().min(1)).optional(),
      evidenceStatus: z.enum(evidenceStatuses).optional(),
      closureStatus: z.enum(closureStatuses).optional(),
      fallbackOnly: z.boolean().optional(),
      classificationRationale: z.string().trim().max(1000).optional(),
      confidence: z.coerce.number().min(0).max(1).optional(),
    })).default([]),
    relations: z.array(z.object({
      sourceKey: z.string().trim().min(1).max(100),
      targetKey: z.string().trim().min(1).max(100),
      domainRelation: z.string().trim().min(1).max(240).optional(),
      relationTextInSource: z.string().trim().min(1).max(240).optional(),
      normalizedRelation: z.string().trim().min(1).max(240).optional(),
      baseRelation: z.enum(relationTypes).default("related_to"),
      reason: z.string().trim().min(1).max(1000),
      confidence: z.coerce.number().min(0).max(1).default(0.6),
      evidenceChunkIds: z.array(z.string().trim().min(1)).default([]),
      evidenceStatus: z.enum(evidenceStatuses).optional(),
      closureStatus: z.enum(closureStatuses).optional(),
    })).default([]),
    gaps: z.array(z.object({
      description: z.string().trim().min(1).max(1000),
      severity: z.enum(["low", "medium", "high"]).default("medium"),
      evidenceChunkIds: z.array(z.string().trim().min(1)).optional(),
    })).optional(),
  })).default([]),
  semanticUnits: z.array(z.union([
    z.object({
      kind: z.literal("table"),
      title: z.string().trim().max(240).optional(),
      summary: z.string().trim().min(1).max(3000),
      sourceChunkIds: z.array(z.string().trim().min(1)).default([]),
      sourceNodeIds: z.array(z.string().trim().min(1)).optional(),
      confidence: z.coerce.number().min(0).max(1).default(0.3),
      reflectionStatus: z.enum(["ok", "needs_review", "conflicting", "incomplete"]).default("needs_review"),
      reflectionNotes: z.array(z.string().trim().min(1).max(500)).optional(),
      metadata: z.record(z.unknown()).optional(),
      tableTitle: z.string().trim().min(1).max(240),
      sectionTitle: z.string().trim().min(1).max(240).optional(),
      columns: z.array(z.object({
        name: z.string().trim().min(1).max(120),
        normalizedName: z.string().trim().min(1).max(120).optional(),
        unit: z.string().trim().min(1).max(40).optional(),
        semanticRole: z.enum(["label", "metric", "date", "status", "description", "total", "unknown"]).optional(),
      })).default([]),
      rows: z.array(z.object({
        id: z.string().trim().min(1).max(120),
        ordinal: z.coerce.number().int().min(0),
        cells: z.record(z.object({
          raw: z.string(),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
          unit: z.string().trim().min(1).max(40).optional(),
          normalizedValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
        })),
        sourceChunkIds: z.array(z.string().trim().min(1)).default([]),
      })).default([]),
      unitHints: z.array(z.string().trim().min(1).max(80)).default([]),
      tableRole: z.enum(["financial_metric_table", "status_table", "change_table", "composition_table", "schedule_table", "risk_table", "unknown"]).default("unknown"),
    }),
    z.object({
      kind: z.literal("metric"),
      title: z.string().trim().max(240).optional(),
      summary: z.string().trim().min(1).max(3000),
      sourceChunkIds: z.array(z.string().trim().min(1)).default([]),
      sourceNodeIds: z.array(z.string().trim().min(1)).optional(),
      confidence: z.coerce.number().min(0).max(1).default(0.3),
      reflectionStatus: z.enum(["ok", "needs_review", "conflicting", "incomplete"]).default("needs_review"),
      reflectionNotes: z.array(z.string().trim().min(1).max(500)).optional(),
      metadata: z.record(z.unknown()).optional(),
      metricName: z.string().trim().min(1).max(240),
      tableId: z.string().trim().min(1).max(120).optional(),
      tableTitle: z.string().trim().min(1).max(240).optional(),
      columnName: z.string().trim().min(1).max(120).optional(),
      unit: z.string().trim().min(1).max(40).optional(),
      metricRole: z.enum(["balance", "amount", "change", "planned", "actual", "remaining", "total", "ratio", "status", "unknown"]).default("unknown"),
      aggregationAllowed: z.boolean().default(false),
      aggregationType: z.enum(["sum", "count", "average", "none"]).optional(),
    }),
    z.object({
      kind: z.literal("event"),
      title: z.string().trim().max(240).optional(),
      summary: z.string().trim().min(1).max(3000),
      sourceChunkIds: z.array(z.string().trim().min(1)).default([]),
      sourceNodeIds: z.array(z.string().trim().min(1)).optional(),
      confidence: z.coerce.number().min(0).max(1).default(0.3),
      reflectionStatus: z.enum(["ok", "needs_review", "conflicting", "incomplete"]).default("needs_review"),
      reflectionNotes: z.array(z.string().trim().min(1).max(500)).optional(),
      metadata: z.record(z.unknown()).optional(),
      eventName: z.string().trim().min(1).max(240),
      eventCategory: z.enum(["policy_change", "error_correction", "contract_obligation", "risk_event", "approval_event", "status_change", "business_event", "unknown"]).default("unknown"),
      affectedItems: z.array(z.string().trim().min(1).max(240)).default([]),
      sourceSectionTitle: z.string().trim().min(1).max(240),
      excludes: z.array(z.string().trim().min(1).max(240)).optional(),
    }),
    z.object({
      kind: z.literal("causal_chain"),
      title: z.string().trim().max(240).optional(),
      summary: z.string().trim().min(1).max(3000),
      sourceChunkIds: z.array(z.string().trim().min(1)).default([]),
      sourceNodeIds: z.array(z.string().trim().min(1)).optional(),
      confidence: z.coerce.number().min(0).max(1).default(0.3),
      reflectionStatus: z.enum(["ok", "needs_review", "conflicting", "incomplete"]).default("needs_review"),
      reflectionNotes: z.array(z.string().trim().min(1).max(500)).optional(),
      metadata: z.record(z.unknown()).optional(),
      cause: z.string().trim().min(1).max(500),
      mechanism: z.string().trim().min(1).max(1000).optional(),
      effects: z.array(z.object({
        item: z.string().trim().min(1).max(240),
        direction: z.enum(["increase", "decrease", "reclassify", "no_effect", "unknown"]).default("unknown"),
        amount: z.coerce.number().optional(),
        unit: z.string().trim().min(1).max(40).optional(),
      })).default([]),
      relatedEventId: z.string().trim().min(1).max(120).optional(),
      relatedTableIds: z.array(z.string().trim().min(1).max(120)).optional(),
    }),
    z.object({
      kind: z.literal("reconciliation"),
      title: z.string().trim().max(240).optional(),
      summary: z.string().trim().min(1).max(3000),
      sourceChunkIds: z.array(z.string().trim().min(1)).default([]),
      sourceNodeIds: z.array(z.string().trim().min(1)).optional(),
      confidence: z.coerce.number().min(0).max(1).default(0.3),
      reflectionStatus: z.enum(["ok", "needs_review", "conflicting", "incomplete"]).default("needs_review"),
      reflectionNotes: z.array(z.string().trim().min(1).max(500)).optional(),
      metadata: z.record(z.unknown()).optional(),
      name: z.string().trim().min(1).max(240),
      sourceTableId: z.string().trim().min(1).max(120).optional(),
      sourceEventId: z.string().trim().min(1).max(120).optional(),
      formulaType: z.enum(["sum", "delta", "reclassification", "beginning_plus_changes_equals_ending"]).default("sum"),
      items: z.array(z.object({
        label: z.string().trim().min(1).max(240),
        value: z.coerce.number(),
        unit: z.string().trim().min(1).max(40),
        sign: z.union([z.literal(1), z.literal(-1)]).default(1),
        sourceRowId: z.string().trim().min(1).max(120).optional(),
        sourceCellId: z.string().trim().min(1).max(120).optional(),
      })).default([]),
      computedTotal: z.coerce.number(),
      reportedTotal: z.coerce.number().optional(),
      diff: z.coerce.number().optional(),
      closed: z.boolean().default(false),
    }),
    z.object({
      kind: z.literal("negative_fact"),
      title: z.string().trim().max(240).optional(),
      summary: z.string().trim().min(1).max(3000),
      sourceChunkIds: z.array(z.string().trim().min(1)).default([]),
      sourceNodeIds: z.array(z.string().trim().min(1)).optional(),
      confidence: z.coerce.number().min(0).max(1).default(0.3),
      reflectionStatus: z.enum(["ok", "needs_review", "conflicting", "incomplete"]).default("needs_review"),
      reflectionNotes: z.array(z.string().trim().min(1).max(500)).optional(),
      metadata: z.record(z.unknown()).optional(),
      target: z.string().trim().min(1).max(240),
      predicate: z.string().trim().min(1).max(240),
      scope: z.string().trim().min(1).max(240),
      statement: z.string().trim().min(1).max(2000),
      certainty: z.enum(["explicit", "implicit"]),
    }),
  ])).default([]),
  reflectiveFindings: z.array(z.object({
    id: z.string().trim().min(1).max(120),
    semanticUnitId: z.string().trim().min(1).max(120),
    findingType: z.enum(["incomplete_table", "unit_mismatch", "event_boundary_conflict", "calculation_not_closed", "ambiguous_scope", "overlap_with_other_aspect", "insufficient_source_evidence"]),
    severity: z.enum(["low", "medium", "high"]),
    message: z.string().trim().min(1).max(1000),
  })).default([]),
  selfQuestions: z.array(z.object({
    question: z.string().trim().min(1).max(1000),
    answer: z.string().trim().min(1).max(2000).optional(),
    evidenceChunkIds: z.array(z.string().trim().min(1)).default([]),
    status: z.enum(["answered", "gap", "unchecked"]).default("unchecked"),
  })).default([]),
  reflectiveReport: reflectiveIndexReportSchema,
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
