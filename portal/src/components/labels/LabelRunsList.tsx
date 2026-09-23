/**
 * Generate Labels' "Recent runs" — the standard directory-list scaffold
 * (same shape as reports' `HistoryTab`), scoped to whichever initiative
 * is selected on the page (or every run when none is). No column
 * customization here — like `HistoryTab`, this is an embedded list on
 * one page, not its own route.
 */
import { useAuth } from '../../auth/AuthContext';
import type { LabelRun } from '../../lib/api';
import { ColHead, listGridStyle, listScale, titleFor, type ColumnDef } from '../../lib/listTools';
import { RowActionsMenu } from '../hardware/RowActionsMenu';

const STATUS_LABEL: Record<LabelRun['status'], string> = {
  queued: 'Queued', running: 'Generating', completed: 'Completed', failed: 'Failed', canceled: 'Canceled',
};
const STATUS_CHIP: Record<LabelRun['status'], string> = {
  queued: 'c-slate', running: 'c-violet', completed: 'c-green', failed: 'c-red', canceled: 'c-slate',
};

// No column registry pre-migration (hand-written header spans) — this
// local COLUMNS mirrors them (recipe R1).
//
// Fit: default columns + trailing ≤ LIST_FIT.page (1172px — .portal-page at a
// 1512px window, nav expanded — GenerateLabels.tsx mounts this list directly
// under .portal-page's .glabels-section, which adds no horizontal padding of
// its own).
const COLUMNS: ColumnDef[] = [
  { key: 'started', label: 'Started', width: '1.3fr', default: true, min: 96 },
  { key: 'initiative', label: 'Initiative', width: '1.6fr', default: true },
  { key: 'types', label: 'Types', width: '1fr', default: true },
  { key: 'requested_by', label: 'Requested by', width: '1fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  {
    key: 'results', label: 'Generated / Skipped / Errors', short: 'Gen/Skip/Err',
    width: '1.4fr', default: true,
  },
];
const TRAILING = ['100px'];

export default function LabelRunsList({ runs, highlightRunId, typeLabel, onViewErrors }: {
  runs: LabelRun[] | null;
  highlightRunId?: string | null;
  typeLabel: (key: string) => string;
  onViewErrors: (run: LabelRun) => void;
}) {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const grid = listGridStyle(COLUMNS, TRAILING, undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
  return (
    <div className="dir-list list-scroll">
      <div className="list-head" style={rowStyle}>
        {COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
        <span className="col-head" aria-hidden="true" />
      </div>
      {runs === null && <div className="dir-empty">Loading…</div>}
      {runs !== null && runs.length === 0 && <div className="dir-empty">No runs yet.</div>}
      {runs?.map((r) => {
        const started = new Date(r.created_at).toLocaleString();
        const results = `${r.generated} / ${r.skipped} / ${r.errors}`;
        return (
          <div key={r.id} className={`dir-row ${r.id === highlightRunId ? 'row-highlight' : ''}`}
               style={{ minWidth: rowStyle.minWidth }}>
            <div className="row-main" style={rowStyle}>
              <div className="cell">
                <span className="mono cell-line" title={titleFor(started)}>{started}</span>
              </div>
              <div className="cell">
                <b className="cell-top cell-line" title={titleFor(r.initiative_name)}>{r.initiative_name}</b>
              </div>
              <div className="cell">
                <span className="chips-wrap" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {r.label_types.map((t) => {
                    const manual = !!r.template_overrides?.[t];
                    return (
                      <span key={t} className="chip tag" title={manual ? 'Manual template' : undefined}
                            aria-label={manual ? `${typeLabel(t)} (manual template)` : undefined}>
                        {typeLabel(t)}
                      </span>
                    );
                  })}
                </span>
              </div>
              <div className="cell">
                <span className="cell-top cell-line" title={titleFor(r.requested_by_name)}>{r.requested_by_name}</span>
              </div>
              <div className="cell">
                <span className={`chip ${STATUS_CHIP[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </div>
              <div className="cell">
                <span className="mono cell-line" title={titleFor(results)}>{results}</span>
              </div>
              <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <RowActionsMenu actions={[
                  ...(r.errors > 0
                    ? [{ key: 'errors', label: 'View errors', onSelect: () => onViewErrors(r) }] : []),
                ]} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
