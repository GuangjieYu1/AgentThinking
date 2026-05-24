import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Document, IngestJob, Library, LibrarySettings, OcrMode } from "@agent-thinking/contracts";
import { api } from "./api";
import { GraphWorkspace } from "./GraphWorkspace";
import { ModelTools } from "./ModelTools";

export function App() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string>();
  const [health, setHealth] = useState<{ provider: string; aiConfigured: boolean; vectorEngine: string }>();

  const loadLibraries = async () => {
    const values = await api.libraries();
    setLibraries(values);
    setSelectedId((current) => current && values.some((item) => item.id === current) ? current : values[0]?.id);
  };

  useEffect(() => {
    void Promise.all([loadLibraries(), api.health().then(setHealth)]).catch((cause: Error) => setError(cause.message));
  }, []);

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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          <div><strong>AgentThinking</strong><small>Knowledge Graph Studio</small></div>
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
        <ModelTools
          provider={health?.provider ?? "model"}
          onHealthChange={() => void api.health().then(setHealth).catch((cause: Error) => setError(cause.message))}
        />
        <footer className="runtime">
          <span className={health?.aiConfigured ? "online" : "warning"} />
          {health ? `${health.provider} / ${health.vectorEngine}` : "连接服务中..."}
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

function LibraryWorkspace({ library, onError }: { library: Library; onError: (message: string) => void }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [settings, setSettings] = useState<LibrarySettings>();
  const [refreshGraph, setRefreshGraph] = useState(0);
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
  };

  useEffect(() => {
    void reload().catch((cause: Error) => onError(cause.message));
    const stream = new EventSource(`/api/libraries/${library.id}/events`);
    stream.onmessage = (event) => {
      const update = JSON.parse(event.data) as IngestJob | { type: string };
      if ("id" in update) {
        setJobs((current) => [update, ...current.filter((job) => job.id !== update.id)]);
        if (update.stage === "completed") {
          void api.documents(library.id).then(setDocuments);
          setRefreshGraph((value) => value + 1);
        }
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

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div>
          <h1>{library.name}</h1>
          <p>{documents.length} 个文档 / {activeJobs.length} 个处理中任务</p>
        </div>
        <label className="upload">
          导入 Markdown / TXT / PDF
          <input type="file" multiple accept=".md,.markdown,.txt,.pdf" onChange={(event) => void upload(event.target.files)} />
        </label>
      </header>
      <div className="panels">
        <section className="ingest-panel card">
          <h2>材料与处理</h2>
          <label className="setting">
            扫描 PDF OCR
            <select value={settings?.ocrMode ?? "local"} onChange={(event) => void setOcrMode(event.target.value as OcrMode)}>
              <option value="local">本地 OCR</option>
              <option value="cloud">云端视觉模型</option>
            </select>
          </label>
          <div className="document-list">
            {documents.map((document) => (
              <div className="document" key={document.id}>
                <span>{document.name}</span>
                <small>{document.latestVersion?.status ?? "等待"}</small>
              </div>
            ))}
          </div>
          <h2>后台任务</h2>
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
          </div>
        </section>
        <GraphWorkspace libraryId={library.id} refreshKey={refreshGraph} onError={onError} />
      </div>
    </div>
  );
}
