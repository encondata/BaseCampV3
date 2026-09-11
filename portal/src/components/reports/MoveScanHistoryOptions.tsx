/**
 * GenerateReportModal's options step for `report_type ===
 * 'move_scan_history'`. The initiative is picked by the shared "pick"
 * step (this report type has no "No initiative" choice, unlike the
 * survey — Next stays disabled until one is picked) — this component
 * loads that move's scan-history preview, lets the requester choose the
 * output format and which status columns to include, and hands the
 * result back to GenerateReportModal's own progress step exactly like
 * `SiteMoveSurveyOptions` does.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  ApiError, getScanHistoryPreview, type InitiativeItem, type ReportDefinition,
  type ScanHistoryPreview,
} from '../../lib/api';
import {
  buildRunOptions, columnsForMode, formatDefaults,
  type ScanHistoryFormat, type StatusColumnsMode,
} from '../../lib/moveScanHistory';
import { Switch } from '../Switch';

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—');
const fmtDateTime = (s: string | null) => (s ? new Date(s).toLocaleString() : 'No scans yet');

export default function MoveScanHistoryOptions({ definition, initiative, onBack, onGenerate }: {
  definition: ReportDefinition;
  /** Already picked by GenerateReportModal's shared "pick" step. This
   *  report type always requires one, so it's only ever `null` for the
   *  brief instant before the pick step's Next click. */
  initiative: InitiativeItem | null;
  onBack: () => void;
  onGenerate: (payload: {
    initiative_id: string | null; options: Record<string, unknown>; notify: boolean;
  }) => void;
}) {
  const defaults = useMemo(() => formatDefaults(definition), [definition]);
  const [format, setFormat] = useState<ScanHistoryFormat>(defaults.format);
  const [mode, setMode] = useState<StatusColumnsMode>(defaults.statusColumns);
  const [notify, setNotify] = useState(false);

  const [preview, setPreview] = useState<ScanHistoryPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!initiative) { setPreview(null); setLoading(false); setLoadError(''); return; }
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    getScanHistoryPreview(initiative.id)
      .then((p) => { if (!cancelled) { setPreview(p); setLoading(false); } })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : "Couldn't load the preview.");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [initiative, retryKey]);

  const columns = useMemo(
    () => (preview ? columnsForMode(preview.statuses, mode) : []), [preview, mode]);
  const mainColumns = columns.filter((c) => !c.alsoScanned);
  const extraColumns = columns.filter((c) => c.alsoScanned);

  const generate = () => {
    if (!initiative) return;
    onGenerate({
      initiative_id: initiative.id,
      // `buildRunOptions`'s own return type (ScanHistoryRunOptions) has no
      // index signature, so it needs an explicit widen for the
      // report-agnostic payload type GenerateReportModal's `createReportRun`
      // call expects — same pattern as SiteMoveSurveyOptions.
      options: buildRunOptions(format, mode) as unknown as Record<string, unknown>,
      notify,
    });
  };

  return (
    <>
      <div className="modal-body">
        <div className="msh-grid">
          <div className="msh-preview">
            <div className="modal-section">Preview</div>
            {loading && <p className="page-hint">Loading preview…</p>}
            {!loading && loadError && (
              <div className="pf-error">
                {loadError}{' '}
                <button type="button" className="mini-btn" onClick={() => setRetryKey((k) => k + 1)}>
                  Retry
                </button>
              </div>
            )}
            {!loading && !loadError && preview && (
              <>
                <div className="cell-top">{preview.initiative.name}</div>
                <div className="cell-sub">{preview.initiative.client_name ?? '—'}</div>
                <div className="cell-sub">
                  {preview.initiative.source_name ?? '—'} → {preview.initiative.destination_name ?? '—'}
                </div>
                <div className="cell-sub">
                  Scheduled start: {fmtDate(preview.initiative.scheduled_start)}
                </div>
                <div className="dash-kpis">
                  <div className="dash-kpi">
                    <span className="dash-kpi-label">Assets</span>
                    <span className="dash-kpi-value">{preview.total_assets}</span>
                  </div>
                  <div className="dash-kpi">
                    <span className="dash-kpi-label">Scanned</span>
                    <span className="dash-kpi-value">{preview.scanned_assets}</span>
                  </div>
                  <div className="dash-kpi">
                    <span className="dash-kpi-label">Complete</span>
                    <span className="dash-kpi-value">{preview.completed}</span>
                  </div>
                  <div className="dash-kpi">
                    <span className="dash-kpi-label">Completion</span>
                    <span className="dash-kpi-value">{preview.completion_pct}%</span>
                  </div>
                </div>
                <div className="msh-progress-track">
                  <div className="msh-progress-fill" style={{ width: `${preview.completion_pct}%` }} />
                </div>
                <p className="page-hint">Last scan: {fmtDateTime(preview.last_scan_at)}</p>
                {preview.total_assets === 0 && (
                  <p className="pf-notice">This move has no assets yet — the report will say so.</p>
                )}
              </>
            )}
          </div>

          <div className="msh-options">
            <div className="modal-section">Format</div>
            <div className="msh-format-cards" role="radiogroup" aria-label="Format">
              <button type="button" role="radio" aria-checked={format === 'xlsx'}
                      className={`msh-format-card ${format === 'xlsx' ? 'on' : ''}`}
                      onClick={() => setFormat('xlsx')}>
                <span className="msh-format-title">Excel workbook</span>
                <span className="msh-format-desc">Overview and Scan History sheets</span>
              </button>
              <button type="button" role="radio" aria-checked={format === 'pdf'}
                      className={`msh-format-card ${format === 'pdf' ? 'on' : ''}`}
                      onClick={() => setFormat('pdf')}>
                <span className="msh-format-title">PDF document</span>
                <span className="msh-format-desc">
                  Landscape, printable, with a document tracking barcode
                </span>
              </button>
            </div>

            <div className="modal-section">Status columns</div>
            <div className="segmented" role="tablist" style={{ marginBottom: 8 }}>
              <button type="button" role="tab" aria-selected={mode === 'pipeline'}
                      className={mode === 'pipeline' ? 'on' : ''} onClick={() => setMode('pipeline')}>
                Pipeline
              </button>
              <button type="button" role="tab" aria-selected={mode === 'all'}
                      className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>
                All statuses
              </button>
            </div>
            <div className="msh-status-chips">
              {mainColumns.map((c) => (
                <span key={c.key} className={c.color ? 'chip custom' : 'chip c-slate'}
                      style={c.color ? ({ '--chip': c.color } as CSSProperties) : undefined}>
                  {c.label} <span className="mono">{c.scan_count}</span>
                </span>
              ))}
              {extraColumns.length > 0 && (
                <>
                  <span className="cell-sub msh-also-scanned">also scanned</span>
                  {extraColumns.map((c) => (
                    <span key={c.key} className={c.color ? 'chip custom' : 'chip c-slate'}
                          style={c.color ? ({ '--chip': c.color } as CSSProperties) : undefined}>
                      {c.label} <span className="mono">{c.scan_count}</span>
                    </span>
                  ))}
                </>
              )}
            </div>

            <div className="modal-section">Notify</div>
            <div className="mini-list report-sections">
              <label className="mini-row report-section-row">
                <Switch checked={notify} onChange={setNotify} />
                <span className="report-section-text">
                  <span className="cell-top">Notify me</span>
                  <span className="cell-sub">Get an inbox notification when the report is ready.</span>
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onBack}>Back</button>
        <button type="button" className="btn-solid" disabled={!initiative} onClick={generate}>
          Generate Report
        </button>
      </div>
    </>
  );
}
