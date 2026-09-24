/**
 * AssetBulkUpload — the upload → preview → apply pane of "Update assets in
 * bulk", laid out exactly like the shared BulkUpload pane (file row,
 * Preview / apply / Update all / Skip all, summary line, a Row / Name /
 * Matched by / Action / Details preview). Preview uploads the file once and
 * keeps the job it creates; every pick or skip re-previews that job with
 * `{overrides, skip}` only (the rows stay on the server). Updates apply only
 * where Update is checked, or all of them after Update all. The preview
 * lists 200 lines at a time. Apply queues the job and polls it every 1.5 s
 * for progress, then shows the server's per-row summary.
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, cancelAssetBulk, commitAssetBulk, getAssetBulkJob, previewAssetBulk, uploadAssetBulk,
  type AssetBulkAction, type AssetBulkJob, type AssetBulkListing, type AssetBulkOverrides,
  type AssetBulkResultRow, type AssetBulkRow,
} from '../../lib/api';
import { assetBulkError, assetBulkFailure, placementNote } from '../../lib/assetBulk';
import BulkApplySummary, { type BulkSummaryResult } from '../bulk/BulkApplySummary';
import DataTable from '../DataTable';
import AssetBulkRowDetails, {
  FIELD_LOADERS, type AssetField, type AssetFieldFailed, type AssetFieldOptions, type AssetListField,
} from './AssetBulkRowDetails';

const PAGE = 200;
const POLL_MS = 1500;

const ACTION_LABEL: Record<AssetBulkAction, string> = {
  update: 'Update', unchanged: 'No change', attention: 'Needs a match', error: 'Error', skipped: 'Skipped',
};

/** bulk.css tints the Action column by these (an attention row blocks Apply, so it reads as an error). */
const ROW_CLASS: Record<AssetBulkAction, string> = {
  update: 'update', unchanged: 'unchanged', attention: 'error', error: 'error', skipped: 'skipped',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
const toggled = (s: Set<number>, n: number) => {
  const next = new Set(s);
  if (next.has(n)) next.delete(n);
  else next.add(n);
  return next;
};
const num = (n: number) => n.toLocaleString('en-US');
const discard = (jobId: string | null) => { if (jobId) cancelAssetBulk(jobId).catch(() => undefined); };

export default function AssetBulkUpload() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [preview, setPreview] = useState<AssetBulkListing | null>(null);
  const [overrides, setOverrides] = useState<AssetBulkOverrides>({});
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [approveAll, setApproveAll] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [applying, setApplying] = useState<AssetBulkJob | null>(null);
  const [result, setResult] = useState<BulkSummaryResult<AssetBulkResultRow> | null>(null);
  const [resultNote, setResultNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [options, setOptions] = useState<AssetFieldOptions>({});
  const [failed, setFailed] = useState<AssetFieldFailed>({});
  const loading = useRef(new Set<AssetListField>());
  const seq = useRef(0);

  /** Forget the job and everything picked against it (state setters only). */
  const clearJob = () => {
    setJobId(null);
    setPreview(null);
    setOverrides({});
    setSkip(new Set());
    setApproved(new Set());
    setApproveAll(false);
    setShown(PAGE);
  };

  // The full model / client / site / status lists back the dropdowns of
  // UNKNOWN values only — fetched once per field, the first time one shows
  // up. A failed load clears the field's flag, so reopening its dropdown
  // retries (candidates still work meanwhile; the full list is a convenience).
  const loadField = (field: AssetListField) => {
    if (loading.current.has(field)) return;
    loading.current.add(field);
    setFailed((prev) => ({ ...prev, [field]: false }));
    FIELD_LOADERS[field]()
      .then((list) => setOptions((prev) => ({ ...prev, [field]: list })))
      .catch(() => {
        loading.current.delete(field);
        setFailed((prev) => ({ ...prev, [field]: true }));
      });
  };

  useEffect(() => {
    for (const r of preview?.rows ?? []) {
      for (const issue of r.issues) {
        if (issue.kind === 'unknown' && issue.field !== 'asset') loadField(issue.field);
      }
    }
  }, [preview]);   // loadField only touches a ref and state setters

  // Poll the applying job; one request at a time, stopped on unmount. A
  // network blip keeps polling; an API error (the job is gone) stops it.
  const applyingId = applying?.id ?? null;
  useEffect(() => {
    if (!applyingId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await getAssetBulkJob(applyingId);
        if (stopped) return;
        if (next.status === 'queued' || next.status === 'running') setApplying(next);
        else return settle(next);
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError) return settle(null, assetBulkError(err));
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [applyingId]);   // settle only uses state setters and refs

  /** A finished job: the summary on success, otherwise the reason — either way the preview is spent. */
  const settle = (job: AssetBulkJob | null, message?: string) => {
    setApplying(null);
    clearJob();
    if (job?.status === 'completed' && job.error === null && job.results) {
      const { summary, rows } = job.results;
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setResult({ updated: summary.updated, skipped: summary.skipped, unchanged: summary.unchanged, rows });
      setResultNote(placementNote(summary.placement));
    } else {
      setError(message ?? assetBulkFailure(job));
    }
  };

  const accept = (next: AssetBulkListing) => {
    setPreview(next);
    const updates = new Set(next.rows.filter((r) => r.action === 'update').map((r) => r.row));
    setApproved((prev) => new Set([...prev].filter((n) => updates.has(n))));
  };

  const runPreview = async () => {
    if (!file) return;
    const mine = ++seq.current;
    discard(jobId);
    clearJob();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const up = await uploadAssetBulk(file, file.name);
      if (mine !== seq.current) return discard(up.job_id);
      setJobId(up.job_id);
      setPreview(up.preview);          // every update starts unapproved
    } catch (err) {
      if (mine !== seq.current) return;
      setError(assetBulkError(err));
    } finally {
      setBusy(false);
    }
  };

  /** Re-preview the job with the accumulated picks and skips; a newer request wins. */
  const rerun = async (nextOverrides: AssetBulkOverrides, nextSkip: Set<number>) => {
    if (!jobId) return;
    setOverrides(nextOverrides);
    setSkip(nextSkip);
    const mine = ++seq.current;
    setPending((p) => p + 1);
    setError('');
    try {
      const next = await previewAssetBulk(jobId, { overrides: nextOverrides, skip: sorted(nextSkip) });
      if (mine === seq.current) accept(next);
    } catch (err) {
      if (mine === seq.current) {
        setPreview(null);
        setError(assetBulkError(err));
      }
    } finally {
      setPending((p) => p - 1);
    }
  };

  const rows = preview?.rows ?? [];
  const count = (a: AssetBulkAction) => preview?.counts[a] ?? 0;
  const updates = rows.filter((r) => r.action === 'update');
  const unmatched = rows.filter((r) => r.action === 'attention' || r.action === 'error');
  const isApproved = (r: AssetBulkRow) => r.action === 'update' && (approveAll || approved.has(r.row));
  const updating = updates.filter(isApproved).length;
  const skipping = count('update') - updating + count('skipped');
  const attention = count('attention');
  const locked = busy || applying !== null;
  const canApply = !!preview && preview.can_commit && pending === 0 && !locked && updating > 0;

  const pick = (n: number, field: AssetField, id: string) =>
    void rerun({ ...overrides, [n]: { ...overrides[n], [field]: id } }, skip);
  const clearPicks = (n: number) => {
    const next = { ...overrides };
    delete next[n];
    void rerun(next, skip);
  };
  const toggleSkip = (n: number) => void rerun(overrides, toggled(skip, n));
  const skipUnmatched = () => void rerun(overrides, new Set([...skip, ...unmatched.map((r) => r.row)]));
  const setAll = (all: boolean) => {
    setApproveAll(all);
    setApproved(new Set());
  };
  /** Under Update all, unchecking one line approves every other update explicitly. */
  const toggleApprove = (n: number) => {
    if (approveAll) {
      setApproveAll(false);
      setApproved(new Set(updates.map((r) => r.row).filter((m) => m !== n)));
      return;
    }
    setApproved((prev) => toggled(prev, n));
  };

  const runApply = async () => {
    if (!preview || !jobId) return;
    setBusy(true);
    setError('');
    try {
      setApplying(await commitAssetBulk(jobId, {
        overrides, skip: sorted(skip), approved_updates: approveAll ? [] : sorted(approved),
        approve_all: approveAll,
      }));
    } catch (err) {
      setError(assetBulkError(err));
      discard(jobId);
      clearJob();         // stale after a failed commit — force a fresh upload
    } finally {
      setBusy(false);
    }
  };

  const actionLabel = (r: AssetBulkRow) =>
    r.action === 'update' ? (isApproved(r) ? 'Update' : 'Skip') : ACTION_LABEL[r.action];
  const rowClass = (r: AssetBulkRow) =>
    `bulk-row-${r.action === 'update' && !isApproved(r) ? 'skipped' : ROW_CLASS[r.action]}`;

  const inputId = 'asset-bulk-file';

  return (
    <div className="bulk-import">
      <div className="bulk-file-row">
        <label htmlFor={inputId}>Upload a file (.csv or .xlsx)</label>
        <input
          id={inputId}
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={locked || pending > 0}
          onChange={(e) => {
            seq.current += 1;          // an in-flight preview of the old file is now stale
            discard(jobId);
            clearJob();
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
            setError('');
          }}
        />
      </div>

      <div className="bulk-actions">
        <button className="btn-solid" type="button" disabled={locked || !file}
                onClick={() => void runPreview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button className="btn-solid" type="button" disabled={!canApply}
                onClick={() => void runApply()}>
          {`Update ${plural(updating, 'asset')}`}
        </button>
        {updates.length > 0 && (
          <>
            <button className="mini-btn" type="button" disabled={locked} onClick={() => setAll(true)}>
              Update all
            </button>
            <button className="mini-btn" type="button" disabled={locked} onClick={() => setAll(false)}>
              Skip all
            </button>
          </>
        )}
        {unmatched.length > 0 && (
          <button className="mini-btn" type="button" disabled={locked} onClick={skipUnmatched}>
            Skip all unmatched
          </button>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {applying && (
        <p className="set-note">{`Applying… ${num(applying.processed_rows)} of ${num(applying.total_rows)}`}</p>
      )}

      {result && (
        <BulkApplySummary
          result={result}
          entityLabel="Asset"
          linkFor={(r) => (r.asset_id ? `/assets/${r.asset_id}` : '/assets')}
          filename="assets-bulk-summary"
          openTo="/assets"
          openLabel="Open Assets"
          pageSize={PAGE}
          extraColumn={{ label: 'Asset ID', mono: true,
                         value: (r) => (r.asset_number === null ? '' : String(r.asset_number)) }}
          note={resultNote ?? undefined}
        />
      )}

      {preview && (
        <>
          <p className="set-note">
            {`${updating} to update · ${skipping} to skip · ${count('unchanged')} unchanged · `
              + `${attention} ${attention === 1 ? 'needs' : 'need'} a match · ${plural(count('error'), 'error')}`}
          </p>
          <DataTable
            ariaLabel="Import preview"
            className="bulk-preview"
            columns={[
              { key: 'row', label: 'Row', width: '64px', mono: true },
              { key: 'name', label: 'Name' },
              { key: 'matched_by', label: 'Matched by' },
              { key: 'action', label: 'Action' },
              { key: 'details', label: 'Details' },
            ]}
            rows={rows.slice(0, shown).map((r) => ({
              key: String(r.row),
              className: rowClass(r),
              cells: [
                r.row,
                <>
                  {r.name ?? '—'}
                  {r.asset_number !== null && <div className="mono">Asset {r.asset_number}</div>}
                </>,
                r.matched_by ?? '—',
                actionLabel(r),
                <AssetBulkRowDetails
                  key="details"
                  row={r}
                  options={options}
                  failed={failed}
                  picked={overrides[r.row] ?? {}}
                  skipped={skip.has(r.row)}
                  approved={isApproved(r)}
                  disabled={locked}
                  onPick={(field, id) => pick(r.row, field, id)}
                  onOpenField={loadField}
                  onClearPicks={() => clearPicks(r.row)}
                  onToggleSkip={() => toggleSkip(r.row)}
                  onToggleApprove={() => toggleApprove(r.row)}
                />,
              ],
            }))}
          />
          {rows.length > shown && (
            <div className="bulk-actions">
              <button className="mini-btn" type="button" onClick={() => setShown((s) => s + PAGE)}>
                {`Show ${Math.min(PAGE, rows.length - shown)} more`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
