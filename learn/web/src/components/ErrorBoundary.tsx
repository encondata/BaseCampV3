/** Catches a render error so the page shows what went wrong (and a way
 *  out) instead of unmounting to a blank screen. */
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { t } from '../lib/i18n';

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[learn] render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="learn-crash" role="alert">
        <div className="eyebrow">{t('app.name')}</div>
        <h1>{t('crash.title')}</h1>
        <p>{t('crash.hint')}</p>
        <pre>{error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>{t('crash.reload')}</button>
      </main>
    );
  }
}
