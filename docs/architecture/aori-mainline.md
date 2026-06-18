# AORI Mainline

## 1. Unique Mainline

The AORI production answer mainline is:

```text
Document Input
  -> Chunking
  -> AORI Document Index
  -> SemanticUnit / Aspect / ReflectiveFinding
  -> AoriSemanticAnswerEngine
  -> QuestionAspectPlan
  -> AspectPlanExecutor
  -> EvidencePack
  -> Answer
```

If the semantic path cannot produce a guarded answer, the only AORI fallback is:

```text
AoriDemandAnswerEngine
  -> DemandAnswerPlan
  -> source-bound EvidenceRecord extraction
  -> EvidencePack
  -> Answer
```

## 2. Production Chain Modules

- Import and chunking: `parser.ts`, `chunker.ts`, `source-structure.ts`, `document-tree.ts`, `ingestion.ts`.
- AORI index: `aori.ts`, `aori-semantic-index.ts`, `library-aori.ts`.
- Query orchestration: `pulse.ts`.
- Semantic answer: `aori-semantic-answer.ts`, `aori-question-routing.ts`, `aori-aspect-plan-executor.ts`.
- Demand fallback: `aori-demand-answer.ts`.
- Evidence validation/storage: semantic and demand `EvidencePack` builders plus DB persistence.

## 3. Fallback Modules

- `AoriDemandAnswerEngine` is the semantic fallback.
- It runs only after semantic routing has no selected aspects, confidence is below threshold, strategy is `fallback_demand`, or semantic execution returns no answer.
- It has bounded fallback budgets: `maxModelCalls`, `maxTotalTokens`, `maxSourceItems`, and `maxEvidenceRecords`.

## 4. Experiment Modules

- AORI/Pulse benchmark runner lives in `experiments/baselines/aori-pulse`.
- CSAIR golden runner lives in `experiments/archived`.
- Historical benchmark/golden reports live in ignored `experiments/reports`.
- Production code must not import from `experiments`.

## 5. GraphRAG Status

GraphRAG is not part of the production answer chain in this mainline. If GraphRAG work returns, it should live under `experiments/baselines/graphrag` as a baseline until explicitly promoted.

## 6. EvidencePack Generation

- Semantic path: `buildSemanticEvidencePack` in `aori-semantic-answer.ts`.
- Demand fallback: `buildStorageEvidencePack` in `aori-demand-answer.ts`.
- Deprecated traversal/debug path also emits an `EvidencePack`, but it is not the mainline.

Every answer path that persists a pulse must store an `EvidencePack` with citations, evidence rows, retrieval trace, and diagnostics.

## 7. QuestionAspectPlan Generation

`buildQuestionAspectPlan` in `aori-question-routing.ts` classifies the question into generic types:

- numeric aggregation
- exhaustive list
- negative fact
- event effect
- concept boundary
- general QA

It selects persisted `SemanticUnit`s by generic lexical overlap, unit kind, and confidence. It must not route concrete business terms to fixed plans.

## 8. SemanticUnit Usage

`SemanticUnit`s are produced during AORI indexing by model drafts plus deterministic draft extraction. They are normalized into `AoriDocumentIndex`, persisted, selected by `QuestionAspectPlan`, executed by `AspectPlanExecutor`, and copied into answer diagnostics as `semanticUnitsUsed`.

## 9. Demand Fallback Conditions

`AoriDemandAnswerEngine` is invoked when:

- no semantic units are available;
- semantic routing selects nothing;
- semantic routing confidence is below `SEMANTIC_SELECTION_THRESHOLD`;
- semantic strategy is `fallback_demand`;
- selected semantic units cannot produce a guarded answer.

The fallback must remain bounded and citation-backed.

## 10. PulseEngine Call Order

`PulseEngine.create` order:

1. Start metrics collection.
2. If AORI indexes exist and mode is not explicit legacy, run `AoriSemanticAnswerEngine`.
3. If semantic succeeds, persist semantic answer and semantic `EvidencePack`.
4. If semantic fails, run `AoriDemandAnswerEngine` with fallback budget and persist demand `EvidencePack`.
5. Only when no AORI index exists or explicit legacy mode is requested, use old full/progressive compatibility paths.

## Target Structure

The repo should continue moving toward:

```text
apps/server/src/services/aori/
  index/
  routing/
  execution/
  evidence/
  fallback/
apps/server/src/services/pulse/
experiments/
  baselines/
    graphrag/
    aori-pulse/
  reports/
  archived/
```

This pass does not perform that full directory migration. It defines the boundary and removes the production dependency on benchmark/test fixtures first.
