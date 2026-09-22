/**
 * BulkUpload — the upload → preview → apply pane for Bulk Actions tools
 * with per-row update-or-skip (workers, trucks). Pick a csv/xlsx file,
 * Preview renders per-row results, matched rows are skipped unless their
 * Update box is ticked, and Apply posts the uploaded cells plus the
 * approved record ids. Everything entity-specific comes in through config.
 */

import { useRef, useState } from 'react';

import { ApiError } from '../../lib/api';
import BulkApplySummary, { type BulkDiff, type BulkSummaryResult, type BulkSummaryRow } from './BulkApplySummary';
import DataTable from '../DataTable';

export interface BulkPreviewRow {
  row: number;
  name: string | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  matched_by: string | null;
  matched_name: string | null;
  errors: string[];
  diff: BulkDiff | null;
  /** The uploaded cells, no defaults — what the commit replays. */
  cells: Record<string, string>;
  data: Record<string, unknown> | null;
}

export interface BulkPreviewResult<P extends BulkPreviewRow> {
  rows: P[];
  can_commit: boolean;
}

export interface BulkUploadConfig<P extends BulkPreviewRow, R extends BulkSummaryRow> {
  /** File input id becomes `${idPrefix}-bulk-file`. */
  idPrefix: string;
  /** Singular noun for button copy ("worker" → "Add 2 workers"). */
  noun: string;
  /** Matched-by cell for rows with no match ("new worker"). */
  newLabel: string;
  errors: Record<string, string>;
  preview(file: File, filename: string): Promise<BulkPreviewResult<P>>;
  commit(rows: Record<string, unknown>[], approved: string[], source: string): Promise<BulkSummaryResult<R>>;
  /** The existing record's id on a matched preview row. */
  idOf(row: P): string | null;
  summary: {
    entityLabel: string;
    linkFor: (row: R) => string;
    filename: string;
    openTo: string;
    openLabel: string;
  };
}

const ACTION_LABEL: Record<BulkPreviewRow['action'], string> = {
  create: 'Add',
  update: 'Update',
  unchanged: 'No change',
  error: 'Error',
};

/** One line per changed field; list fields (add/remove) render as +name / −name. */
export function describeDiff(diff: BulkDiff): { field: string; from: string; to: string }[] {
  return Object.entries(diff).map(([field, change]) => {
    if (change.add !== undefined || change.remove !== undefined) {
      const add = (change.add ?? []).map((n) => `+${n}`);
      const remove = (change.remove ?? []).map((n) => `−${n}`);
      return { field, from: '', to: [...add, ...remove].join(', ') };
    }
    return {
      field,
      from: change.old === null || change.old === undefined ? '—' : String(change.old),
      to: String(change.new),
    };
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Props<P extends BulkPreviewRow, R extends BulkSummaryRow> {
  config: BulkUploadConfig<P, R>;
  onDone?(result: BulkSummaryResult<R>): void;
}

export default function BulkUpload<P extends BulkPreviewRow, R extends BulkSummaryRow>({ config, onDone }: Props<P, R>) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BulkPreviewResult<P> | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BulkSummaryResult<R> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (config.errors[err.code] ?? 'Import failed — try again.')
      : 'Network error.';

  const runPreview = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await config.preview(file, file.name));
      setApproved(new Set());          // every matched row starts as a skip
    } catch (err) {
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = preview?.rows ?? [];
  const idOf = config.idOf;
  const adds = rows.filter((r) => r.action === 'create').length;
  const matched = rows.filter((r) => r.action === 'update');
  const updating = matched.filter((r) => { const id = idOf(r); return id !== null && approved.has(id); }).length;
  const skipping = matched.length - updating;
  const unchanged = rows.filter((r) => r.action === 'unchanged').length;
  const errors = rows.filter((r) => r.action === 'error').length;
  const canApply = !!preview && preview.can_commit && (adds > 0 || updating > 0);

  const runImport = async () => {
    if (!preview || !file) return;
    setBusy(true);
    setError('');
    try {
      // the ORIGINAL cells, never the preview's normalized `data` — replaying
      // `data` would write its create-only defaults onto existing records
      const posted = preview.rows.filter((r) => r.action !== 'error');
      const counts = await config.commit(posted.map((r) => r.cells), [...approved], file.name);
      // The commit numbers rows from 1 (JSON path); the preview numbered the
      // spreadsheet lines from 2. Relabel so the summary ties back to the file.
      const applied = {
        ...counts,
        rows: counts.rows.map((r, i) => ({ ...r, row: posted[i]?.row ?? r.row })),
      };
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setResult(applied);
      onDone?.(applied);
    } catch (err) {
      setError(mapError(err));
      setPreview(null);   // stale after a failed commit — force re-preview
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const inputId = `${config.idPrefix}-bulk-file`;

  return (
    <div className="bulk-import">
      <div className="bulk-file-row">
        <label htmlFor={inputId}>Upload a file (.csv or .xlsx)</label>
        <input
          id={inputId}
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
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
                onClick={() => void runImport()}>
          {`Add ${plural(adds, config.noun)} and update ${plural(updating, config.noun)}`}
        </button>
        {matched.length > 0 && (
          <>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set(matched.map((r) => idOf(r) as string)))}>
              Update all
            </button>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set())}>
              Skip all
            </button>
          </>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {result && (
        <BulkApplySummary
          result={result}
          entityLabel={config.summary.entityLabel}
          linkFor={config.summary.linkFor}
          filename={config.summary.filename}
          openTo={config.summary.openTo}
          openLabel={config.summary.openLabel}
        />
      )}

      {preview && (
        <>
          <p className="set-note">
            {`${adds} to add · ${updating} to update · ${skipping} to skip · ${unchanged} unchanged · ${plural(errors, 'error')}`}
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
            rows={preview.rows.map((r) => {
              const id = idOf(r);
              const willUpdate = id !== null && approved.has(id);
              return {
                key: String(r.row),
                className: `bulk-row-${r.action === 'update' && !willUpdate ? 'skipped' : r.action}`,
                cells: [
                  r.row,
                  r.name ?? '—',
                  r.matched_by ?? config.newLabel,
                  r.action === 'update' ? (willUpdate ? 'Update' : 'Skip') : ACTION_LABEL[r.action],
                  <>
                    {r.action === 'error' && r.errors.map((e) => (
                      <span key={e} className="pf-error">{e}</span>
                    ))}
                    {r.action === 'update' && r.diff && (
                      <div className="bulk-diff">
                        {describeDiff(r.diff).map((d) => (
                          <span key={d.field}>{d.field}: {d.from ? `${d.from} → ` : ''}{d.to}</span>
                        ))}
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`Update ${r.name}`}
                            checked={willUpdate}
                            disabled={busy}
                            onChange={() => id && toggle(id)}
                          />
                          {' '}Update
                        </label>
                      </div>
                    )}
                  </>,
                ],
              };
            })}
          />
        </>
      )}
    </div>
  );
}
