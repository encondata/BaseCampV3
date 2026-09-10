/**
 * Generate <definition> — one dialog, three states: pick an initiative,
 * choose sections, then progress (poll the run every 2 s) with
 * "Notify me when it's ready" / Close, ending in Download or Try again.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Switch } from '../Switch';
import {
  ApiError, createReportRun, getReportRun, getReportRunDownloadUrl, listInitiatives,
  setReportRunNotify,
} from '../../lib/api';
import type { InitiativeItem, ReportDefinition, ReportRun } from '../../lib/api';
import { MOVE_REPORT_SECTIONS, openPresigned, sortInitiativesForPicker } from '../../lib/reports';
import { useSystemStatus } from '../../lib/systemStatusContext';

export const MODAL_POLL_MS = 2000;

type Step = 'pick' | 'sections' | 'progress';

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—');

export default function GenerateReportModal({ definition, onClose, onToast }: {
  definition: ReportDefinition;
  onClose: () => void;
  onToast?: (message: string) => void;
}) {
  const { status: sys } = useSystemStatus();
  const [step, setStep] = useState<Step>('pick');
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [picked, setPicked] = useState<InitiativeItem | null>(null);
  const [options, setOptions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MOVE_REPORT_SECTIONS.map((s) => [s.key, !!definition.options[s.key]])));
  const [run, setRun] = useState<ReportRun | null>(null);
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState<number>(0);
  const [elapsed, setElapsed] = useState(0);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    listInitiatives().then(setInitiatives).catch(() => setError("Couldn't load initiatives."));
    return () => { closedRef.current = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sorted = useMemo(() => sortInitiativesForPicker(initiatives ?? []), [initiatives]);
  const types = useMemo(() => {
    const m = new Map<string, string>();
    sorted.forEach((i) => m.set(i.initiative_type, i.type_label));
    return [...m.entries()];
  }, [sorted]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sorted.filter((i) => (!type || i.initiative_type === type)
      && (!q || `${i.name} ${i.client_name ?? ''}`.toLowerCase().includes(q)));
  }, [sorted, search, type]);

  const enabledCount = MOVE_REPORT_SECTIONS.filter((s) => options[s.key]).length;
  const setAll = (v: boolean) =>
    setOptions(Object.fromEntries(MOVE_REPORT_SECTIONS.map((s) => [s.key, v])));

  const start = async () => {
    if (!picked) return;
    setError('');
    setStep('progress');
    setRun(null);
    setElapsed(0);
    setStartedAt(Date.now());
    try {
      setRun(await createReportRun({
        definition_id: definition.id, initiative_id: picked.id, options, notify: false,
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the report.");
    }
  };

  // poll while queued/running
  const active = !!run && (run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (!active || !run) return;
    const id = run.id;
    const timer = setInterval(() => {
      getReportRun(id).then((next) => { if (!closedRef.current) setRun(next); })
        .catch(() => undefined);                  // transient poll failure: keep polling
    }, MODAL_POLL_MS);
    return () => clearInterval(timer);
    // keyed on the run *id*: depending on `run` itself would tear the
    // interval down and rebuild it on every poll response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, run?.id]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [active, startedAt]);

  const notifyMe = async () => {
    if (!run) return;
    try {
      await setReportRunNotify(run.id, true);
      onToast?.("We'll let you know when it's ready");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't set the reminder.");
    }
  };
  const download = async () => {
    if (!run) return;
    try {
      await openPresigned(() => getReportRunDownloadUrl(run.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't fetch the download link.");
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card">
        <div className="modal-head">
          <h3>Generate {definition.name}</h3>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>

        {step === 'pick' && (
          <>
            <div className="modal-body ini-picker">
              <div className="ini-picker-tools">
                <input placeholder="Search initiatives…" value={search}
                       onChange={(e) => setSearch(e.target.value)} />
                <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">All types</option>
                  {types.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </div>
              <div className="ini-picker-list" role="radiogroup">
                {initiatives === null && <div className="ini-picker-empty">Loading…</div>}
                {initiatives !== null && shown.length === 0 && (
                  <div className="ini-picker-empty">No initiatives match.</div>
                )}
                {shown.map((i) => (
                  <label key={i.id} className={`ini-picker-row ${picked?.id === i.id ? 'on' : ''}`}>
                    <input type="radio" name="initiative" aria-label={i.name}
                           checked={picked?.id === i.id} onChange={() => setPicked(i)} />
                    <span className="cell-primary">{i.name}</span>
                    <span className="cell-sub">{i.client_name ?? '—'}</span>
                    <span className="chip custom" style={{ '--chip': i.status_color } as CSSProperties}>
                      <span className="dot" />{i.status_label}
                    </span>
                    <span className="cell-sub">{i.type_label} · {fmtDate(i.scheduled_start)}{i.scheduled_end ? ` → ${fmtDate(i.scheduled_end)}` : ''}</span>
                  </label>
                ))}
              </div>
              {error && <div className="pf-error">{error}</div>}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn-solid" disabled={!picked}
                      onClick={() => setStep('sections')}>Next</button>
            </div>
          </>
        )}

        {step === 'sections' && (
          <>
            <div className="modal-body">
              <p className="cell-sub">Select which sections to include in the PDF report for <b>{picked?.name}</b>:</p>
              <div className="report-sections">
                {MOVE_REPORT_SECTIONS.map((s) => (
                  <label key={s.key} className="report-section-row">
                    <Switch checked={!!options[s.key]}
                            onChange={(v) => setOptions((o) => ({ ...o, [s.key]: v }))} />
                    <span className="report-section-text">
                      <span className="report-section-title">{s.title}</span>
                      <span className="report-section-desc">{s.description}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="report-section-actions">
                <button type="button" onClick={() => setAll(true)}>Select All</button>
                <button type="button" onClick={() => setAll(false)}>Deselect All</button>
              </div>
              {enabledCount === 0 && <div className="pf-error">Turn on at least one section</div>}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn-ghost" onClick={() => setStep('pick')}>Back</button>
              <button type="button" className="btn-solid" disabled={enabledCount === 0}
                      onClick={() => void start()}>
                Generate Report
              </button>
            </div>
          </>
        )}

        {step === 'progress' && (
          <>
            <div className="modal-body report-progress">
              {(!run || active) && !error && (
                <>
                  <div className="spinner" />
                  <div>
                    {sys.workers_paused ? 'Paused for maintenance — will resume automatically'
                      : run?.status === 'running' ? 'Generating…' : 'Queued'}
                  </div>
                  <div className="elapsed">{elapsed}s</div>
                </>
              )}
              {run?.status === 'completed' && (
                <>
                  <div><b>{run.filename}</b></div>
                  <div className="cell-sub">Also saved to the initiative&apos;s Files</div>
                </>
              )}
              {run?.status === 'failed' && (
                <div className="err">{run.error ?? 'The report failed.'}</div>
              )}
              {error && <div className="err">{error}</div>}
            </div>
            <div className="modal-foot">
              {active && (
                <button type="button" className="btn-ghost" onClick={() => void notifyMe()}>
                  Notify me when it&apos;s ready
                </button>
              )}
              {run?.status === 'failed' && (
                <button type="button" className="btn-ghost" onClick={() => void start()}>Try again</button>
              )}
              <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
              {run?.status === 'completed' && (
                <button type="button" className="btn-solid" onClick={() => void download()}>Download</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
