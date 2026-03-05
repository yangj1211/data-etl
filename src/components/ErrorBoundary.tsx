import { Component, type ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.fallbackLabel || '', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleClearAndReset = () => {
    // Clear potentially corrupted localStorage
    const keys = Object.keys(localStorage).filter(k => k.startsWith('etl-'));
    keys.forEach(k => localStorage.removeItem(k));
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center mx-auto mb-3">
              <AlertCircle className="w-6 h-6 text-red-400" />
            </div>
            <p className="text-sm font-medium text-slate-700 mb-1">
              {this.props.fallbackLabel || '组件'}渲染出错
            </p>
            <p className="text-xs text-slate-400 mb-1 font-mono break-all">
              {this.state.error?.message}
            </p>
            <div className="flex items-center justify-center gap-2 mt-3">
              <button
                onClick={this.handleReset}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                重试
              </button>
              <button
                onClick={this.handleClearAndReset}
                className="px-3 py-1.5 text-xs text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors cursor-pointer"
              >
                清除缓存并刷新
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
