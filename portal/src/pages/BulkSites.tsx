/**
 * BulkSites — /bulk/sites: the column guide, template and export
 * downloads, then SiteBulkUpload (upload → preview → apply).
 */
import { useState } from 'react';

import SiteBulkUpload from '../components/sites/SiteBulkUpload';
import DataTable from '../components/DataTable';
import { downloadSiteExport, downloadSiteTemplate } from '../lib/api';
import { SITE_COLUMN_GUIDE } from '../lib/siteBulk';
import '../styles/bulk.css';
import '../styles/sites.css';

export default function BulkSites() {
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
      <h1 className="page-title">Add or update sites in bulk</h1>
      <p className="page-hint">
        Download the template or the current list, fill it in, upload it, and review every add and update before applying.
        Rows match existing sites by name or by street address.
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
          rows={SITE_COLUMN_GUIDE.map((c) => ({
            key: c.key, cells: [c.key, c.required ? 'Yes' : '', c.accepts, c.example || '—'],
          }))}
        />
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Download</p>
        <div className="bulk-actions">
          <button className="mini-btn" disabled={!!busy} onClick={() => void download('t-xlsx', () => downloadSiteTemplate('xlsx'))}>Template (.xlsx)</button>
          <button className="mini-btn" disabled={!!busy} onClick={() => void download('t-csv', () => downloadSiteTemplate('csv'))}>Template (.csv)</button>
          <button className="mini-btn accent" disabled={!!busy} onClick={() => void download('e-xlsx', () => downloadSiteExport('xlsx'))}>Current sites (.xlsx)</button>
          <button className="mini-btn accent" disabled={!!busy} onClick={() => void download('e-csv', () => downloadSiteExport('csv'))}>Current sites (.csv)</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
        <p className="set-note">
          Uploads are limited to 1,000 rows and 5 MB. Larger exports need to be split before re-uploading.
        </p>
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Upload</p>
        <SiteBulkUpload onDone={() => {}} />
      </section>
    </div>
  );
}
