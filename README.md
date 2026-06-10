# AgentThinking

AgentThinking is a private knowledge graph studio. It imports Markdown, text, Word, and PDF material, breaks it into traceable chunks, derives reviewable concepts and claims, and displays their relationships in an explorable graph.

## Quick Start

Requires Node.js 24 LTS. The project intentionally pins its supported runtime in `.nvmrc` and `.node-version`.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://127.0.0.1:4311` during development. The default `.env` is prepared for the official DeepSeek API; insert a key before importing documents:

```dotenv
AI_PROVIDER=deepseek
AI_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=...
AI_CHAT_MODEL=deepseek-v4-flash
AI_THINKING_MODE=disabled
AI_EMBEDDING_PROVIDER=local
```

DeepSeek's official API documents chat completions but not embeddings or OCR endpoints, so this configuration uses local hashed vectors for candidate retrieval and a separate OCR provider for scanned pages. For higher-quality semantic retrieval, configure a separate OpenAI-compatible embeddings service with `AI_EMBEDDING_PROVIDER=api`, `AI_EMBEDDING_BASE_URL`, `AI_EMBEDDING_API_KEY`, and `AI_EMBEDDING_MODEL`.

For an entirely offline demonstration without sending document text, set `AI_PROVIDER=fake`.

Run a production build with `npm run build && npm start`; the server then hosts the built UI at `http://127.0.0.1:4310`.

## Authentication

For a hosted deployment, enable registration-gated authentication in `.env`:

```dotenv
AUTH_REQUIRED=true
REGISTRATION_KEYS=your-private-invite-key
AUTH_SESSION_DAYS=30
# Use true only behind HTTPS:
AUTH_COOKIE_SECURE=false
```

Users register with username, password, and one of your registration keys. Libraries are owned by the creating user; other users cannot list or access them directly. A returning user keeps their imported files, graph reviews, pulse history, and published analysis notes.

## MVP Capabilities

- Multiple private knowledge libraries with versioned document imports and SHA-256 deduplication.
- Structured Markdown/TXT chunking and PDF text extraction; scanned PDF pages use local Tesseract OCR by default.
- Optional Alibaba Cloud OCR per library for scanned PDF pages.
- DeepSeek V4 JSON graph extraction plus local retrieval vectors by default; a separate OpenAI-compatible embeddings endpoint remains configurable.
- SQLite persistence with FTS5 search support and a `sqlite-vec` backed vector store, with an in-process cosine fallback when the native extension cannot load.
- Concept/claim overview graph, evidence chunk expansion, semantic search, suggested relationship review, manual edges, and editable abstract-node content.
- Immutable uploaded sources with Markdown frontmatter/link/block-reference preservation and line/page-based evidence citations.
- Manually published Markdown analysis reports plus ZIP exports containing the report and source-file copies.
- Background ingestion jobs and browser updates over server-sent events.

## Privacy And Data

Runtime files live under `data/` and are excluded from version control. API credentials are read only by the server from environment variables and are never returned in API responses or stored in SQLite.

Uploaded files remain unchanged under `data/files/`. After reviewing suggested relationships, publish an analysis note from the library panel; generated Markdown reports are stored under `data/analysis/` and can be downloaded with their cited source copies.

With the default DeepSeek configuration, extracted text is submitted to DeepSeek only for relationship extraction; local vectors are used for retrieval. Scanned page images stay local in `local` OCR mode, and are submitted page by page to Alibaba Cloud OCR only when a library selects Alibaba Cloud OCR.

## Alibaba Cloud OCR Setup

DeepSeek remains responsible for concept and relationship extraction. Alibaba Cloud OCR is used only when a scanned PDF page has insufficient embedded text.

1. Activate the Alibaba Cloud **OCR - Text Recognition** service and grant a RAM user permission to call OCR APIs. Avoid using the root account AccessKey.
2. Create a RAM AccessKey, then add the following values to `.env`:

```dotenv
OCR_PROVIDER=aliyun
ALIYUN_OCR_ENDPOINT=ocr-api.cn-hangzhou.aliyuncs.com
ALIBABA_CLOUD_ACCESS_KEY_ID=your_ram_access_key_id
ALIBABA_CLOUD_ACCESS_KEY_SECRET=your_ram_access_key_secret
# Set this only for STS temporary credentials:
ALIBABA_CLOUD_SECURITY_TOKEN=
```

3. Restart the development server after changing `.env`:

```bash
npm run dev
```

4. In a knowledge library, select **阿里云 OCR** under **扫描 PDF OCR**, then import or reanalyze a scanned PDF. PDFs with sufficient embedded text do not call OCR.

The integration uses Alibaba Cloud OCR `RecognizeGeneral` (`2021-07-07`) and sends each rendered scanned page as PNG binary content to `ocr-api.cn-hangzhou.aliyuncs.com`. Keep `OCR_PROVIDER=local` to use local Tesseract without transmitting scanned page images.

## Commands

```bash
npm run dev          # Start server and Vite UI
npm run typecheck    # TypeScript validation
npm test             # Domain and ingestion integration tests
npm run build        # Production assets and server bundle
```

## RAG Benchmark Suite

The repo includes a local AORI/Pulse benchmark pack that covers benchmark styles other than BEIR:

- `KILT` style: source-bound QA with provenance expectations
- `CRAG` style: robustness, abstention, and uncertainty exposure
- `RAGBench` style: end-to-end grounded QA
- `CRUD-RAG` style: Chinese source-grounded QA
- `RAGAS` style: automatic scoring proxies for faithfulness/relevancy/context
- `ARES` style: automatic scoring proxies for answer/context relevance

Quick run with local fake provider:

```bash
npm run benchmark:rag-suite -w @agent-thinking/server
```

Benchmark results are persisted as JSON files under `data/benchmarks/`. The app can read these runs and compare historical iterations directly in the Benchmark workspace.

Run a specific suite:

```bash
npm run benchmark:aori-pulse -w @agent-thinking/server -- --provider fake --suite crud_rag
```

Run with the configured real model:

```bash
npm run benchmark:aori-pulse -w @agent-thinking/server -- --provider configured --iterations 2
```

Optional filters:

- `--suite kilt|crag|ragbench|crud_rag|ragas|ares`
- `--scenario <scenario-name>`
- `--mode full|progressive`
- `--json`

## Boundaries

This first release does not include collaboration, watched folders, or full-graph rendering for large libraries. The default graph is an abstract overview and loads evidence chunks on demand.

## 技术文档

- [项目技术文档（通用版）](docs/AgentThinking_项目技术文档_通用版.md)
- [技术人员文档：架构与流程](docs/AgentThinking_技术人员文档_架构与流程.md)
