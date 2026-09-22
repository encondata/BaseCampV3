/**
 * BulkWorkers — /bulk/workers: the column guide, template and export
 * downloads, then WorkerBulkUpload (upload → preview → apply).
 */
import { useState } from 'react';

import WorkerBulkUpload from '../components/workers/WorkerBulkUpload';
import DataTable from '../components/DataTable';
import { downloadWorkerExport, downloadWorkerTemplate } from '../lib/api';
import { WORKER_COLUMN_GUIDE } from '../lib/workerBulk';
import '../styles/bulk.css';

export default function BulkWorkers() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const download = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try { await fn(); } catch { setError('Download failed — try again.'); } finally { setBusy(''); }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Bulk Actions</div>
      <h1 className="page-title">Add or update workers in bulk</h1>
      <p className="page-hint">
        Download the template or the current list, fill it in, upload it, and review every add before applying.
        Rows match existing people by email, phone, or name; matched rows are skipped unless you tick Update.
        Every imported person gets the worker role. Login accounts are not created here.
      </p>

      <section className="bulk-section">
        <p className="eyebrow-sm">Columns</p>
        <DataTable
          ariaLabel="Template columns"
          columns={[
            { key: 'key', label: 'Column', mono: true },
            { key: 'required', label: 'Required' },
            { key: 'accepts', label: 'Accepts' },
            { key: 'example', label: 'Example', mono: true },
          ]}
          rows={WORKER_COLUMN_GUIDE.map((c) => ({
            key: c.key, cells: [c.key, c.required ? 'Yes' : '', c.accepts, c.example || '—'],
          }))}
        />
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Download</p>
        <div className="bulk-actions">
          <button className="mini-btn" disabled={!!busy} onClick={() => void download('t-xlsx', () => downloadWorkerTemplate('xlsx'))}>Template (.xlsx)</button>
          <button className="mini-btn" disabled={!!busy} onClick={() => void download('t-csv', () => downloadWorkerTemplate('csv'))}>Template (.csv)</button>
          <button className="mini-btn accent" disabled={!!busy} onClick={() => void download('e-xlsx', () => downloadWorkerExport('xlsx'))}>Current workers (.xlsx)</button>
          <button className="mini-btn accent" disabled={!!busy} onClick={() => void download('e-csv', () => downloadWorkerExport('csv'))}>Current workers (.csv)</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
        <p className="set-note">
          Uploads are limited to 1,000 rows and 5 MB. Larger exports need to be split before re-uploading.
        </p>
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Upload</p>
        <WorkerBulkUpload onDone={() => {}} />
      </section>
    </div>
  );
}
