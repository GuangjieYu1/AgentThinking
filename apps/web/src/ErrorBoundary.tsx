import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  message?: string;
  stack?: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(cause: unknown): ErrorBoundaryState {
    return {
      message: cause instanceof Error ? cause.message : "前端渲染时出现未知错误。",
    };
  }

  componentDidCatch(cause: unknown, info: ErrorInfo) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error("AgentThinking UI crashed", cause, info);
    this.setState({
      message,
      ...(info.componentStack ? { stack: info.componentStack } : {}),
    });
  }

  render() {
    if (!this.state.message) return this.props.children;
    return (
      <main className="app-crash">
        <section className="card app-crash-card">
          <span className="eyebrow">AgentThinking</span>
          <h1>页面渲染中断</h1>
          <p>刚才的操作触发了前端渲染错误，项目服务仍在运行。可以先刷新恢复；下面的信息用于定位问题。</p>
          <pre>{this.state.message}</pre>
          {this.state.stack && <details><summary>组件栈</summary><pre>{this.state.stack}</pre></details>}
          <button type="button" onClick={() => window.location.reload()}>刷新页面</button>
        </section>
      </main>
    );
  }
}
