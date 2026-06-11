import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  BenchmarkCatalog,
  BenchmarkRunListEntry,
  BenchmarkRunResult,
  BenchmarkSuite,
  CreateBenchmarkRunInput,
} from "@agent-thinking/contracts";
import { api } from "./api";

const suiteOrder: BenchmarkSuite[] = ["kilt", "crag", "ragbench", "crud_rag", "ragas", "ares"];

const kindLabel = {
  dataset: "数据集型",
  scoring: "评分型",
} as const;

const reviewVerdictLabel = {
  aligned: "基本一致",
  partial: "部分一致",
  mismatch: "差异明显",
} as const;

const reviewRoleLabel = {
  included: "纳入",
  excluded: "排除",
  uncertain: "不确定",
  background: "背景",
  not_mentioned: "未提及",
} as const;

function percent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function decimal(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function integer(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return Math.round(value).toString();
}

function suiteSummary(run: BenchmarkRunResult | undefined, suite: BenchmarkSuite) {
  return run?.benchmarkSuites.find((entry) => entry.suite === suite);
}

function delta(next: number | undefined, previous: number | undefined): string | undefined {
  if (next === undefined || previous === undefined || !Number.isFinite(next) || !Number.isFinite(previous)) return undefined;
  const diff = next - previous;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${(diff * 100).toFixed(1)}%`;
}

export function BenchmarkWorkspace({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const [catalog, setCatalog] = useState<BenchmarkCatalog>();
  const [runs, setRuns] = useState<BenchmarkRunListEntry[]>([]);
  const [activeRun, setActiveRun] = useState<BenchmarkRunResult>();
  const [compareRun, setCompareRun] = useState<BenchmarkRunResult>();
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [selectedSuites, setSelectedSuites] = useState<Set<BenchmarkSuite>>(new Set());
  const [provider, setProvider] = useState<CreateBenchmarkRunInput["provider"]>("configured");
  const [mode, setMode] = useState<CreateBenchmarkRunInput["mode"]>("full");
  const [iterations, setIterations] = useState(1);
  const [label, setLabel] = useState("");
  const [expandedScenario, setExpandedScenario] = useState<string>();

  const load = async () => {
    setLoading(true);
    try {
      const [nextCatalog, nextRuns] = await Promise.all([api.benchmarkCatalog(), api.benchmarkRuns()]);
      setCatalog(nextCatalog);
      setRuns(nextRuns);
      const primary = nextRuns[0];
      const secondary = nextRuns[1];
      setActiveRun(primary ? await api.benchmarkRun(primary.id) : undefined);
      setCompareRun(secondary ? await api.benchmarkRun(secondary.id) : undefined);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const runIds = useMemo(() => new Set(runs.map((run) => run.id)), [runs]);

  useEffect(() => {
    if (!activeRun || runIds.has(activeRun.id)) return;
    setActiveRun(undefined);
  }, [activeRun?.id, runIds]);

  useEffect(() => {
    if (!compareRun || runIds.has(compareRun.id)) return;
    setCompareRun(undefined);
  }, [compareRun?.id, runIds]);

  const startRun = async (event: FormEvent) => {
    event.preventDefault();
    setRunning(true);
    try {
      const created = await api.createBenchmarkRun({
        ...(label.trim() ? { label: label.trim() } : {}),
        provider,
        mode,
        iterations,
        suites: suiteOrder.filter((suite) => selectedSuites.has(suite)),
        scenarioNames: [],
      });
      setLabel("");
      await load();
      setActiveRun(created);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const openRun = async (runId: string, target: "active" | "compare") => {
    try {
      const run = await api.benchmarkRun(runId);
      if (target === "active") setActiveRun(run);
      else setCompareRun(run);
    } catch (cause) {
      onError((cause as Error).message);
    }
  };

  const visibleSuites = catalog?.suites ?? [];
  const activeSuiteRows = suiteOrder
    .map((suite) => ({
      suite,
      current: suiteSummary(activeRun, suite),
      previous: suiteSummary(compareRun, suite),
      meta: visibleSuites.find((entry) => entry.suite === suite),
    }))
    .filter((entry) => entry.meta);

  return (
    <section className="benchmark-workspace card">
      <header className="benchmark-header">
        <div>
          <h2>Benchmark 面板</h2>
          <p>运行固定场景基准，保留每次 JSON 结果，并直接在界面对比版本迭代。</p>
        </div>
        <div className="benchmark-header-actions">
          {activeRun && (
            <>
              <a className="ghost button-link" href={api.benchmarkRunMarkdownUrl(activeRun.id)}>导出 Markdown</a>
              <a className="ghost button-link" href={api.benchmarkRunJsonUrl(activeRun.id)}>导出 JSON</a>
            </>
          )}
          <button className="ghost" type="button" onClick={() => void load()} disabled={loading || running}>刷新</button>
        </div>
      </header>

      <div className="benchmark-layout">
        <aside className="benchmark-sidebar">
          <form className="benchmark-runner" onSubmit={(event) => void startRun(event)}>
            <h3>新建 Run</h3>
            <label>
              <span>标签</span>
              <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：AORI demand v2.3" />
            </label>
            <label>
              <span>Provider</span>
              <select value={provider} onChange={(event) => setProvider(event.target.value as CreateBenchmarkRunInput["provider"])}>
                <option value="configured">configured</option>
                <option value="fake">fake</option>
              </select>
            </label>
            <label>
              <span>模式</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as CreateBenchmarkRunInput["mode"])}>
                <option value="full">full</option>
                <option value="progressive">progressive</option>
              </select>
            </label>
            <label>
              <span>迭代次数</span>
              <input
                type="number"
                min={1}
                max={5}
                value={iterations}
                onChange={(event) => setIterations(Math.max(1, Math.min(5, Number(event.target.value) || 1)))}
              />
            </label>
            <fieldset className="benchmark-suite-picker">
              <legend>套件筛选</legend>
              {visibleSuites.map((suite) => {
                const checked = selectedSuites.has(suite.suite);
                return (
                  <label key={suite.suite} className="benchmark-suite-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setSelectedSuites((current) => {
                        const next = new Set(current);
                        if (checked) next.delete(suite.suite);
                        else next.add(suite.suite);
                        return next;
                      })}
                    />
                    <div>
                      <strong>{suite.label}</strong>
                      <small>{kindLabel[suite.kind]} · {suite.focus.join(" / ")}</small>
                    </div>
                  </label>
                );
              })}
            </fieldset>
            <button type="submit" disabled={running}>{running ? "运行中..." : "运行 Benchmark"}</button>
          </form>

          <div className="benchmark-history">
            <div className="panel-section-heading">
              <h3>历史结果</h3>
              <span>{runs.length} runs</span>
            </div>
            {runs.length === 0 && !loading && <p className="muted">还没有 benchmark 结果。</p>}
            <div className="benchmark-run-list">
              {runs.map((run) => (
                <div className="benchmark-run-card" key={run.id}>
                  <button className="benchmark-run-main" type="button" onClick={() => void openRun(run.id, "active")}>
                    <strong>{run.label ?? run.id}</strong>
                    <small>{new Date(run.createdAt).toLocaleString()}</small>
                    <small>{run.providerLabel} · {run.mode} · {run.iterations} iter</small>
                    <small>strict {percent(run.overall.strictPassRate)} · faith {percent(run.overall.avgRagasFaithfulness)}</small>
                  </button>
                  <div className="benchmark-run-actions">
                    <button type="button" className={activeRun?.id === run.id ? "selected" : ""} onClick={() => void openRun(run.id, "active")}>主视图</button>
                    <button type="button" className={compareRun?.id === run.id ? "selected" : ""} onClick={() => void openRun(run.id, "compare")}>对比</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main className="benchmark-main">
          {!activeRun && !loading && <div className="workspace-panel"><p className="muted">运行一次 benchmark 后，这里会显示结果总览和历史对比。</p></div>}
          {activeRun && (
            <>
              <div className="workspace-panel benchmark-summary-panel">
                <div className="benchmark-summary-header">
                  <div>
                    <h3>{activeRun.label ?? activeRun.id}</h3>
                    <small>{new Date(activeRun.createdAt).toLocaleString()} · {activeRun.providerLabel} · {activeRun.mode} · {activeRun.iterations} iter</small>
                  </div>
                  <div className="pipeline-strip">
                    <span>strict {percent(activeRun.overall.strictPassRate)}</span>
                    <span>coverage {percent(activeRun.overall.avgAnswerCoverage)}</span>
                    <span>citeR {percent(activeRun.overall.avgCitationRecall)}</span>
                    <span>ragas faith {percent(activeRun.overall.avgRagasFaithfulness)}</span>
                    <span>ares rel {percent(activeRun.overall.avgAresAnswerRelevance)}</span>
                    <span>{decimal(activeRun.overall.avgDurationMs)}ms / run</span>
                    <span>{integer(activeRun.overall.avgTotalTokens)} tok / run</span>
                  </div>
                </div>
                <div className="benchmark-methodology">
                  <strong>评测前提</strong>
                  <p>{activeRun.methodology.benchmarkTarget}</p>
                  <p>{activeRun.methodology.benchmarkAssumption}</p>
                  <p className="muted">{activeRun.methodology.caveat}</p>
                </div>
                {compareRun && (
                  <div className="benchmark-compare-note">
                    对比基线：<strong>{compareRun.label ?? compareRun.id}</strong>
                    <small>{new Date(compareRun.createdAt).toLocaleString()}</small>
                  </div>
                )}
              </div>

              <div className="workspace-panel benchmark-suite-table">
                <div className="panel-section-heading">
                  <h3>套件对比</h3>
                  <span>{activeRun.benchmarkSuites.length} suites</span>
                </div>
                <div className="benchmark-table-scroll">
                  <div className="benchmark-table benchmark-suite-grid">
                    <div className="benchmark-table-row benchmark-table-head">
                      <span>Suite</span>
                      <span>Strict</span>
                      <span>Coverage</span>
                      <span>Citation Recall</span>
                      <span>RAGAS Faithfulness</span>
                      <span>ARES Relevance</span>
                      <span>Avg Duration</span>
                      <span>Avg Tokens</span>
                    </div>
                    {activeSuiteRows.map(({ suite, current, previous, meta }) => (
                      <div className="benchmark-table-row" key={suite}>
                        <div>
                          <strong>{meta?.label}</strong>
                          <small>{kindLabel[meta!.kind]}</small>
                        </div>
                        <div>
                          <strong>{percent(current?.strictPassRate)}</strong>
                          {compareRun && <small>{delta(current?.strictPassRate, previous?.strictPassRate) ?? "-"}</small>}
                        </div>
                        <div>
                          <strong>{percent(current?.avgAnswerCoverage)}</strong>
                          {compareRun && <small>{delta(current?.avgAnswerCoverage, previous?.avgAnswerCoverage) ?? "-"}</small>}
                        </div>
                        <div>
                          <strong>{percent(current?.avgCitationRecall)}</strong>
                          {compareRun && <small>{delta(current?.avgCitationRecall, previous?.avgCitationRecall) ?? "-"}</small>}
                        </div>
                        <div>
                          <strong>{percent(current?.avgRagasFaithfulness)}</strong>
                          {compareRun && <small>{delta(current?.avgRagasFaithfulness, previous?.avgRagasFaithfulness) ?? "-"}</small>}
                        </div>
                        <div>
                          <strong>{percent(current?.avgAresAnswerRelevance)}</strong>
                          {compareRun && <small>{delta(current?.avgAresAnswerRelevance, previous?.avgAresAnswerRelevance) ?? "-"}</small>}
                        </div>
                        <div>
                          <strong>{decimal(current?.avgDurationMs)}ms</strong>
                          {compareRun && (
                            <small>
                              {current?.avgDurationMs !== undefined && previous?.avgDurationMs !== undefined
                                ? `${current.avgDurationMs >= previous.avgDurationMs ? "+" : ""}${decimal(current.avgDurationMs - previous.avgDurationMs)}ms`
                                : "-"}
                            </small>
                          )}
                        </div>
                        <div>
                          <strong>{integer(current?.avgTotalTokens)}</strong>
                          {compareRun && (
                            <small>
                              {current?.avgTotalTokens !== undefined && previous?.avgTotalTokens !== undefined
                                ? `${Math.round(current.avgTotalTokens - previous.avgTotalTokens) >= 0 ? "+" : ""}${Math.round(current.avgTotalTokens - previous.avgTotalTokens)}`
                                : "-"}
                            </small>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="workspace-panel benchmark-scenario-table">
                <div className="panel-section-heading">
                  <h3>场景详情</h3>
                  <span>{activeRun.scenarioSummaries.length} scenarios</span>
                </div>
                <div className="benchmark-table-scroll">
                  <div className="benchmark-table benchmark-scenario-grid">
                    <div className="benchmark-table-row benchmark-table-head">
                      <span>Scenario</span>
                      <span>Strict</span>
                      <span>Coverage</span>
                      <span>Misses</span>
                      <span>Duration</span>
                      <span>Tokens</span>
                      <span>Report</span>
                    </div>
                    {activeRun.scenarioSummaries.map((scenario) => (
                      <div className="benchmark-table-row" key={scenario.scenario}>
                        <div>
                          <strong>{scenario.scenario}</strong>
                          <small>{activeRun.records.find((record) => record.scenario === scenario.scenario)?.language ?? "-"}</small>
                        </div>
                        <div><strong>{percent(scenario.strictPassRate)}</strong></div>
                        <div><strong>{percent(scenario.avgAnswerCoverage)}</strong></div>
                        <div><small>{scenario.latestAnswerMisses.length > 0 ? scenario.latestAnswerMisses.join(" | ") : "-"}</small></div>
                        <div><strong>{decimal(scenario.avgDurationMs)}ms</strong></div>
                        <div><strong>{integer(scenario.avgTotalTokens)}</strong></div>
                        <div>
                          <button
                            type="button"
                            className={expandedScenario === scenario.scenario ? "selected" : ""}
                            onClick={() => setExpandedScenario((current) => current === scenario.scenario ? undefined : scenario.scenario)}
                          >
                            {expandedScenario === scenario.scenario ? "收起" : "展开"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {expandedScenario && (() => {
                  const record = activeRun.records.find((entry) => entry.scenario === expandedScenario);
                  if (!record) return null;
                  return (
                    <div className="benchmark-report-card">
                      <div className="panel-section-heading">
                        <h3>{record.scenario} 报告</h3>
                        <span>{record.language} · {record.modelCalls} calls · {integer(record.totalTokens)} tok</span>
                      </div>
                      <div className="benchmark-report-grid">
                        <section>
                          <h4>问题</h4>
                          <pre>{record.question}</pre>
                        </section>
                        <section>
                          <h4>模型回答</h4>
                          <pre>{record.actualAnswer}</pre>
                        </section>
                        <section>
                          <h4>回答摘要</h4>
                          <pre>{record.actualSummary}</pre>
                        </section>
                        <section>
                          <h4>期望答案应包含</h4>
                          <ul>
                            {record.expectedAnswerIncludes.map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </section>
                        <section>
                          <h4>期望答案不应包含</h4>
                          <ul>
                            {(record.expectedAnswerExcludes.length > 0 ? record.expectedAnswerExcludes : ["-"]).map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </section>
                        <section>
                          <h4>本次未命中的关键点</h4>
                          <ul>
                            {(record.answerMisses.length > 0 ? record.answerMisses : ["-"]).map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </section>
                      </div>
                      <div className="benchmark-report-grid benchmark-report-grid-extended">
                        <section>
                          <h4>原文证据</h4>
                          {(record.sourceItems?.length ?? 0) > 0 ? (
                            <div className="benchmark-source-list">
                              {record.sourceItems?.map((item) => (
                                <article key={`${record.scenario}-${item.title}`} className="benchmark-source-item">
                                  <strong>{item.title}</strong>
                                  <pre>{item.text}</pre>
                                </article>
                              ))}
                            </div>
                          ) : (
                            <p className="muted">此旧版 benchmark 记录未保留原文片段。</p>
                          )}
                        </section>
                        <section>
                          <h4>AI评审结论</h4>
                          {record.answerReview ? (
                            <div className="benchmark-review-block">
                              <p><strong>{reviewVerdictLabel[record.answerReview.verdict]}</strong></p>
                              <p>{record.answerReview.summary}</p>
                              <p>预期答案概括：{record.answerReview.expectedAnswerSummary}</p>
                              <p>实际答案概括：{record.answerReview.actualAnswerSummary}</p>
                            </div>
                          ) : (
                            <p className="muted">此旧版 benchmark 记录未保留结构化 AI 评审结果。</p>
                          )}
                        </section>
                        <section>
                          <h4>AI评审 - 差异点</h4>
                          {record.answerReview && record.answerReview.differences.length > 0 ? (
                            <ul>
                              {record.answerReview.differences.map((item, index) => (
                                <li key={`${item.aspect}-${index}`}>
                                  <strong>{item.aspect}</strong><br />
                                  预期：{item.expected}<br />
                                  实际：{item.actual}<br />
                                  影响：{item.impact}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted">{record.answerReview ? "没有额外记录到结构化差异。" : "暂无 AI 差异评审。"}</p>
                          )}
                        </section>
                        <section>
                          <h4>AI评审 - 原文 / 预期 / 实际对应</h4>
                          {record.answerReview && record.answerReview.sourceComparisons.length > 0 ? (
                            <div className="benchmark-source-list">
                              {record.answerReview.sourceComparisons.map((item) => (
                                <article key={`${record.scenario}-${item.sourceTitle}`} className="benchmark-source-item">
                                  <strong>{item.sourceTitle}</strong>
                                  <small>预期：{reviewRoleLabel[item.expectedRole]} ｜ 实际：{reviewRoleLabel[item.actualRole]}</small>
                                  <pre>{item.sourceTextExcerpt}</pre>
                                  <p>{item.note}</p>
                                </article>
                              ))}
                            </div>
                          ) : (
                            <p className="muted">{record.answerReview ? "没有生成原文级对照。" : "暂无 AI 原文对照评审。"}</p>
                          )}
                        </section>
                        <section>
                          <h4>AI评审 - 改进建议</h4>
                          {record.answerReview && record.answerReview.improvementActions.length > 0 ? (
                            <ul>
                              {record.answerReview.improvementActions.map((item) => <li key={item}>{item}</li>)}
                            </ul>
                          ) : (
                            <p className="muted">{record.answerReview ? "没有额外建议。" : "暂无 AI 改进建议。"}</p>
                          )}
                        </section>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </>
          )}
        </main>
      </div>
    </section>
  );
}
