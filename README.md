# AgentThinking

AgentThinking is a local, single-user knowledge graph studio. It imports Markdown, text, and PDF material, breaks it into traceable chunks, derives reviewable concepts and claims, and displays their relationships in an explorable force-directed graph.

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

DeepSeek's official API documents chat completions but not an embeddings endpoint, so this configuration uses local hashed vectors for candidate retrieval and search. For higher-quality semantic retrieval, configure a separate OpenAI-compatible embeddings service with `AI_EMBEDDING_PROVIDER=api`, `AI_EMBEDDING_BASE_URL`, `AI_EMBEDDING_API_KEY`, and `AI_EMBEDDING_MODEL`.

For an entirely offline demonstration without sending document text, set `AI_PROVIDER=fake`.

Run a production build with `npm run build && npm start`; the server then hosts the built UI at `http://127.0.0.1:4310`.

## MVP Capabilities

- Multiple local knowledge libraries with versioned document imports and SHA-256 deduplication.
- Structured Markdown/TXT chunking and PDF text extraction; scanned PDF pages use local Tesseract OCR by default.
- Optional cloud OCR per library when `AI_VISION_MODEL` is configured.
- DeepSeek V4 JSON graph extraction plus local retrieval vectors by default; a separate OpenAI-compatible embeddings endpoint remains configurable.
- SQLite persistence with FTS5 search support and a `sqlite-vec` backed vector store, with an in-process cosine fallback when the native extension cannot load.
- Concept/claim overview graph, evidence chunk expansion, semantic search, suggested relationship review, manual edges, and editable abstract-node content.
- Background ingestion jobs and browser updates over server-sent events.

## Privacy And Data

Runtime files live under `data/` and are excluded from version control. API credentials are read only by the server from environment variables and are never returned in API responses or stored in SQLite.

With the default DeepSeek configuration, extracted text is submitted to DeepSeek only for relationship extraction; local vectors are used for retrieval. Scanned page images stay local. Cloud OCR requires a separately supported vision-capable configuration rather than the default DeepSeek text API.

## Commands

```bash
npm run dev          # Start server and Vite UI
npm run typecheck    # TypeScript validation
npm test             # Domain and ingestion integration tests
npm run build        # Production assets and server bundle
```

## Boundaries

This first release does not include authentication, collaboration, question answering, DOCX/web imports, local inference, watched folders, or full-graph rendering for large libraries. The default graph is an abstract overview and loads evidence chunks on demand.
