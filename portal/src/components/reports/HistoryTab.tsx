/** History tab: report runs the caller may see (rank + scope gate is
 *  server-side). Polls every 3 s while any listed run is queued/running. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, getReportRunDownloadUrl, listReportRuns } from '../../lib/api';
import type { ReportRun } from '../../lib/api';
import { formatBytes } from '../../lib/reports';
import { RowActionsMenu } from '../hardware/RowActionsMenu';

export const HISTORY_POLL_MS = 3000;

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
  const [runs, setRuns] = useState<ReportRun[] | null>(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<ReportRun | null>(null);

  const load = async () => {
    try {
      const rows = await listReportRuns();
      setRuns(rows);
      onCount(rows.length);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load report history.");
    }
  };
  useEffect(() => { void load(); }, []);           // eslint-disable-line react-hooks/exhaustive-deps

  const active = useMemo(
    () => (runs ?? []).some((r) => r.status === 'queued' || r.status === 'running'), [runs],
  );
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { void load(); }, HISTORY_POLL_MS);
    return () => clearInterval(t);
  }, [active]);                                    // eslint-disable-line react-hooks/exhaustive-deps

  const download = async (run: ReportRun) => {
    try { window.open(await getReportRunDownloadUrl(run.id), '_blank'); } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't fetch the download link.");
    }
  };

  const grid = { gridTemplateColumns: '1.4fr 1.4fr 1.2fr 1.2fr 1fr 0.8fr 100px' };
  return (
    <div className="dir-list">
      {error && <div className="dir-empty"><b>Couldn&apos;t load history</b>{error}</div>}
      <div className="list-head" style={grid}>
        <span className="col-head">Report</span><span className="col-head">Initiative</span>
        <span className="col-head">Requested by</span><span className="col-head">Requested at</span>
        <span className="col-head">Status</span><span className="col-head">Size</span><span />
      </div>
      {runs && runs.length === 0 && <div className="dir-empty">No reports generated yet.</div>}
      {(runs ?? []).map((r) => (
        <div key={r.id} className={`dir-row ${r.id === highlightRunId ? 'row-highlight' : ''}`}>
          <div className="row-main" style={grid}>
            <div className="cell"><span className="cell-primary">{r.definition_name}</span></div>
            <div className="cell"><Link to={`/initiatives/${r.initiative_id}`}>{r.initiative_name}</Link></div>
            <div className="cell">{r.requested_by_name}</div>
            <div className="cell">{new Date(r.created_at).toLocaleString()}</div>
            <div className="cell">
              <span className={`chip ${STATUS_CHIP[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              {duration(r) && <span className="cell-sub" style={{ marginLeft: 6 }}>{duration(r)}</span>}
            </div>
            <div className="cell">{formatBytes(r.size_bytes)}</div>
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
      ))}
      {viewing && (
        <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
          <div className="modal-card reports-modal-card">
            <div className="modal-head"><h3>Report failed</h3>
              <button type="button" className="modal-close" aria-label="Close"
                      onClick={() => setViewing(null)}>×</button></div>
            <div className="modal-body"><pre className="err" style={{ whiteSpace: 'pre-wrap' }}>{viewing.error}</pre></div>
          </div>
        </div>
      )}
    </div>
  );
}
