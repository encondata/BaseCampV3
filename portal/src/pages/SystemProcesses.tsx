/** System → Processes: the heartbeat registry with derived status.
 *  Rows link to the log viewer only for god-mode developers. */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { listSystemProcesses, type SystemProcessOut } from '../lib/api';
import { ColHead, listGridStyle, listScale, titleFor } from '../lib/listTools';
import { formatAge, formatUptime, statusMeta, SYSTEM_PROCESS_COLUMNS } from '../lib/system';
import '../styles/directory.css';
import '../styles/system.css';

const POLL_MS = 10_000;

/** statusMeta()'s `className` is a `sys-dot-*` visual-key color — reuse it
 *  to pick the matching golden status chip (c-green running / c-amber
 *  paused / c-slate stopped / c-red failed) rather than adding a second,
 *  divergent status→color map. Kept local (not exported from lib/system)
 *  so lib/system.test.ts's exact statusMeta() shape assertions stay
 *  untouched. */
const STATUS_CHIP_CLASS: Record<string, string> = {
  'sys-dot-running': 'c-green',
  'sys-dot-paused': 'c-amber',
  'sys-dot-stopped': 'c-slate',
  'sys-dot-failed': 'c-red',
};

export default function SystemProcesses() {
  const { can, godMode, preferences } = useAuth();
  const canViewLogs = can('devtools', 'view') && godMode;
  const listGridScale = listScale(preferences?.list_size);
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

  const grid = listGridStyle(SYSTEM_PROCESS_COLUMNS, [], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <h1 className="page-title">Processes</h1>
      <p className="page-hint">
        Every ServerSherpa process, its heartbeat, and its status.
      </p>

      {error && <div className="dir-empty"><b>{error}</b></div>}

      <div className="dir-list sys-proc-list list-scroll">
        <div className="list-head" style={rowStyle}>
          {SYSTEM_PROCESS_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
        </div>
        {rows.map((p) => {
          const meta = statusMeta(p.status);
          const degraded = p.meta.forwarding_degraded === true;
          const host = p.hostname || '—';
          const pid = String(p.pid ?? '—');
          const uptime = formatUptime(p.uptime_seconds);
          const heartbeat = formatAge(p.heartbeat_at, now);
          const body = (
            <>
              <div className="cell sys-status">
                <span className={`sys-dot ${meta.className}`} />
                <span className={`chip ${STATUS_CHIP_CLASS[meta.className] ?? 'c-slate'}`}>
                  {meta.label}
                </span>
                {degraded && (
                  <span className="chip c-amber">forwarding degraded</span>
                )}
              </div>
              <div className="cell">
                <span className="cell-top cell-line" title={titleFor(p.name)}><b>{p.name}</b></span>
              </div>
              <div className="cell"><span className="chip c-slate">{p.kind}</span></div>
              <div className="cell"><span className="mono cell-line" title={titleFor(host)}>{host}</span></div>
              <div className="cell"><span className="mono cell-line" title={titleFor(pid)}>{pid}</span></div>
              <div className="cell">
                <span className="mono cell-line" title={titleFor(uptime)}>{uptime}</span>
              </div>
              <div className="cell">
                <span className="mono cell-line" title={titleFor(heartbeat)}>{heartbeat}</span>
              </div>
            </>
          );
          return (
            <div key={p.name} className="dir-row" style={{ minWidth: rowStyle.minWidth }}>
              {canViewLogs && p.kind !== 'probe' ? (
                <Link className="row-main" style={rowStyle}
                      to={`/system/processes/${p.name}/logs`}>
                  {body}
                </Link>
              ) : (
                <div className="row-main" style={{ ...rowStyle, cursor: 'default' }}>{body}</div>
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
