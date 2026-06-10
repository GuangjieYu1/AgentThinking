import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Chunk,
  DemandAnswerPlan,
  DemandAnswerSynthesisInput,
  EvidenceRecord,
  PulseAnswerOutput,
  PulseInputMode,
  PulseResponse,
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
        summary: "Demand answer found an evidence gap in the fixed eval fixture.",
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

export interface EvalScenario {
  name: string;
  question: string;
  aspectKind: Parameters<typeof buildAoriDocumentIndex>[0]["drafts"][number]["draft"]["aspects"][number]["kind"];
  domainKind: string;
  centralQuestion: string;
  items: EvalItem[];
  expected: {
    answerIncludes: string[];
    answerExcludes?: string[] | undefined;
    recordCount: number;
    selectedChunkCount: number;
    gapCount?: number | undefined;
  };
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

export function saveAoriEvalIndex(db: AgentDatabase, scenario: EvalScenario): { libraryId: string; chunks: Chunk[] } {
  const library = db.createLibrary(`Eval ${scenario.name}`);
  const version = db.createDocumentVersion(
    library.id,
    `${scenario.name}.md`,
    "text/markdown",
    `hash-${scenario.name}`,
    `${scenario.name}.md`,
    { indexStrategy: "aspect_oriented_reflective" },
  ).version;
  const chunks = db.replaceChunks(library.id, version.id, scenario.items.map((item, index) => ({
    ordinal: index,
    headingPath: item.title,
    pageNumber: null,
    startChar: index * 100,
    endChar: index * 100 + item.text.length,
    text: item.text,
  })));

  db.saveAoriDocumentIndex(buildAoriDocumentIndex({
    libraryId: library.id,
    documentId: version.documentId,
    documentName: `${scenario.name}.md`,
    versionId: version.id,
    chunks,
    drafts: [{
      groupId: "eval-group",
      draft: {
        understanding: {
          summary: `Fixed AORI/Pulse eval fixture for ${scenario.name}.`,
          centralQuestion: scenario.centralQuestion,
          evidenceChunkIds: chunks.map((chunk) => chunk.id),
          evidenceStatus: "supported",
          closureStatus: "partial",
          classificationRationale: "Fixed eval fixture.",
          confidence: 0.82,
        },
        aspects: [{
          kind: scenario.aspectKind,
          domainKind: scenario.domainKind,
          title: scenario.centralQuestion,
          summary: `Source-bound ${scenario.domainKind} eval aspect.`,
          centralQuestion: scenario.centralQuestion,
          classificationRationale: "Fixed eval fixture.",
          confidence: 0.82,
          items: chunks.map((chunk, index) => ({
            key: `eval-item-${index + 1}`,
            title: scenario.items[index]?.title ?? `Eval item ${index + 1}`,
            summary: scenario.items[index]?.summary ?? scenario.items[index]?.text ?? "",
            evidenceChunkIds: [chunk.id],
            evidenceStatus: "supported" as const,
            closureStatus: "partial" as const,
            classificationRationale: "Fixed eval fixture.",
            confidence: 0.82,
          })),
          relations: [],
          gaps: [],
        }],
        selfQuestions: [],
        reflectiveReport: { summary: "complete fixture", completenessRisk: "none", warnings: [], truncationCount: 0 },
      },
    }],
    rationaleTrace: [],
    reflectiveReport: { summary: "complete fixture", completenessRisk: "none", warnings: [], truncationCount: 0 },
    createdAt: "2026-06-08T00:00:00.000Z",
  }));

  return { libraryId: library.id, chunks };
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
  } = {},
): Promise<{
  db: AgentDatabase;
  pulse: Awaited<ReturnType<PulseEngine["create"]>>;
  events: PulseStreamEvent[];
}> {
  const db = await createEvalDatabase();
  const { libraryId } = saveAoriEvalIndex(db, scenario);
  const events: PulseStreamEvent[] = [];
  const pulse = await new PulseEngine(
    db,
    new NoLegacyRetrievalVectorStore(db),
    options.model ?? new EvalModelProvider(),
  ).create(
    libraryId,
    scenario.question,
    options.mode ?? "full",
    (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  );
  return { db, pulse, events };
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

export const aoriPulseEvalScenarios: EvalScenario[] = [{
  name: "count-list",
  question: "How many people paid Huang in 2005? list all people",
  aspectKind: "finding",
  domainKind: "count_list",
  centralQuestion: "Who paid Huang and when?",
  items: [
    { title: "SourceA payment", text: "source: SourceA; person: Alice; time: 2005; evidence: Alice paid Huang in 2005." },
    { title: "SourceB payment", text: "source: SourceB; person: Bob; time: 2005; evidence: Bob paid Huang in 2005." },
    { title: "SourceC payment", text: "source: SourceC; person: Charlie; time: 2010; evidence: Charlie paid Huang in 2010." },
    { title: "SourceD payment", text: "source: SourceD; person: Dana; time: 2005-2006; evidence: Dana paid Huang across a range." },
    { title: "SourceE payment", text: "source: SourceE; person: Eve; evidence: Eve paid Huang but time is unclear." },
  ],
  expected: {
    answerIncludes: ['"count":2', "SourceA", "SourceB", "Uncertain records: SourceD, SourceE"],
    answerExcludes: ["SourceC [", "16 chunks"],
    recordCount: 5,
    selectedChunkCount: 5,
    gapCount: 1,
  },
}, {
  name: "timeline",
  question: "timeline 2005 events",
  aspectKind: "timeline",
  domainKind: "timeline",
  centralQuestion: "When did payment events happen?",
  items: [
    { title: "EventA", text: "source: SourceA; event: Alice paid Huang; time: 2005; evidence: Alice payment." },
    { title: "EventB", text: "source: SourceB; event: Bob paid Huang; time: 2005-2006; evidence: Bob payment range." },
    { title: "EventC", text: "source: SourceC; event: Charlie paid Huang; time: 2010; evidence: Charlie payment." },
  ],
  expected: {
    answerIncludes: ["Alice paid Huang", "Uncertain records: SourceB"],
    answerExcludes: ["Charlie paid Huang [", "16 chunks"],
    recordCount: 3,
    selectedChunkCount: 3,
  },
}, {
  name: "amount",
  question: "What total amount of money did Huang receive?",
  aspectKind: "amount",
  domainKind: "amount",
  centralQuestion: "What source-bound amounts are recorded?",
  items: [
    { title: "AmountA", text: "source: SourceA; amount: 10 wan; time: 2005; evidence: SourceA paid 10 wan." },
    { title: "AmountB", text: "source: SourceB; amount: 20 wan; time: 2006; evidence: SourceB paid 20 wan." },
    { title: "AmountC", text: "source: SourceC; amount: 5 wan; time: 2007; evidence: SourceC paid 5 wan." },
  ],
  expected: {
    answerIncludes: ["SourceA: 10 wan", "SourceB: 20 wan", "SourceC: 5 wan"],
    answerExcludes: ["No source-bound amount value was extracted", "16 chunks"],
    recordCount: 3,
    selectedChunkCount: 3,
  },
}, {
  name: "argument-response",
  question: "Was the defense argument accepted and how did the court respond?",
  aspectKind: "argument",
  domainKind: "argument_response",
  centralQuestion: "How did the court respond to each argument?",
  items: [
    {
      title: "Loan defense",
      text: "argument: payment was a loan; response: court rejected the defense; finding: payment was a bribe; status: not_accepted; evidence: court explains why.",
    },
    {
      title: "Amount defense",
      text: "argument: amount was overstated; response: court accepted part of it; finding: amount reduced; status: partially_accepted; evidence: court recalculated.",
    },
  ],
  expected: {
    answerIncludes: ["payment was a loan", "court rejected the defense", "amount was overstated", "partially_accepted"],
    answerExcludes: ["16 chunks"],
    recordCount: 2,
    selectedChunkCount: 2,
  },
}, {
  name: "insufficient-evidence",
  question: "What exact date did the unclear payment happen?",
  aspectKind: "finding",
  domainKind: "evidence_gap",
  centralQuestion: "Which facts remain insufficiently evidenced?",
  items: [
    { title: "Unclear payment", text: "source: SourceA; evidence: SourceA may have paid Huang, but the exact date is not recorded." },
  ],
  expected: {
    answerIncludes: ["Evidence is insufficient", "No source-bound records or no required field values were extracted"],
    answerExcludes: ['"count":0', "16 chunks"],
    recordCount: 1,
    selectedChunkCount: 1,
    gapCount: 1,
  },
}];
