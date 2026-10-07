import { Component, type ReactNode } from "react";

/** 部署切换或网络失败导致页面代码不可用时，保留导航和明确恢复出口。 */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <main className="page" role="alert">
      <h1>页面文件未能加载</h1>
      <p>已保存的制作不会丢失。请检查连接后重新加载，也可以从导航打开其他页面。</p>
      <button className="button button-primary" type="button" onClick={() => window.location.reload()}>重新加载页面</button>
    </main>;
    return this.props.children;
  }
}
