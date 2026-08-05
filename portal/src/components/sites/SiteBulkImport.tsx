/**
 * SiteBulkImport — the Bulk tab of the New-site modal (admin-rank only;
 * the modal decides visibility). Paste JSON or pick a csv/xlsx file,
 * Preview renders per-row results, and Import stays locked until the
 * server says can_commit AND (god path) every `update` row is approved.
 * Pasted JSON wins over a chosen file; picking a file clears the paste
 * precedence note by clearing edits — see `effectiveSource`.
 */

import { useEffect, useRef, useState } from 'react';

import {
  ApiError,
  commitSiteBulk,
  downloadSiteTemplate,
  getSiteBulkSample,
  previewSiteBulk,
  type BulkPreview,
  type BulkRowResult,
} from '../../lib/api';

interface Props {
  onDone: () => Promise<void> | void;
}

const ACTION_LABEL: Record<BulkRowResult['action'], string> = {
  create: 'Create',
  update: 'Update',
  unchanged: 'No change',
  error: 'Error',
};

const BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The data has columns that are not in the template.',
  too_many_rows: 'Too many rows — the limit is 1,000 per import.',
  file_too_large: 'File too large — the limit is 5 MB.',
  invalid_json: 'That is not valid JSON — expected an array of row objects.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv, .xlsx, or .json.',
  updates_not_allowed: 'Updating existing sites needs developer access.',
  rows_invalid: 'Some rows have problems — fix them and preview again.',
  forbidden: 'You do not have permission to bulk import.',
};

/** Preview `data` back to template-shaped cells for the commit replay:
 * arrays re-join with semicolons, numbers stringify, blanks drop. */
function toTemplateRow(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.join('; ');
      continue;
    }
    out[key] = typeof value === 'number' ? String(value) : value;
  }
  return out;
}

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

export default function SiteBulkImport({ onDone }: Props) {
  const [text, setText] = useState('');
  const [textEdited, setTextEdited] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSiteBulkSample()
      .then((rows) => {
        if (!cancelled) setText(JSON.stringify(rows, null, 2));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Pasted (edited) JSON wins over a chosen file, per the spec.
  const effectiveSource: { blob: Blob; name: string } | null = (() => {
    if (textEdited || file === null) {
      if (!text.trim()) return null;
      return {
        blob: new Blob([text], { type: 'application/json' }),
        name: 'paste.json',
      };
    }
    return { blob: file, name: file.name };
  })();

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (BULK_ERRORS[err.code] ?? 'Import failed — try again.')
      : 'Network error.';

  const runPreview = async () => {
    if (!effectiveSource) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await previewSiteBulk(effectiveSource.blob, effectiveSource.name);
      setPreview(result);
      setApproved(new Set());
    } catch (err) {
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const updates = preview?.rows.filter((r) => r.action === 'update') ?? [];
  const allApproved = updates.every((r) => r.site_id !== null && approved.has(r.site_id));
  const canImport = !!preview && preview.can_commit && allApproved
    && preview.rows.some((r) => r.action !== 'unchanged');

  const runImport = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const rows = preview.rows
        .filter((r) => r.data !== null)
        .map((r) => toTemplateRow(r.data as Record<string, unknown>));
      const counts = await commitSiteBulk(
        rows, [...approved],
        effectiveSource && effectiveSource.name !== 'paste.json'
          ? effectiveSource.name : 'paste');
      setNotice(
        `${counts.created} site${counts.created === 1 ? '' : 's'} created`
        + (counts.updated ? `, ${counts.updated} updated` : '')
        + (counts.unchanged ? `, ${counts.unchanged} unchanged` : '') + '.');
      await onDone();
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
      <div className="bulk-templates">
        <span className="set-note">Start from a template:</span>
        <button className="mini-btn" type="button" disabled={busy}
                onClick={() => void downloadSiteTemplate('xlsx')}>
          Template (.xlsx)
        </button>
        <button className="mini-btn" type="button" disabled={busy}
                onClick={() => void downloadSiteTemplate('csv')}>
          Template (.csv)
        </button>
      </div>

      <label>Rows (JSON) — overwrite the sample or paste your data</label>
      <textarea
        rows={10}
        value={text}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setTextEdited(true);
          setPreview(null);
        }}
      />

      <div className="bulk-file-row">
        <label>…or upload a file (.csv / .xlsx)</label>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setTextEdited(false);
            setPreview(null);
          }}
        />
        {textEdited && file !== null && (
          <span className="set-note">Pasted JSON takes precedence over the file.</span>
        )}
      </div>

      <div className="bulk-actions">
        <button className="btn-solid" type="button"
                disabled={busy || !effectiveSource}
                onClick={() => void runPreview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button className="btn-solid" type="button"
                disabled={busy || !canImport}
                onClick={() => void runImport()}>
          Import
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
      {notice && <p className="set-note">{notice}</p>}

      {preview && (
        <table className="bulk-preview">
          <thead>
            <tr><th>Row</th><th>Name</th><th>Action</th><th>Details</th></tr>
          </thead>
          <tbody>
            {preview.rows.map((r) => (
              <tr key={r.row} className={`bulk-row-${r.action}`}>
                <td>{r.row}</td>
                <td>{r.name ?? '—'}</td>
                <td>{ACTION_LABEL[r.action]}</td>
                <td>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
