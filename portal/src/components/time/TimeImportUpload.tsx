/**
 * TimeImportUpload — the upload → preview → apply pane of "Add time punches
 * in bulk", laid out exactly like TeamBulkUpload:
 *   - the file row;
 *   - Preview, "Add N shifts" and "Skip all unmatched";
 *   - the summary line;
 *   - a Row / Name / Matched by / Action / Details preview with bulk-row-* tints.
 * Preview parses the file once, and its cells and spreadsheet row numbers
 * become the base that every later JSON re-preview and the commit post.
 * Unknown or ambiguous workers, jobs and sites are matched per line
 * (overrides), lines can be skipped, and Apply shows the server's per-row
 * summary. The API lists problem rows first; the table shows 200 at a time.
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, commitTimeImport, listInitiatives, listSites, listWorkerOptions,
  previewTimeImport, previewTimeImportFile,
  type TimeImportAction, type TimeImportCommitResult, type TimeImportField,
  type TimeImportOverrides, type TimeImportPreview,
} from '../../lib/api';
import { jobOptionDetail } from '../../lib/teamBulk';
import { TIME_IMPORT_ERRORS } from '../../lib/timeImport';
import BulkApplySummary from '../bulk/BulkApplySummary';
import type { ComboOption } from '../ComboBox';
import DataTable from '../DataTable';
import TimeImportRowDetails, { type TimeFieldFailed, type TimeFieldOptions } from './TimeImportRowDetails';

const PAGE = 200;

const ACTION_LABEL: Record<TimeImportAction, string> = {
  add: 'Add', duplicate: 'Already there', attention: 'Needs a match', error: 'Error', skipped: 'Skipped',
};

/** bulk.css tints the Action column by these (an attention row blocks Add, so it reads as an error). */
const ROW_CLASS: Record<TimeImportAction, string> = {
  add: 'create', duplicate: 'unchanged', attention: 'error', error: 'error', skipped: 'skipped',
};

const LOADERS: Record<TimeImportField, () => Promise<ComboOption[]>> = {
  worker: async () => (await listWorkerOptions())
    .map((w) => ({ value: w.person_id, label: w.display_name })),
  job: async () => (await listInitiatives()).filter((j) => !j.archived_at)
    .map((j) => ({ value: j.id, label: j.name, sub: jobOptionDetail(j) || null })),
  site: async () => (await listSites()).filter((s) => !s.archived_at)
    .map((s) => ({ value: s.id, label: s.name })),
};

const num = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${num(n)} ${n === 1 ? word : `${word}s`}`;
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

/** Uploaded cell, then "→ matched" when the match reads differently. */
function matched(cell: string | undefined, name: string | null) {
  const text = cell?.trim() || '—';
  return name && name !== cell ? <>{text} → <b>{name}</b></> : text;
}

interface Base { cells: Record<string, string>[]; rows: number[] }

export default function TimeImportUpload() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [preview, setPreview] = useState<TimeImportPreview | null>(null);
  const [overrides, setOverrides] = useState<TimeImportOverrides>({});
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<TimeImportCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [options, setOptions] = useState<TimeFieldOptions>({});
  const [failed, setFailed] = useState<TimeFieldFailed>({});
  const loading = useRef(new Set<TimeImportField>());
  const seq = useRef(0);

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (TIME_IMPORT_ERRORS[err.code] ?? 'That did not work. Try again.')
      : 'Network error.';

  // The full worker / job / site lists back the dropdowns of UNKNOWN values
  // only, fetched once per field the first time one shows up. A failed load
  // clears the field's flag, so reopening its dropdown retries.
  const loadField = (field: TimeImportField) => {
    if (loading.current.has(field)) return;
    loading.current.add(field);
    setFailed((prev) => ({ ...prev, [field]: false }));
    LOADERS[field]()
      .then((list) => setOptions((prev) => ({ ...prev, [field]: list })))
      .catch(() => {
        loading.current.delete(field);
        setFailed((prev) => ({ ...prev, [field]: true }));
      });
  };

  useEffect(() => {
    for (const r of preview?.rows ?? []) {
      for (const issue of r.issues) {
        if (issue.kind === 'unknown') loadField(issue.field);
      }
    }
  }, [preview]);   // loadField only touches a ref and state setters

  const resetPicks = () => {
    setOverrides({});
    setSkip(new Set());
    setShown(PAGE);
  };

  const runPreview = async () => {
    if (!file) return;
    const mine = ++seq.current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const next = await previewTimeImportFile(file, file.name);
      if (mine !== seq.current) return;
      setBase({ cells: next.rows.map((r) => r.cells), rows: next.rows.map((r) => r.row) });
      resetPicks();
      setPreview(next);
    } catch (err) {
      if (mine !== seq.current) return;
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  /** JSON re-preview with the accumulated picks and skips; a newer request wins. */
  const rerun = async (nextOverrides: TimeImportOverrides, nextSkip: Set<number>) => {
    if (!base) return;
    setOverrides(nextOverrides);
    setSkip(nextSkip);
    const mine = ++seq.current;
    setPending((p) => p + 1);
    setError('');
    try {
      const next = await previewTimeImport({
        rows: base.cells, row_numbers: base.rows, overrides: nextOverrides, skip: sorted(nextSkip),
      });
      if (mine === seq.current) setPreview(next);
    } catch (err) {
      if (mine === seq.current) {
        setPreview(null);
        setError(mapError(err));
      }
    } finally {
      setPending((p) => p - 1);
    }
  };

  const pick = (n: number, field: TimeImportField, id: string) =>
    void rerun({ ...overrides, [n]: { ...overrides[n], [field]: id } }, skip);
  const clearPicks = (n: number) => {
    const next = { ...overrides };
    delete next[n];
    void rerun(next, skip);
  };
  const toggleSkip = (n: number) => {
    const next = new Set(skip);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    void rerun(overrides, next);
  };

  const rows = preview?.rows ?? [];
  const count = (a: TimeImportAction) => preview?.counts[a] ?? 0;
  const unmatched = rows.filter((r) => r.action === 'attention' || r.action === 'error');
  const skipUnmatched = () => void rerun(overrides, new Set([...skip, ...unmatched.map((r) => r.row)]));
  const adds = count('add');
  const attention = count('attention');
  const canApply = !!preview && preview.can_commit && pending === 0 && adds > 0;

  const runApply = async () => {
    if (!preview || !base || !file) return;
    setBusy(true);
    setError('');
    try {
      const applied = await commitTimeImport({
        rows: base.cells, row_numbers: base.rows, overrides, skip: sorted(skip), source: file.name,
      });
      setPreview(null);
      setBase(null);
      setFile(null);
      resetPicks();
      if (fileRef.current) fileRef.current.value = '';
      setResult(applied);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'rows_invalid') {
        // Re-preview with the same picks and skips, so the row that now
        // fails (a shift punched since the preview, say) shows in place.
        void rerun(overrides, skip);
      } else if (code !== 'busy') {
        setPreview(null);   // stale after a refused commit: force a fresh preview
      }
      // busy: nothing was written and the preview still holds; Add again.
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const inputId = 'time-bulk-file';

  return (
    <div className="bulk-import">
      <div className="bulk-file-row">
        <label htmlFor={inputId}>Upload a file (.csv or .xlsx)</label>
        <input
          id={inputId}
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy || pending > 0}
          onChange={(e) => {
            seq.current += 1;          // an in-flight preview of the old file is now stale
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setBase(null);
            resetPicks();
            setResult(null);
            setError('');
          }}
        />
      </div>

      <div className="bulk-actions">
        <button className="btn-solid" type="button" disabled={busy || !file}
                onClick={() => void runPreview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button className="btn-solid" type="button" disabled={busy || !canApply}
                onClick={() => void runApply()}>
          {`Add ${plural(adds, 'shift')}`}
        </button>
        {unmatched.length > 0 && (
          <button className="mini-btn" type="button" disabled={busy} onClick={skipUnmatched}>
            Skip all unmatched
          </button>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {result && (
        <BulkApplySummary
          result={{
            created: result.summary.added, skipped: result.summary.skipped,
            rows: result.rows.map((r) => ({ ...r, diff: null })),
          }}
          entityLabel="Worker"
          linkFor={() => null}
          filename="time-bulk-summary"
          openTo="/people/time"
          openLabel="Open Time Management"
          pageSize={PAGE}
          extraColumn={{ label: 'Shift', value: (r) => r.detail ?? '' }}
        />
      )}

      {preview && (
        <>
          <p className="set-note">
            {`${num(adds)} to add · ${num(count('duplicate'))} already there · ${num(count('skipped'))} to skip · `
              + `${num(attention)} ${attention === 1 ? 'needs' : 'need'} a match · ${plural(count('error'), 'error')}`}
          </p>
          <DataTable
            ariaLabel="Time preview"
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
              className: `bulk-row-${ROW_CLASS[r.action]}`,
              cells: [
                r.row,
                matched(r.cells.worker, r.person_name),
                r.matched_by ?? '—',
                ACTION_LABEL[r.action],
                <TimeImportRowDetails
                  key="details"
                  row={r}
                  options={options}
                  failed={failed}
                  picked={overrides[r.row] ?? {}}
                  skipped={skip.has(r.row)}
                  disabled={busy}
                  onPick={(field, id) => pick(r.row, field, id)}
                  onOpenField={loadField}
                  onClearPicks={() => clearPicks(r.row)}
                  onToggleSkip={() => toggleSkip(r.row)}
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
