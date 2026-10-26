/**
 * The Translations tab: a row per configured language with its status chip
 * (Draft / In review / Published / Out of date / Not translated) and the
 * actions that status allows.
 *
 *   Translate draft     Claude drafts the current version (missing, out of
 *                       date, or an existing draft)
 *   Edit / Write one    title + HTML + live preview; saving makes a draft
 *   Submit for review   a draft goes to review
 *   Approve             an in-review translation publishes; hidden from its
 *                       last editor unless they are a developer (the API
 *                       enforces the same, 409 self_review)
 *
 * All actions need learning:change and a published document.
 */

import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  approveTranslation, draftTranslation, getTranslation, languageName, submitTranslation,
  type Translation, type TranslationStatusRow,
} from '../../lib/learning';
import { apiErrorText, shortDate, TRANSLATION_ERRORS, TRANSLATION_STATUS } from '../../lib/learningDoc';
import { useToast } from '../../lib/notificationsContext';
import LearningList, { type LearningColumn } from './LearningList';
import TranslationEditModal from './TranslationEditModal';
import { useLearningAccess } from './useLearningAccess';

export const TRANSLATION_COLUMNS = {
  language: { key: 'language', label: 'Language', width: '1.2fr', default: true, min: 120 },
  status: { key: 'status', label: 'Status', width: '1fr', default: true, min: 130 },
  version: { key: 'version', label: 'Version', short: 'Ver.', width: '0.6fr', default: true, min: 70 },
  updated: { key: 'updated', label: 'Last edit', width: '1fr', default: true, min: 120 },
  reviewer: { key: 'reviewer', label: 'Approved by', short: 'Approver', width: '1fr', default: true, min: 120 },
  actions: { key: 'actions', label: 'Actions', width: '2.6fr', default: true, min: 300 },
};

export default function TranslationsPanel({ documentId, currentVersionNo, rows, onReload }: {
  documentId: string;
  /** Null while the document has no published version. */
  currentVersionNo: number | null;
  rows: TranslationStatusRow[];
  /** Refetch the language statuses after a change. */
  onReload: () => void;
}) {
  const can = useLearningAccess();
  const canChange = can('change');
  const { person, hasRole } = useAuth();
  const toast = useToast();
  const isDeveloper = hasRole('developer');
  const published = currentVersionNo !== null;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<TranslationStatusRow | null>(null);
  // The last editor of each in-review translation (the status rows don't say).
  const [reviewable, setReviewable] = useState<Record<string, Translation>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (!canChange) return;
    rows.filter((r) => r.status === 'in_review').forEach((r) => {
      const key = `${r.language}:${r.updated_at}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      getTranslation(documentId, r.language)
        .then((t) => setReviewable((m) => ({ ...m, [r.language]: t })))
        .catch(() => { /* no Approve button without knowing the editor */ });
    });
  }, [rows, documentId, canChange]);

  const run = async (row: TranslationStatusRow, what: 'draft' | 'submit' | 'approve') => {
    const name = languageName(row.language);
    setBusy(`${row.language}:${what}`);
    setError('');
    try {
      if (what === 'draft') await draftTranslation(documentId, row.language);
      else if (what === 'submit') await submitTranslation(documentId, row.language);
      else await approveTranslation(documentId, row.language);
      toast(what === 'draft' ? `Drafted the ${name} translation`
        : what === 'submit' ? `Sent the ${name} translation for review`
          : `Approved the ${name} translation`);
      setReviewable((m) => { const n = { ...m }; delete n[row.language]; return n; });
      asked.current.clear();
      onReload();
    } catch (e) {
      setError(apiErrorText(e, TRANSLATION_ERRORS));
    } finally {
      setBusy(null);
    }
  };

  const actions = (row: TranslationStatusRow) => {
    if (!canChange || !published) return null;
    const disabled = busy !== null;
    const detail = reviewable[row.language];
    const lastEditor = detail?.updated_by?.id !== undefined && detail.updated_by.id === person?.id;
    return (
      <div className="lrn-actions">
        {(row.status === 'missing' || row.status === 'out_of_date' || row.status === 'draft') && (
          <button type="button" className="mini-btn" disabled={disabled}
                  onClick={() => void run(row, 'draft')}>
            {busy === `${row.language}:draft` ? 'Translating…' : 'Translate draft'}
          </button>
        )}
        <button type="button" className="mini-btn" disabled={disabled} onClick={() => setEditing(row)}>
          {row.status === 'missing' ? 'Write one' : 'Edit'}
        </button>
        {row.status === 'draft' && (
          <button type="button" className="mini-btn" disabled={disabled}
                  onClick={() => void run(row, 'submit')}>Submit for review</button>
        )}
        {row.status === 'in_review' && detail && (!lastEditor || isDeveloper) && (
          <button type="button" className="mini-btn accent" disabled={disabled}
                  onClick={() => void run(row, 'approve')}>Approve</button>
        )}
        {row.status === 'in_review' && detail && lastEditor && !isDeveloper && (
          <span className="cell-sub">Someone else has to approve this.</span>
        )}
      </div>
    );
  };

  const columns: LearningColumn<TranslationStatusRow>[] = [
    {
      def: TRANSLATION_COLUMNS.language,
      cell: (r) => (
        <div className="pn">
          <b className="cell-top cell-line">{languageName(r.language)}</b>
          {languageName(r.language) !== r.language && <span>{r.language}</span>}
        </div>
      ),
    },
    {
      def: TRANSLATION_COLUMNS.status,
      cell: (r) => {
        const meta = TRANSLATION_STATUS[r.status];
        return <span className={`chip ${meta.cls}`}>{meta.label}</span>;
      },
    },
    {
      def: TRANSLATION_COLUMNS.version,
      cell: (r) => <span className="cell-top cell-line">{r.version_no === null ? '—' : `v${r.version_no}`}</span>,
    },
    {
      def: TRANSLATION_COLUMNS.updated,
      cell: (r) => <span className="cell-top cell-line">{r.updated_at ? shortDate(r.updated_at) : '—'}</span>,
    },
    {
      def: TRANSLATION_COLUMNS.reviewer,
      cell: (r) => <span className="cell-top cell-line">{r.reviewed_by?.name ?? '—'}</span>,
    },
    ...(canChange && published ? [{ def: TRANSLATION_COLUMNS.actions, cell: actions }] : []),
  ];

  return (
    <div className="lrn-tab">
      {!published && (
        <p className="lrn-hint">Publish the document before translating it.</p>
      )}
      {error && <p className="pf-error" role="alert">{error}</p>}
      <LearningList columns={columns} rows={rows} rowKey={(r) => r.language}
                    ariaLabel="Translations"
                    empty={<><b>No languages are set up</b>Add languages in Learning settings.</>} />
      {editing && (
        <TranslationEditModal documentId={documentId} language={editing.language}
                              existing={editing.status !== 'missing'}
                              onClose={() => setEditing(null)}
                              onSaved={() => {
                                toast(`Saved the ${languageName(editing.language)} translation`);
                                setEditing(null);
                                asked.current.clear();
                                onReload();
                              }} />
      )}
    </div>
  );
}
