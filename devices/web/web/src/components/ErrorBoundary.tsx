/** Catches a render error so the page shows what went wrong (and a way
 *  out) instead of unmounting to a blank screen. */
import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[devices] render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="portal-shell devices-notice" role="alert">
        <div className="portal-page">
          <div className="eyebrow">ServerSherpa Devices</div>
          <h1 className="page-title">Something went wrong</h1>
          <p className="page-hint">Reload the page to try again.</p>
          <pre className="devices-error-detail">{error.message}</pre>
          <button type="button" className="btn-ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
