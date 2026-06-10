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
    label: "CRUD-RAG-style Chinese QA",
    kind: "dataset",
    focus: ["Chinese source handling", "citation support", "faithful structured answers"],
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
  benchmarkSuites: ["kilt", "ragbench", "ragas", "ares"],
  language: "en",
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
  benchmarkSuites: ["kilt", "ragbench", "ragas", "ares"],
  language: "en",
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
  benchmarkSuites: ["kilt", "ragbench", "ragas", "ares"],
  language: "en",
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
  benchmarkSuites: ["ragbench", "ragas", "ares"],
  language: "en",
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
  benchmarkSuites: ["crag", "ragbench", "ragas", "ares"],
  language: "en",
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
}, {
  name: "count-list-2006-overlap",
  benchmarkSuites: ["crag", "ragbench", "ragas", "ares"],
  language: "en",
  question: "How many people paid Huang in 2006? list all people",
  aspectKind: "finding",
  domainKind: "count_list_overlap",
  centralQuestion: "Which records are exact versus uncertain for year-specific counting?",
  items: [
    { title: "SourceA payment", text: "source: SourceA; person: Alice; time: 2006; evidence: Alice paid Huang in 2006." },
    { title: "SourceB payment", text: "source: SourceB; person: Bob; time: 2005-2006; evidence: Bob paid Huang across 2005-2006." },
    { title: "SourceC payment", text: "source: SourceC; person: Charlie; evidence: Charlie paid Huang but time is not explicit." },
    { title: "SourceD payment", text: "source: SourceD; person: Dana; time: 2010; evidence: Dana paid Huang in 2010." },
  ],
  expected: {
    answerIncludes: ['"count":1', "SourceA", "Uncertain records: SourceB, SourceC"],
    answerExcludes: ["SourceD [", "16 chunks"],
    recordCount: 4,
    selectedChunkCount: 4,
    gapCount: 1,
  },
}, {
  name: "amount-2008-null",
  benchmarkSuites: ["crag", "ragbench", "ragas", "ares"],
  language: "en",
  question: "What total amount of money did Huang receive in 2008?",
  aspectKind: "amount",
  domainKind: "amount_year_null",
  centralQuestion: "What happens when the requested year has no exact amount record?",
  items: [
    { title: "AmountA", text: "source: SourceA; amount: 10 wan; time: 2005; evidence: SourceA paid 10 wan." },
    { title: "AmountB", text: "source: SourceB; amount: 20 wan; time: 2006; evidence: SourceB paid 20 wan." },
    { title: "AmountC", text: "source: SourceC; amount: 5 wan; time: 2007; evidence: SourceC paid 5 wan." },
  ],
  expected: {
    answerIncludes: ["2008 amount: null"],
    answerExcludes: ["SourceA:", "SourceB:", "SourceC:", "16 chunks"],
    recordCount: 3,
    selectedChunkCount: 3,
  },
}, {
  name: "crud-rag-count-zh",
  benchmarkSuites: ["crud_rag", "ragas", "ares"],
  language: "zh",
  question: "2005年向黄某付款的人有多少，列出名单",
  aspectKind: "finding",
  domainKind: "crud_count_zh",
  centralQuestion: "中文语料里哪些付款记录能被准确计数？",
  items: [
    { title: "证据甲", text: "source: 证据甲; person: 张三; time: 2005; evidence: 张三在2005年向黄某付款。" },
    { title: "证据乙", text: "source: 证据乙; person: 李四; time: 2005; evidence: 李四在2005年向黄某付款。" },
    { title: "证据丙", text: "source: 证据丙; person: 王五; time: 2010; evidence: 王五在2010年向黄某付款。" },
    { title: "证据丁", text: "source: 证据丁; person: 赵六; time: 2005-2006; evidence: 赵六在2005至2006年间向黄某付款。" },
    { title: "证据戊", text: "source: 证据戊; person: 孙七; evidence: 孙七向黄某付款，但时间未写明。" },
  ],
  expected: {
    answerIncludes: ['"count":2', "证据甲", "证据乙", "Uncertain records: 证据丁, 证据戊"],
    answerExcludes: ["证据丙 [", "16 chunks"],
    recordCount: 5,
    selectedChunkCount: 5,
    gapCount: 1,
  },
}, {
  name: "crud-rag-timeline-zh",
  benchmarkSuites: ["crud_rag", "ragas", "ares"],
  language: "zh",
  question: "按时间线列出2005年的付款事件",
  aspectKind: "timeline",
  domainKind: "crud_timeline_zh",
  centralQuestion: "中文时间线问题能否保持出处绑定？",
  items: [
    { title: "事件甲", text: "source: 证据甲; event: 张三向黄某付款; time: 2005; evidence: 张三付款。" },
    { title: "事件乙", text: "source: 证据乙; event: 李四向黄某付款; time: 2005-2006; evidence: 李四付款时间有区间。" },
    { title: "事件丙", text: "source: 证据丙; event: 王五向黄某付款; time: 2010; evidence: 王五付款。" },
  ],
  expected: {
    answerIncludes: ["张三向黄某付款", "Uncertain records: 证据乙"],
    answerExcludes: ["王五向黄某付款 [", "16 chunks"],
    recordCount: 3,
    selectedChunkCount: 3,
  },
}, {
  name: "crud-rag-amount-zh",
  benchmarkSuites: ["crud_rag", "ragas", "ares"],
  language: "zh",
  question: "黄某一共收了多少金额？",
  aspectKind: "amount",
  domainKind: "crud_amount_zh",
  centralQuestion: "中文金额问题是否能逐条给出出处？",
  items: [
    { title: "金额甲", text: "source: 来源甲; amount: 10万; time: 2005; evidence: 来源甲支付10万。" },
    { title: "金额乙", text: "source: 来源乙; amount: 20万; time: 2006; evidence: 来源乙支付20万。" },
    { title: "金额丙", text: "source: 来源丙; amount: 5万; time: 2007; evidence: 来源丙支付5万。" },
  ],
  expected: {
    answerIncludes: ["来源甲: 10万", "来源乙: 20万", "来源丙: 5万"],
    answerExcludes: ["No source-bound amount value was extracted", "16 chunks"],
    recordCount: 3,
    selectedChunkCount: 3,
  },
}, {
  name: "crud-rag-argument-zh",
  benchmarkSuites: ["crud_rag", "ragas", "ares"],
  language: "zh",
  question: "辩护意见是否被法院采纳，法院如何回应？",
  aspectKind: "argument",
  domainKind: "crud_argument_zh",
  centralQuestion: "中文辩护-回应结构能否保持来源绑定？",
  items: [
    {
      title: "借款辩护",
      text: "argument: 付款属于借款; response: 法院认为该辩护不能成立; finding: 属于行贿款; status: not_accepted; evidence: 法院说明借款说法缺乏依据。",
    },
    {
      title: "金额辩护",
      text: "argument: 金额被夸大; response: 法院部分采纳该意见; finding: 对金额进行了调减; status: partially_accepted; evidence: 法院重新核算金额。",
    },
  ],
  expected: {
    answerIncludes: ["付款属于借款", "法院认为该辩护不能成立", "金额被夸大", "partially_accepted"],
    answerExcludes: ["16 chunks"],
    recordCount: 2,
    selectedChunkCount: 2,
  },
}];
