/**
 * Generate Labels' progress panel — visible whenever the selected
 * initiative has an active run (just started here, already running from
 * another tab, or opened via `?run=`). Purely presentational: the page
 * owns the run state and the polling interval.
 */
import { progressPct } from '../../lib/generateLabels';
import type { LabelRun, LabelRunStatus } from '../../lib/api';

const STATUS_LABEL: Record<LabelRunStatus, string> = {
  queued: 'Queued', running: 'Generating', completed: 'Completed', failed: 'Failed', canceled: 'Canceled',
};
const STATUS_CHIP: Record<LabelRunStatus, string> = {
  queued: 'c-slate', running: 'c-violet', completed: 'c-green', failed: 'c-red', canceled: 'c-slate',
};

export default function GenerationProgress({ run, typeLabel, paused, onCancel }: {
  run: LabelRun;
  /** Maps a vocab `type` key (e.g. `run.current_label_type`) to its label. */
  typeLabel: (key: string) => string;
  paused?: boolean;
  onCancel?: () => void;
}) {
  const pct = progressPct(run);
  const active = run.status === 'queued' || run.status === 'running';

  return (
    <div className="glabels-progress">
      <div className="glabels-progress-status">
        <span className={`chip ${STATUS_CHIP[run.status]}`}><span className="dot" />{STATUS_LABEL[run.status]}</span>
        {run.status === 'queued' && (
          <span className="cell-sub">
            {paused ? 'Paused for maintenance — will resume automatically' : 'Waiting for the label worker…'}
          </span>
        )}
        {run.status === 'running' && (
          <span className="cell-sub">
            Processing {run.current_label_type ? typeLabel(run.current_label_type) : '…'}
            {' · '}{run.processed.toLocaleString()} / {run.total.toLocaleString()}
          </span>
        )}
        {run.status === 'canceled' && <span className="cell-sub">Stopped after the current batch.</span>}
      </div>

      <div className="rgm-progress-track" role="progressbar" aria-label="Generation progress"
           aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="rgm-progress-fill" style={{ width: `${pct}%` }} />
      </div>

      {run.current_item && active && <p className="page-hint">Current: {run.current_item}</p>}

      <div className="dash-kpis">
        <div className="dash-kpi">
          <span className="dash-kpi-label">Processed</span>
          <span className="dash-kpi-value">{run.processed.toLocaleString()} / {run.total.toLocaleString()}</span>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-label">Generated</span>
          <span className="dash-kpi-value">{run.generated}</span>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-label">Skipped</span>
          <span className="dash-kpi-value">{run.skipped}</span>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-label">Errors</span>
          <span className="dash-kpi-value">{run.errors}</span>
        </div>
      </div>

      {run.status === 'failed' && <div className="pf-error">{run.error ?? 'The run failed.'}</div>}

      {active && onCancel && (
        <div className="glabels-progress-actions">
          <button type="button" className="btn-ghost" disabled={run.cancel_requested} onClick={onCancel}>
            {run.cancel_requested ? 'Canceling…' : 'Cancel'}
          </button>
        </div>
      )}
    </div>
  );
}
