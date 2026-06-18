# Codebase Inventory

Generated during AORI mainline slimming on branch `beforeHardCode`.

## 1. Current Production Entrypoints

- `apps/server/src/index.ts` starts the Fastify server.
- `apps/server/src/app.ts` wires API routes, `IngestionQueue`, `PulseEngine`, graph views, settings, auth, and benchmark report endpoints.
- `apps/server/src/services/pulse.ts` is the production answer orchestration entrypoint for pulse creation.
- `apps/web/src/App.tsx` and `apps/web/src/api.ts` are the browser UI/API consumers.

## 2. Current Document Import Path

- Upload/API handling lives in `apps/server/src/app.ts`.
- Import jobs are queued through `IngestionQueue` in `apps/server/src/services/ingestion.ts`.
- Raw parsing is delegated to `apps/server/src/services/parser.ts`; file type helpers live in `apps/server/src/domain/files.ts`.
- OCR integration is in `apps/server/src/services/aliyun-ocr.ts` plus local OCR cache config.

## 3. Current Chunking Path

- Source sections are normalized by `parseTextSections` in `apps/server/src/domain/chunker.ts` and `parseMarkdownStructure` in `apps/server/src/domain/source-structure.ts`.
- Document tree and chunks are built by `buildDocumentIndex` in `apps/server/src/domain/document-tree.ts`.
- Chunks are persisted with `AgentDatabase.replaceChunks` and indexed into both legacy chunk vectors and v2 context/retrieval units.

## 4. Current AORI Index Build Path

- `apps/server/src/services/ingestion.ts` decides whether `job.indexStrategy === "aspect_oriented_reflective"`.
- AORI context grouping/budgeting is local to `ingestion.ts`.
- Model AORI draft extraction calls `model.extractAoriDocument`.
- Deterministic draft semantic units are added by `apps/server/src/services/aori-semantic-index.ts`.
- `buildAoriDocumentIndex` in `apps/server/src/services/aori.ts` normalizes drafts into `AoriDocumentIndex`.
- `AgentDatabase.saveAoriDocumentIndex` persists the document index, and `LibraryAoriService.mergeDocument` updates the library-level AORI profile.

## 5. Current Query Path

- `PulseEngine.create` is the production query entrypoint.
- If AORI document indexes exist and `AORI_ANSWER_MODE` is not `legacy`, it tries `AoriSemanticAnswerEngine` first.
- `AoriSemanticAnswerEngine` builds a `QuestionAspectPlan` via `aori-question-routing.ts`, executes it via `aori-aspect-plan-executor.ts`, and emits an `EvidencePack`.
- If semantic confidence or execution is insufficient, `AoriDemandAnswerEngine` runs as fallback.
- If there is no AORI index or mode is explicitly `legacy`, `PulseEngine` still has legacy full/progressive paths through `PulseEvidenceController`; these are compatibility paths, not the AORI mainline.

## 6. Current Fallback Path

- Primary fallback is `AoriDemandAnswerEngine` in `apps/server/src/services/aori-demand-answer.ts`.
- Demand fallback builds an AORI traversal map using `buildAoriTraversalMap` from `aori-traversal-answer.ts`, asks the model for a `DemandAnswerPlan`, extracts source-bound `EvidenceRecord`s, validates quotes against chunks, and synthesizes the answer.
- The fallback now carries `defaultDemandFallbackBudget` with `maxModelCalls`, `maxTotalTokens`, `maxSourceItems`, and `maxEvidenceRecords`.
- Direct `AoriTraversalAnswerEngine` remains available for tests/debug compatibility but is deprecated as a production answer path.

## 7. Current EvidencePack Build Path

- Semantic: `buildSemanticEvidencePack` in `aori-semantic-answer.ts`.
- Demand: `buildStorageEvidencePack` in `aori-demand-answer.ts`.
- Traversal legacy/debug: `buildStorageEvidencePack` in `aori-traversal-answer.ts`.
- Legacy/vector path: `PulseEvidenceController` builds the older `EvidencePack` shape.
- All active AORI answer outputs save a storage `EvidencePack` and attach diagnostics/citations.

## 8. Current Test, Benchmark, Experiment Files

- Unit/integration/regression tests live under `apps/server/test`.
- Guard tests now live under `apps/server/test/guards`.
- AORI/Pulse public-data benchmark runner was moved from production `src` to `experiments/baselines/aori-pulse`.
- CSAIR golden runner was moved to `experiments/archived/csair-golden-case.ts`.
- Historical benchmark and golden reports were moved from `data/benchmarks` to ignored `experiments/reports`.

## 9. Suspected Old Code

- `PulseEngine.createFull` and `PulseEngine.createProgressive` are legacy/vector compatibility paths.
- `PulseEvidenceController` and context-unit/v2 pack support remain production-accessible for non-AORI-indexed libraries but are not the AORI mainline.
- `AoriTraversalAnswerEngine` is a legacy/debug answer engine. Its map builder is still reused by demand fallback, so only the direct engine should be deprecated.
- Benchmark API/UI still reads and exports prior reports, but production no longer runs the benchmark suite directly.

## 10. Suspected Hardcoded Code

- No production code contains CSAIR/SouthAir-specific parsers after this pass.
- `aori-question-routing.ts` uses generic question-type rules such as numeric aggregation, negative fact, event effect, exhaustive list, and concept boundary.
- Archived experiments contain CSAIR-specific questions and are intentionally outside production.

## 11. Suspected Duplicate Answer Paths

- Main: `AoriSemanticAnswerEngine`.
- Fallback: `AoriDemandAnswerEngine`.
- Deprecated/debug: `AoriTraversalAnswerEngine`.
- Compatibility only: legacy full/progressive vector answer paths when no AORI index exists or `AORI_ANSWER_MODE=legacy`.
- Removed from production: benchmark runner as a production service dependency.

## 12. Suspected Unused Types

- `ContextUnit`, `RetrievalUnit`, v2 pack types, benchmark types, graph view types, and diagnostics types remain referenced by server code, tests, and web API contracts.
- `Benchmark*` contract types remain because report listing/export endpoints and the web benchmark workspace still render historical results.
- `GraphView`/AORI graph types remain used by AORI graph endpoints.

## 13. Direct Deletion Candidates

- Production `apps/server/src/services/benchmark-runner.ts` was removed by moving it to `experiments/baselines/aori-pulse`.
- `apps/server/test/csair-golden-case.ts` was moved to `experiments/archived`.
- Historical reports were removed from `data/benchmarks` and archived under ignored `experiments/reports`.

## 14. Migrate Before Deleting

- Split `buildAoriTraversalMap` into a neutral `aori-map` module before deleting or fully archiving `AoriTraversalAnswerEngine`.
- Move benchmark UI/API behind an explicit dev/experiment gate before deleting benchmark contract types.
- Decide whether non-AORI-index legacy pulse paths should stay as compatibility or be moved behind an explicit `legacy` feature flag.

## 15. Temporarily Kept But Deprecated

- Direct traversal answering in `AoriTraversalAnswerEngine`.
- Legacy full/progressive vector paths in `PulseEngine`.
- Benchmark report endpoints for reading/exporting existing reports.
- Context/retrieval unit contracts are retained because v2 indexing and evidence validation still reference them.
