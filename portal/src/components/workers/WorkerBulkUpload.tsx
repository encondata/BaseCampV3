/**
 * WorkerBulkUpload — the /bulk/workers page's upload pane. Pick a csv/xlsx
 * file, Preview renders per-row results (add / update / no change / error,
 * and which keys matched an existing person), matched rows are skipped
 * unless their Update box is ticked, and Apply posts the uploaded cells
 * plus the approved person ids.
 */

import { useRef, useState } from 'react';

import {
  ApiError,
  commitWorkerBulk,
  previewWorkerBulk,
  type WorkerBulkCommitResult,
  type WorkerBulkPreview,
  type WorkerBulkRowResult,
} from '../../lib/api';
import { WORKER_BULK_ERRORS } from '../../lib/workerBulk';
import BulkApplySummary from '../bulk/BulkApplySummary';
import DataTable from '../DataTable';

interface Props {
  onDone(result: WorkerBulkCommitResult): void;
}

const ACTION_LABEL: Record<WorkerBulkRowResult['action'], string> = {
  create: 'Add',
  update: 'Update',
  unchanged: 'No change',
  error: 'Error',
};

function describeDiff(
  diff: NonNullable<WorkerBulkRowResult['diff']>,
): { field: string; from: string; to: string }[] {
  return Object.entries(diff).map(([field, change]) => ({
    field,
    from: change.old === null || change.old === undefined ? '—' : String(change.old),
    to: String(change.new),
  }));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function WorkerBulkUpload({ onDone }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WorkerBulkPreview | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<WorkerBulkCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (WORKER_BULK_ERRORS[err.code] ?? 'Import failed — try again.')
      : 'Network error.';

  const runPreview = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await previewWorkerBulk(file, file.name));
      setApproved(new Set());          // every matched row starts as a skip
    } catch (err) {
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = preview?.rows ?? [];
  const adds = rows.filter((r) => r.action === 'create').length;
  const matched = rows.filter((r) => r.action === 'update');
  const updating = matched.filter((r) => r.person_id !== null && approved.has(r.person_id)).length;
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
      // `data` would write its create-only status/country defaults
      const posted = preview.rows.filter((r) => r.action !== 'error');
      const counts = await commitWorkerBulk(posted.map((r) => r.cells), [...approved], file.name);
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
      onDone(applied);
    } catch (err) {
      setError(mapError(err));
      setPreview(null);   // stale after a failed commit — force re-preview
    } finally {
      setBusy(false);
    }
  };

  const toggle = (personId: string) =>
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });

  return (
    <div className="bulk-import">
      <div className="bulk-file-row">
        <label htmlFor="worker-bulk-file">Upload a file (.csv or .xlsx)</label>
        <input
          id="worker-bulk-file"
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
          {`Add ${plural(adds, 'worker')} and update ${plural(updating, 'worker')}`}
        </button>
        {matched.length > 0 && (
          <>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set(matched.map((r) => r.person_id as string)))}>
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
          entityLabel="Worker"
          linkFor={(r) => `/people/workers/${r.person_id}`}
          filename="workers-bulk-summary"
          openTo="/people/workers"
          openLabel="Open Workers"
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
              const willUpdate = r.person_id !== null && approved.has(r.person_id);
              return {
                key: String(r.row),
                className: `bulk-row-${r.action === 'update' && !willUpdate ? 'skipped' : r.action}`,
                cells: [
                  r.row,
                  r.name ?? '—',
                  r.matched_by ?? 'new worker',
                  r.action === 'update' ? (willUpdate ? 'Update' : 'Skip') : ACTION_LABEL[r.action],
                  <>
                    {r.action === 'error' && r.errors.map((e) => (
                      <span key={e} className="pf-error">{e}</span>
                    ))}
                    {r.action === 'update' && r.diff && (
                      <div className="bulk-diff">
                        {describeDiff(r.diff).map((d) => (
                          <span key={d.field}>{d.field}: {d.from} → {d.to}</span>
                        ))}
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`Update ${r.name}`}
                            checked={willUpdate}
                            disabled={busy}
                            onChange={() => r.person_id && toggle(r.person_id)}
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
