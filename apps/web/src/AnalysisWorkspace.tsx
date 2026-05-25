import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AnalysisDraft, AnalysisStatement, Citation, PublishedAnalysis, SearchResult } from "@agent-thinking/contracts";
import { api } from "./api";

const precheckLabels = {
  not_checked: "等待 AI 预检",
  supported: "支持充分",
  partially_supported: "部分支持",
  unsupported: "不支持",
  failed: "检查失败",
} as const;

export function AnalysisWorkspace({
  libraryId,
  analysis,
  onPublished,
  onError,
  onOpenCitation,
}: {
  libraryId: string;
  analysis?: PublishedAnalysis | undefined;
  onPublished: (analysis: PublishedAnalysis) => void;
  onError: (message: string) => void;
  onOpenCitation: (citation: Citation) => void;
}) {
  const [draft, setDraft] = useState<AnalysisDraft>();
  const [selectedId, setSelectedId] = useState<string>();
  const [editing, setEditing] = useState("");
  const [statusFilter, setStatusFilter] = useState<AnalysisStatement["status"] | "">("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [checking, setChecking] = useState<Set<string>>(new Set());

  const load = async () => {
    const current = await api.syncAnalysisDraft(libraryId);
    setDraft(current);
    setSelectedId((selected) => selected && current.statements.some((item) => item.id === selected)
      ? selected
      : current.statements[0]?.id);
  };

  useEffect(() => {
    setResults([]);
    setQuery("");
    void load().catch((cause: Error) => onError(cause.message));
  }, [libraryId]);

  const statements = draft?.statements ?? [];
  const selected = statements.find((statement) => statement.id === selectedId);
  useEffect(() => setEditing(selected?.text ?? ""), [selected?.id, selected?.text]);

  const refreshStatement = (statement: AnalysisStatement) => {
    setDraft((current) => current ? {
      ...current,
      statements: current.statements.map((item) => item.id === statement.id ? statement : item),
      summary: summaryFor(current.statements.map((item) => item.id === statement.id ? statement : item)),
    } : current);
  };

  const runPrecheck = async (statement: AnalysisStatement) => {
    if (checking.has(statement.id)) return;
    setChecking((current) => new Set(current).add(statement.id));
    try {
      refreshStatement(await api.precheckStatement(statement.id));
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(statement.id);
        return next;
      });
    }
  };

  useEffect(() => {
    for (const statement of statements) {
      if (statement.status === "pending" && statement.precheck.status === "not_checked" && !checking.has(statement.id)) {
        void runPrecheck(statement);
      }
    }
  }, [draft]);

  const displayed = useMemo(
    () => statements.filter((statement) => !statusFilter || statement.status === statusFilter),
    [statements, statusFilter],
  );

  const saveText = async () => {
    if (!selected || editing.trim() === selected.text) return;
    try {
      refreshStatement(await api.updateStatement(selected.id, { text: editing }));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const decide = async (status: "approved" | "rejected") => {
    if (!selected) return;
    try {
      refreshStatement(await api.updateStatement(selected.id, { status }));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const searchEvidence = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setResults(await api.evidence(libraryId, query));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const addEvidence = async (chunkId: string) => {
    if (!selected) return;
    try {
      refreshStatement(await api.addStatementEvidence(selected.id, chunkId));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const removeEvidence = async (chunkId: string) => {
    if (!selected) return;
    try {
      refreshStatement(await api.deleteStatementEvidence(selected.id, chunkId));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const publish = async () => {
    if (!window.confirm("正式报告只纳入已批准陈述；待审核内容会阻止发布。继续吗？")) return;
    try {
      onPublished(await api.publishAnalysis(libraryId));
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  return (
    <section className="analysis-workspace card">
      <header className="analysis-toolbar">
        <div>
          <h2>分析笔记审核</h2>
          <p>关系确认后，逐条核对陈述与原文引用。</p>
        </div>
        <div className="analysis-publish">
          <button disabled={(draft?.summary.pending ?? 0) > 0} onClick={() => void publish()}>发布分析笔记</button>
          {analysis && <>
            <a href={api.analysisDownloadUrl(libraryId)}>下载 Markdown</a>
            <a href={api.exportUrl(libraryId)}>导出归档</a>
          </>}
        </div>
      </header>
      <div className="analysis-counts">
        <span>待审核 <strong>{draft?.summary.pending ?? 0}</strong></span>
        <span>已批准 <strong>{draft?.summary.approved ?? 0}</strong></span>
        <span>已拒绝 <strong>{draft?.summary.rejected ?? 0}</strong></span>
        {(draft?.summary.invalidated ?? 0) > 0 && <span className="warning">待重审 {draft?.summary.invalidated}</span>}
      </div>
      <div className="analysis-grid">
        <aside className="statement-queue">
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AnalysisStatement["status"] | "")}>
            <option value="">全部陈述</option>
            <option value="pending">待审核</option>
            <option value="approved">已批准</option>
            <option value="rejected">已拒绝</option>
          </select>
          {displayed.map((statement) => (
            <button
              className={statement.id === selectedId ? "statement selected" : "statement"}
              key={statement.id}
              onClick={() => setSelectedId(statement.id)}
            >
              <strong className={statement.relationType === "contradicts" ? "conflict" : ""}>{statement.relationType}</strong>
              <span>{statement.text}</span>
              <small>{statement.status === "pending" && statement.invalidatedAt ? "失效待重审" : statement.status}</small>
            </button>
          ))}
          {displayed.length === 0 && <p className="muted">没有符合条件的陈述。</p>}
        </aside>
        <main className="statement-editor">
          {selected ? <>
            <div className="statement-meta">
              <span>{selected.relationType}</span>
              <span className={`status ${selected.status}`}>{selected.status}</span>
            </div>
            {selected.invalidatedReason && selected.status === "pending" && <p className="invalidation">{selected.invalidatedReason}</p>}
            <textarea rows={6} value={editing} onChange={(event) => setEditing(event.target.value)} />
            <div className="actions">
              <button onClick={() => void saveText()}>保存陈述</button>
              <button onClick={() => void decide("approved")}>批准</button>
              <button className="danger" onClick={() => void decide("rejected")}>拒绝</button>
            </div>
            <section className={`precheck ${selected.precheck.status}`}>
              <div>
                <strong>AI 对应性预检</strong>
                <span>{checking.has(selected.id) ? "检查中..." : precheckLabels[selected.precheck.status]}</span>
              </div>
              {selected.precheck.reason && <p>{selected.precheck.reason}</p>}
              {selected.precheck.status === "failed" && <button onClick={() => void runPrecheck(selected)}>重新检查</button>}
            </section>
          </> : <p className="muted">完成关系审核后，在此核对可发布的分析陈述。</p>}
        </main>
        <aside className="evidence-editor">
          <h3>原文证据</h3>
          {selected?.citations.map((citation) => (
            <div className="statement-citation" key={citation.chunkId}>
              <button onClick={() => onOpenCitation(citation)}>
                {citation.documentName}{citation.pageNumber ? ` / P${citation.pageNumber}` : ` / L${citation.startLine ?? "?"}-${citation.endLine ?? "?"}`}
              </button>
              <p>{citation.excerpt}</p>
              <button className="ghost" onClick={() => void removeEvidence(citation.chunkId)}>移除</button>
            </div>
          ))}
          {selected && selected.citations.length === 0 && <p className="muted">尚无原文引用，不能批准。</p>}
          <form className="evidence-search" onSubmit={(event) => void searchEvidence(event)}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索库内原文块" />
            <button type="submit">查找</button>
          </form>
          {results.map((result) => (
            <div className="evidence-result" key={result.chunk.id}>
              <p>{result.chunk.text.slice(0, 130)}</p>
              <button onClick={() => void addEvidence(result.chunk.id)}>添加引用</button>
            </div>
          ))}
        </aside>
      </div>
    </section>
  );
}

function summaryFor(statements: AnalysisStatement[]): AnalysisDraft["summary"] {
  return {
    pending: statements.filter((statement) => statement.status === "pending").length,
    approved: statements.filter((statement) => statement.status === "approved").length,
    rejected: statements.filter((statement) => statement.status === "rejected").length,
    invalidated: statements.filter((statement) => statement.status === "pending" && statement.invalidatedAt !== null).length,
  };
}
