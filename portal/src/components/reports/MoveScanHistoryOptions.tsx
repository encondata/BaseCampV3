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
import { ChoiceCard, InitiativeSummary, OptionGroup, OptionsGrid, PreviewCard } from './ReportOptionsLayout';

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
  const defaults = formatDefaults(definition);
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
    onGenerate({ initiative_id: initiative.id, options: buildRunOptions(format, mode), notify });
  };

  return (
    <>
      <div className="modal-body">
        <OptionsGrid preview={
          <PreviewCard title="Preview">
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
                <InitiativeSummary
                  initiative={{
                    name: preview.initiative.name, clientName: preview.initiative.client_name,
                    scheduledStart: preview.initiative.scheduled_start,
                    originName: preview.initiative.source_name,
                    destinationName: preview.initiative.destination_name,
                  }}
                  emptyText="Pick an initiative to see its details here."
                />
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
                <div className="rgm-progress-track" role="progressbar" aria-label="Completion"
                     aria-valuenow={preview.completion_pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="rgm-progress-fill" style={{ width: `${preview.completion_pct}%` }} />
                </div>
                <p className="page-hint">Last scan: {fmtDateTime(preview.last_scan_at)}</p>
                {preview.total_assets === 0 && (
                  <p className="pf-notice">This move has no assets yet — the report will say so.</p>
                )}
              </>
            )}
          </PreviewCard>
        }>
          <OptionGroup title="Format">
            <div className="rgm-choice-cards" role="radiogroup" aria-label="Format">
              <ChoiceCard title="Excel workbook" description="Overview and Scan History sheets"
                          selected={format === 'xlsx'} onSelect={() => setFormat('xlsx')} />
              <ChoiceCard title="PDF document"
                          description="Landscape, printable, with a document tracking barcode"
                          selected={format === 'pdf'} onSelect={() => setFormat('pdf')} />
            </div>
          </OptionGroup>

          <OptionGroup title="Status columns">
            <div className="segmented" role="tablist" aria-label="Status columns" style={{ marginBottom: 8 }}>
              <button type="button" role="tab" aria-selected={mode === 'pipeline'}
                      className={mode === 'pipeline' ? 'on' : ''} onClick={() => setMode('pipeline')}>
                Pipeline
              </button>
              <button type="button" role="tab" aria-selected={mode === 'all'}
                      className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>
                All statuses
              </button>
            </div>
            <div className="rgm-status-chips">
              {mainColumns.map((c) => (
                <span key={c.key} className={c.color ? 'chip custom' : 'chip c-slate'}
                      style={c.color ? ({ '--chip': c.color } as CSSProperties) : undefined}>
                  {c.label} <span className="mono">{c.scan_count}</span>
                </span>
              ))}
              {extraColumns.length > 0 && (
                <>
                  <span className="cell-sub rgm-also-scanned">also scanned</span>
                  {extraColumns.map((c) => (
                    <span key={c.key} className={c.color ? 'chip custom' : 'chip c-slate'}
                          style={c.color ? ({ '--chip': c.color } as CSSProperties) : undefined}>
                      {c.label} <span className="mono">{c.scan_count}</span>
                    </span>
                  ))}
                </>
              )}
            </div>
          </OptionGroup>

          <OptionGroup title="Notify">
            <div className="mini-list report-sections">
              <label className="mini-row report-section-row">
                <Switch checked={notify} onChange={setNotify} />
                <span className="report-section-text">
                  <span className="cell-top">Notify me</span>
                  <span className="cell-sub">Get an inbox notification when the report is ready.</span>
                </span>
              </label>
            </div>
          </OptionGroup>
        </OptionsGrid>
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
