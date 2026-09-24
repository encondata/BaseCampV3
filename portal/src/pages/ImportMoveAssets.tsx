/** Move-assets bulk import: upload -> validate report -> commit -> results.
 *  All state renders from the polled import job, so a refresh mid-import
 *  loses nothing. The heavy lifting happens in the separate API worker.
 *
 *  The page reads as a true three-step sequence — Upload, Review, Import —
 *  and the stepper at the top plus every card below it are driven purely
 *  by the polled `job`, never by separate "which screen am I on" UI state
 *  (see `currentStep` below). */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ImportProgress from '../components/imports/ImportProgress';
import ImportReport from '../components/imports/ImportReport';
import ImportUploadFields, { ImportTemplateLinks } from '../components/imports/ImportUploadFields';
import FixMakeModelDialog from '../components/initiatives/FixMakeModelDialog';
import {
  cancelImportJob, commitImportJob, createMoveAssetImportJob,
  getImportJob, getInitiative, reprocessImportJob,
  type ImportJobOut, type InitiativeDetail,
} from '../lib/api';
import {
  countDetails, etaSeconds, IMPORT_ERRORS, importErrorMessage, jobIsActive,
  rowsPerSecond, type SpeedSample,
} from '../lib/moveAssetImport';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';

const POLL_MS = 2000;

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
  const [mode, setMode] = useState('fuzzy');
  const [generateSerials, setGenerateSerials] = useState(false);
  const [job, setJob] = useState<ImportJobOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    setError(null);
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
                <ImportTemplateLinks busy={busy} />
              </div>

              <ImportUploadFields file={file} onFile={setFile} mode={mode} onMode={setMode}
                                  generateSerials={generateSerials}
                                  onGenerateSerials={setGenerateSerials}
                                  busy={busy} inputRef={fileInputRef} />

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

              <ImportProgress job={job} speed={speed} eta={eta} />

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

                    <ImportReport job={job} fixedTexts={fixedTexts} onFix={setFixTarget}
                                  canAddModels={canAddModels} canChangeModels={canChangeModels} />

                    {job.phase === 'validate' && (
                      <div className="imp-card-foot">
                        <button className="btn-solid" type="button"
                                disabled={busy || committable === 0}
                                onClick={() => void run(() => commitImportJob(job.id))}>
                          {busy ? 'Importing…' : `Import ${committable} rows`}
                        </button>
                        {counts.review > 0 && can('initiatives', 'change') && (
                          <button className="mini-btn" type="button" disabled={busy}
                                  onClick={() => {
                                    setFixedTexts(new Set());
                                    void run(() => reprocessImportJob(job.id));
                                  }}>
                            {busy ? 'Reprocessing…' : `Reprocess ${counts.review} flagged`}
                          </button>
                        )}
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
