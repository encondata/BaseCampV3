/** System → Processes: the heartbeat registry with derived status.
 *  Rows link to the log viewer only for god-mode developers. */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { listSystemProcesses, type SystemProcessOut } from '../lib/api';
import { formatAge, formatUptime, statusMeta } from '../lib/system';
import '../styles/directory.css';
import '../styles/system.css';

const POLL_MS = 10_000;

export default function SystemProcesses() {
  const { can, godMode } = useAuth();
  const canViewLogs = can('devtools', 'view') && godMode;
  const [rows, setRows] = useState<SystemProcessOut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () =>
      listSystemProcesses()
        .then((r) => { if (alive) { setRows(r); setError(null); } })
        .catch(() => { if (alive) setError('Cannot load processes.'); });
    void load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, []);

  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <h1 className="page-title">Processes</h1>
      <p className="page-hint">
        Every ServerSherpa process, its heartbeat, and its status.
      </p>

      {error && <div className="dir-empty"><b>{error}</b></div>}

      <div className="dir-list sys-proc-list">
        <div className="list-head sys-proc-grid">
          <span className="col-head">Status</span>
          <span className="col-head">Process</span>
          <span className="col-head">Kind</span>
          <span className="col-head">Host</span>
          <span className="col-head">PID</span>
          <span className="col-head">Uptime</span>
          <span className="col-head">Last heartbeat</span>
        </div>
        {rows.map((p) => {
          const meta = statusMeta(p.status);
          const degraded = p.meta.forwarding_degraded === true;
          const body = (
            <>
              <div className="cell sys-status">
                <span className={`sys-dot ${meta.className}`} />
                {meta.label}
                {degraded && (
                  <span className="chip c-amber">forwarding degraded</span>
                )}
              </div>
              <div className="cell"><span className="cell-top"><b>{p.name}</b></span></div>
              <div className="cell"><span className="chip c-slate">{p.kind}</span></div>
              <div className="cell"><span className="mono">{p.hostname || '—'}</span></div>
              <div className="cell"><span className="mono">{p.pid ?? '—'}</span></div>
              <div className="cell"><span className="mono">{formatUptime(p.uptime_seconds)}</span></div>
              <div className="cell"><span className="mono">{formatAge(p.heartbeat_at, now)}</span></div>
            </>
          );
          return (
            <div key={p.name} className="dir-row">
              {canViewLogs && p.kind !== 'probe' ? (
                <Link className="row-main sys-proc-grid"
                      to={`/system/processes/${p.name}/logs`}>
                  {body}
                </Link>
              ) : (
                <div className="row-main sys-proc-grid" style={{ cursor: 'default' }}>{body}</div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && !error && (
          <p className="page-hint" style={{ padding: 16 }}>
            No processes have registered yet.
          </p>
        )}
      </div>
    </div>
  );
}
