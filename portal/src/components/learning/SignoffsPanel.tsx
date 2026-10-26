/**
 * The Sign-offs tab: who signed this document, newest first, a page at a
 * time (offset paging behind usePagedList's cursor), optionally for one
 * version. Signatures themselves aren't shown here; the worker's certificate
 * holds them.
 */

import { useMemo, useState } from 'react';

import {
  languageName, listDocumentSignoffs, type DocumentSignoff, type VersionSummary,
} from '../../lib/learning';
import { dateTime } from '../../lib/learningDoc';
import { usePagedList } from '../../lib/usePagedList';
import LearningList, { type LearningColumn } from './LearningList';

const PAGE_SIZE = 50;

export const SIGNOFF_COLUMNS = {
  worker: { key: 'worker', label: 'Worker', width: '1.6fr', default: true, min: 150 },
  version: { key: 'version', label: 'Version', short: 'Ver.', width: '0.6fr', default: true, min: 70 },
  language: { key: 'language', label: 'Language', short: 'Lang.', width: '0.9fr', default: true, min: 100 },
  signed: { key: 'signed', label: 'Signed', width: '1.3fr', default: true, min: 150 },
  read: { key: 'read', label: 'Read time', short: 'Read', width: '0.8fr', default: true, min: 90 },
  quiz: { key: 'quiz', label: 'Quiz score', short: 'Quiz', width: '0.8fr', default: true, min: 80 },
  initiative: { key: 'initiative', label: 'Initiative', width: '1.4fr', default: true, min: 140 },
};

/** 75 → "1 min 15 s". */
function readTime(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export default function SignoffsPanel({ documentId, versions }: {
  documentId: string;
  versions: VersionSummary[];
}) {
  const [versionId, setVersionId] = useState('');
  const list = usePagedList<DocumentSignoff, { versionId: string }>({
    query: useMemo(() => ({ versionId }), [versionId]),
    fetchPage: async ({ versionId: version, cursor }) => {
      const offset = cursor === null ? 0 : Number(cursor);
      const page = await listDocumentSignoffs(documentId, {
        limit: PAGE_SIZE, offset, versionId: version || undefined,
      });
      const next = offset + page.items.length;
      return { rows: page.items, total: page.total, next_cursor: next < page.total && page.items.length > 0 ? String(next) : null };
    },
  });
  const failed = list.error !== null && list.rows.length === 0;

  const columns: LearningColumn<DocumentSignoff>[] = [
    { def: SIGNOFF_COLUMNS.worker, cell: (s) => <span className="cell-top cell-line">{s.person.name}</span> },
    { def: SIGNOFF_COLUMNS.version, cell: (s) => <span className="cell-top cell-line">v{s.version_no}</span> },
    { def: SIGNOFF_COLUMNS.language, cell: (s) => <span className="cell-top cell-line">{languageName(s.language)}</span> },
    { def: SIGNOFF_COLUMNS.signed, cell: (s) => <span className="cell-top cell-line">{dateTime(s.signed_at)}</span> },
    { def: SIGNOFF_COLUMNS.read, cell: (s) => <span className="cell-top cell-line">{readTime(s.read_seconds)}</span> },
    { def: SIGNOFF_COLUMNS.quiz, cell: (s) => <span className="cell-top cell-line">{s.quiz_score === null ? '—' : `${s.quiz_score}%`}</span> },
    { def: SIGNOFF_COLUMNS.initiative, cell: (s) => <span className="cell-top cell-line">{s.initiative ?? '—'}</span> },
  ];

  return (
    <div className="lrn-tab">
      <div className="dir-toolbar">
        <div className="toolbar-right">
          <label className="lrn-filter">
            <span className="lrn-lbl">Version</span>
            <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
              <option value="">All versions</option>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version_no}</option>)}
            </select>
          </label>
          <span className="result-count" aria-live="polite">
            {failed ? '' : list.loading && list.rows.length === 0 ? 'Loading…'
              : `${list.rows.length.toLocaleString()} of ${list.total.toLocaleString()} shown`}
          </span>
        </div>
      </div>

      {failed && (
        <div className="dir-empty">
          <b>Couldn&apos;t load the sign-offs</b>{list.error}
          <div className="audit-more">
            <button type="button" className="mini-btn" onClick={list.reload}>Try again</button>
          </div>
        </div>
      )}
      {!failed && (
        <>
          <LearningList columns={columns} rows={list.rows} rowKey={(s) => s.id} ariaLabel="Sign-offs"
                        empty={list.loading ? null : <><b>No sign-offs yet</b>They appear here as workers sign.</>} />
          {list.error && list.rows.length > 0 && (
            <div className="audit-more">
              <span className="set-note">{list.error}</span>
              <button type="button" className="mini-btn" onClick={list.retry}>Retry</button>
            </div>
          )}
          {list.hasMore && (
            <div className="audit-more">
              <button type="button" className="mini-btn" disabled={list.loadingMore} onClick={list.loadMore}>
                {list.loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
