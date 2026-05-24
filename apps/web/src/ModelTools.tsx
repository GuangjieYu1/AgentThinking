import { useRef, useState, type FormEvent } from "react";
import type { ModelTestResult } from "@agent-thinking/contracts";
import { api } from "./api";

export function ModelTools({
  provider,
  onHealthChange,
}: {
  provider: string;
  onHealthChange: () => void;
}) {
  const [testOpen, setTestOpen] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ModelTestResult>();
  const [testError, setTestError] = useState<string>();
  const [prompt, setPrompt] = useState("请用两句话说明如何从材料中识别概念与逻辑关系。");
  const [content, setContent] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);

  const runTest = async () => {
    setTestOpen(true);
    setTesting(true);
    setTestError(undefined);
    try {
      const result = await api.testModel();
      setTestResult(result);
      onHealthChange();
    } catch (cause) {
      setTestResult(undefined);
      setTestError((cause as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const runStream = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || streaming) return;
    controller.current?.abort();
    controller.current = new AbortController();
    setStreaming(true);
    setStreamError(undefined);
    setContent("");
    setReasoning("");
    try {
      await api.streamModel(prompt, (update) => {
        if (update.type === "content") setContent((value) => value + update.text);
        if (update.type === "reasoning") setReasoning((value) => value + update.text);
        if (update.type === "error") setStreamError(update.message);
      }, controller.current.signal);
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") setStreamError((cause as Error).message);
    } finally {
      setStreaming(false);
    }
  };

  const closeStream = () => {
    controller.current?.abort();
    setStreaming(false);
    setStreamOpen(false);
  };

  return (
    <>
      <section className="model-tools">
        <h2>模型工具</h2>
        <button onClick={() => void runTest()}>测试模型连接</button>
        <button onClick={() => setStreamOpen(true)}>流式输出窗口</button>
      </section>
      {testOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTestOpen(false)}>
          <section className="modal model-test-modal" role="dialog" aria-label="模型连接测试" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>模型连接测试</h2>
              <button className="icon-button" onClick={() => setTestOpen(false)}>x</button>
            </header>
            <div className={testing ? "connection checking" : testResult?.ok ? "connection ok" : "connection failed"}>
              <span />
              <strong>{testing ? "连接中..." : testResult?.ok ? "连接成功" : "连接失败"}</strong>
            </div>
            <p className="model-name">{testResult?.provider ?? provider}</p>
            <p className="test-message">{testError ?? testResult?.message ?? "正在请求模型服务。"}</p>
            <button onClick={() => void runTest()} disabled={testing}>重新测试</button>
          </section>
        </div>
      )}
      {streamOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal stream-modal" role="dialog" aria-label="大模型流式输出">
            <header>
              <div>
                <h2>大模型流式输出</h2>
                <small>{provider}</small>
              </div>
              <button className="icon-button" onClick={closeStream}>x</button>
            </header>
            <form className="stream-compose" onSubmit={(event) => void runStream(event)}>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="输入测试提示词" />
              <div>
                <button type="submit" disabled={streaming}>{streaming ? "生成中..." : "发送"}</button>
                {streaming && <button type="button" className="danger" onClick={() => controller.current?.abort()}>停止</button>}
                <button type="button" className="ghost" onClick={() => { setContent(""); setReasoning(""); setStreamError(undefined); }}>清空</button>
              </div>
            </form>
            <div className="stream-output" aria-live="polite">
              {reasoning && <details><summary>思考内容</summary><pre>{reasoning}</pre></details>}
              <pre className={!content ? "placeholder" : ""}>
                {content || (streaming ? "等待首个输出片段..." : "发送提示词后，模型的输出会在这里逐字出现。")}
              </pre>
              {streamError && <p className="stream-error">{streamError}</p>}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
