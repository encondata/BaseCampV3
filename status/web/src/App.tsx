import { useCallback, useEffect, useRef, useState } from 'react';

import ServiceCard from './components/ServiceCard';
import StatusBanner from './components/StatusBanner';
import { fetchSummary, formatClock, POLL_MS, type Summary } from './lib/summary';

export default function App() {
  const [data, setData] = useState<Summary | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const next = await fetchSummary(ctrl.signal);
      setData(next);
      setLoadedAt(new Date());
      setFailed(false);
    } catch {
      if (!ctrl.signal.aborted) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      inflight.current?.abort();
    };
  }, [load]);

  return (
    <div className="portal-shell ss-shell">
      <main className="portal-page ss-page">
        <header className="ss-header">
          <div className="ss-brand">
            <img src="/serversherpa-logo.png" alt="" className="ss-logo" />
            <div>
              <div className="eyebrow">ServerSherpa</div>
              <h1 className="page-title">System Status</h1>
            </div>
          </div>
          {loadedAt && <div className="ss-updated">Updated {formatClock(loadedAt)}</div>}
        </header>

        {failed && data && loadedAt && (
          <div className="ss-stale" role="alert">
            Status data may be stale — last updated {formatClock(loadedAt)}. Retrying…
          </div>
        )}

        {data ? (
          <>
            <StatusBanner overall={data.overall} services={data.services} />
            <div className="ss-cards">
              {data.services.map((s) => <ServiceCard key={s.key} service={s} />)}
            </div>
          </>
        ) : failed ? (
          <div className="ss-stale" role="alert">Status is unavailable right now. Retrying…</div>
        ) : (
          <div className="ss-loading">Loading status…</div>
        )}

        <footer className="ss-footer">
          Checks run every minute. A service shows down after two failed checks in a row.
        </footer>
      </main>
    </div>
  );
}
