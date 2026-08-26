/** Move-assets bulk import: upload -> validate report -> commit -> results.
 *  All state renders from the polled import job, so a refresh mid-import
 *  loses nothing. The heavy lifting happens in the separate API worker. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  cancelImportJob, commitImportJob, createMoveAssetImportJob,
  downloadMoveAssetTemplate, getImportJob, getInitiative,
  type ImportJobOut, type InitiativeDetail,
} from '../lib/api';
import {
  countDetails, etaSeconds, IMPORT_ERRORS, importErrorMessage, jobIsActive,
  jobProgressPct, rowsPerSecond, type SpeedSample,
} from '../lib/moveAssetImport';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';
import '../styles/sites.css';

const POLL_MS = 2000;
const PAGE_SIZE = 500;

/** make/model mode descriptions — verbatim from the template's Reference
 *  sheet (api/src/serversherpa/imports/parsing.py's build_template_xlsx). */
const MODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'fuzzy', label: 'fuzzy — match catalog + aliases; unmatched rows need review' },
  { value: 'force', label: 'force — always create missing make/models' },
  { value: 'hybrid', label: 'hybrid — match first, create when unmatched' },
];

/** row-status -> chip class, shared by the summary chips and the details
 *  table (SiteBulkImport.tsx's report-table idiom: a span with a class). */
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

export default function ImportMoveAssets() {
  const { id } = useParams<{ id: string }>();
  const [initiative, setInitiative] = useState<InitiativeDetail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState('fuzzy');
  const [generateSerials, setGenerateSerials] = useState(false);
  const [job, setJob] = useState<ImportJobOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const samplesRef = useRef<SpeedSample[]>([]);
  const [speed, setSpeed] = useState(0);

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

  const isMove = !initiative || initiative.initiative_type === 'move';
  const active = job !== null && jobIsActive(job);
  const eta = job && active ? etaSeconds(job, speed) : null;

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
          {error && <p className="pf-error" style={{ marginTop: 16 }}>{error}</p>}

          {!active && (
            <div className="init-panel" style={{ marginTop: 16 }}>
              <p className="eyebrow-sm">Upload</p>

              <div className="bulk-templates">
                <span className="page-hint" style={{ margin: 0 }}>
                  Start from a template:
                </span>
                <button className="mini-btn" type="button" disabled={busy}
                        onClick={() => void downloadMoveAssetTemplate('xlsx')}>
                  Template (.xlsx)
                </button>
                <button className="mini-btn" type="button" disabled={busy}
                        onClick={() => void downloadMoveAssetTemplate('csv')}>
                  Template (.csv)
                </button>
              </div>

              <div className="bulk-file-row" style={{ marginTop: 14 }}>
                <label>File (.csv, .xlsx, .xls)</label>
                <input type="file" accept=".csv,.xlsx,.xls" disabled={busy}
                       onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>

              <div className="init-field" style={{ marginTop: 14, flex: '1 1 100%' }}>
                <label>Make/model mode</label>
                <div className="init-checks">
                  {MODE_OPTIONS.map((opt) => (
                    <label key={opt.value} className="init-check">
                      <input type="radio" name="make-model-mode" value={opt.value}
                             checked={mode === opt.value} disabled={busy}
                             onChange={() => setMode(opt.value)} />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="init-checks" style={{ marginTop: 12 }}>
                <label className="init-check">
                  <input type="checkbox" checked={generateSerials} disabled={busy}
                         onChange={(e) => setGenerateSerials(e.target.checked)} />
                  Generate serial numbers for blank rows
                </label>
              </div>

              <div className="bulk-actions" style={{ marginTop: 14 }}>
                <button className="btn-solid" type="button"
                        disabled={busy || !file}
                        onClick={() => {
                          if (!id || !file) return;
                          void run(() => createMoveAssetImportJob(
                            id, file, { makeModelMode: mode, generateSerials }));
                        }}>
                  {busy ? 'Working…' : 'Validate'}
                </button>
              </div>
            </div>
          )}

          {job && active && (
            <div className="init-panel" style={{ marginTop: 16 }}>
              <p className="eyebrow-sm">
                {job.phase === 'commit' ? 'Importing…' : 'Validating…'}
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

              <p className="page-hint">
                {job.processed_rows} of {job.total_rows} rows
                {' — '}{Math.round(speed)} rows/s
                {eta !== null && eta > 0 && ` — about ${eta}s remaining`}
              </p>

              <div className="bulk-actions">
                <button className="mini-btn danger" type="button" disabled={busy}
                        onClick={() => void run(() => cancelImportJob(job.id))}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {job && !active && (
            <div className="init-panel" style={{ marginTop: 16 }}>
              <p className="eyebrow-sm">Results</p>

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

                return (
                  <>
                    <div className="chips">
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

                    <table className="bulk-preview" style={{ marginTop: 14 }}>
                      <thead>
                        <tr><th>Row</th><th>Serial</th><th>Status</th><th>Message</th></tr>
                      </thead>
                      <tbody>
                        {pageRows.map((d) => (
                          <tr key={d.row}>
                            <td>{d.row}</td>
                            <td>{d.serial_number || '—'}</td>
                            <td>
                              <span className={`chip ${STATUS_CHIP[d.status] ?? 'c-slate'}`}>
                                <span className="dot" />{d.status}
                              </span>
                            </td>
                            <td>{d.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <div className="bulk-actions" style={{ marginTop: 10 }}>
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
                      <span className="page-hint" style={{ margin: 0 }}>
                        showing {total === 0 ? 0 : start + 1}–{end} of {total}
                      </span>
                    </div>

                    {job.phase === 'validate' && (
                      <div className="bulk-actions" style={{ marginTop: 14 }}>
                        <button className="btn-solid" type="button"
                                disabled={busy || committable === 0}
                                onClick={() => void run(() => commitImportJob(job.id))}>
                          Import {committable} rows
                        </button>
                        {skippable > 0 && (
                          <span className="page-hint" style={{ margin: 0 }}>
                            review and error rows will be skipped
                          </span>
                        )}
                      </div>
                    )}

                    {job.phase === 'commit' && (
                      <div className="bulk-actions" style={{ marginTop: 14 }}>
                        <Link className="mini-btn" to={id ? `/initiatives/${id}` : '/initiatives'}>
                          Back to move
                        </Link>
                        <button className="btn-solid" type="button"
                                onClick={() => {
                                  setJob(null);
                                  setFile(null);
                                  setPage(0);
                                  setError(null);
                                }}>
                          Import another file
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
