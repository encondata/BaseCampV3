/**
 * /labels/generate — V3 port of V2's Generate Labels page, now backed by
 * a queue + `label-worker` process instead of an in-process job: pick an
 * initiative and one or more label types, kick off a run, watch its
 * progress (polled every ~1.75s while queued/running), and review recent
 * runs (with a per-run error drill-down) for the initiative in view.
 *
 * Layout follows the report Generate modals' two-column shape
 * (`OptionsGrid`/`PreviewCard`/`OptionGroup` from
 * `components/reports/ReportOptionsLayout`) even though this is a full
 * page, not a modal — the pieces are generic. The one true modal here
 * (`LabelRunErrorsModal`) still carries the roomy eyebrow/title/
 * description header per the house rule for new modals.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  ApiError, cancelLabelRun, getLabelGeneratePreview, getLabelRun, listInitiatives, listLabelRuns,
  listLabelVocab, startLabelRun,
  type InitiativeItem, type LabelGeneratePreview, type LabelRun, type LabelVocab,
} from '../lib/api';
import { canGenerate, isRunActive, visibleInitiativesForGenerate } from '../lib/generateLabels';
import { vocabLabel, vocabOfKind } from '../lib/labels';
import { useSystemStatus } from '../lib/systemStatusContext';
import ComboBox from '../components/ComboBox';
import GenerationProgress from '../components/labels/GenerationProgress';
import LabelRunErrorsModal from '../components/labels/LabelRunErrorsModal';
import LabelRunsList from '../components/labels/LabelRunsList';
import LabelTypeCards from '../components/labels/LabelTypeCards';
import {
  InitiativeSummary, OptionGroup, OptionsGrid, PreviewCard,
} from '../components/reports/ReportOptionsLayout';
import { Switch } from '../components/Switch';
import '../styles/directory.css';
import '../styles/dashboard.css';  /* .dash-kpis (progress panel's live counters) */
import '../styles/reports.css';    /* .rgm-grid/.rgm-options/.rgm-summary/.rgm-progress-* etc. */
import '../styles/labels.css';

const RUNS_LIMIT = 25;
const POLL_MS = 1750;

const STATUS_TEXT: Record<string, string> = {
  planned: 'Planned', scheduled: 'Scheduled', in_progress: 'In progress',
  on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled',
};

export default function GenerateLabels() {
  const { status: sys } = useSystemStatus();
  const [params, setParams] = useSearchParams();

  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [initiativeId, setInitiativeId] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [regenerateExisting, setRegenerateExisting] = useState(false);
  const [notify, setNotify] = useState(false);

  const [preview, setPreview] = useState<LabelGeneratePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const [activeRun, setActiveRun] = useState<LabelRun | null>(null);
  const [runs, setRuns] = useState<LabelRun[] | null>(null);
  const [viewingErrors, setViewingErrors] = useState<LabelRun | null>(null);
  const [error, setError] = useState('');
  const highlightRunId = params.get('run');
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    listInitiatives().then(setInitiatives).catch(() => setError("Couldn't load initiatives."));
    listLabelVocab().then(setVocab).catch(() => setError("Couldn't load label types."));
    return () => { closedRef.current = true; };
  }, []);

  // ?run=<id> deep link: pin that run's initiative into the picker and
  // resume its progress panel (still active) or open its errors modal
  // (already finished with errors) — whichever applies.
  useEffect(() => {
    const runId = params.get('run');
    if (!runId) return;
    getLabelRun(runId).then((run) => {
      if (closedRef.current) return;
      setInitiativeId(run.initiative_id);
      if (isRunActive(run)) setActiveRun(run);
      else if (run.errors > 0) setViewingErrors(run);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typeVocab = useMemo(() => vocabOfKind(vocab, 'type'), [vocab]);
  const typeLabelFor = (key: string) => vocabLabel(vocab, 'type', key);

  const pickerOptions = useMemo(
    () => visibleInitiativesForGenerate(initiatives ?? [])
      .map((i) => ({ value: i.id, label: i.name, sub: i.client_name })),
    [initiatives],
  );

  const loadRuns = async () => {
    try {
      setRuns(await listLabelRuns({ initiative_id: initiativeId || undefined, limit: RUNS_LIMIT }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load recent runs.");
    }
  };
  useEffect(() => { setRuns(null); void loadRuns(); }, [initiativeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initiativeId) { setPreview(null); setPreviewLoading(false); setPreviewError(''); return; }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError('');
    getLabelGeneratePreview(initiativeId)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setPreviewLoading(false);
        if (p.active_run_id) {
          getLabelRun(p.active_run_id).then((r) => { if (!cancelled) setActiveRun(r); }).catch(() => undefined);
        } else {
          setActiveRun((cur) => (cur && cur.initiative_id === initiativeId ? cur : null));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(err instanceof ApiError ? err.message : "Couldn't load the preview.");
        setPreviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [initiativeId]);

  // Poll the active run while it's queued/running; once it settles,
  // refresh the runs list so the new row (with its final counts) shows.
  useEffect(() => {
    if (!activeRun || !isRunActive(activeRun)) return;
    const id = activeRun.id;
    const timer = setInterval(() => {
      getLabelRun(id).then((next) => {
        if (closedRef.current) return;
        setActiveRun(next);
        if (!isRunActive(next)) {
          clearInterval(timer);
          void loadRuns();
        }
      }).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id]);

  const toggleType = (key: string) =>
    setSelectedTypes((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  const activeBlockingId = activeRun && isRunActive(activeRun) ? activeRun.id : null;
  const canGo = canGenerate({ initiativeId: initiativeId || null, labelTypes: selectedTypes, activeRunId: activeBlockingId });

  const generate = async () => {
    if (!canGo) return;
    setError('');
    try {
      const run = await startLabelRun({
        initiative_id: initiativeId, label_types: selectedTypes,
        regenerate_existing: regenerateExisting, notify,
      });
      setActiveRun(run);
      void loadRuns();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'run_active') {
        setError('A run is already active for this initiative.');
        const runId = (err.detail as { run_id?: string } | null | undefined)?.run_id;
        if (runId) void getLabelRun(runId).then(setActiveRun).catch(() => undefined);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't start the run.");
      }
    }
  };

  const cancel = async () => {
    if (!activeRun) return;
    try {
      setActiveRun(await cancelLabelRun(activeRun.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't cancel the run.");
    }
  };

  const openErrors = (run: LabelRun) => {
    setViewingErrors(run);
    const next = new URLSearchParams(params);
    next.set('run', run.id);
    setParams(next, { replace: true });
  };
  const closeErrors = () => {
    setViewingErrors(null);
    const next = new URLSearchParams(params);
    next.delete('run');
    setParams(next, { replace: true });
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">Generate Labels</h1>
          <p className="page-hint">
            Generate printable labels for every asset on an initiative. Labels are rendered by the
            label worker and kept for printing.
          </p>
        </div>
      </div>

      {error && <div className="pf-error" style={{ marginBottom: 12 }}>{error}</div>}

      <OptionsGrid preview={
        <PreviewCard title="Initiative">
          <div style={{ marginBottom: 10 }}>
            <ComboBox options={pickerOptions} value={initiativeId}
                      onChange={(v) => { setInitiativeId(v); setSelectedTypes([]); }}
                      placeholder="Choose an initiative…" clearable />
          </div>
          {!initiativeId && <p className="page-hint">Pick an initiative to see its details here.</p>}
          {initiativeId && previewLoading && <p className="page-hint">Loading preview…</p>}
          {initiativeId && !previewLoading && previewError && (
            <div className="pf-error">{previewError}</div>
          )}
          {initiativeId && !previewLoading && !previewError && preview && (
            <>
              <InitiativeSummary
                initiative={{
                  name: preview.initiative.name, clientName: preview.initiative.client_name,
                  scheduledStart: preview.initiative.scheduled_start,
                  originName: preview.initiative.source_name, destinationName: preview.initiative.destination_name,
                }}
                emptyText="Pick an initiative to see its details here."
              />
              <p className="cell-sub">
                {STATUS_TEXT[preview.initiative.status] ?? preview.initiative.status}
                {' · '}{preview.initiative.asset_count} asset{preview.initiative.asset_count === 1 ? '' : 's'}
              </p>
              {preview.types.map((t) => (
                <div className="glabels-preview-type" key={t.key}>
                  <span className="cell-sub">{typeLabelFor(t.key)}</span>
                  {t.template ? (
                    <span className="chip tag">
                      {t.template.name} v{t.template.version} · {t.template.scope === 'site' ? 'site' : 'global'}
                    </span>
                  ) : (
                    <span className="chip c-red">No active template</span>
                  )}
                  <span className="mono">{t.current} current · {t.stale} stale</span>
                </div>
              ))}
            </>
          )}
        </PreviewCard>
      }>
        <OptionGroup title="Label types">
          <LabelTypeCards vocab={typeVocab} types={preview?.types ?? null}
                           selected={selectedTypes} onToggle={toggleType} />
        </OptionGroup>

        <OptionGroup title="Options">
          <div className="mini-list report-sections">
            <label className="mini-row report-section-row">
              <Switch checked={regenerateExisting} onChange={setRegenerateExisting} />
              <span className="report-section-text">
                <span className="cell-top">Regenerate existing labels</span>
                <span className="cell-sub">Off skips assets that already have a current label for the type.</span>
              </span>
            </label>
            <label className="mini-row report-section-row">
              <Switch checked={notify} onChange={setNotify} />
              <span className="report-section-text">
                <span className="cell-top">Notify me when finished</span>
                <span className="cell-sub">Get an inbox notification when the run completes.</span>
              </span>
            </label>
          </div>
        </OptionGroup>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn-solid" disabled={!canGo} onClick={() => void generate()}>
            Generate labels
          </button>
          {activeBlockingId && (
            <span className="page-hint" style={{ margin: 0 }}>A run is already active for this initiative.</span>
          )}
        </div>

        {activeRun && (
          <GenerationProgress run={activeRun} typeLabel={typeLabelFor}
                               paused={sys.workers_paused} onCancel={() => void cancel()} />
        )}

        <div className="modal-section">Recent runs</div>
        <LabelRunsList runs={runs} highlightRunId={highlightRunId} typeLabel={typeLabelFor}
                        onViewErrors={openErrors} />
      </OptionsGrid>

      {viewingErrors && (
        <LabelRunErrorsModal run={viewingErrors} typeLabel={typeLabelFor} onClose={closeErrors} />
      )}
    </div>
  );
}
