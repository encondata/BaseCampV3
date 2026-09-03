/** Move-assets bulk import: upload -> validate report -> commit -> results.
 *  All state renders from the polled import job, so a refresh mid-import
 *  loses nothing. The heavy lifting happens in the separate API worker.
 *
 *  The page reads as a true three-step sequence — Upload, Review, Import —
 *  and the stepper at the top plus every card below it are driven purely
 *  by the polled `job`, never by separate "which screen am I on" UI state
 *  (see `currentStep` below). */

import {
  useCallback, useEffect, useMemo, useRef, useState, type DragEvent,
} from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import FixMakeModelDialog from '../components/initiatives/FixMakeModelDialog';
import {
  cancelImportJob, commitImportJob, createMoveAssetImportJob,
  downloadMoveAssetTemplate, getImportJob, getInitiative, reprocessImportJob,
  type ImportJobOut, type ImportRowDetail, type InitiativeDetail,
} from '../lib/api';
import {
  countDetails, etaSeconds, IMPORT_ERRORS, importErrorMessage, jobIsActive,
  jobProgressPct, missingMakeModels, reviewMakeModel, rowsPerSecond, suggestSplit,
  type SpeedSample,
} from '../lib/moveAssetImport';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';

const POLL_MS = 2000;
const PAGE_SIZE = 500;

/** make/model mode descriptions — verbatim intent from the template's
 *  Reference sheet (api/src/serversherpa/imports/parsing.py's
 *  build_template_xlsx), reworded here as a title + one-line description
 *  instead of one cramped all-caps pill label. */
const MODE_OPTIONS: { value: string; title: string; desc: string }[] = [
  { value: 'fuzzy', title: 'Match only',
    desc: 'Unmatched make/models are flagged for review.' },
  { value: 'force', title: 'Always create',
    desc: 'Missing make/models are created automatically.' },
  { value: 'hybrid', title: 'Match, then create',
    desc: 'Try to match first; create when nothing matches.' },
];

/** row-status -> chip class, shared by the summary chips and the details
 *  list (matches the c-* chip idiom used across the portal). */
const STATUS_CHIP: Record<string, string> = {
  created: 'c-green', updated: 'c-amber', review: 'c-slate', error: 'c-red',
};

/** summary-chip labels differ by phase — the validate report previews what
 *  WILL happen, the commit report says what DID happen. */
const PHASE_LABELS: Record<'validate' | 'commit',
  { created: string; updated: string; review: string; error: string }> = {
  validate: { created: 'will create', updated: 'will update',
              review: 'needs review', error: 'errors' },
  commit: { created: 'created', updated: 'updated',
            review: 'review skipped', error: 'errors' },
};

const STEPS: { n: 1 | 2 | 3; label: string }[] = [
  { n: 1, label: 'Upload' },
  { n: 2, label: 'Review' },
  { n: 3, label: 'Import' },
];

/** Which of the three steps is current, derived purely from the polled
 *  job — never separate UI state, so a page refresh mid-import shows the
 *  right step immediately.
 *  - no job, or the validate phase hasn't finished successfully yet
 *    (queued/running/failed/cancelled): step 1 — there's nothing usable to
 *    review until validation actually completes.
 *  - validate completed: step 2, the report card is showing.
 *  - any commit-phase status (queued/running/completed/failed/cancelled):
 *    step 3 — once a commit job exists the user has moved on to
 *    importing, whether it's still running, finished, or ended badly. */
function currentStep(job: ImportJobOut | null): 1 | 2 | 3 {
  if (!job) return 1;
  if (job.phase === 'commit') return 3;
  return job.status === 'completed' ? 2 : 1;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function ImportStepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="imp-stepper">
      {STEPS.map((s, i) => (
        <div key={s.n} className="imp-stepper-item">
          <span className={`imp-stepper-dot${
            s.n < step ? ' done' : s.n === step ? ' active' : ''}`}>
            {s.n < step ? (
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor"
                   strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 6.5 4.8 9.5 10 2.8" />
              </svg>
            ) : s.n}
          </span>
          <span className={`imp-stepper-label${s.n === step ? ' active' : ''}`}>
            {s.label}
          </span>
          {i < STEPS.length - 1 && <span className="imp-stepper-line" />}
        </div>
      ))}
    </div>
  );
}

export default function ImportMoveAssets() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const canAddModels = can('asset_models', 'add');
  const canChangeModels = can('asset_models', 'change');
  const [initiative, setInitiative] = useState<InitiativeDetail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState('fuzzy');
  const [generateSerials, setGenerateSerials] = useState(false);
  const [job, setJob] = useState<ImportJobOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const samplesRef = useRef<SpeedSample[]>([]);
  const [speed, setSpeed] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Which unmatched make/model strings have been fixed (created/mapped) this
  // session, keyed lowercase — flips a group's card entry to "ready to
  // reprocess" without waiting on a refetch. Reset whenever the polled job
  // itself changes (a fresh upload or a reprocess child both start clean).
  const [fixedTexts, setFixedTexts] = useState<Set<string>>(new Set());
  useEffect(() => { setFixedTexts(new Set()); }, [job?.id]);

  // The row/group currently open in FixMakeModelDialog, or null when closed.
  const [fixTarget, setFixTarget] = useState<
    { text: string; make: string; model: string } | null>(null);
  const closeFix = useCallback(() => setFixTarget(null), []);
  const markFixed = useCallback((text: string) => {
    setFixedTexts((s) => new Set(s).add(text.toLowerCase()));
    setFixTarget(null);
  }, []);

  const reviewDetails: ImportRowDetail[] = job?.results?.details ?? [];
  const missing = useMemo(() => missingMakeModels(reviewDetails), [reviewDetails]);

  useEffect(() => {
    if (!id) return;
    void getInitiative(id).then(setInitiative)
      .catch((e) => setError(importErrorMessage(e)));
  }, [id]);

  // poll while the job is active
  useEffect(() => {
    if (!job || !jobIsActive(job)) return undefined;
    const timer = setInterval(() => {
      void getImportJob(job.id).then((next) => {
        setJob(next);
        samplesRef.current = [...samplesRef.current.slice(-5),
          { at: Date.now(), processed: next.processed_rows }];
        setSpeed(rowsPerSecond(samplesRef.current));
      }).catch(() => undefined);   // transient poll failures: keep polling
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job]);

  const run = useCallback(async (fn: () => Promise<ImportJobOut>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      samplesRef.current = [];
      setSpeed(0);
      setPage(0);
      setJob(next);
    } catch (e) {
      setError(importErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Clears the file-input's DOM value along with the file/job state — a
  // browser won't re-fire onChange for the same path unless the element's
  // value is cleared first, so re-picking the exact same file after
  // "Import another file" / "Start over" would otherwise silently no-op.
  const resetImport = useCallback(() => {
    setJob(null);
    setFile(null);
    setPage(0);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const removeFile = useCallback(() => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const isMove = !initiative || initiative.initiative_type === 'move';
  const active = job !== null && jobIsActive(job);
  const eta = job && active ? etaSeconds(job, speed) : null;
  const step = currentStep(job);

  return (
    <div className="portal-page">
      <Link to={id ? `/initiatives/${id}` : '/initiatives'} className="idet-back">
        ← Back to move
      </Link>

      <div className="dir-head">
        <div>
          <div className="eyebrow">Bulk import</div>
          <h1 className="page-title">{initiative?.name ?? 'Loading…'}</h1>
        </div>
      </div>

      {initiative && !isMove && (
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Imports only apply to moves.</b>
        </div>
      )}

      {isMove && (
        <>
          <ImportStepper step={step} />

          {job?.options?.reprocess_of && (
            <p className="page-hint imp-reprocess-banner">
              Reprocessing {job.options.only_rows?.length ?? ''} flagged rows from the earlier run.
            </p>
          )}

          {error && <p className="pf-error" style={{ marginTop: -6, marginBottom: 16 }}>{error}</p>}

          {!active && (
            <div className="init-panel imp-card">
              <div className="imp-card-head">
                <p className="eyebrow-sm">Upload</p>
                <div className="imp-template-links">
                  <span>Download template:</span>
                  <button type="button" className="imp-link-btn" disabled={busy}
                          onClick={() => void downloadMoveAssetTemplate('xlsx')}>
                    .xlsx
                  </button>
                  <span>·</span>
                  <button type="button" className="imp-link-btn" disabled={busy}
                          onClick={() => void downloadMoveAssetTemplate('csv')}>
                    .csv
                  </button>
                </div>
              </div>

              <label
                className={`imp-dropzone${dragOver ? ' drag' : ''}${file ? ' has-file' : ''}`}
                onDragOver={(e: DragEvent<HTMLLabelElement>) => {
                  e.preventDefault();
                  if (!busy) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e: DragEvent<HTMLLabelElement>) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (busy) return;
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) setFile(dropped);
                }}
              >
                <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls"
                       disabled={busy} className="imp-dropzone-input"
                       onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                {file ? (
                  <div className="imp-dropzone-file">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                      <path d="M14 2v6h6" />
                    </svg>
                    <div className="imp-dropzone-file-meta">
                      <span className="imp-dropzone-file-name">{file.name}</span>
                      <span className="imp-dropzone-file-size">{formatBytes(file.size)}</span>
                    </div>
                    <button type="button" className="imp-dropzone-remove"
                            aria-label="Remove file" disabled={busy}
                            onClick={(e) => { e.preventDefault(); removeFile(); }}>
                      ×
                    </button>
                  </div>
                ) : (
                  <div className="imp-dropzone-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 18a4.5 4.5 0 0 1-1.2-8.84A5.5 5.5 0 0 1 16.5 8H17a4 4 0 0 1 1 7.87" />
                      <path d="M12 12v7" />
                      <path d="M9.5 14.5 12 12l2.5 2.5" />
                    </svg>
                    <p className="imp-dropzone-title">Drop your file here, or click to browse</p>
                    <p className="imp-dropzone-hint">
                      CSV or Excel spreadsheet — .csv, .xlsx, or .xls
                    </p>
                  </div>
                )}
              </label>

              <div className="imp-options">
                <p className="imp-options-label">Options</p>

                <div className="imp-options-group">
                  <p className="imp-options-sublabel">Make / model matching</p>
                  <p className="imp-options-explainer">
                    How makes and models in your file are matched against the catalog.
                  </p>
                  <div className="imp-radio-group" role="radiogroup"
                       aria-label="Make/model handling">
                    {MODE_OPTIONS.map((opt) => (
                      <label key={opt.value} className="imp-radio">
                        <input type="radio" name="make-model-mode" value={opt.value}
                               checked={mode === opt.value} disabled={busy}
                               onChange={() => setMode(opt.value)} />
                        <span className="imp-radio-body">
                          <span className="imp-radio-title">{opt.title}</span>
                          <span className="imp-radio-desc">{opt.desc}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="imp-options-group">
                  <p className="imp-options-sublabel">Serial numbers</p>
                  <label className="imp-checkbox">
                    <input type="checkbox" checked={generateSerials} disabled={busy}
                           onChange={(e) => setGenerateSerials(e.target.checked)} />
                    <span className="imp-radio-body">
                      <span className="imp-radio-title">Generate serial numbers</span>
                      <span className="imp-radio-desc">
                        Blank serial-number rows get one generated automatically.
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              <div className="imp-card-foot">
                <button className="btn-solid" type="button"
                        disabled={busy || !file}
                        onClick={() => {
                          if (!id || !file) return;
                          void run(() => createMoveAssetImportJob(
                            id, file, { makeModelMode: mode, generateSerials }));
                        }}>
                  {busy ? 'Validating…' : 'Validate file'}
                </button>
              </div>
            </div>
          )}

          {job && active && (
            <div className="init-panel imp-card">
              <p className="eyebrow-sm">
                {job.phase === 'commit' ? 'Importing rows…' : 'Checking the file…'}
              </p>

              <div className="idet-assets-progress">
                <div className="idet-assets-progress-label">
                  <span>{jobProgressPct(job)}%</span>
                </div>
                <div className="idet-assets-progress-track">
                  <div className="idet-assets-progress-fill"
                       style={{ width: `${jobProgressPct(job)}%` }} />
                </div>
              </div>

              <p className="page-hint imp-progress-hint">
                {job.processed_rows} of {job.total_rows} rows
              </p>
              {speed > 0 && (
                <p className="page-hint imp-progress-meta">
                  ~{Math.round(speed)} rows/s
                  {eta !== null && eta > 0 ? ` · about ${eta}s left` : ''}
                </p>
              )}

              <div className="imp-card-foot">
                <button className="mini-btn" type="button" disabled={busy}
                        onClick={() => void run(() => cancelImportJob(job.id))}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {job && !active && (
            <div className="init-panel imp-card">
              {job.status === 'failed' && (
                <div className="dir-empty">
                  <b>Import failed</b>
                  {IMPORT_ERRORS[job.error ?? ''] ?? 'Something went wrong — try again.'}
                </div>
              )}

              {job.status === 'cancelled' && (
                <p className="page-hint" style={{ margin: 0 }}>
                  {job.phase === 'commit'
                    ? `Import cancelled — ${job.processed_rows} rows were already committed.`
                    : 'Validation cancelled.'}
                </p>
              )}

              {job.status === 'completed' && job.results && (() => {
                const counts = countDetails(job.results.details);
                const labels = PHASE_LABELS[job.phase];
                const details = job.results.details;
                const total = details.length;
                const start = page * PAGE_SIZE;
                const end = Math.min(start + PAGE_SIZE, total);
                const pageRows = details.slice(start, end);
                const collisions = job.results.summary.collisions_flagged ?? 0;
                const committable = counts.created + counts.updated;
                const skippable = counts.review + counts.error;
                const headline = job.phase === 'validate'
                  ? (committable > 0 ? `Ready to import ${committable} rows` : 'Nothing to import')
                  : `Imported: ${counts.created} created, ${counts.updated} updated`;

                return (
                  <>
                    <div className="imp-card-head">
                      <p className="eyebrow-sm">
                        {job.phase === 'commit' ? 'Import complete' : 'Review'}
                      </p>
                      {job.phase === 'validate' && (
                        <button type="button" className="imp-link-btn" onClick={resetImport}>
                          Start over
                        </button>
                      )}
                    </div>
                    <h2 className="imp-report-headline">{headline}</h2>

                    <div className="chips imp-report-chips">
                      <span className="chip c-green">
                        <span className="dot" />{counts.created} {labels.created}
                      </span>
                      <span className="chip c-amber">
                        <span className="dot" />{counts.updated} {labels.updated}
                      </span>
                      <span className="chip c-slate">
                        <span className="dot" />{counts.review} {labels.review}
                      </span>
                      <span className="chip c-red">
                        <span className="dot" />{counts.error} {labels.error}
                      </span>
                      {collisions > 0 && (
                        <span className="chip c-amber">
                          <span className="dot" />{collisions} collisions flagged
                        </span>
                      )}
                    </div>

                    {missing.length > 0 && (
                      <div className="init-panel imp-missing-card">
                        <p className="eyebrow-sm">
                          {missing.length} missing make/model{missing.length === 1 ? '' : 's'}
                        </p>
                        {!canAddModels && !canChangeModels && (
                          <p className="page-hint">Ask an admin to add these models.</p>
                        )}
                        <div className="imp-missing-list">
                          {missing.map((g) => {
                            const fixed = fixedTexts.has(g.text.toLowerCase());
                            return (
                              <div key={g.text} className="imp-missing-row">
                                <span className="mono">{g.text}</span>
                                <span className="page-hint">{g.rows.length} rows</span>
                                {fixed ? (
                                  <span className="chip c-green">
                                    <span className="dot" />Ready — reprocess to apply
                                  </span>
                                ) : (
                                  <span className="imp-missing-actions">
                                    {canAddModels && (
                                      <button type="button" className="mini-btn"
                                              onClick={() => setFixTarget(
                                                { text: g.text, make: g.make, model: g.model })}>
                                        Create model…
                                      </button>
                                    )}
                                    {canChangeModels && (
                                      <button type="button" className="mini-btn"
                                              onClick={() => setFixTarget(
                                                { text: g.text, make: g.make, model: g.model })}>
                                        Map to existing…
                                      </button>
                                    )}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="dir-list imp-report-list">
                      <div className="list-head imp-report-grid">
                        <span className="col-head">Row</span>
                        <span className="col-head">Serial</span>
                        <span className="col-head">Status</span>
                        <span className="col-head">Message</span>
                      </div>
                      {pageRows.map((d) => (
                        <div key={d.row} className="dir-row">
                          <div className="row-main imp-report-grid">
                            <div className="cell"><span className="cell-top">{d.row}</span></div>
                            <div className="cell">
                              <span className="cell-top">{d.serial_number || '—'}</span>
                            </div>
                            <div className="cell">
                              <span className={`chip ${STATUS_CHIP[d.status] ?? 'c-slate'}`}>
                                <span className="dot" />{d.status}
                              </span>
                            </div>
                            <div className="cell">
                              <span className="cell-top">{d.message}</span>
                              {(() => {
                                const text = reviewMakeModel(d);
                                if (!text || fixedTexts.has(text.toLowerCase())) return null;
                                if (!canAddModels && !canChangeModels) return null;
                                const split = d.suggested_make && d.suggested_model
                                  ? { make: d.suggested_make, model: d.suggested_model }
                                  : suggestSplit(text);
                                return (
                                  <button type="button" className="mini-btn"
                                          style={{ marginLeft: 8 }}
                                          onClick={() => setFixTarget({ text, ...split })}>
                                    Fix…
                                  </button>
                                );
                              })()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="imp-pagination">
                      <button className="mini-btn" type="button"
                              disabled={page === 0}
                              onClick={() => setPage((p) => p - 1)}>
                        Prev
                      </button>
                      <button className="mini-btn" type="button"
                              disabled={end >= total}
                              onClick={() => setPage((p) => p + 1)}>
                        Next
                      </button>
                      <span className="page-hint">
                        showing {total === 0 ? 0 : start + 1}–{end} of {total}
                      </span>
                    </div>

                    {job.phase === 'validate' && (
                      <div className="imp-card-foot">
                        <button className="btn-solid" type="button"
                                disabled={busy || committable === 0}
                                onClick={() => void run(() => commitImportJob(job.id))}>
                          {busy ? 'Importing…' : `Import ${committable} rows`}
                        </button>
                        {skippable > 0 && (
                          <span className="page-hint">
                            Review and error rows will be skipped.
                          </span>
                        )}
                      </div>
                    )}

                    {job.phase === 'commit' && (
                      <div className="imp-card-foot">
                        <Link className="imp-link-btn" to={id ? `/initiatives/${id}` : '/initiatives'}>
                          Back to move
                        </Link>
                        <button className="mini-btn" type="button" onClick={resetImport}>
                          Import another file
                        </button>
                        {counts.review > 0 && can('initiatives', 'change') && (
                          <button className="btn-solid" type="button" disabled={busy}
                                  onClick={() => {
                                    setFixedTexts(new Set());
                                    void run(() => reprocessImportJob(job.id));
                                  }}>
                            {busy ? 'Reprocessing…' : `Reprocess ${counts.review} flagged`}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </>
      )}

      {fixTarget && (
        <FixMakeModelDialog
          text={fixTarget.text}
          make={fixTarget.make}
          model={fixTarget.model}
          onClose={closeFix}
          onFixed={markFixed}
        />
      )}
    </div>
  );
}
