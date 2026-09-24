/** Step 2 — the From-To file. Upload runs the same background check the
 *  move import page runs (no move yet); the review matches that page —
 *  counts, per-row list, Fix make/model — and Check again re-checks the
 *  whole file. Rows that still need review are not imported. */
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, getMoveSetupCheck, recheckMoveSetupAssets, uploadMoveSetupAssets,
  type ImportJobOut, type MoveSetupDraft,
} from '../../lib/api';
import { countDetails, IMPORT_ERRORS, jobIsActive } from '../../lib/moveAssetImport';
import { moveSetupError } from '../../lib/moveSetup';
import WizardFooter from '../common/WizardFooter';
import ImportProgress from '../imports/ImportProgress';
import ImportReport, { type FixTarget } from '../imports/ImportReport';
import ImportUploadFields, { ImportTemplateLinks } from '../imports/ImportUploadFields';
import FixMakeModelDialog from '../initiatives/FixMakeModelDialog';
import { useSkip } from './useSkip';

const POLL_MS = 1500;

interface Props {
  draft: MoveSetupDraft;
  job: ImportJobOut | null;
  setJob: (job: ImportJobOut | null) => void;
  onBack: () => void;
  onSkip: () => Promise<void>;
  onNext: () => void;
}

export default function AssetsStep({ draft, job, setJob, onBack, onSkip, onNext }: Props) {
  const { can } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState('fuzzy');
  const [generateSerials, setGenerateSerials] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fixedTexts, setFixedTexts] = useState<Set<string>>(new Set());
  const [fixTarget, setFixTarget] = useState<FixTarget | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { skipping, skip } = useSkip(onSkip, setError);
  useEffect(() => { setFixedTexts(new Set()); }, [job?.id]);

  // poll the draft's check while it is running: one request at a time,
  // stopped on unmount; a network blip keeps polling, an API error stops.
  // Polled by draft id, not the check job's own id — GET
  // /bulk/move-setup/{id}/assets serves whichever check the draft
  // currently holds, so this never touches the initiatives:change-gated
  // /initiatives/assets/import-jobs route.
  const active = job !== null && jobIsActive(job);
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await getMoveSetupCheck(draft.id);
        if (stopped) return;
        setJob(next);
        if (!jobIsActive(next)) return;
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError) { setError(moveSetupError(err)); return; }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, draft.id, setJob]);

  const run = async (fn: () => Promise<ImportJobOut>) => {
    setBusy(true);
    setError('');
    try {
      setJob(await fn());
      setReplacing(false);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError(moveSetupError(err));
    } finally {
      setBusy(false);
    }
  };

  const showUpload = !active && (job === null || replacing || job.status !== 'completed');
  const checked = job?.status === 'completed' && !!job.results && !replacing;
  const counts = checked ? countDetails(job.results!.details) : null;
  const importable = counts ? counts.created + counts.updated : 0;

  return (
    <>
      {showUpload && (
        <section className="init-panel imp-card">
          <div className="imp-card-head">
            <p className="eyebrow-sm">Upload</p>
            <ImportTemplateLinks busy={busy} />
          </div>
          {job && (job.status === 'failed' || job.status === 'cancelled') && !replacing && (
            <div className="dir-empty">
              <b>The check did not finish</b>
              {IMPORT_ERRORS[job.error ?? ''] ?? 'Something went wrong. Upload the file again.'}
            </div>
          )}
          <ImportUploadFields file={file} onFile={setFile} mode={mode} onMode={setMode}
                              generateSerials={generateSerials}
                              onGenerateSerials={setGenerateSerials}
                              busy={busy} inputRef={inputRef} />
          <div className="imp-card-foot">
            <button className="btn-solid" type="button" disabled={busy || !file}
                    onClick={() => file && void run(() => uploadMoveSetupAssets(
                      draft.id, file, { makeModelMode: mode, generateSerials }))}>
              {busy ? 'Uploading…' : 'Check file'}
            </button>
            {replacing && (
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => setReplacing(false)}>
                Keep the current file
              </button>
            )}
          </div>
        </section>
      )}

      {job && active && (
        <section className="init-panel imp-card">
          <p className="eyebrow-sm">Checking the file…</p>
          <ImportProgress job={job} speed={0} eta={null} />
        </section>
      )}

      {checked && counts && job && (
        <section className="init-panel imp-card">
          <div className="imp-card-head">
            <p className="eyebrow-sm">Review · {job.filename}</p>
            <button type="button" className="imp-link-btn" onClick={() => setReplacing(true)}>
              Upload a different file
            </button>
          </div>
          <h2 className="imp-report-headline">
            {importable > 0
              ? `${importable} rows will be imported when the move is created`
              : 'Nothing in this file will be imported'}
          </h2>
          <ImportReport job={job} fixedTexts={fixedTexts} onFix={setFixTarget}
                        canAddModels={can('asset_models', 'add')}
                        canChangeModels={can('asset_models', 'change')}
                        readyLabel="Ready — check again to apply" pagingOnlyWhenNeeded />
          <div className="imp-card-foot">
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => void run(() => recheckMoveSetupAssets(draft.id))}>
              {busy ? 'Checking…' : 'Check again'}
            </button>
            {counts.review + counts.error > 0 && (
              <span className="page-hint">
                Rows that need review or have errors are not imported. Fix a make/model, then check again.
              </span>
            )}
          </div>
        </section>
      )}

      <WizardFooter onBack={onBack} onSkip={skip} onNext={onNext} nextDisabled={!checked}
                    busy={busy || skipping} error={error}
                    note={job === null ? 'Upload a From-To file, or skip this step.' : undefined} />

      {fixTarget && (
        <FixMakeModelDialog text={fixTarget.text} make={fixTarget.make} model={fixTarget.model}
                            onClose={() => setFixTarget(null)}
                            onFixed={(text) => {
                              setFixedTexts((s) => new Set(s).add(text.toLowerCase()));
                              setFixTarget(null);
                            }} />
      )}
    </>
  );
}
