import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 全局错误边界：捕获子树渲染错误，防止单组件异常导致整页白屏。
 * 出错时展示友好提示与错误详情，支持一键刷新恢复。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] 渲染崩溃:', error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-slate-900 border border-red-800/50 rounded-2xl p-8 text-center space-y-4">
            <div className="text-4xl">⚠️</div>
            <h1 className="text-lg font-bold text-slate-100">页面渲染出现异常</h1>
            <p className="text-sm text-slate-400">
              应用遇到了一个错误。请尝试刷新页面，若问题持续请联系管理员。
            </p>
            {this.state.error && (
              <pre className="text-left text-xs text-red-300 bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-auto max-h-40">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold shadow transition-colors"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
