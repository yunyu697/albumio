// ErrorBoundary：兜底 render 阶段的 React 异常（纯 UI 崩溃）。
// 每个屏一个；兜底 UI 不抢焦点，给"返回首页"按钮（把 App 的 dir 清空就能回到侧栏）。
// 不做 class 组件了，用 react-error-boundary（npm 包里已有）+ 最小 fallback。
// 实际上用我们自己的 class 也行，但这个项目没引入 react-error-boundary，
// 所以就地写一个极简 class 版。
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 出错后给用户一个"回退"回调（比如清空 dir / 关闭弹窗）。不填就只显示错误。 */
  onReset?: () => void;
  /** 给用户的一句话，说明刚刚挂了什么（屏名）。 */
  label?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message || String(err) };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // 只打 console.error，不做上报——RC 阶段不想引入 Sentry 这类额外依赖。
    console.error(`[ErrorBoundary] ${this.props.label ?? "组件"} crashed:`, err, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, message: "" });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="eb-root">
          <div className="eb-card">
            <div className="eb-title">{this.props.label ?? "这个组件"} 崩了</div>
            <div className="eb-msg">{this.state.message}</div>
            <div className="eb-actions">
              <button className="eb-btn" onClick={this.handleReset}>
                重试
              </button>
              {this.props.onReset && (
                <button className="eb-btn secondary" onClick={this.handleReset}>
                  返回首页
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
