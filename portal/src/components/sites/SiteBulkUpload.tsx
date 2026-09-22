/**
 * SiteBulkUpload — the /bulk/sites page's upload pane. Pick a csv/xlsx
 * file, Preview renders per-row results (create/update/no-change/error,
 * and which existing site an update matched by), and Apply stays locked
 * until the server says can_commit AND every `update` row is approved.
 */

import { useRef, useState } from 'react';

import {
  ApiError,
  commitSiteBulk,
  previewSiteBulk,
  type BulkCommitResult,
  type BulkPreview,
  type BulkRowResult,
} from '../../lib/api';
import { SITE_BULK_ERRORS } from '../../lib/siteBulk';
import BulkApplySummary from '../bulk/BulkApplySummary';
import DataTable from '../DataTable';

interface Props {
  onDone(result: BulkCommitResult): void;
}

const ACTION_LABEL: Record<BulkRowResult['action'], string> = {
  create: 'Add',
  update: 'Update',
  unchanged: 'No change',
  error: 'Error',
};

const MATCH_LABEL: Record<'name' | 'address', string> = {
  name: 'name',
  address: 'address',
};

function describeDiff(
  diff: NonNullable<BulkRowResult['diff']>,
): { field: string; from: string; to: string }[] {
  return Object.entries(diff).map(([field, change]) => {
    if (field === 'clients') {
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

export default function SiteBulkUpload({ onDone }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BulkCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (SITE_BULK_ERRORS[err.code] ?? 'Import failed — try again.')
      : 'Network error.';

  const runPreview = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const result = await previewSiteBulk(file, file.name);
      setPreview(result);
      setApproved(new Set());
    } catch (err) {
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const adds = preview?.rows.filter((r) => r.action === 'create').length ?? 0;
  const updates = preview?.rows.filter((r) => r.action === 'update') ?? [];
  const unchanged = preview?.rows.filter((r) => r.action === 'unchanged').length ?? 0;
  const errors = preview?.rows.filter((r) => r.action === 'error').length ?? 0;
  const allApproved = updates.every((r) => r.site_id !== null && approved.has(r.site_id));
  const canApply = !!preview && preview.can_commit && allApproved
    && preview.rows.some((r) => r.action !== 'unchanged');

  const runImport = async () => {
    if (!preview || !file) return;
    setBusy(true);
    setError('');
    try {
      // the ORIGINAL cells, never the preview's normalized `data` — replaying
      // `data` would write its create-only status/country defaults
      const posted = preview.rows.filter((r) => r.action !== 'error');
      const counts = await commitSiteBulk(posted.map((r) => r.cells), [...approved], file.name);
      // The commit numbers rows from 1 (JSON path); the preview numbered the
      // spreadsheet lines from 2. Relabel so the summary ties back to the
      // file the approver just read — order and length line up because no
      // posted row is blank.
      const result = {
        ...counts,
        rows: counts.rows.map((r, i) => ({ ...r, row: posted[i]?.row ?? r.row })),
      };
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';   // re-picking the same file must fire change
      setResult(result);
      onDone(result);
    } catch (err) {
      setError(mapError(err));
      setPreview(null);   // stale after a failed commit — force re-preview
    } finally {
      setBusy(false);
    }
  };

  const toggleApproval = (siteId: string) =>
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(siteId)) next.delete(siteId);
      else next.add(siteId);
      return next;
    });

  return (
    <div className="bulk-import">
      <div className="bulk-file-row">
        <label htmlFor="site-bulk-file">Upload a file (.csv or .xlsx)</label>
        <input
          id="site-bulk-file"
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setResult(null);
            setError('');       // the new file gets a clean slate
          }}
        />
      </div>

      <div className="bulk-actions">
        <button className="btn-solid" type="button"
                disabled={busy || !file}
                onClick={() => void runPreview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button className="btn-solid" type="button"
                disabled={busy || !canApply}
                onClick={() => void runImport()}>
          {`Add ${adds} site${adds === 1 ? '' : 's'} and update ${updates.length} site${updates.length === 1 ? '' : 's'}`}
        </button>
        {updates.length > 1 && (
          <button className="mini-btn" type="button" disabled={busy}
                  onClick={() => setApproved(new Set(
                    updates.map((r) => r.site_id as string)))}>
            Approve all updates
          </button>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {result && (
        <BulkApplySummary
          result={result}
          entityLabel="Site"
          linkFor={(r) => `/sites?open=${r.site_id}`}
          filename="sites-bulk-summary"
          openTo="/sites"
          openLabel="Open Sites"
        />
      )}

      {preview && (
        <>
          <p className="set-note">
            {`${adds} to add · ${updates.length} to update · ${unchanged} unchanged · ${errors} error${errors === 1 ? '' : 's'}`}
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
            rows={preview.rows.map((r) => ({
              key: String(r.row),
              className: `bulk-row-${r.action}`,
              cells: [
                r.row,
                r.name ?? '—',
                r.matched_by ? MATCH_LABEL[r.matched_by] : 'new site',
                ACTION_LABEL[r.action],
                <>
                  {r.action === 'error' && r.errors.map((e) => (
                    <span key={e} className="pf-error">{e}</span>
                  ))}
                  {r.action === 'update' && r.diff && (
                    <div className="bulk-diff">
                      {describeDiff(r.diff).map((d) => (
                        <span key={d.field}>
                          {d.field}: {d.from ? `${d.from} → ` : ''}{d.to}
                        </span>
                      ))}
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`Approve update to ${r.name}`}
                          checked={r.site_id !== null && approved.has(r.site_id)}
                          disabled={busy}
                          onChange={() => r.site_id && toggleApproval(r.site_id)}
                        />
                        {' '}Approve
                      </label>
                    </div>
                  )}
                </>,
              ],
            }))}
          />
        </>
      )}
    </div>
  );
}
