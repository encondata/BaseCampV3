/**
 * ContainerBulkImport — Import-button modal on the Containers list.
 * CSV/XLSX file → preview (per-row create/error) → commit. Create-only;
 * commit stays locked until every row previews as `create`.
 * Mirrors SiteBulkImport.tsx's flow and ContainerEditModal's modal chrome
 * (this component owns its own modal-scrim/modal-card, unlike
 * SiteBulkImport which is a tab embedded in SiteEditModal).
 */

import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';

import {
  ApiError,
  commitContainerBulk,
  downloadContainerTemplate,
  previewContainerBulk,
  type ContainerBulkRow,
} from '../../lib/api';
import '../../styles/sites.css';

interface Props {
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

const BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The data has columns that are not in the template.',
  too_many_rows: 'Too many rows — the limit is 1,000 per import.',
  rows_invalid: 'Some rows have problems — fix them and preview again.',
  forbidden: 'You do not have permission to import containers.',
};

const ROW_ERRORS: Record<string, string> = {
  name_required: 'Name is required',
  duplicate_name: 'A container with this name already exists',
  unknown_container_type: 'Unknown container type',
  unknown_status: 'Unknown status',
  unknown_site: 'Unknown site',
  duplicate_rfid_tag: 'Duplicate RFID tag',
};

/** File → array of row objects keyed by header. XLSX via the xlsx
 *  package (also handles .csv — SheetJS auto-detects the format). */
async function parseFile(file: File): Promise<Record<string, unknown>[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  return XLSX.utils.sheet_to_json(sheet!, { defval: '' });
}

export default function ContainerBulkImport({ onClose, onDone }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [preview, setPreview] = useState<ContainerBulkRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<number | null>(null);

  const pickFile = async (file: File) => {
    setError('');
    setPreview(null);
    setDone(null);
    try {
      const parsed = await parseFile(file);
      setRows(parsed);
      setFileName(file.name);
    } catch {
      setError('Could not read that file — use .csv or .xlsx.');
    }
  };

  const runPreview = async () => {
    if (!rows) return;
    setBusy(true);
    setError('');
    try {
      setPreview((await previewContainerBulk(rows)).rows);
    } catch (err) {
      setError(err instanceof ApiError
        ? (BULK_ERRORS[err.code] ?? 'Preview failed — try again.')
        : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const runCommit = async () => {
    if (!rows) return;
    setBusy(true);
    setError('');
    try {
      const result = await commitContainerBulk(rows);
      setDone(result.created);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError
        ? (BULK_ERRORS[err.code] ?? 'Import failed — try again.')
        : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const template = async () => {
    const blob = await downloadContainerTemplate();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'containers-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const canCommit = !!preview && preview.length > 0
    && preview.every((r) => r.action === 'create');

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Import containers</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <p className="page-hint">
            Upload a .csv or .xlsx matching the template — names must be new
            (this import creates containers, it never updates).
          </p>
          <div className="pf-form">
            <div>
              <button className="mini-btn" type="button" onClick={() => void template()}>
                Download template
              </button>
            </div>
            <div>
              <input ref={fileRef} type="file" accept=".csv,.xlsx"
                     style={{ display: 'none' }}
                     onChange={(e) => {
                       const f = e.target.files?.[0];
                       if (f) void pickFile(f);
                     }} />
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => fileRef.current?.click()}>
                {fileName || 'Choose file…'}
              </button>
            </div>
          </div>

          {preview && (
            <table className="bulk-preview">
              <thead>
                <tr><th>Row</th><th>Name</th><th>Result</th></tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.row} className={`bulk-row-${r.action}`}>
                    <td>{r.row}</td>
                    <td>{String(r.data.name ?? '')}</td>
                    <td>{r.action === 'create'
                      ? 'Create'
                      : r.errors.map((e) => (
                        <span key={e} className="pf-error">{ROW_ERRORS[e] ?? e}</span>
                      ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {done !== null && (
            <p className="page-hint"><b>Imported {done} containers.</b></p>
          )}
          {error && <span className="pf-error">{error}</span>}
        </div>
        <div className="modal-foot">
          <button className="mini-btn" type="button" disabled={!rows || busy}
                  onClick={() => void runPreview()}>
            {busy ? 'Working…' : 'Preview'}
          </button>
          <button className="btn-solid" type="button" disabled={!canCommit || busy || done !== null}
                  onClick={() => void runCommit()}>
            Import
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>
            {done !== null ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
