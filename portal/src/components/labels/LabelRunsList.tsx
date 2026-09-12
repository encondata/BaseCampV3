/**
 * Generate Labels' "Recent runs" — the standard directory-list scaffold
 * (same shape as reports' `HistoryTab`), scoped to whichever initiative
 * is selected on the page (or every run when none is). No column
 * customization here — like `HistoryTab`, this is an embedded list on
 * one page, not its own route.
 */
import type { LabelRun } from '../../lib/api';
import { RowActionsMenu } from '../hardware/RowActionsMenu';

const STATUS_LABEL: Record<LabelRun['status'], string> = {
  queued: 'Queued', running: 'Generating', completed: 'Completed', failed: 'Failed', canceled: 'Canceled',
};
const STATUS_CHIP: Record<LabelRun['status'], string> = {
  queued: 'c-slate', running: 'c-violet', completed: 'c-green', failed: 'c-red', canceled: 'c-slate',
};

const GRID = { gridTemplateColumns: '1.3fr 1.6fr 1fr 1.1fr 1.4fr 100px' };

export default function LabelRunsList({ runs, highlightRunId, typeLabel, onViewErrors }: {
  runs: LabelRun[] | null;
  highlightRunId?: string | null;
  typeLabel: (key: string) => string;
  onViewErrors: (run: LabelRun) => void;
}) {
  return (
    <div className="dir-list">
      <div className="list-head" style={GRID}>
        <span className="col-head">Started</span>
        <span className="col-head">Initiative</span>
        <span className="col-head">Types</span>
        <span className="col-head">Status</span>
        <span className="col-head">Generated / Skipped / Errors</span>
        <span />
      </div>
      {runs === null && <div className="dir-empty">Loading…</div>}
      {runs !== null && runs.length === 0 && <div className="dir-empty">No runs yet.</div>}
      {runs?.map((r) => (
        <div key={r.id} className={`dir-row ${r.id === highlightRunId ? 'row-highlight' : ''}`}>
          <div className="row-main" style={GRID}>
            <div className="cell">
              <span className="mono">{new Date(r.created_at).toLocaleString()}</span>
            </div>
            <div className="cell"><b className="cell-top">{r.initiative_name}</b></div>
            <div className="cell">
              <span className="chips-wrap" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {r.label_types.map((t) => <span key={t} className="chip tag">{typeLabel(t)}</span>)}
              </span>
            </div>
            <div className="cell">
              <span className={`chip ${STATUS_CHIP[r.status]}`}>{STATUS_LABEL[r.status]}</span>
            </div>
            <div className="cell">
              <span className="mono">{r.generated} / {r.skipped} / {r.errors}</span>
            </div>
            <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <RowActionsMenu actions={[
                ...(r.errors > 0
                  ? [{ key: 'errors', label: 'View errors', onSelect: () => onViewErrors(r) }] : []),
              ]} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
