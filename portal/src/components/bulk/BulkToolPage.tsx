/**
 * BulkToolPage — the page shell every Bulk Actions tool shares: title and
 * hint (plus an optional intro, e.g. a job picker, right under it), the
 * column guide, the template / export downloads with the upload
 * limit note, and an Upload section holding the tool's own pane.
 */
import { useState, type ReactNode } from 'react';

import DataTable from '../DataTable';
import '../../styles/bulk.css';

export interface BulkColumnGuide { key: string; required: boolean; accepts: string; example: string }
export interface BulkDownload { key: string; label: string; run: () => Promise<void>; accent?: boolean; disabled?: boolean }

interface Props {
  title: string;
  hint: ReactNode;
  guide: BulkColumnGuide[];
  downloads: BulkDownload[];
  /** Optional content (e.g. a job picker) rendered right after the hint, with no heading. */
  intro?: ReactNode;
  /** Overrides the default "Uploads are limited to 1,000 rows and 5 MB…"
   *  note under Download, for tools with a different limit. */
  limitNote?: string;
  children: ReactNode;
}

export default function BulkToolPage({ title, hint, guide, downloads, intro, limitNote, children }: Props) {
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
      <h1 className="page-title">{title}</h1>
      <p className="page-hint">{hint}</p>
      {intro && <div className="bulk-intro">{intro}</div>}

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
          rows={guide.map((c) => ({
            key: c.key, cells: [c.key, c.required ? 'Yes' : '', c.accepts, c.example || '—'],
          }))}
        />
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Download</p>
        <div className="bulk-actions">
          {downloads.map((d) => (
            <button key={d.key} className={d.accent ? 'mini-btn accent' : 'mini-btn'} disabled={!!busy || !!d.disabled}
                    onClick={() => void download(d.key, d.run)}>
              {d.label}
            </button>
          ))}
          {error && <span className="pf-error">{error}</span>}
        </div>
        <p className="set-note">
          {limitNote ?? 'Uploads are limited to 1,000 rows and 5 MB. Larger exports need to be split before re-uploading.'}
        </p>
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Upload</p>
        {children}
      </section>
    </div>
  );
}
