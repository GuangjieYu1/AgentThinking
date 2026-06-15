import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import publicCmrc2018DevSubset from "./public-cmrc2018-dev-subset.json";
import type {
  Chunk,
  DemandAnswerPlan,
  DemandAnswerSynthesisInput,
  EvidenceRecord,
  PulseAnswerOutput,
  PulseInputMode,
  PulseStreamEvent,
  SearchResult,
} from "@agent-thinking/contracts";
import { AgentDatabase } from "../../src/db.js";
import { buildAoriDocumentIndex } from "../../src/services/aori.js";
import type { ModelProvider } from "../../src/services/models.js";
import { FakeModelProvider } from "../../src/services/models.js";
import { PulseEngine } from "../../src/services/pulse.js";
import { VectorStore } from "../../src/services/vector-store.js";

const temporaryDirectories: string[] = [];

export async function createEvalDatabase(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-aori-pulse-eval-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

export async function cleanupEvalDatabases(): Promise<void> {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface EvalWorkspace {
  db: AgentDatabase;
  libraryId: string;
  closeWhenDone: boolean;
}

export class NoLegacyRetrievalVectorStore extends VectorStore {
  override search(): SearchResult[] {
    throw new Error("AORI/Pulse eval cases must not fall back to legacy semantic retrieval.");
  }
}

export class EvalModelProvider extends FakeModelProvider {
  override async planDemandAnswer(input: Parameters<FakeModelProvider["planDemandAnswer"]>[0]): Promise<DemandAnswerPlan> {
    if (/exact date/i.test(input.question)) {
      const base = await super.planDemandAnswer(input);
      const target = input.aspects
        .filter((aspect) => aspect.itemCount > 0)
        .sort((left, right) => right.itemCount - left.itemCount)[0];
      return {
        ...base,
        requiredRecords: [{
          recordName: "date_records",
          source: "aspect_items",
          ...(target ? { aspectId: target.aspectId } : {}),
          fields: [
            { name: "source_name", description: "Source person or organization.", required: true },
            { name: "time_range", description: "Exact date or time range for the event.", required: true },
            { name: "evidence", description: "Source quote supporting the date.", required: true },
          ],
          coverage: "all",
        }],
      };
    }
    return super.planDemandAnswer(input);
  }

  override async synthesizeDemandAnswer(input: DemandAnswerSynthesisInput): Promise<PulseAnswerOutput> {
    const hasUsefulValue = input.records.some((record) =>
      Object.values(record.fields).some((field) => {
        const value = field.value;
        return value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0);
      })
    );
    const missingRequiredRecords = input.records.filter((record) =>
      input.plan.requiredRecords.some((spec) =>
        spec.fields
          .filter((field) => field.required)
          .some((field) => {
            const value = record.fields[field.name]?.value;
            return value === null || value === undefined || (Array.isArray(value) && value.length === 0) || value === "";
          })
      )
    );

    if (!hasUsefulValue || (/exact date/i.test(input.question) && missingRequiredRecords.length > 0)) {
      return {
        answer: `Evidence is insufficient: ${input.plan.answerPolicy.whatCountsAsInsufficient}`,
        summary: "Demand answer found an evidence gap in the public dataset eval fixture.",
        diagnostics: {
          answerPipeline: "aori_demand",
          demandPlan: input.plan,
          evidenceRecords: input.records,
          sourceChunkIds: uniqueStrings(input.records.flatMap((record) => record.evidenceChunkIds)),
          fallbackTraversalUsed: false,
          skillRouteFallback: true,
          verifiedGaps: [{
            type: "missing_itemized_evidence",
            description: input.plan.answerPolicy.whatCountsAsInsufficient,
            suggestedQueries: [input.question],
            severity: "high",
          }],
        },
      };
    }

    return super.synthesizeDemandAnswer(input);
  }
}

interface EvalItem {
  title: string;
  text: string;
  summary?: string | undefined;
}

export type BenchmarkSuite = "kilt" | "crag" | "ragbench" | "crud_rag" | "ragas" | "ares";

export const aoriPulseBenchmarkSuites = {
  kilt: {
    label: "KILT-style provenance QA",
    kind: "dataset",
    focus: ["answer correctness", "provenance", "source-bound evidence"],
  },
  crag: {
    label: "CRAG-style robustness QA",
    kind: "dataset",
    focus: ["abstention", "uncertainty exposure", "retrieval robustness"],
  },
  ragbench: {
    label: "RAGBench-style end-to-end QA",
    kind: "dataset",
    focus: ["grounded answer quality", "multi-step evidence use", "pipeline stability"],
  },
  crud_rag: {
    label: "CMRC 2018 public subset",
    kind: "dataset",
    focus: ["public dataset subset", "Chinese source handling", "citation support", "faithful structured answers"],
  },
  ragas: {
    label: "RAGAS-style automatic scoring",
    kind: "scoring",
    focus: ["faithfulness", "answer relevancy", "context precision", "context recall"],
  },
  ares: {
    label: "ARES-style automatic scoring",
    kind: "scoring",
    focus: ["answer faithfulness", "answer relevance", "context relevance"],
  },
} satisfies Record<BenchmarkSuite, {
  label: string;
  kind: "dataset" | "scoring";
  focus: string[];
}>;

export interface EvalScenario {
  name: string;
  benchmarkSuites: BenchmarkSuite[];
  language: "en" | "zh";
  question: string;
  items: EvalItem[];
  expected: {
    testsetAnswers: string[];
    answerIncludes: string[];
    answerExcludes?: string[] | undefined;
    recordCount: number;
    selectedChunkCount: number;
    gapCount?: number | undefined;
  };
}

interface PublicDatasetQaFixture {
  dataset: string;
  split: string;
  license: string;
  sourceUrl: string;
  articleId: string;
  questionId: string;
  title: string;
  question: string;
  contextExcerpt: string;
  answers: string[];
  evidence: string;
}

const PUBLIC_EVAL_TARGET_COUNT = 25;

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function normalizeContextExcerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function publicSourceText(entry: PublicDatasetQaFixture): string {
  return normalizeContextExcerpt(entry.contextExcerpt);
}

function publicScenarioName(entry: PublicDatasetQaFixture): string {
  const slug = entry.questionId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `cmrc2018-${slug}`;
}

function toPublicEvalScenario(entry: PublicDatasetQaFixture): EvalScenario {
  return {
    name: publicScenarioName(entry),
    benchmarkSuites: ["crud_rag", "ragas", "ares"],
    language: "zh",
    question: entry.question,
    items: [{
      title: entry.title,
      text: publicSourceText(entry),
      summary: entry.contextExcerpt,
    }],
    expected: {
      testsetAnswers: entry.answers,
      answerIncludes: entry.answers,
      answerExcludes: [
        "Evidence is insufficient",
        "No source-bound records or no required field values were extracted.",
      ],
      recordCount: 1,
      selectedChunkCount: 1,
      gapCount: 0,
    },
  };
}

function buildPublicEvalScenarios(entries: PublicDatasetQaFixture[]): EvalScenario[] {
  if (entries.length === 0) return [];
  if (entries.length < PUBLIC_EVAL_TARGET_COUNT) {
    throw new Error(`Public CMRC2018 subset must contain at least ${PUBLIC_EVAL_TARGET_COUNT} real questions.`);
  }
  return entries.slice(0, PUBLIC_EVAL_TARGET_COUNT).map((entry) => toPublicEvalScenario(entry));
}

interface EvalCorpusDocument extends EvalItem {
  key: string;
  articleIds: string[];
  questionIds: string[];
}

function buildEvalCorpusDocuments(entries: PublicDatasetQaFixture[]): EvalCorpusDocument[] {
  const byContext = new Map<string, EvalCorpusDocument>();
  for (const entry of entries) {
    const context = publicSourceText(entry);
    const existing = byContext.get(context);
    if (existing) {
      existing.articleIds = uniqueStrings([...existing.articleIds, entry.articleId]);
      existing.questionIds = uniqueStrings([...existing.questionIds, entry.questionId]);
      continue;
    }
    byContext.set(context, {
      key: `cmrc2018-doc-${byContext.size + 1}`,
      title: entry.title,
      text: context,
      summary: context,
      articleIds: [entry.articleId],
      questionIds: [entry.questionId],
    });
  }
  return [...byContext.values()];
}

const publicEvalCorpusDocuments = buildEvalCorpusDocuments(publicCmrc2018DevSubset as PublicDatasetQaFixture[]);

export async function saveAoriEvalIndex(
  db: AgentDatabase,
  model: ModelProvider,
  options: { libraryName?: string } = {},
): Promise<{ libraryId: string; chunks: Chunk[] }> {
  const library = db.createLibrary(options.libraryName ?? "Eval public-cmrc2018-deduped");
  const allChunks: Chunk[] = [];

  for (const document of publicEvalCorpusDocuments) {
    const version = db.createDocumentVersion(
      library.id,
      `${document.key}.md`,
      "text/markdown",
      `hash-${document.key}`,
      `${document.key}.md`,
      { indexStrategy: "aspect_oriented_reflective" },
    ).version;
    const chunks = db.replaceChunks(library.id, version.id, [{
      ordinal: 0,
      headingPath: document.title,
      pageNumber: null,
      startChar: 0,
      endChar: document.text.length,
      text: document.text,
    }]);
    const draft = await model.extractAoriDocument({
      documentName: `${document.key}.md`,
      chunks,
      context: {
        stage: "global_reading",
        groupId: document.key,
        documentName: `${document.key}.md`,
        documentTokenEstimate: Math.max(1, Math.ceil(document.text.length / 4)),
        inputTokenEstimate: Math.max(1, Math.ceil(document.text.length / 4)),
        usedTokenEstimate: Math.max(1, Math.ceil(document.text.length / 4)),
        preservedRanges: ["full_document"],
        omittedRanges: [],
        truncated: false,
        risk: "low",
        minTruncatedContextTokens: 10_000,
        evidenceBindingMinContextTokens: 10_000,
        allowSmallContextOnlyForQuoteLookup: true,
      },
    });
    const aoriIndex = buildAoriDocumentIndex({
      libraryId: library.id,
      documentId: version.documentId,
      documentName: `${document.key}.md`,
      versionId: version.id,
      chunks,
      drafts: [{ groupId: document.key, draft }],
      rationaleTrace: [],
      reflectiveReport: draft.reflectiveReport,
    });
    db.saveAoriDocumentIndex(aoriIndex);
    allChunks.push(...chunks);
  }

  return { libraryId: library.id, chunks: allChunks };
}

export async function createEvalWorkspace(model: ModelProvider = new EvalModelProvider()): Promise<EvalWorkspace> {
  const db = await createEvalDatabase();
  const { libraryId } = await saveAoriEvalIndex(db, model);
  return { db, libraryId, closeWhenDone: true };
}

export async function createEvalWorkspaceInDatabase(
  db: AgentDatabase,
  model: ModelProvider,
  options: { libraryName?: string } = {},
): Promise<EvalWorkspace> {
  const { libraryId } = await saveAoriEvalIndex(db, model, options);
  return { db, libraryId, closeWhenDone: false };
}

export function diagnosticsFrom(pulse: Awaited<ReturnType<PulseEngine["create"]>>): Record<string, unknown> {
  return pulse.evidencePack?.diagnostics as Record<string, unknown>;
}

export async function runEvalScenario(
  scenario: EvalScenario,
  options: {
    model?: ModelProvider;
    mode?: PulseInputMode;
    onEvent?: (event: PulseStreamEvent) => void;
    workspace?: EvalWorkspace;
  } = {},
): Promise<{
  db: AgentDatabase;
  libraryId: string;
  pulse: Awaited<ReturnType<PulseEngine["create"]>>;
  events: PulseStreamEvent[];
}> {
  const model = options.model ?? new EvalModelProvider();
  const workspace = options.workspace ?? await createEvalWorkspace(model);
  const { db, libraryId } = workspace;
  const events: PulseStreamEvent[] = [];
  const pulse = await new PulseEngine(
    db,
    new NoLegacyRetrievalVectorStore(db),
    model,
  ).create(
    libraryId,
    scenario.question,
    options.mode ?? "full",
    (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  );
  return { db, libraryId, pulse, events };
}

export interface EvalScenarioAssessment {
  scenario: string;
  strictPass: boolean;
  structuralPass: boolean;
  answerIncludesMatched: string[];
  answerIncludesMissed: string[];
  answerExcludesViolated: string[];
  checks: {
    pipelineIsDemand: boolean;
    retrievalTraceMatches: boolean;
    requiredEventsPresent: boolean;
    forbiddenEventsAbsent: boolean;
    recordCountMatches: boolean;
    selectedChunkCountMatches: boolean;
    citationsSufficient: boolean;
    gapCountMatches: boolean;
    mustCiteSourceChunks: boolean;
    evidenceRecordsBound: boolean;
  };
}

export function assessEvalScenario(
  scenario: EvalScenario,
  pulse: Awaited<ReturnType<PulseEngine["create"]>>,
  events: PulseStreamEvent[],
): EvalScenarioAssessment {
  const diagnostics = diagnosticsFrom(pulse);
  const records = diagnostics.evidenceRecords as EvidenceRecord[] | undefined;
  const selectedChunkCount = pulse.evidencePack?.chunkEvidencePack?.selectedChunks.length ?? 0;
  const citationsCount = pulse.evidencePack?.citations.length ?? 0;
  const retrievalTrace = pulse.evidencePack?.retrievalTrace?.map((step) => step.tool) ?? [];
  const plan = diagnostics.demandPlan as DemandAnswerPlan | undefined;
  const answerIncludesMatched = scenario.expected.answerIncludes.filter((text) => pulse.pulse.answer.includes(text));
  const answerIncludesMissed = scenario.expected.answerIncludes.filter((text) => !pulse.pulse.answer.includes(text));
  const answerExcludesViolated = (scenario.expected.answerExcludes ?? []).filter((text) => pulse.pulse.answer.includes(text));
  const eventTypes = new Set(events.map((event) => event.type));

  const checks = {
    pipelineIsDemand: pulse.evidencePack?.pipeline?.packBuilder === "aori_demand",
    retrievalTraceMatches: JSON.stringify(retrievalTrace) === JSON.stringify([
      "planDemandAnswer",
      "extractEvidenceRecords",
      "synthesizeDemandAnswer",
    ]),
    requiredEventsPresent: [
      "demand_plan_generated",
      "demand_records_started",
      "demand_record_extracted",
      "demand_answer_synthesized",
    ].every((type) => eventTypes.has(type as PulseStreamEvent["type"])),
    forbiddenEventsAbsent: [
      "skill_route_generated",
      "aori_traversal_started",
      "bfs_node_decision",
      "dfs_node_entered",
    ].every((type) => !eventTypes.has(type as PulseStreamEvent["type"])),
    recordCountMatches: (records?.length ?? 0) === scenario.expected.recordCount,
    selectedChunkCountMatches: selectedChunkCount === scenario.expected.selectedChunkCount,
    citationsSufficient: citationsCount >= scenario.expected.selectedChunkCount,
    gapCountMatches: (pulse.evidencePack?.gaps.length ?? 0) === (scenario.expected.gapCount ?? 0),
    mustCiteSourceChunks: plan?.answerPolicy.mustCiteSourceChunks === true,
    evidenceRecordsBound: (records ?? []).every((record) =>
      record.evidenceChunkIds.length > 0 &&
      Object.values(record.fields).every((field) => field.evidenceChunkIds.length > 0)
    ),
  };

  const strictPass = Object.values(checks).every(Boolean) && answerIncludesMissed.length === 0 && answerExcludesViolated.length === 0;
  const structuralPass = checks.pipelineIsDemand &&
    checks.retrievalTraceMatches &&
    checks.requiredEventsPresent &&
    checks.forbiddenEventsAbsent &&
    checks.recordCountMatches &&
    checks.selectedChunkCountMatches &&
    checks.gapCountMatches &&
    checks.citationsSufficient;

  return {
    scenario: scenario.name,
    strictPass,
    structuralPass,
    answerIncludesMatched,
    answerIncludesMissed,
    answerExcludesViolated,
    checks,
  };
}

export const aoriPulseEvalScenarios: EvalScenario[] =
  buildPublicEvalScenarios(publicCmrc2018DevSubset as PublicDatasetQaFixture[]);
