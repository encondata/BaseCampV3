/**
 * Print Labels › Printing labels — V2's batch dialog: "X of N" headline,
 * progress bar, current/total/per-batch tiles, the auto-print toggle with
 * its 5 s countdown, V2's status lines, and Cancel / Reprint current batch
 * / Print next batch / Done. Purely presentational: the page owns the
 * state machine (`BatchPrintState`) and the printer. Not dismissable
 * while printing (no scrim click, no Escape).
 */
import { useEffect } from 'react';

import { Switch } from '../Switch';

export interface BatchPrintState {
  total: number;
  batchSize: number;
  currentBatch: number;
  totalBatches: number;
  printedCount: number;
  printing: boolean;
  finishing: boolean;
  batchComplete: boolean;
  allComplete: boolean;
  autoPrintNext: boolean;
  autoCountdown: number | null;
  error: string | null;
}

interface Props {
  state: BatchPrintState;
  subtitle: string;
  onAutoPrintNextChange: (v: boolean) => void;
  onPrintNext: () => void;
  onReprint: () => void;
  onCancel: () => void;
  onDone: () => void;
}

export default function PrintBatchModal({
  state, subtitle, onAutoPrintNextChange, onPrintNext, onReprint, onCancel, onDone,
}: Props) {
  const {
    total, batchSize, currentBatch, totalBatches, printedCount, printing, finishing,
    batchComplete, allComplete, autoPrintNext, autoCountdown, error,
  } = state;
  const pct = total > 0 ? Math.round((printedCount / total) * 100) : 0;
  const nextCount = Math.min(batchSize, total - printedCount);

  // Escape cancels only between batches — V2's dialog can't be dismissed mid-print.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !printing && !allComplete) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [printing, allComplete, onCancel]);

  return (
    <div className="modal-scrim">
      <div className="modal-card reports-modal-card rgm-card plabels-batch-card" role="dialog" aria-label="Printing labels">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Print Labels</div>
            <h3>Printing labels</h3>
            <p className="page-hint">{subtitle}</p>
          </div>
        </div>
        <div className="modal-body">
          <div className={`plabels-batch-headline dash-kpi ${allComplete ? 'done' : ''}`}>
            <span className="dash-kpi-value">{printedCount} of {total}</span>
            <span className="dash-kpi-label">labels printed</span>
          </div>
          <div className="plabels-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={`plabels-progress-fill ${allComplete ? 'done' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="dash-kpis plabels-batch-kpis">
            <div className="dash-kpi"><span className="dash-kpi-label">Current batch</span><span className="dash-kpi-value">{currentBatch}</span></div>
            <div className="dash-kpi"><span className="dash-kpi-label">Total batches</span><span className="dash-kpi-value">{totalBatches}</span></div>
            <div className="dash-kpi"><span className="dash-kpi-label">Per batch</span><span className="dash-kpi-value">{batchSize}</span></div>
          </div>

          {!allComplete && (
            <div className="plabels-batch-toggle">
              <label className="mini-row report-section-row">
                <Switch checked={autoPrintNext} onChange={onAutoPrintNextChange} />
                <span className="report-section-text">
                  <span className="cell-top">Auto print next batch (5 s delay)</span>
                </span>
              </label>
            </div>
          )}

          {printing && (
            <div className="plabels-notice info plabels-batch-status">
              <p className="page-hint">
                {finishing
                  ? `Batch ${currentBatch} sent - waiting for printer to finish printing…`
                  : `Printing batch ${currentBatch} of ${totalBatches}…`}
              </p>
            </div>
          )}
          {batchComplete && !allComplete && !printing && !error && (
            <div className={`plabels-notice ${autoCountdown !== null ? 'info' : 'success'}`}>
              <p className="page-hint">
                {autoCountdown !== null
                  ? `Batch ${currentBatch} complete! Next batch starts automatically in ${autoCountdown}s… (turn off the toggle to pause)`
                  : `Batch ${currentBatch} complete! Ready to print next batch.`}
              </p>
            </div>
          )}
          {allComplete && (
            <div className="plabels-notice success">
              <p className="page-hint">All {total} labels printed successfully!</p>
            </div>
          )}
          {error && (
            <div className="plabels-notice error">
              <p className="page-hint">{error}</p>
            </div>
          )}
        </div>
        <div className="modal-foot">
          {allComplete ? (
            <button type="button" className="btn-solid" onClick={onDone}>Done</button>
          ) : (
            <>
              <button type="button" className="mini-btn" onClick={onCancel} disabled={printing}>Cancel</button>
              <button type="button" className="mini-btn" onClick={onReprint} disabled={printing || !batchComplete}>
                Reprint current batch
              </button>
              <button type="button" className="btn-solid" onClick={onPrintNext} disabled={printing || !batchComplete || !!error}>
                {printing ? 'Printing…' : `Print next batch (${nextCount} labels)`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
