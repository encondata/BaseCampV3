/**
 * The Versions tab: every published version with its change note, who
 * published it and when, and how many people signed it. Clicking a row shows
 * that version's HTML — the server's snapshot, sanitized when it was made —
 * under the list.
 */

import { useState } from 'react';

import { getLearningVersion, type LearningDocument, type LearningVersion, type VersionSummary } from '../../lib/learning';
import { apiErrorText, dateTime } from '../../lib/learningDoc';
import LearningList, { type LearningColumn } from './LearningList';

export const VERSION_COLUMNS = {
  version: { key: 'version', label: 'Version', short: 'Ver.', width: '0.8fr', default: true, min: 120 },
  note: { key: 'note', label: 'What changed', width: '2.6fr', default: true, min: 220 },
  by: { key: 'by', label: 'Published by', short: 'By', width: '1.2fr', default: true, min: 130 },
  at: { key: 'at', label: 'Published', width: '1.3fr', default: true, min: 150 },
  signed: { key: 'signed', label: 'Sign-offs', short: 'Signed', width: '0.8fr', default: true, min: 90 },
};

export default function VersionsPanel({ doc, counts }: {
  doc: LearningDocument;
  /** Version id → sign-off count; null until it loads. */
  counts: Record<string, number> | null;
}) {
  const [open, setOpen] = useState<{ summary: VersionSummary; version: LearningVersion | null } | null>(null);
  const [error, setError] = useState('');

  const show = async (summary: VersionSummary) => {
    setError('');
    setOpen({ summary, version: null });
    try {
      const version = await getLearningVersion(doc.id, summary.id);
      setOpen((cur) => (cur?.summary.id === summary.id ? { summary, version } : cur));
    } catch (e) {
      setOpen(null);
      setError(apiErrorText(e, {}, 'Couldn’t load that version.'));
    }
  };

  const columns: LearningColumn<VersionSummary>[] = [
    {
      def: VERSION_COLUMNS.version,
      cell: (v) => (
        <span className="cell-top cell-line lrn-ver-cell">
          <span className="lrn-ver-no">v{v.version_no}</span>
          {v.id === doc.current_version_id && <span className="chip c-green">Current</span>}
        </span>
      ),
    },
    { def: VERSION_COLUMNS.note, cell: (v) => <span className="cell-top cell-line" title={v.change_note ?? undefined}>{v.change_note || '—'}</span> },
    { def: VERSION_COLUMNS.by, cell: (v) => <span className="cell-top cell-line">{v.published_by?.name ?? '—'}</span> },
    { def: VERSION_COLUMNS.at, cell: (v) => <span className="cell-top cell-line">{dateTime(v.published_at)}</span> },
    { def: VERSION_COLUMNS.signed, cell: (v) => <span className="cell-top cell-line">{counts ? (counts[v.id] ?? 0) : '…'}</span> },
  ];

  return (
    <div className="lrn-tab">
      {error && <p className="pf-error" role="alert">{error}</p>}
      <LearningList columns={columns} rows={doc.versions} rowKey={(v) => v.id} ariaLabel="Versions"
                    onRowClick={(v) => void show(v)} selectedKey={open?.summary.id ?? null}
                    empty={<><b>Nothing published yet</b>Publish the document to create version 1.</>} />
      {open && (
        <section className="lrn-card lrn-version-view" aria-label={`Version ${open.summary.version_no}`}>
          <div className="lrn-section-head">
            <p className="eyebrow-sm">Version {open.summary.version_no}</p>
            <button type="button" className="mini-btn" onClick={() => setOpen(null)}>Close</button>
          </div>
          <h3 className="lrn-version-title">{open.summary.title}</h3>
          {open.version === null && <p className="page-hint">Loading…</p>}
          {/* the version's HTML is the server's snapshot, sanitized when it was published */}
          {open.version && <div className="lrn-prose" dangerouslySetInnerHTML={{ __html: open.version.html }} />}
        </section>
      )}
    </div>
  );
}
