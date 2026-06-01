import type {
  AbstractNode,
  AspectKind,
  AnalysisDraft,
  AnalysisStatement,
  AuthSession,
  Document,
  GraphResponse,
  GraphView,
  IngestJob,
  Library,
  LibrarySettings,
  MappingAudit,
  OcrMode,
  Relation,
  RelationStatus,
  RelationType,
  SearchResult,
  ModelStreamEvent,
  ModelTestResult,
  Pulse,
  PulseInputMode,
  PulseResponse,
  PulseStreamEvent,
  PublishedAnalysis,
  SourceStructure,
} from "@agent-thinking/contracts";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(message.error ?? "请求失败");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{
    provider: string;
    aiConfigured: boolean;
    vectorEngine: string;
    ocrProvider: "local" | "aliyun";
    ocrConfigured: boolean;
    authRequired: boolean;
  }>("/health"),
  session: () => request<AuthSession>("/auth/session"),
  register: (username: string, password: string, registrationKey: string) =>
    request<AuthSession>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, registrationKey }),
    }),
  login: (username: string, password: string) =>
    request<AuthSession>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<AuthSession>("/auth/logout", { method: "POST", body: JSON.stringify({}) }),
  testModel: () => request<ModelTestResult>("/model/test", {
    method: "POST",
    body: JSON.stringify({}),
  }),
  streamModel: async (
    prompt: string,
    onEvent: (event: ModelStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const response = await fetch("/api/model/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) {
      const failure = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(failure.error ?? "流式请求失败");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const parts = buffered.split(/\r?\n\r?\n/);
      buffered = done ? "" : parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          onEvent(JSON.parse(line.slice(5).trim()) as ModelStreamEvent);
        }
      }
      if (done) break;
    }
  },
  libraries: () => request<Library[]>("/libraries"),
  createLibrary: (name: string) =>
    request<Library>("/libraries", { method: "POST", body: JSON.stringify({ name }) }),
  deleteLibrary: (id: string) => request<void>(`/libraries/${id}`, { method: "DELETE" }),
  settings: (id: string) => request<LibrarySettings>(`/libraries/${id}/settings`),
  updateSettings: (id: string, ocrMode: OcrMode) =>
    request<LibrarySettings>(`/libraries/${id}/settings`, {
      method: "PATCH",
      body: JSON.stringify({ ocrMode }),
    }),
  documents: (id: string) => request<Document[]>(`/libraries/${id}/documents`),
  sourceUrl: (versionId: string, download = false) => `/api/versions/${versionId}/source${download ? "?download=true" : ""}`,
  sourceText: async (versionId: string) => {
    const response = await fetch(`/api/versions/${versionId}/source`);
    if (!response.ok) throw new Error("读取原文件失败");
    return response.text();
  },
  structure: (versionId: string) => request<SourceStructure>(`/versions/${versionId}/structure`),
  reanalyze: (versionId: string) => request<IngestJob>(`/versions/${versionId}/reanalyze`, { method: "POST" }),
  runMappingAudit: (versionId: string) =>
    request<MappingAudit>(`/versions/${versionId}/mapping-audit`, { method: "POST" }),
  mappingAudit: (versionId: string) =>
    request<MappingAudit>(`/versions/${versionId}/mapping-audit`),
  rebuildGraphFromMappingAudit: (versionId: string) =>
    request<MappingAudit>(`/versions/${versionId}/mapping-audit/rebuild-graph`, { method: "POST" }),
  updateMappingAuditFindingComment: (versionId: string, findingIndex: number, userComment: string) =>
    request<MappingAudit>(`/versions/${versionId}/mapping-audit/findings/${findingIndex}/comment`, {
      method: "PATCH",
      body: JSON.stringify({ userComment }),
    }),
  jobs: (id: string) => request<IngestJob[]>(`/libraries/${id}/jobs`),
  retry: (id: string) => request<IngestJob>(`/jobs/${id}/retry`, { method: "POST" }),
  deleteJob: (id: string) => request<void>(`/jobs/${id}`, { method: "DELETE" }),
  import: (id: string, files: FileList) => {
    const body = new FormData();
    Array.from(files).forEach((file) => body.append("file", file));
    return request<Array<{ fileName: string; duplicate: boolean }>>(`/libraries/${id}/import`, {
      method: "POST",
      body,
    });
  },
  graph: (
    id: string,
    options: {
      centerId?: string;
      includeChunks?: boolean;
      status?: RelationStatus;
      type?: RelationType;
      view?: GraphView;
      aspect?: AspectKind;
      pulseId?: string;
      pulseStats?: boolean;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.centerId) query.set("centerId", options.centerId);
    if (options.includeChunks) query.set("includeChunks", "true");
    if (options.status) query.set("status", options.status);
    if (options.type) query.set("type", options.type);
    if (options.view) query.set("view", options.view);
    if (options.aspect) query.set("aspect", options.aspect);
    if (options.pulseId) query.set("pulseId", options.pulseId);
    if (options.pulseStats) query.set("pulseStats", "true");
    return request<GraphResponse>(`/libraries/${id}/graph?${query}`);
  },
  search: (id: string, query: string) =>
    request<SearchResult[]>(`/libraries/${id}/search`, {
      method: "POST",
      body: JSON.stringify({ query, limit: 10 }),
    }),
  pulses: (libraryId: string) => request<Pulse[]>(`/libraries/${libraryId}/pulses`),
  pulse: (libraryId: string, pulseId: string) => request<PulseResponse>(`/libraries/${libraryId}/pulses/${pulseId}`),
  clearPulses: (libraryId: string) =>
    request<{ deleted: number }>(`/libraries/${libraryId}/pulses`, { method: "DELETE" }),
  createPulse: (libraryId: string, question: string, mode: PulseInputMode = "full") =>
    request<PulseResponse>(`/libraries/${libraryId}/pulses`, {
      method: "POST",
      body: JSON.stringify({ question, mode }),
    }),
  streamPulse: async (
    libraryId: string,
    question: string,
    mode: PulseInputMode = "full",
    onEvent: (event: PulseStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const response = await fetch(`/api/libraries/${libraryId}/pulses/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, mode }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) {
      const failure = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(failure.error ?? "脉冲流式请求失败");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const parts = buffered.split(/\r?\n\r?\n/);
      buffered = done ? "" : parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          onEvent(JSON.parse(line.slice(5).trim()) as PulseStreamEvent);
        }
      }
      if (done) break;
    }
  },
  reviewPulse: (pulseId: string, status: "correct" | "wrong") =>
    request<PulseResponse>(`/pulses/${pulseId}/review`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  updateNode: (nodeId: string, title: string, summary: string) =>
    request<AbstractNode>(`/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ title, summary }),
    }),
  updateNodeFields: (nodeId: string, values: { title?: string; summary?: string }) =>
    request<AbstractNode>(`/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  addNodeEvidence: (nodeId: string, chunkId: string) =>
    request<AbstractNode>(`/nodes/${nodeId}/evidence`, {
      method: "POST",
      body: JSON.stringify({ chunkId }),
    }),
  removeNodeEvidence: (nodeId: string, chunkId: string) =>
    request<AbstractNode>(`/nodes/${nodeId}/evidence/${chunkId}`, { method: "DELETE" }),
  updateNodeAspects: (nodeId: string, aspects: AspectKind[]) =>
    request<AbstractNode>(`/nodes/${nodeId}/aspects`, {
      method: "PATCH",
      body: JSON.stringify({ aspects }),
    }),
  resetNodeAspects: (nodeId: string) =>
    request<AbstractNode>(`/nodes/${nodeId}/aspects`, { method: "DELETE" }),
  deleteNode: (nodeId: string) => request<void>(`/nodes/${nodeId}`, { method: "DELETE" }),
  createRelation: (libraryId: string, values: {
    sourceNodeId: string;
    targetNodeId: string;
    type: RelationType;
    reason: string;
  }) => request<Relation>(`/libraries/${libraryId}/relations`, {
    method: "POST",
    body: JSON.stringify(values),
  }),
  reviewRelation: (relationId: string, status: "accepted" | "rejected") =>
    request<Relation>(`/relations/${relationId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  relation: (relationId: string) => request<Relation>(`/relations/${relationId}`),
  updateRelation: (relationId: string, values: {
    status?: "accepted" | "rejected";
    type?: RelationType;
    reason?: string;
    confidence?: number | null;
  }) =>
    request<Relation>(`/relations/${relationId}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  addRelationEvidence: (relationId: string, chunkId: string) =>
    request<Relation>(`/relations/${relationId}/evidence`, {
      method: "POST",
      body: JSON.stringify({ chunkId }),
    }),
  removeRelationEvidence: (relationId: string, chunkId: string) =>
    request<Relation>(`/relations/${relationId}/evidence/${chunkId}`, { method: "DELETE" }),
  deleteRelation: (relationId: string) =>
    request<void>(`/relations/${relationId}`, { method: "DELETE" }),
  syncAnalysisDraft: (libraryId: string) =>
    request<AnalysisDraft>(`/libraries/${libraryId}/analysis/draft`, { method: "POST" }),
  analysisDraft: (libraryId: string) =>
    request<AnalysisDraft>(`/libraries/${libraryId}/analysis/draft`),
  evidence: (libraryId: string, q = "") =>
    request<SearchResult[]>(`/libraries/${libraryId}/evidence?q=${encodeURIComponent(q)}`),
  updateStatement: (statementId: string, values: { text?: string; status?: "pending" | "approved" | "rejected" }) =>
    request<AnalysisStatement>(`/analysis/statements/${statementId}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  addStatementEvidence: (statementId: string, chunkId: string) =>
    request<AnalysisStatement>(`/analysis/statements/${statementId}/evidence`, {
      method: "POST",
      body: JSON.stringify({ chunkId }),
    }),
  deleteStatementEvidence: (statementId: string, chunkId: string) =>
    request<AnalysisStatement>(`/analysis/statements/${statementId}/evidence/${chunkId}`, { method: "DELETE" }),
  precheckStatement: (statementId: string) =>
    request<AnalysisStatement>(`/analysis/statements/${statementId}/precheck`, { method: "POST" }),
  publishAnalysis: (libraryId: string) =>
    request<PublishedAnalysis>(`/libraries/${libraryId}/analysis/publish`, { method: "POST" }),
  analysis: (libraryId: string) => request<PublishedAnalysis>(`/libraries/${libraryId}/analysis`),
  analysisDownloadUrl: (libraryId: string) => `/api/libraries/${libraryId}/analysis/download`,
  exportUrl: (libraryId: string) => `/api/libraries/${libraryId}/export`,
};
