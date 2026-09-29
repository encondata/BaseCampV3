/** Catches a render error so the wiki shows what went wrong instead of
 *  unmounting to a blank (dark) screen. Wrapped around the whole app in
 *  Root and around the page area in WikiShell, where `resetKey` is the
 *  path so moving to another page clears the error and the sidebar stays.
 *  A lazy page chunk that fails to download lands here too. */
import { Component, type ErrorInfo, type ReactNode } from 'react';

/** `app` brings its own themed shell (nothing above it carries the
 *  portal tokens); `page` renders like any page inside the wiki shell. */
type Props = { children: ReactNode; resetKey?: string; scope?: 'app' | 'page' };
type State = { error: Error | null; resetKey?: string };

const CHUNK_RE = /dynamically imported module|Importing a module script failed|Failed to fetch/i;

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[wiki] render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const download = CHUNK_RE.test(error.message);
    const page = (
      <div className="portal-page wiki-page">
        <div className="eyebrow">ServerSherpa Wiki</div>
        <h1 className="page-title">Something went wrong</h1>
        <p className="page-hint">
          {download
            ? "Part of the wiki couldn't be downloaded. Reloading usually fixes it."
            : 'This page hit an error. Reloading usually fixes it. If it keeps happening, send the details below to an administrator.'}
        </p>
        <pre className="wiki-error-detail">{error.message}</pre>
        <p><button type="button" className="btn-solid" onClick={() => window.location.reload()}>Reload</button></p>
      </div>
    );
    return this.props.scope === 'page' ? page : <div className="portal-shell wiki-notice">{page}</div>;
  }
}
