import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AuthSession,
  Citation,
  Document,
  GraphRuleStage,
  GraphRulesSummary,
  GraphRuleTrace,
  IngestJob,
  Library,
  LibraryStreamEvent,
  LibrarySettings,
  MappingAudit,
  MappingAuditFinding,
  OcrMode,
  PublishedAnalysis,
  SourceStructure,
} from "@agent-thinking/contracts";
import { api } from "./api";
import { AnalysisWorkspace } from "./AnalysisWorkspace";
import { GraphWorkspace } from "./GraphWorkspace";
import { ModelTools } from "./ModelTools";
import { TimelineWorkspace } from "./TimelineWorkspace";

const mappingAuditStatusLabels: Record<MappingAudit["status"], string> = {
  clean: "未发现明显分歧",
  minor_issues: "有轻微问题",
  major_issues: "有严重问题",
  failed: "审计失败",
};

const mappingAuditKindLabels: Record<MappingAuditFinding["kind"], string> = {
  missing_source_meaning: "原文语义遗漏",
  unsupported_graph_claim: "图谱推断缺证据",
  wrong_relation: "关系错误",
  chunk_boundary_loss: "切分边界丢失",
  overgeneralization: "过度概括",
  other: "其他",
};

const mappingAuditSeverityLabels: Record<MappingAuditFinding["severity"], string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const graphRuleCategoryLabels: Record<NonNullable<MappingAuditFinding["ruleCategory"]>, string> = {
  graph_validity: "图合法性",
  relation_algebra: "关系代数",
  semantic_coverage: "语义覆盖",
  graph_evolution: "图演化",
};

const mappingAuditFindingStatusLabels: Record<NonNullable<MappingAuditFinding["status"]>, string> = {
  open: "待处理",
  accepted: "已接受",
  dismissed: "已忽略",
  fixed: "已修复",
};

function mappingAuditSeverityCounts(findings: MappingAuditFinding[]): { high: number; medium: number; low: number } {
  return findings.reduce((counts, finding) => {
    counts[finding.severity] += 1;
    return counts;
  }, { high: 0, medium: 0, low: 0 });
}

interface RuleGovernanceFeed {
  stage?: GraphRuleStage;
  summary?: GraphRulesSummary;
  traces: GraphRuleTrace[];
}

function isLegacyJobEvent(value: unknown): value is IngestJob {
  return Boolean(value && typeof value === "object" && "id" in value && "stage" in value && !("type" in value));
}

function mergeRuleSummary(current: GraphRulesSummary | undefined, next: GraphRulesSummary): GraphRulesSummary {
  if (!current) return next;
  return {
    totalRelations: next.totalRelations,
    keptCount: next.keptCount,
    downgradedCount: next.downgradedCount,
    excludedCount: next.excludedCount ?? next.droppedCount,
    droppedCount: next.droppedCount ?? next.excludedCount,
    reviewCount: next.reviewCount,
    warningCount: next.warningCount,
    categoryCounts: {
      graph_validity: next.categoryCounts.graph_validity,
      relation_algebra: next.categoryCounts.relation_algebra,
      semantic_coverage: next.categoryCounts.semantic_coverage,
      graph_evolution: next.categoryCounts.graph_evolution,
    },
  };
}

export function App() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<AuthSession>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [health, setHealth] = useState<{
    provider: string;
    aiConfigured: boolean;
    vectorEngine: string;
    ocrProvider: "local" | "aliyun";
    ocrConfigured: boolean;
    authRequired: boolean;
  }>();

  const loadLibraries = async () => {
    const values = await api.libraries();
    setLibraries(values);
    setSelectedId((current) => current && values.some((item) => item.id === current) ? current : values[0]?.id);
  };

  useEffect(() => {
    void Promise.all([api.session(), api.health()])
      .then(([nextSession, nextHealth]) => {
        setSession(nextSession);
        setHealth(nextHealth);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(() => {
    if (!session) return;
    if (session.authRequired && !session.user) {
      setLibraries([]);
      setSelectedId(undefined);
      return;
    }
    void loadLibraries().catch((cause: Error) => setError(cause.message));
  }, [session?.authRequired, session?.user?.id]);

  const selected = libraries.find((library) => library.id === selectedId);
  const createLibrary = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    try {
      const library = await api.createLibrary(newName);
      setLibraries((current) => [library, ...current]);
      setSelectedId(library.id);
      setNewName("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const logout = async () => {
    try {
      const nextSession = await api.logout();
      setSession(nextSession);
      setLibraries([]);
      setSelectedId(undefined);
      setNewName("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  if (!session) {
    return (
      <div className="auth-shell">
        {error && <div className="banner error" onClick={() => setError(undefined)}>{error}</div>}
        <section className="auth-card card">
          <span className="brand-mark" />
          <h1>AgentThinking</h1>
          <p>正在连接服务...</p>
        </section>
      </div>
    );
  }

  if (session.authRequired && !session.user) {
    return (
      <AuthGate
        error={error}
        onError={setError}
        onAuthenticated={(nextSession) => {
          setError(undefined);
          setSession(nextSession);
        }}
      />
    );
  }

  return (
    <div className={sidebarCollapsed ? "shell sidebar-collapsed" : "shell"}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          <div className="brand-copy"><strong>AgentThinking</strong><small>Knowledge Graph Studio</small></div>
          <button
            className="sidebar-toggle"
            type="button"
            title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        </div>
        <form className="create-library" onSubmit={(event) => void createLibrary(event)}>
          <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新建知识库" />
          <button type="submit">创建</button>
        </form>
        <nav className="libraries">
          {libraries.map((library) => (
            <button
              key={library.id}
              className={library.id === selectedId ? "library selected" : "library"}
              onClick={() => setSelectedId(library.id)}
            >
              <strong>{library.name}</strong>
              <span>{new Date(library.updatedAt).toLocaleDateString()}</span>
            </button>
          ))}
          {libraries.length === 0 && <p className="muted">创建一个知识库后导入资料。</p>}
        </nav>
        {session.user && (
          <div className="user-card">
            <div>
              <small>当前用户</small>
              <strong>{session.user.username}</strong>
            </div>
            <button type="button" className="ghost" onClick={() => void logout()}>退出</button>
          </div>
        )}
        <ModelTools
          provider={health?.provider ?? "model"}
          onHealthChange={() => void api.health().then(setHealth).catch((cause: Error) => setError(cause.message))}
        />
        <footer className="runtime">
          <span className={health?.aiConfigured && health.ocrConfigured ? "online" : "warning"} />
          {health ? `${health.provider} / OCR:${health.ocrProvider}` : "连接服务中..."}
        </footer>
      </aside>
      <main className="main">
        {error && <div className="banner error" onClick={() => setError(undefined)}>{error}</div>}
        {selected ? (
          <LibraryWorkspace library={selected} onError={setError} />
        ) : (
          <section className="empty">
            <h1>把材料变成可探索的思考地图</h1>
            <p>导入笔记或 PDF，抽象概念、论点和它们之间可审核的逻辑关系。</p>
          </section>
        )}
      </main>
    </div>
  );
}

function AuthGate({
  error,
  onError,
  onAuthenticated,
}: {
  error: string | undefined;
  onError: (message: string | undefined) => void;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [registrationKey, setRegistrationKey] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const nextSession = mode === "register"
        ? await api.register(username, password, registrationKey)
        : await api.login(username, password);
      onAuthenticated(nextSession);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      {error && <div className="banner error" onClick={() => onError(undefined)}>{error}</div>}
      <section className="auth-card card">
        <div className="auth-brand">
          <span className="brand-mark" />
          <div>
            <h1>AgentThinking</h1>
            <p>登录后进入你的私有知识库。注册需要部署者发放的密钥。</p>
          </div>
        </div>
        <div className="auth-tabs">
          <button type="button" className={mode === "login" ? "selected" : ""} onClick={() => setMode("login")}>登录</button>
          <button type="button" className={mode === "register" ? "selected" : ""} onClick={() => setMode("register")}>注册</button>
        </div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label>
            用户名
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="your_name" />
          </label>
          <label>
            密码
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder="至少 8 位" />
          </label>
          {mode === "register" && (
            <label>
              注册密钥
              <input value={registrationKey} onChange={(event) => setRegistrationKey(event.target.value)} type="password" autoComplete="off" placeholder="由管理员提供" />
            </label>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? "处理中..." : mode === "register" ? "创建账户" : "登录"}
          </button>
        </form>
        <p className="auth-note">
          不同用户只能看到自己创建的知识库；同一用户再次登录会保留历史资料、图谱、脉冲与分析笔记。
        </p>
      </section>
    </div>
  );
}

function LibraryWorkspace({ library, onError }: { library: Library; onError: (message: string) => void }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [settings, setSettings] = useState<LibrarySettings>();
  const [refreshGraph, setRefreshGraph] = useState(0);
  const [activeWorkspace, setActiveWorkspace] = useState<"graph" | "timeline" | "analysis">("graph");
  const [analysis, setAnalysis] = useState<PublishedAnalysis>();
  const [sourceView, setSourceView] = useState<{ structure: SourceStructure; text?: string; focus?: Citation }>();
  const [mappingAuditView, setMappingAuditView] = useState<{
    versionId: string;
    documentName: string;
    mediaType: string;
    loading: boolean;
    graphRebuildLoading?: boolean;
    audit?: MappingAudit;
  }>();
  const [ruleGovernanceFeed, setRuleGovernanceFeed] = useState<RuleGovernanceFeed>({ traces: [] });
  const [resourcePanelCollapsed, setResourcePanelCollapsed] = useState(false);
  const activeJobs = useMemo(() => jobs.filter((job) => !["completed", "failed"].includes(job.stage)), [jobs]);

  const reload = async () => {
    const [nextDocuments, nextJobs, nextSettings] = await Promise.all([
      api.documents(library.id),
      api.jobs(library.id),
      api.settings(library.id),
    ]);
    setDocuments(nextDocuments);
    setJobs(nextJobs);
    setSettings(nextSettings);
    void api.analysis(library.id).then(setAnalysis).catch(() => setAnalysis(undefined));
  };

  useEffect(() => {
    void reload().catch((cause: Error) => onError(cause.message));
    const stream = new EventSource(`/api/libraries/${library.id}/events`);
    stream.onmessage = (event) => {
      const update = JSON.parse(event.data) as LibraryStreamEvent | IngestJob;
      const job = isLegacyJobEvent(update) ? update : "type" in update && update.type === "job" ? update.job : undefined;
      if (job) {
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        if (job.stage === "completed") {
          void api.documents(library.id).then(setDocuments);
          setRefreshGraph((value) => value + 1);
        }
        return;
      }
      if (!("type" in update)) return;
      const streamUpdate = update;
      if (streamUpdate.type === "graph_rule_trace" || streamUpdate.type === "graph_rebuild_rule_trace") {
        setRuleGovernanceFeed((current) => ({
          ...(streamUpdate.stage ?? current.stage ? { stage: streamUpdate.stage ?? current.stage } : {}),
          summary: mergeRuleSummary(current.summary, streamUpdate.summary),
          traces: [...current.traces, ...streamUpdate.traces].slice(-20),
        }));
        return;
      }
      if (streamUpdate.type === "graph_rule_summary" || streamUpdate.type === "graph_rebuild_summary" || streamUpdate.type === "graph_candidate_batch_ready") {
        setRuleGovernanceFeed((current) => ({
          ...(streamUpdate.stage ?? current.stage ? { stage: streamUpdate.stage ?? current.stage } : {}),
          summary: mergeRuleSummary(current.summary, streamUpdate.summary),
          traces: current.traces,
        }));
      }
    };
    return () => stream.close();
  }, [library.id]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      await api.import(library.id, files);
      await reload();
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const setOcrMode = async (mode: OcrMode) => {
    try {
      setSettings(await api.updateSettings(library.id, mode));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const deleteFailedJob = async (jobId: string) => {
    if (!window.confirm("删除该失败任务及对应导入版本？此操作不可撤销。")) return;
    try {
      await api.deleteJob(jobId);
      await reload();
      setRefreshGraph((value) => value + 1);
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const openSource = async (versionId: string, mediaType: string, focus?: Citation) => {
    try {
      const structure = await api.structure(versionId);
      const text = mediaType === "text/markdown" || mediaType === "text/plain"
        ? await api.sourceText(versionId)
        : undefined;
      let resolvedFocus = focus;
      if (focus?.chunkId && focus.startLine == null) {
        const chunk = structure.chunks.find((item) => item.id === focus.chunkId);
        if (chunk) {
          resolvedFocus = {
            ...focus,
            headingPath: chunk.headingPath,
            pageNumber: chunk.pageNumber,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            blockId: chunk.blockId,
            excerpt: chunk.text.slice(0, 280),
          };
        }
      }
      setSourceView({ structure, ...(text !== undefined ? { text } : {}), ...(resolvedFocus ? { focus: resolvedFocus } : {}) });
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const reanalyze = async (versionId: string) => {
    if (!window.confirm("重新分析会替换该版本支撑的 AI 审核结果；人工关系与已发布报告会保留。继续吗？")) return;
    try {
      await api.reanalyze(versionId);
      await reload();
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const runMappingAudit = async (document: Document) => {
    const version = document.latestVersion;
    if (!version) return;
    setMappingAuditView({
      versionId: version.id,
      documentName: document.name,
      mediaType: document.mediaType,
      loading: true,
    });
    try {
      const audit = await api.runMappingAudit(version.id);
      setMappingAuditView({
        versionId: version.id,
        documentName: document.name,
        mediaType: document.mediaType,
        loading: false,
        audit,
      });
    } catch (cause) {
      setMappingAuditView(undefined);
      onError((cause as Error).message);
    }
  };

  const openMappingAudit = async (document: Document) => {
    const version = document.latestVersion;
    if (!version) return;
    setMappingAuditView({
      versionId: version.id,
      documentName: document.name,
      mediaType: document.mediaType,
      loading: true,
    });
    try {
      const audit = await api.mappingAudit(version.id);
      setMappingAuditView({
        versionId: version.id,
        documentName: document.name,
        mediaType: document.mediaType,
        loading: false,
        audit,
      });
    } catch (cause) {
      if ((cause as Error).message.includes("尚未运行")) {
        await runMappingAudit(document);
        return;
      }
      setMappingAuditView(undefined);
      onError((cause as Error).message);
    }
  };

  const rebuildGraphFromMappingAudit = async () => {
    const view = mappingAuditView;
    if (!view?.audit) return;
    setMappingAuditView((current) => current && current.versionId === view.versionId ? { ...current, graphRebuildLoading: true } : current);
    try {
      const audit = await api.rebuildGraphFromMappingAudit(view.versionId);
      setMappingAuditView((current) => current && current.versionId === view.versionId
        ? { ...current, loading: false, graphRebuildLoading: false, audit }
        : current);
      setRefreshGraph((value) => value + 1);
    } catch (cause) {
      setMappingAuditView((current) => current && current.versionId === view.versionId ? { ...current, graphRebuildLoading: false } : current);
      onError((cause as Error).message);
    }
  };

  const saveMappingAuditFindingComment = async (findingIndex: number, userComment: string) => {
    const view = mappingAuditView;
    if (!view?.audit) return;
    const audit = await api.updateMappingAuditFindingComment(view.versionId, findingIndex, userComment);
    setMappingAuditView((current) => current && current.versionId === view.versionId ? { ...current, audit } : current);
  };

  const openAuditChunk = (view: { versionId: string; documentName: string; mediaType: string }, chunkId: string) => {
    void openSource(view.versionId, view.mediaType, {
      versionId: view.versionId,
      chunkId,
      documentName: view.documentName,
      mediaType: view.mediaType,
      headingPath: null,
      pageNumber: null,
      startLine: null,
      endLine: null,
      blockId: null,
      excerpt: "",
    });
  };

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="workspace-title">
          <span className="eyebrow">当前知识库</span>
          <h1>{library.name}</h1>
          <div className="workspace-meta">
            <span>{documents.length} 个文档</span>
            <span>{activeJobs.length} 个处理中任务</span>
            {analysis && <span>已有发布报告</span>}
          </div>
        </div>
      </header>
      <div className={resourcePanelCollapsed ? "panels resource-collapsed" : "panels"}>
        <section className={resourcePanelCollapsed ? "ingest-panel card collapsed" : "ingest-panel card"}>
          {resourcePanelCollapsed ? (
            <button
              className="resource-rail-button"
              type="button"
              title="展开资料面板"
              onClick={() => setResourcePanelCollapsed(false)}
            >
              <span>资料</span>
              <small>展开</small>
            </button>
          ) : <>
          <div className="ingest-panel-top">
            <strong>资料面板</strong>
            <button className="ghost panel-collapse-button" type="button" onClick={() => setResourcePanelCollapsed(true)}>收起</button>
          </div>
          <div className="panel-section">
            <div className="panel-section-heading">
              <h2>材料与处理</h2>
              <div className="panel-heading-actions">
                <span>{documents.length}</span>
                <label className="upload compact-upload">
                  导入
                  <input type="file" multiple accept=".md,.markdown,.txt,.pdf,.doc,.docx" onChange={(event) => void upload(event.target.files)} />
                </label>
              </div>
            </div>
            <label className="setting">
              扫描 PDF OCR
              <select value={settings?.ocrMode ?? "local"} onChange={(event) => void setOcrMode(event.target.value as OcrMode)}>
                <option value="local">本地 OCR</option>
                <option value="cloud">阿里云 OCR</option>
              </select>
            </label>
            <div className="document-list">
              {documents.map((document) => (
                <div className="document" key={document.id}>
                  <span>{document.name}</span><small>{document.latestVersion?.status ?? "等待"}</small>
                  {document.latestVersion && <div className="document-actions">
                    <button onClick={() => void openSource(document.latestVersion!.id, document.mediaType)}>查看</button>
                    <a href={api.sourceUrl(document.latestVersion.id, true)}>下载</a>
                    <button
                      disabled={document.latestVersion.status !== "completed" || mappingAuditView?.loading}
                      onClick={() => void openMappingAudit(document)}
                    >
                      映射审计
                    </button>
                    <button onClick={() => void reanalyze(document.latestVersion!.id)}>重新分析</button>
                  </div>}
                </div>
              ))}
              {documents.length === 0 && <p className="muted empty-panel-note">还没有导入材料。</p>}
            </div>
          </div>
          <div className="panel-section">
            <div className="panel-section-heading">
              <h2>分析笔记</h2>
              <span>{analysis ? "已发布" : "未发布"}</span>
            </div>
            <div className="analysis-actions">
              <button onClick={() => setActiveWorkspace("analysis")}>进入分析审核</button>
              {analysis && <>
                <a href={api.analysisDownloadUrl(library.id)}>下载 Markdown</a>
                <a href={api.exportUrl(library.id)}>导出归档</a>
              </>}
            </div>
            {analysis && <details className="analysis-preview"><summary>预览最新报告</summary><pre>{analysis.content}</pre></details>}
          </div>
          <div className="panel-section">
            <div className="panel-section-heading">
              <h2>后台任务</h2>
              <span>{jobs.length}</span>
            </div>
            <div className="job-list">
              {jobs.slice(0, 8).map((job) => (
                <div className="job" key={job.id}>
                  <div><span>{job.stage}</span><small>{Math.round(job.progress * 100)}%</small></div>
                  <progress max={1} value={job.progress} />
                  {job.error && <p>{job.error}</p>}
                  {job.stage === "failed" && (
                    <div className="job-actions">
                      <button onClick={() => void api.retry(job.id).catch((cause: Error) => onError(cause.message))}>重试</button>
                      <button className="danger" onClick={() => void deleteFailedJob(job.id)}>删除</button>
                    </div>
                  )}
                </div>
              ))}
              {jobs.length === 0 && <p className="muted empty-panel-note">暂无后台任务。</p>}
            </div>
          </div>
          </>}
        </section>
        <div className="work-surface">
          <nav className="workspace-tabs">
            <button className={activeWorkspace === "graph" ? "selected" : ""} onClick={() => setActiveWorkspace("graph")}>关系图谱审核</button>
            <button className={activeWorkspace === "timeline" ? "selected" : ""} onClick={() => setActiveWorkspace("timeline")}>时间脉络</button>
            <button className={activeWorkspace === "analysis" ? "selected" : ""} onClick={() => setActiveWorkspace("analysis")}>分析笔记审核</button>
          </nav>
          {activeWorkspace === "graph" ? (
            <GraphWorkspace
              key={library.id}
              libraryId={library.id}
              refreshKey={refreshGraph}
              ruleGovernanceFeed={ruleGovernanceFeed}
              onError={onError}
              onOpenCitation={(citation) => void openSource(citation.versionId, citation.mediaType, citation)}
            />
          ) : activeWorkspace === "timeline" ? (
            <TimelineWorkspace
              libraryId={library.id}
              refreshKey={refreshGraph}
              onError={onError}
              onOpenCitation={(citation) => void openSource(citation.versionId, citation.mediaType, citation)}
            />
          ) : (
            <AnalysisWorkspace
              key={`${library.id}:${refreshGraph}`}
              libraryId={library.id}
              analysis={analysis}
              onPublished={setAnalysis}
              onError={onError}
              onOpenCitation={(citation) => void openSource(citation.versionId, citation.mediaType, citation)}
            />
          )}
        </div>
      </div>
      {sourceView && <SourcePreview view={sourceView} onClose={() => setSourceView(undefined)} />}
      {mappingAuditView && (
        <MappingAuditPanel
          view={mappingAuditView}
          onClose={() => setMappingAuditView(undefined)}
          onRerun={() => {
            const document = documents.find((item) => item.latestVersion?.id === mappingAuditView.versionId);
            if (document) void runMappingAudit(document);
          }}
          onRebuildGraph={() => void rebuildGraphFromMappingAudit()}
          onOpenChunk={(chunkId) => openAuditChunk(mappingAuditView, chunkId)}
          onSaveComment={saveMappingAuditFindingComment}
        />
      )}
    </div>
  );
}

function MappingAuditPanel({
  view,
  onClose,
  onRerun,
  onRebuildGraph,
  onOpenChunk,
  onSaveComment,
}: {
  view: { versionId: string; documentName: string; mediaType: string; loading: boolean; graphRebuildLoading?: boolean; audit?: MappingAudit };
  onClose: () => void;
  onRerun: () => void;
  onRebuildGraph: () => void;
  onOpenChunk: (chunkId: string) => void;
  onSaveComment: (findingIndex: number, userComment: string) => Promise<void>;
}) {
  const audit = view.audit;
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const summary = audit ? displayMappingAuditSummary(audit) : "";
  const [commentMessage, setCommentMessage] = useState<string>();
  const [savingCommentIndex, setSavingCommentIndex] = useState<number | null>(null);
  const saveComment = async (findingIndex: number, userComment: string) => {
    setSavingCommentIndex(findingIndex);
    setCommentMessage(undefined);
    try {
      await onSaveComment(findingIndex, userComment);
      setCommentMessage("评论已保存。下次点击“重构图谱”时会一并提供给 AI。");
    } catch (cause) {
      setCommentMessage((cause as Error).message);
    } finally {
      setSavingCommentIndex(null);
    }
  };
  return (
    <div className="source-overlay">
      <section className="mapping-audit-panel card">
        <header>
          <div>
            <h2>映射审计</h2>
            <p>{view.documentName}</p>
          </div>
          <div className="mapping-audit-actions">
            <button
              className="ghost"
              disabled={view.loading || view.graphRebuildLoading || !audit || findings.length === 0}
              onClick={onRebuildGraph}
            >
              {view.graphRebuildLoading ? "重构中..." : "重构图谱"}
            </button>
            <button className="ghost" disabled={view.loading || view.graphRebuildLoading} onClick={onRerun}>重新运行</button>
            <button onClick={onClose}>关闭</button>
          </div>
        </header>
        {view.loading ? (
          <div className="mapping-audit-loading">
            <strong>正在重构语义轮廓并审计 mapping...</strong>
            <p>这一步会对照 chunk 原文、AI 节点和关系，只给建议，不会修改图谱。</p>
          </div>
        ) : audit ? (
          <>
            {commentMessage && <div className="mapping-audit-tool-message">{commentMessage}</div>}
            <section className={`mapping-audit-summary ${audit.status}`}>
              <MappingAuditSeverityPills audit={audit} findings={findings} />
              <p>{summary}</p>
              {audit.status === "failed" && (
                <p className="mapping-audit-failure-note">语义重构会尽量保留；失败通常来自模型结构化输出异常，不会修改你的原文或图谱。</p>
              )}
              <small>{new Date(audit.createdAt).toLocaleString()}</small>
            </section>
            <section className="mapping-audit-reconstruction">
              <h3>语义重构</h3>
              <pre>{audit.reconstruction || "本次审计没有生成可展示的重构文本。"}</pre>
            </section>
            <section className="mapping-audit-graph-rebuild">
              <h3>审计驱动图谱重构</h3>
              {view.graphRebuildLoading ? (
                <p className="muted">正在把原文、当前关系图谱和审计报告一起交给模型，重新生成候选节点与关系...</p>
              ) : audit.graphRebuildReport ? (
                <>
                  {audit.graphRebuiltAt && <small>生成时间：{new Date(audit.graphRebuiltAt).toLocaleString()}</small>}
                  <pre>{audit.graphRebuildReport}</pre>
                </>
              ) : (
                <p className="muted">点击“重构图谱”，系统会以原文 chunk、当前关系图谱和审计报告为素材，生成一轮新的 AI 候选节点与关系。</p>
              )}
            </section>
            <section className="mapping-audit-findings">
              <h3>发现的问题</h3>
              {findings.length === 0 ? (
                <p className="muted">没有发现明显语义分歧。</p>
              ) : findings.map((finding, index) => (
                <article className={`mapping-finding ${finding.severity}`} key={`${finding.kind}-${index}`}>
                  <div className="mapping-finding-heading">
                    <strong>{finding.title}</strong>
                    <span>{mappingAuditKindLabels[finding.kind]} / {mappingAuditSeverityLabels[finding.severity]}</span>
                  </div>
                  <div className="mapping-finding-tags">
                    <span>{graphRuleCategoryLabels[finding.ruleCategory ?? "semantic_coverage"]}</span>
                    <span>{mappingAuditFindingStatusLabels[finding.status ?? "open"]}</span>
                  </div>
                  <p>{displayMappingAuditText(finding.description, "模型结构化输出校验失败，无法展示可靠说明，请重新运行审计。")}</p>
                  <small>{displayMappingAuditText(finding.suggestion, "请重新运行审计；如果反复失败，可缩短输入文档或更换模型。")}</small>
                  <MappingFindingRefs finding={finding} onOpenChunk={onOpenChunk} />
                  <MappingFindingComment
                    finding={finding}
                    disabled={savingCommentIndex !== null}
                    saving={savingCommentIndex === index}
                    onSave={(comment) => void saveComment(index, comment)}
                  />
                </article>
              ))}
            </section>
          </>
        ) : (
          <p className="muted">尚未运行映射审计。</p>
        )}
      </section>
    </div>
  );
}

function MappingAuditSeverityPills({ audit, findings }: { audit: MappingAudit; findings: MappingAuditFinding[] }) {
  if (findings.length === 0) {
    return <div className="mapping-audit-severity-pills"><span className="severity-pill clean">{mappingAuditStatusLabels[audit.status]}</span></div>;
  }
  const counts = mappingAuditSeverityCounts(findings);
  return (
    <div className="mapping-audit-severity-pills" aria-label="审计问题严重度统计">
      <span className="severity-pill high">{counts.high} 个红色问题</span>
      <span className="severity-pill medium">{counts.medium} 个黄色问题</span>
      <span className="severity-pill low">{counts.low} 个蓝色问题</span>
    </div>
  );
}

function looksLikeRawValidationError(text: string | undefined): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  return (
    (value.startsWith("[{") && value.includes('"code"') && value.includes('"path"'))
    || value.includes("ZodError")
    || (value.includes("too_big") && value.includes("String must contain"))
  );
}

function displayMappingAuditText(text: string | undefined, fallback: string): string {
  return looksLikeRawValidationError(text) ? fallback : text || fallback;
}

function displayMappingAuditSummary(audit: MappingAudit): string {
  if (audit.status !== "failed") return audit.summary;
  return displayMappingAuditText(audit.summary, "映射审计结构化输出不可用，请重新运行。");
}

function MappingFindingRefs({ finding, onOpenChunk }: { finding: MappingAuditFinding; onOpenChunk: (chunkId: string) => void }) {
  const evidenceChunkIds = Array.isArray(finding.evidenceChunkIds) ? finding.evidenceChunkIds : [];
  const nodeIds = Array.isArray(finding.nodeIds) ? finding.nodeIds : [];
  const relationIds = Array.isArray(finding.relationIds) ? finding.relationIds : [];
  const hasRefs = evidenceChunkIds.length > 0 || nodeIds.length > 0 || relationIds.length > 0;
  if (!hasRefs) return null;
  return (
    <div className="mapping-finding-refs">
      {evidenceChunkIds.length > 0 && (
        <div>
          <span>Chunk</span>
          {evidenceChunkIds.map((chunkId) => (
            <button className="ghost" key={chunkId} onClick={() => onOpenChunk(chunkId)}>{chunkId.slice(0, 8)}</button>
          ))}
        </div>
      )}
      {nodeIds.length > 0 && <div><span>节点</span><code>{nodeIds.map((id) => id.slice(0, 8)).join(", ")}</code></div>}
      {relationIds.length > 0 && <div><span>关系</span><code>{relationIds.map((id) => id.slice(0, 8)).join(", ")}</code></div>}
    </div>
  );
}

function MappingFindingComment({
  finding,
  disabled,
  saving,
  onSave,
}: {
  finding: MappingAuditFinding;
  disabled: boolean;
  saving: boolean;
  onSave: (userComment: string) => void;
}) {
  const [draft, setDraft] = useState(finding.userComment ?? "");
  useEffect(() => {
    setDraft(finding.userComment ?? "");
  }, [finding.userComment]);
  return (
    <div className="mapping-finding-comment">
      <label>
        给 AI 的重构评论
        <textarea
          value={draft}
          maxLength={1200}
          placeholder="例如：这个问题应优先修正关系类型；不要直接删除节点；请把证据改指向描述伏地魔试图杀死哈利的段落。"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div>
        <small>{draft.length}/1200。评论会保存在审计报告中，并在“重构图谱”时一并发送给 AI。</small>
        <button disabled={disabled || draft === finding.userComment} onClick={() => onSave(draft)}>
          {saving ? "保存中..." : "保存评论"}
        </button>
      </div>
    </div>
  );
}

function SourcePreview({ view, onClose }: { view: { structure: SourceStructure; text?: string; focus?: Citation }; onClose: () => void }) {
  const { metadata, links, chunks } = view.structure;
  const lines = view.text?.replace(/\r\n?/g, "\n").split("\n") ?? [];
  return (
    <div className="source-overlay">
      <section className="source-preview card">
        <header><h2>{metadata?.documentName ?? "来源预览"}</h2><button onClick={onClose}>关闭</button></header>
        {metadata?.title && <p className="source-title">解析标题：{metadata.title}</p>}
        {metadata?.frontmatterRaw && <><h3>Frontmatter</h3><pre>{metadata.frontmatterRaw}</pre></>}
        {links.length > 0 && <><h3>链接与块引用</h3><ul>{links.map((link) => <li key={link.id}>L{link.line} / {link.type}: {link.raw}</li>)}</ul></>}
        {view.text === undefined ? (
          <div className="source-chunks">{chunks.map((chunk) => (
            <p className={view.focus?.chunkId === chunk.id ? "focused" : ""} key={chunk.id}>
              {chunk.pageNumber ? `第 ${chunk.pageNumber} 页` : `片段 ${chunk.ordinal + 1}`}：{chunk.text}
            </p>
          ))}</div>
        ) : (
          <pre className="source-text">{lines.map((line, index) => {
            const number = index + 1;
            const focused = view.focus?.startLine != null && number >= view.focus.startLine && number <= (view.focus.endLine ?? view.focus.startLine);
            return <span className={focused ? "focused" : ""} key={number}><b>{number}</b>{line}{"\n"}</span>;
          })}</pre>
        )}
      </section>
    </div>
  );
}
