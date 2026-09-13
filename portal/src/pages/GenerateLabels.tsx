/**
 * /labels/generate — V3 port of V2's Generate Labels page, now backed by
 * a queue + `label-worker` process instead of an in-process job: pick an
 * initiative and one or more label types, kick off a run, watch its
 * progress (polled every ~1.75s while queued/running), and review recent
 * runs (with a per-run error drill-down) for the initiative in view.
 *
 * Layout is a three-step band (Initiative / Label types / Generate),
 * each an equal-height bordered card in the report Generate modals' own
 * look (`ChoiceCard`/`InitiativeSummary` from
 * `components/reports/ReportOptionsLayout`) even though this is a full
 * page, not a modal — the pieces are generic. The one true modal here
 * (`LabelRunErrorsModal`) still carries the roomy eyebrow/title/
 * description header per the house rule for new modals.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  ApiError, cancelLabelRun, getLabelGeneratePreview, getLabelRun, listInitiatives, listLabelRuns,
  listLabelVocab, startLabelRun,
  type InitiativeItem, type LabelGeneratePreview, type LabelRun, type LabelVocab,
} from '../lib/api';
import {
  canGenerate, firstUnresolvedType, isAssetLabelType, isRunActive, templatesPayloadFor,
  visibleInitiativesForGenerate,
} from '../lib/generateLabels';
import { vocabLabel, vocabOfKind } from '../lib/labels';
import { useSystemStatus } from '../lib/systemStatusContext';
import { useAuth } from '../auth/AuthContext';
import ComboBox from '../components/ComboBox';
import GenerationProgress from '../components/labels/GenerationProgress';
import LabelRunErrorsModal from '../components/labels/LabelRunErrorsModal';
import LabelRunsList from '../components/labels/LabelRunsList';
import LabelTypeCards from '../components/labels/LabelTypeCards';
import { InitiativeSummary } from '../components/reports/ReportOptionsLayout';
import { Switch } from '../components/Switch';
import '../styles/directory.css';
import '../styles/dashboard.css';  /* .dash-kpis (KPI tiles / progress panel's live counters) */
import '../styles/reports.css';    /* .rgm-choice-cards/.rgm-progress-* etc. */
import '../styles/labels.css';

const RUNS_LIMIT = 25;
const POLL_MS = 1750;

/** One card of the three-step band — a numbered eyebrow + title header
 *  over arbitrary content, styled as a bordered card (`.glabels-step`,
 *  the same look as `PreviewCard`'s `.rgm-summary`). */
function StepCard({ step, title, hint, children }: {
  step: string; title: string; hint?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="glabels-step" aria-label={title}>
      <div className="glabels-step-head">
        <span className="eyebrow">{step}</span>
        <div className="modal-section">{title}</div>
        {hint && <p className="page-hint">{hint}</p>}
      </div>
      <div className="glabels-step-body">{children}</div>
    </section>
  );
}

export default function GenerateLabels() {
  const { status: sys } = useSystemStatus();
  const { can } = useAuth();
  // Mirrors the server: labels:add starts a run; labels:change cancels one
  // and may regenerate labels that already exist. Affordances are disabled
  // with a hint rather than hidden, so a view-only user still sees the flow.
  const canAdd = can('labels', 'add');
  const canChange = can('labels', 'change');
  const [params, setParams] = useSearchParams();

  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [initiativeId, setInitiativeId] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [templateOverrides, setTemplateOverrides] = useState<Record<string, string>>({});
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
  // Always-fresh ref for the poll's settle-time refresh, which is
  // scheduled from an earlier render and must not refresh the *old*
  // initiative's scope if the operator switched away while it was
  // in flight — read from here instead of closing over `initiativeId`.
  const initiativeIdRef = useRef(initiativeId);
  initiativeIdRef.current = initiativeId;

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

  // Asset/device label types only — container labels live on their own page.
  const typeVocab = useMemo(() => vocabOfKind(vocab, 'type').filter((v) => isAssetLabelType(v.key)), [vocab]);
  const typeLabelFor = (key: string) => vocabLabel(vocab, 'type', key);

  const pickerOptions = useMemo(
    () => visibleInitiativesForGenerate(initiatives ?? [])
      .map((i) => ({ value: i.id, label: i.name, sub: i.client_name })),
    [initiatives],
  );
  // For the house status chip (color + label) — the preview endpoint's own
  // initiative shape carries just the raw status key, not its vocab color.
  const pickedInitiative = initiatives?.find((i) => i.id === initiativeId) ?? null;

  // Reads the scope through the ref (see above) rather than closing over
  // whatever `initiativeId` was in scope when this particular `loadRuns`
  // closure was created — the poll's settle-time call is created well
  // before it actually runs.
  const loadRuns = async () => {
    try {
      setRuns(await listLabelRuns({ initiative_id: initiativeIdRef.current || undefined, limit: RUNS_LIMIT }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load recent runs.");
    }
  };
  useEffect(() => { setRuns(null); void loadRuns(); }, [initiativeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initiativeId) { setPreview(null); setPreviewLoading(false); setPreviewError(''); return; }
    let cancelled = false;
    setPreview(null);   // never show the previous initiative's template resolution while the new one loads
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
        setPreview(null);   // a failed load must not leave the previous initiative's cards on screen either
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

  const setOverride = (key: string, templateId: string | null) =>
    setTemplateOverrides((cur) => {
      if (!templateId) {
        if (!(key in cur)) return cur;
        const next = { ...cur };
        delete next[key];
        return next;
      }
      return { ...cur, [key]: templateId };
    });

  const activeBlockingId = activeRun && isRunActive(activeRun) ? activeRun.id : null;
  const unresolvedType = firstUnresolvedType(preview?.types ?? null, selectedTypes, templateOverrides);
  const canGo = canAdd && canGenerate({
    initiativeId: initiativeId || null, labelTypes: selectedTypes, activeRunId: activeBlockingId, unresolvedType,
  });

  const generate = async () => {
    if (!canGo) return;
    setError('');
    try {
      const templates = templatesPayloadFor(selectedTypes, templateOverrides);
      const run = await startLabelRun({
        initiative_id: initiativeId, label_types: selectedTypes,
        regenerate_existing: regenerateExisting, notify,
        ...(Object.keys(templates).length ? { templates } : {}),
      });
      setActiveRun(run);
      void loadRuns();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'run_active') {
        // The progress panel already replaces the button once `activeRun`
        // lands — no need for a second, redundant banner above the fold.
        const runId = (err.detail as { run_id?: string } | null | undefined)?.run_id;
        if (runId) void getLabelRun(runId).then(setActiveRun).catch(() => undefined);
      } else if (err instanceof ApiError && err.code === 'invalid_templates') {
        const problems = (err.detail as { problems?: string[] } | null | undefined)?.problems ?? [];
        setError(problems.length ? `Couldn't start the run: ${problems.join('; ')}` : err.message);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't start the run.");
      }
    }
  };

  const cancel = async () => {
    if (!activeRun || !canChange) return;
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

  const pickedTypeLabels = selectedTypes.map(typeLabelFor);
  const runSummary = initiativeId && preview && selectedTypes.length > 0
    ? `${pickedTypeLabels.join(' + ')} for ${preview.initiative.asset_count.toLocaleString()} asset${preview.initiative.asset_count === 1 ? '' : 's'} on ${preview.initiative.name}`
    : null;
  const NO_ADD_HINT = "You don't have permission to generate labels.";
  const NO_CHANGE_HINT = "You don't have permission to change labels.";
  const generateHint = !canAdd
    ? NO_ADD_HINT
    : unresolvedType
      ? `Choose a template for ${typeLabelFor(unresolvedType)} to continue.`
      : runSummary ?? 'Choose an initiative and at least one label type.';

  const autoCount = preview
    ? selectedTypes.filter((k) => !templateOverrides[k] && preview.types.find((t) => t.key === k)?.template).length
    : 0;
  const manualCount = selectedTypes.filter((k) => !!templateOverrides[k]).length;

  return (
    <div className="portal-page glabels-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">Generate Labels</h1>
          <p className="page-hint">
            Generate printable asset and device labels for every asset on an initiative. Labels are
            rendered by the label worker and kept for printing.
          </p>
        </div>
      </div>

      {error && <div className="pf-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="glabels-steps">
        <StepCard step="Step 1" title="Initiative"
                  hint="Pick the initiative whose assets get labels. Its sites decide which templates match.">
          <div className="glabels-initiative">
          <ComboBox options={pickerOptions} value={initiativeId}
                    onChange={(v) => { setInitiativeId(v); setSelectedTypes([]); setTemplateOverrides({}); }}
                    placeholder="Choose an initiative…" clearable />
          {!initiativeId && (
            <p className="page-hint">Pick an initiative to see its sites, asset count, and which template each label type will use.</p>
          )}
          {initiativeId && previewLoading && <p className="page-hint">Loading preview…</p>}
          {initiativeId && !previewLoading && previewError && (
            <div className="pf-error">{previewError}</div>
          )}
          {initiativeId && !previewLoading && !previewError && preview && (
            <div>
              <InitiativeSummary
                initiative={{
                  name: preview.initiative.name, clientName: preview.initiative.client_name,
                  statusLabel: pickedInitiative?.status_label ?? null,
                  statusColor: pickedInitiative?.status_color ?? null,
                  scheduledStart: preview.initiative.scheduled_start,
                  originName: preview.initiative.source_name, destinationName: preview.initiative.destination_name,
                }}
                emptyText="Pick an initiative to see its details here."
              />
              <div className="dash-kpis glabels-kpis">
                <div className="dash-kpi">
                  <span className="dash-kpi-label">Assets</span>
                  <span className="dash-kpi-value">{preview.initiative.asset_count.toLocaleString()}</span>
                </div>
                <div className="dash-kpi">
                  <span className="dash-kpi-label">Templates matched</span>
                  <span className="dash-kpi-value">{preview.types.filter((t) => t.template).length} / {preview.types.length}</span>
                </div>
              </div>
            </div>
          )}
          </div>
        </StepCard>

        <StepCard step="Step 2" title="Label types"
                  hint={<>
                    {initiativeId
                      ? 'Pick one or more. A type needs a resolved template — automatic or chosen — before it can be generated.'
                      : 'Pick an initiative first to see which types have a template.'}
                    {' '}These are asset and device labels; container label sheets come from the{' '}
                    <Link to="/labels/containers">Container Labels</Link> page.
                  </>}>
          <LabelTypeCards vocab={typeVocab} types={preview?.types ?? null}
                           selected={selectedTypes} onToggle={toggleType}
                           overrides={templateOverrides} onOverride={setOverride} />
        </StepCard>

        <StepCard step="Step 3" title="Generate"
                  hint="Review the run, then queue it for the label worker.">
          <div className="glabels-generate">
          <div className="mini-list report-sections">
            <label className="mini-row report-section-row" title={canChange ? undefined : NO_CHANGE_HINT}>
              <Switch checked={regenerateExisting} onChange={setRegenerateExisting} disabled={!canChange} />
              <span className="report-section-text">
                <span className="cell-top">Regenerate existing labels</span>
                <span className="cell-sub">
                  {canChange
                    ? 'Off skips assets that already have a current label for the type.'
                    : `${NO_CHANGE_HINT} Runs skip assets that already have a current label.`}
                </span>
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

          <div>
          {preview && selectedTypes.length > 0 && (
            <dl className="kv">
              <dt>Initiative</dt>
              <dd>{preview.initiative.name}</dd>
              <dt>Types</dt>
              <dd>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {selectedTypes.map((k) => <span key={k} className="chip tag">{typeLabelFor(k)}</span>)}
                </span>
              </dd>
              <dt>Assets</dt>
              <dd>{preview.initiative.asset_count.toLocaleString()}</dd>
              <dt>Templates</dt>
              <dd>{autoCount} auto · {manualCount} manual</dd>
            </dl>
          )}

          {/* While a run is active this replaces the button outright; once it
              settles, the button comes back (so another run can start) but
              the just-finished run's own status/tallies stay in view above
              it rather than disappearing the instant it's done. */}
          {!activeBlockingId && (
            <div className="glabels-step-actions">
              <button type="button" className="btn-solid" disabled={!canGo}
                      title={canAdd ? undefined : NO_ADD_HINT} onClick={() => void generate()}>
                Generate labels
              </button>
              <p className="page-hint">{generateHint}</p>
            </div>
          )}
          </div>
          {activeRun && (
            <GenerationProgress run={activeRun} typeLabel={typeLabelFor}
                                 paused={sys.workers_paused} onCancel={() => void cancel()}
                                 cancelDisabledReason={canChange ? undefined : 'You don\'t have permission to cancel runs.'} />
          )}
          </div>
        </StepCard>
      </div>

      <section className="glabels-section" aria-label="Recent runs">
        <div className="glabels-section-head">
          <div className="modal-section">Recent runs</div>
          <span className="page-hint" style={{ margin: 0 }}>
            {pickedInitiative ? `Runs for ${pickedInitiative.name}` : 'Runs across all initiatives'}
          </span>
        </div>
        <LabelRunsList runs={runs} highlightRunId={highlightRunId} typeLabel={typeLabelFor}
                        onViewErrors={openErrors} />
      </section>

      {viewingErrors && (
        <LabelRunErrorsModal run={viewingErrors} typeLabel={typeLabelFor} onClose={closeErrors} />
      )}
    </div>
  );
}
