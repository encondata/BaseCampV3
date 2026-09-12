/**
 * "N errors in <initiative>" — the roomy eyebrow/title/description modal
 * header pattern (Jimmy's standing rule for every modal), a summary-by-
 * type chip row (busiest first), and the first-50 sample rows via the
 * house `DataTable` (no bare table element).
 */
import { useEffect } from 'react';

import DataTable, { type DataTableRow } from '../DataTable';
import { hasHiddenErrors, sortedErrorSummary } from '../../lib/generateLabels';
import type { LabelRun } from '../../lib/api';

const COLUMNS = [
  { key: 'item', label: 'Item', width: '1.4fr' },
  { key: 'type', label: 'Type', width: '1fr' },
  { key: 'message', label: 'Message', width: '2.4fr' },
];

export default function LabelRunErrorsModal({ run, typeLabel, onClose }: {
  run: LabelRun;
  typeLabel: (key: string) => string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const summary = sortedErrorSummary(run.error_summary);
  const rows: DataTableRow[] = run.error_details.map((d, i) => ({
    key: `${d.item}-${d.label_type}-${i}`,
    cells: [
      <b key="item" className="cell-top">{d.item}</b>,
      <span key="type" className="chip tag">{typeLabel(d.label_type)}</span>,
      <span key="message" className="cell-sub">{d.message}</span>,
    ],
  }));

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Generate Labels</div>
            <h3>{run.errors} error{run.errors === 1 ? '' : 's'} in {run.initiative_name}</h3>
            <p className="page-hint">
              What went wrong while generating {run.label_types.map(typeLabel).join(', ')}.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {summary.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {summary.map(([type, count]) => (
                <span key={type} className="chip c-red">{type} <span className="mono">{count}</span></span>
              ))}
            </div>
          )}
          <DataTable ariaLabel="Sample errors" columns={COLUMNS} rows={rows}
                     emptyText="No error details recorded." />
          {hasHiddenErrors(run) && (
            <p className="page-hint">
              Only the first {run.error_details.length} of {run.errors} errors are shown.
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
