/** History tab: report runs the caller may see (rank + scope gate is
 *  server-side). Polls every 3 s while any listed run is queued/running. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import { ApiError, getReportRun, getReportRunDownloadUrl, listReportRuns } from '../../lib/api';
import type { ReportRun } from '../../lib/api';
import { ColHead, listGridStyle, listScale, titleFor, type ColumnDef } from '../../lib/listTools';
import { formatBytes, openPresigned } from '../../lib/reports';
import { RowActionsMenu } from '../hardware/RowActionsMenu';

export const HISTORY_POLL_MS = 3000;
export const HISTORY_PAGE_SIZE = 100;

// No column registry pre-migration (hand-written header spans) — this
// local COLUMNS mirrors them (recipe R1). Read-only, unsortable list —
// headers render as plain ColHead spans (no onToggleSort). The trailing
// 100px track holds an unlabeled RowActionsMenu trigger (Download / View
// error), kept at its original width.
// Fit: default columns + trailing ≤ LIST_FIT.page (1172px — .portal-page at a
// 1512px window, nav expanded — HistoryTab sits directly in .portal-page
// under the History tab).
const COLUMNS: ColumnDef[] = [
  { key: 'report', label: 'Report', width: '1.4fr', default: true, min: 140 },
  { key: 'initiative', label: 'Initiative', width: '1.4fr', default: true },
  { key: 'requested_by', label: 'Requested by', width: '1.2fr', default: true },
  { key: 'requested_at', label: 'Requested at', short: 'Date', width: '1.2fr', default: true, min: 96 },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'size', label: 'Size', width: '0.8fr', default: true },
];
const TRAILING = ['100px'];

const STATUS_LABEL: Record<ReportRun['status'], string> = {
  queued: 'Queued', running: 'Generating', completed: 'Completed', failed: 'Failed',
};
const STATUS_CHIP: Record<ReportRun['status'], string> = {
  queued: 'c-slate', running: 'c-violet', completed: 'c-green', failed: 'c-red',
};

export function duration(run: ReportRun): string {
  if (!run.started_at || !run.finished_at) return '';
  const s = Math.max(0, Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function HistoryTab({ highlightRunId, onCount }: {
  highlightRunId: string | null;
  onCount: (n: number) => void;
}) {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [runs, setRuns] = useState<ReportRun[] | null>(null);
  const [pinned, setPinned] = useState<ReportRun | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<ReportRun | null>(null);

  // A poll refreshes the newest page only; anything `Load older` already
  // appended stays put (and never doubles up — the head wins on id).
  const load = async (first = false) => {
    try {
      const rows = await listReportRuns({ limit: HISTORY_PAGE_SIZE });
      setRuns((cur) => {
        if (cur === null) return rows;
        const ids = new Set(rows.map((r) => r.id));
        return [...rows, ...cur.filter((r) => !ids.has(r.id))];
      });
      if (first) setMore(rows.length === HISTORY_PAGE_SIZE);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load report history.");
    }
  };
  useEffect(() => { void load(true); }, []);       // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = async () => {
    const last = (runs ?? [])[(runs ?? []).length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const older = await listReportRuns({ before: last.created_at, limit: HISTORY_PAGE_SIZE });
      setRuns((cur) => [...(cur ?? []), ...older]);
      setMore(older.length === HISTORY_PAGE_SIZE);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load older reports.");
    } finally {
      setLoadingMore(false);
    }
  };

  // A notification link can point at a run that has already scrolled off
  // the newest page (or that a filter never loaded): fetch it once and pin
  // it to the top so the deep link always lands on something.
  useEffect(() => {
    if (!highlightRunId || runs === null) return;
    if (runs.some((r) => r.id === highlightRunId)) { setPinned(null); return; }
    if (pinned?.id === highlightRunId) return;
    let done = false;
    void getReportRun(highlightRunId)
      .then((r) => { if (!done) setPinned(r); })
      .catch(() => undefined);                     // gone or not visible: nothing to pin
    return () => { done = true; };
  }, [highlightRunId, runs, pinned?.id]);

  // the pinned run is usually in the page too — drop it from the tail so it
  // isn't rendered twice under the same React key.
  const rows = useMemo(() => {
    const list = runs ?? [];
    return pinned ? [pinned, ...list.filter((r) => r.id !== pinned.id)] : list;
  }, [pinned, runs]);
  useEffect(() => { onCount(rows.length); }, [rows.length, onCount]);

  const active = useMemo(
    () => rows.some((r) => r.status === 'queued' || r.status === 'running'), [rows],
  );
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { void load(); }, HISTORY_POLL_MS);
    return () => clearInterval(t);
  }, [active]);                                    // eslint-disable-line react-hooks/exhaustive-deps

  const download = async (run: ReportRun) => {
    try { await openPresigned(() => getReportRunDownloadUrl(run.id)); } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't fetch the download link.");
    }
  };

  const grid = listGridStyle(COLUMNS, TRAILING, undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
  return (
    <div className="dir-list list-scroll">
      {error && <div className="dir-empty"><b>Couldn&apos;t load history</b>{error}</div>}
      <div className="list-head" style={rowStyle}>
        {COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
        <span className="col-head" aria-hidden="true" />
      </div>
      {runs && rows.length === 0 && <div className="dir-empty">No reports generated yet.</div>}
      {rows.map((r) => {
        const requestedAt = new Date(r.created_at).toLocaleString();
        const size = formatBytes(r.size_bytes);
        return (
          <div key={r.id} className={`dir-row ${r.id === highlightRunId ? 'row-highlight' : ''}`}
               style={{ minWidth: rowStyle.minWidth }}>
            <div className="row-main" style={rowStyle}>
              <div className="cell">
                <b className="cell-top cell-line" title={titleFor(r.definition_name)}>
                  {r.definition_name}
                </b>
                {r.id === pinned?.id && <span className="chip c-slate pinned-run">Linked run</span>}
              </div>
              <div className="cell">
                {r.initiative_id
                  ? (
                    <Link className="cell-top cell-line" title={titleFor(r.initiative_name ?? '')}
                          to={`/initiatives/${r.initiative_id}`}>
                      {r.initiative_name}
                    </Link>
                  )
                  : <span className="cell-top">—</span>}
              </div>
              <div className="cell">
                <span className="cell-top cell-line" title={titleFor(r.requested_by_name)}>
                  {r.requested_by_name}
                </span>
              </div>
              <div className="cell">
                <span className="mono cell-line" title={titleFor(requestedAt)}>{requestedAt}</span>
              </div>
              <div className="cell">
                <span className={`chip ${STATUS_CHIP[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                {duration(r) && <span className="mono" style={{ marginLeft: 6 }}>{duration(r)}</span>}
              </div>
              <div className="cell"><span className="mono cell-line" title={titleFor(size)}>{size}</span></div>
              <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <RowActionsMenu actions={[
                  ...(r.status === 'completed'
                    ? [{ key: 'download', label: 'Download', onSelect: () => void download(r) }] : []),
                  ...(r.status === 'failed'
                    ? [{ key: 'error', label: 'View error', onSelect: () => setViewing(r) }] : []),
                ]} />
              </div>
            </div>
          </div>
        );
      })}
      {more && (
        <div className="history-more">
          <button type="button" className="btn-ghost" disabled={loadingMore}
                  onClick={() => void loadOlder()}>
            {loadingMore ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}
      {viewing && (
        <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
          <div className="modal-card reports-modal-card">
            <div className="modal-head"><h3>Report failed</h3>
              <button type="button" className="modal-close" aria-label="Close"
                      onClick={() => setViewing(null)}>×</button></div>
            <div className="modal-body"><pre className="err">{viewing.error}</pre></div>
          </div>
        </div>
      )}
    </div>
  );
}
