import type {
  AoriDocumentIndex,
  Chunk,
  ClosureStatus,
  EvidenceTable,
  LibraryAspect,
  LibraryRelationAssertion,
  PulseEvidenceGap,
  PulseEvidenceRow,
  PulseQuestionPlan,
  QuestionTaskFrame,
  RoutePlan,
} from "@agent-thinking/contracts";
import type { AgentDatabase } from "../db.js";

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function terms(value: string): string[] {
  return [...new Set(normalizeText(value).split(/[\s,，。；;:：、]+/).filter((term) => term.length > 0))].slice(0, 24);
}

function scoreText(text: string, question: string): number {
  const normalized = normalizeText(text);
  const queryTerms = terms(question);
  if (queryTerms.length === 0) return 0;
  let score = normalized.includes(normalizeText(question)) ? 0.45 : 0;
  for (const term of queryTerms) if (normalized.includes(term)) score += Math.min(0.16, term.length * 0.025);
  return Math.min(1, score);
}

function answerShape(plan: PulseQuestionPlan): EvidenceTable["type"] {
  if (plan.requiresNumericalReconciliation || plan.questionType === "numerical_aggregation") return "AmountFactTable";
  if (plan.requiresTimelineCompleteness || plan.questionType === "timeline") return "TimelineFactTable";
  if (plan.questionType === "comparison" || plan.questionType === "critique") return "CrossDocumentComparisonTable";
  if (plan.questionType === "entity_relation" || plan.questionType === "causal_explanation") return "EntityRelationTable";
  if (plan.questionType === "claim_support") return "ArgumentFactTable";
  return "EventFactTable";
}

function routeType(plan: PulseQuestionPlan, selectedDocumentCount: number): string {
  if (selectedDocumentCount > 1 && plan.questionType === "comparison") return "multi_document_comparison";
  if (selectedDocumentCount > 1) return "multi_document_parallel";
  if (plan.questionType === "critique") return "cross_document_conflict_check";
  if (selectedDocumentCount === 1) return "single_document";
  return "needs_clarification";
}

function rowForAssertion(assertion: LibraryRelationAssertion, chunk: Chunk | undefined): PulseEvidenceRow | undefined {
  const evidenceChunkId = assertion.evidenceChunkIds[0] ?? chunk?.id;
  if (!evidenceChunkId) return undefined;
  return {
    rowId: `aori-row-${assertion.id}`,
    evidenceType: "entity_relation",
    claimText: assertion.assertionText,
    sourceEntity: assertion.sourceEntityId ?? undefined,
    targetEntity: assertion.targetEntityId ?? undefined,
    relationType: assertion.domainRelation,
    evidenceChunkId,
    evidenceQuote: assertion.quote?.trim() || chunk?.text.slice(0, 500) || assertion.assertionText,
    role: "direct_fact",
    authority: "documentary_record",
    usage: assertion.status === "uncertain" ? "supporting_detail" : "answer_core",
    classificationRationale: "Seeded from Library AORI relation assertion before fallback retrieval.",
    confidence: assertion.confidence,
    documentId: assertion.documentId,
    versionId: assertion.versionId,
    warnings: assertion.status === "uncertain" ? ["aori_assertion_uncertain"] : [],
  };
}

export interface AoriRouteAssembly {
  routePlan: RoutePlan;
  questionTaskFrame: QuestionTaskFrame;
  chunks: Chunk[];
  selectedDocumentAori: AoriDocumentIndex[];
  selectedLibraryAspects: LibraryAspect[];
  selectedAssertions: LibraryRelationAssertion[];
  evidenceTables: EvidenceTable[];
  closureChecks: Array<{ id: string; status: ClosureStatus; summary: string; gapIds: string[] }>;
  verifiedGaps: PulseEvidenceGap[];
  refutedGaps: PulseEvidenceGap[];
}

export class AoriQuestionRouter {
  constructor(private readonly db: AgentDatabase) {}

  route(libraryId: string, question: string, questionPlan: PulseQuestionPlan): AoriRouteAssembly {
    const libraryAori = this.db.getLibraryAoriProfile(libraryId);
    const documentAori = this.db.listAoriDocumentIndexes(libraryId);
    const selectedAssertions = libraryAori.available
      ? libraryAori.assertions
        .map((assertion) => ({
          assertion,
          score: scoreText(`${assertion.assertionText}\n${assertion.domainRelation}\n${assertion.quote ?? ""}`, question),
        }))
        .filter((entry) => entry.score > 0.02)
        .sort((left, right) => right.score - left.score)
        .slice(0, 24)
        .map((entry) => entry.assertion)
      : [];
    const assertionVersionIds = new Set(selectedAssertions.map((assertion) => assertion.versionId));
    const scoredDocuments = documentAori
      .map((index) => ({
        index,
        score: Math.max(
          scoreText(`${index.documentName}\n${index.understanding.summary}\n${index.understanding.centralQuestion}`, question),
          ...index.aspects.map((aspect) => scoreText(`${aspect.title}\n${aspect.summary}\n${aspect.centralQuestion}`, question)),
          assertionVersionIds.has(index.versionId) ? 0.9 : 0,
        ),
      }))
      .filter((entry) => entry.score > 0.02 || assertionVersionIds.has(entry.index.versionId))
      .sort((left, right) => right.score - left.score);
    const selectedDocumentAori = scoredDocuments.length > 0
      ? scoredDocuments.slice(0, questionPlan.questionType === "summary" ? 6 : 4).map((entry) => entry.index)
      : documentAori.slice(0, Math.min(4, documentAori.length));
    const selectedVersionIds = new Set(selectedDocumentAori.map((index) => index.versionId));
    const selectedLibraryAspects = libraryAori.available
      ? libraryAori.aspects.filter((aspect) =>
        aspect.relatedDocumentAspectIds.some((aspectId) =>
          selectedDocumentAori.some((index) => index.aspects.some((documentAspect) => documentAspect.id === aspectId)),
        ) || scoreText(`${aspect.title}\n${aspect.summary}\n${aspect.domainKind}`, question) > 0.02,
      ).slice(0, 20)
      : [];
    const selectedChunkIds = [
      ...selectedAssertions.flatMap((assertion) => assertion.evidenceChunkIds),
      ...selectedDocumentAori.flatMap((index) => index.aspects.flatMap((aspect) => [
        ...aspect.items.flatMap((item) => item.evidenceChunkIds),
        ...aspect.relations.flatMap((relation) => relation.evidenceChunkIds),
      ])),
    ];
    const chunks = this.db.getChunksByIds([...new Set(selectedChunkIds)]).slice(0, 40);
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const rows = selectedAssertions.flatMap((assertion) => {
      const chunk = assertion.evidenceChunkIds.flatMap((chunkId) => chunkById.get(chunkId) ?? [])[0];
      const row = rowForAssertion(assertion, chunk);
      return row ? [row] : [];
    });
    const gaps: PulseEvidenceGap[] = chunks.length === 0
      ? [{
        type: "unsupported_claim",
        description: "AORI route selected structure but did not find source-bound evidence chunks.",
        suggestedQueries: [question],
        severity: "high",
      }]
      : [];
    const table: EvidenceTable = {
      id: `aori-evidence-table-${Date.now()}`,
      type: answerShape(questionPlan),
      title: "AORI Evidence Assembly",
      rows,
      sourceAssertionIds: selectedAssertions.map((assertion) => assertion.id),
      sourceAspectIds: selectedLibraryAspects.map((aspect) => aspect.id),
      sourceDocumentIds: selectedDocumentAori.map((index) => index.documentId),
      closureStatus: gaps.length === 0 && rows.length > 0 ? "partial" : "open",
      gaps,
    };
    const route: RoutePlan = {
      routeType: routeType(questionPlan, selectedDocumentAori.length),
      selectedDocuments: selectedDocumentAori.map((index) => ({
        documentId: index.documentId,
        versionId: index.versionId,
        role: assertionVersionIds.has(index.versionId) ? "assertion_source" : "aori_context",
        reason: "Selected by AORI route from document understanding, aspects, and library assertions.",
      })),
      excludedDocuments: documentAori
        .filter((index) => !selectedVersionIds.has(index.versionId))
        .map((index) => ({ documentId: index.documentId, reason: "Lower AORI route score for this question." })),
      selectedLibraryAspects: selectedLibraryAspects.map((aspect) => aspect.id),
      selectedLibraryEntities: libraryAori.available
        ? [...new Set(selectedAssertions.flatMap((assertion) => [assertion.sourceEntityId, assertion.targetEntityId]).filter((id): id is string => Boolean(id)))]
        : [],
      selectedLibraryRelations: libraryAori.available
        ? libraryAori.relations.filter((relation) => relation.assertionIds.some((id) => selectedAssertions.some((assertion) => assertion.id === id))).map((relation) => relation.id)
        : [],
      selectedAssertions: selectedAssertions.map((assertion) => assertion.id),
      crossDocumentOperations: selectedDocumentAori.length > 1 ? ["compare_selected_aori_documents", "assemble_cross_document_assertions"] : [],
      ambiguity: selectedDocumentAori.length === 0 ? ["No AORI document matched the question strongly."] : [],
      confidence: chunks.length > 0 ? 0.72 : 0.35,
    };
    const frame: QuestionTaskFrame = {
      userQuestion: question,
      taskIntent: {
        shortName: questionPlan.questionType,
        naturalLanguageGoal: `Answer using AORI-selected ${selectedDocumentAori.length > 1 ? "documents" : "document"} and source-bound evidence.`,
        whyThisIsTheGoal: questionPlan.reasoning,
      },
      answerContract: {
        expectedForm: table.type,
        mustInclude: questionPlan.expectedEvidenceTypes,
        mustExclude: ["unsupported AORI gaps", "fallbackOnly evidence"],
        uncertaintyPolicy: questionPlan.answerMustExposeGaps ? "Expose gaps explicitly before answering completely." : "State uncertainty when source-bound rows are thin.",
      },
      scopeContract: {
        targetSubjects: questionPlan.keyEntities,
        targetObjects: questionPlan.evidenceTargets,
        includedAspects: selectedLibraryAspects.map((aspect) => aspect.title),
        excludedAspects: [],
        boundaryQuestions: route.ambiguity,
      },
      evidenceContract: {
        requiredEvidenceKinds: questionPlan.expectedEvidenceTypes,
        requiredAuthorityKinds: ["source_bound_aori", "documentary_record"],
        sourceBindingRequired: true,
        quoteRequired: questionPlan.requiresSourceQuotes,
      },
      operationPlan: [
        {
          name: "AORI route",
          purpose: "Select documents, aspects, library relations, and assertions before fallback retrieval.",
          inputNeeded: ["Library AORI", "Document AORI", "user question"],
          outputExpected: "RoutePlan",
        },
        {
          name: "AORI evidence assembly",
          purpose: "Bind selected AORI structures back to evidence chunks and rows.",
          inputNeeded: ["selected assertions", "selected document aspects"],
          outputExpected: table.type,
        },
      ],
      riskAssessment: {
        ambiguity: route.ambiguity,
        likelyFailureModes: gaps.map((gap) => gap.description),
        verificationNeeded: ["closure_check", "gap_verification", "evidence_usage_gate"],
      },
      confidence: route.confidence,
      legacyTaskType: questionPlan.questionType === "comparison" ? "argument_comparison" : "mixed",
    };
    return {
      routePlan: route,
      questionTaskFrame: frame,
      chunks,
      selectedDocumentAori,
      selectedLibraryAspects,
      selectedAssertions,
      evidenceTables: [table],
      closureChecks: [{
        id: `aori-closure-${Date.now()}`,
        status: table.closureStatus,
        summary: gaps.length === 0 ? "AORI evidence assembly found source-bound chunks." : "AORI evidence assembly has open gaps.",
        gapIds: gaps.map((gap) => gap.description),
      }],
      verifiedGaps: [],
      refutedGaps: [],
    };
  }
}
