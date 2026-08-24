import React from 'react';
import { track, captureException } from '../services/analytics';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  // Explicit member declarations — @types/react is not installed in this
  // project, so React.Component's generics don't flow to this.state/props/setState.
  declare props: Props;
  declare setState: (s: Partial<State>) => void;
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // PostHog crash counter (props scrubbed — error_message is dropped by the
    // scrubber; the full message goes to Sentry below, not PostHog).
    track('app.crash', {
      severity: 'critical',
      stack: error.stack?.slice(0, 1000),
      component_stack: info.componentStack?.slice(0, 1000),
    });
    // Sentry exception capture (no-op without VITE_SENTRY_DSN).
    captureException(error, { scope: 'react-error-boundary' });
    console.error('[ErrorBoundary]', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl p-8 text-center">
            <div className="text-rose-500 text-4xl mb-3">⚠</div>
            <h1 className="text-xl font-bold text-slate-900 mb-2">Something went wrong</h1>
            <p className="text-sm text-slate-500 mb-5">
              This part of the app hit an unexpected error. The issue has been logged.
            </p>
            {this.state.error?.message && (
              <pre className="text-left text-[11px] bg-slate-100 border border-slate-200 rounded-lg p-3 mb-5 overflow-auto max-h-40 text-rose-700 whitespace-pre-wrap">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReset}
                className="rounded-full bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 transition"
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="rounded-full border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
              >
                Reload app
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
