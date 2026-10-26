/**
 * /learning/library/:documentId — one learning document. The header carries
 * the version chip, Preview as worker (in a phone-width modal, not the learn
 * app), Edit in wiki, and Publish vN. Tabs (?tab=): Content and rules | Quiz |
 * Translations | Versions | Sign-offs.
 *
 * Mutation controls follow the API's actions: change for settings, publish,
 * translations and questions, delete for Archive. A view-only manager gets
 * read-only panels. Settings autosave one field at a time with a toast.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ApiError } from '../../lib/api';
import { wikiUrl } from '../../lib/appLinks';
import {
  archiveLearningDocument, getLearningDocument, listDocumentSignoffs, listTranslations,
  patchLearningDocument,
  type DocumentPatch, type LearningDocument as Doc, type TranslationStatusRow,
} from '../../lib/learning';
import { apiErrorText } from '../../lib/learningDoc';
import { useToast } from '../../lib/notificationsContext';
import DocumentRulesPanel, { type DocTab } from '../../components/learning/DocumentRulesPanel';
import PreviewModal from '../../components/learning/PreviewModal';
import PublishModal from '../../components/learning/PublishModal';
import QuizEditor from '../../components/learning/QuizEditor';
import SignoffsPanel from '../../components/learning/SignoffsPanel';
import TranslationsPanel from '../../components/learning/TranslationsPanel';
import { useLearningAccess } from '../../components/learning/useLearningAccess';
import VersionsPanel from '../../components/learning/VersionsPanel';
import '../../styles/directory.css';
import '../../styles/learning.css';

const TABS: { key: DocTab; label: string }[] = [
  { key: 'content', label: 'Content and rules' },
  { key: 'quiz', label: 'Quiz' },
  { key: 'translations', label: 'Translations' },
  { key: 'versions', label: 'Versions' },
  { key: 'signoffs', label: 'Sign-offs' },
];

export default function LearningDocument() {
  const { documentId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useLearningAccess();
  const canChange = can('change');

  const wanted = params.get('tab');
  const tab: DocTab = TABS.some((t) => t.key === wanted) ? (wanted as DocTab) : 'content';
  const setTab = (next: DocTab) => {
    const p = new URLSearchParams(params);
    if (next === 'content') p.delete('tab'); else p.set('tab', next);
    setParams(p, { replace: true });
  };

  const [doc, setDoc] = useState<Doc | null>(null);
  const [failure, setFailure] = useState<'missing' | 'failed' | null>(null);
  const [translations, setTranslations] = useState<TranslationStatusRow[] | null>(null);
  const [signoffs, setSignoffs] = useState<{ total: number; counts: Record<string, number> } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const requestId = useRef(0);

  const reloadTranslations = useCallback(() => {
    listTranslations(documentId).then(setTranslations).catch(() => setTranslations((t) => t ?? []));
  }, [documentId]);
  const reloadSignoffs = useCallback(() => {
    listDocumentSignoffs(documentId, { limit: 1 })
      .then((p) => setSignoffs({ total: p.total, counts: p.version_counts }))
      .catch(() => { /* the counts just stay off */ });
  }, [documentId]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await getLearningDocument(documentId);
      if (id !== requestId.current) return;
      setDoc(next);
      setFailure(null);
    } catch (e) {
      if (id !== requestId.current) return;
      setFailure(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed');
    }
  }, [documentId]);

  useEffect(() => {
    setDoc(null);
    setFailure(null);
    setTranslations(null);
    setSignoffs(null);
    void load();
    reloadTranslations();
    reloadSignoffs();
  }, [load, reloadTranslations, reloadSignoffs]);

  /** One autosave. Resolves false when it failed, so the panel puts the old value back. */
  const save = useCallback(async (patch: DocumentPatch): Promise<boolean> => {
    try {
      setDoc(await patchLearningDocument(documentId, patch));
      toast('Saved');
      return true;
    } catch (e) {
      toast(`Couldn’t save: ${apiErrorText(e)}`);
      return false;
    }
  }, [documentId, toast]);

  const archive = async () => {
    if (!doc || !window.confirm(`Archive “${doc.title}”? Workers keep their sign-offs; it stops being assigned.`)) return;
    try {
      await archiveLearningDocument(doc.id);
      toast(`Archived ${doc.title}`);
      navigate('/learning/library');
    } catch (e) {
      toast(`Couldn’t archive: ${apiErrorText(e)}`);
    }
  };

  if (failure === 'missing') {
    return (
      <div className="portal-page">
        <div className="eyebrow">Learning</div>
        <h1 className="page-title">Document not found</h1>
        <p className="page-hint">It may have been removed. <Link to="/learning/library">Back to the library</Link></p>
      </div>
    );
  }
  if (failure === 'failed' && !doc) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Learning</div>
        <h1 className="page-title">Document</h1>
        <div className="dir-empty" role="alert">
          <b>Couldn&apos;t load the document</b>
          <div className="audit-more">
            <button type="button" className="mini-btn" onClick={() => void load()}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Learning</div>
        <p className="page-hint">Loading…</p>
      </div>
    );
  }

  const published = doc.current_version_no !== null;
  const nextVersion = (doc.current_version_no ?? 0) + 1;
  const counts: Record<string, number> | null = signoffs?.counts ?? null;
  const tabCount = (key: DocTab): number | null => {
    if (key === 'translations') return translations?.length ?? null;
    if (key === 'versions') return doc.versions.length;
    if (key === 'signoffs') return signoffs?.total ?? null;
    return null;
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow"><Link to="/learning/library">Learning library</Link></div>
          <h1 className="page-title">
            {doc.title}
            {published
              ? <span className="chip c-green"><span className="dot" />v{doc.current_version_no} published</span>
              : <span className="chip c-slate"><span className="dot" />Not published</span>}
            {doc.archived_at && <span className="chip c-slate"><span className="dot" />Archived</span>}
          </h1>
          <p className="page-hint">
            {doc.wiki_page ? `From the wiki page “${doc.wiki_page.title}”` : 'No wiki page linked'}
            {signoffs !== null && ` · ${signoffs.total} sign-offs`}
          </p>
        </div>
        <div className="lrn-head-actions">
          {published && (
            <button type="button" className="btn-ghost" onClick={() => setPreviewing(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" />
              </svg>
              Preview as worker
            </button>
          )}
          {doc.wiki_node_id && (
            <a className="btn-ghost" href={`${wikiUrl()}/n/${doc.wiki_node_id}`} target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4" />
              </svg>
              Edit in wiki
            </a>
          )}
          {can('delete') && !doc.archived_at && (
            <button type="button" className="btn-ghost" onClick={() => void archive()}>Archive</button>
          )}
          {canChange && !doc.archived_at && (
            <button type="button" className="btn-solid" disabled={!doc.has_wiki_changes}
                    title={doc.has_wiki_changes ? undefined : 'The wiki page has no new published changes'}
                    onClick={() => setPublishing(true)}>
              Publish v{nextVersion}
            </button>
          )}
        </div>
      </div>

      {doc.wiki_node_id === null && (
        <p className="lrn-banner" role="status">
          The linked wiki page is gone. Workers still read the published version; link the document to another page to publish again.
        </p>
      )}
      {doc.wiki_node_id !== null && doc.has_wiki_changes && published && (
        <p className="lrn-banner" role="status">
          The wiki page has changes that aren&apos;t published here yet.
        </p>
      )}

      <div className="segmented lrn-tabs" role="tablist" aria-label="Document sections">
        {TABS.map((t) => {
          const n = tabCount(t.key);
          return (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                    className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              {t.label}{n !== null && <span className="n">{n}</span>}
            </button>
          );
        })}
      </div>

      {tab === 'content' && (
        <div className="lrn-docgrid">
          <section className="lrn-card lrn-paper" aria-label="Rendered content">
            <div className="eyebrow">Version {doc.current_version_no ?? '—'}</div>
            <h2 className="lrn-paper-title">{doc.title}</h2>
            {doc.summary && <p className="page-hint">{doc.summary}</p>}
            {/* current_html is the server's snapshot, sanitized when it was published */}
            {doc.current_html
              ? <div className="lrn-prose" dangerouslySetInnerHTML={{ __html: doc.current_html }} />
              : <p className="page-hint">Nothing is published yet. Publish to snapshot the wiki page as version 1.</p>}
          </section>
          <section className="lrn-card" aria-label="Rules">
            <DocumentRulesPanel doc={doc} canChange={canChange} onSave={save}
                                translations={translations} signoffCounts={counts}
                                onOpenTab={setTab} />
          </section>
        </div>
      )}
      {tab === 'quiz' && <QuizEditor doc={doc} onSave={save} />}
      {tab === 'translations' && (translations === null
        ? <p className="page-hint">Loading…</p>
        : <TranslationsPanel documentId={doc.id} currentVersionNo={doc.current_version_no}
                             rows={translations} onReload={reloadTranslations} />)}
      {tab === 'versions' && <VersionsPanel doc={doc} counts={counts} />}
      {tab === 'signoffs' && <SignoffsPanel documentId={doc.id} versions={doc.versions} />}

      {publishing && (
        <PublishModal documentId={doc.id} title={doc.title} versionNo={nextVersion}
                      onClose={() => setPublishing(false)}
                      onPublished={(v) => {
                        setPublishing(false);
                        toast(`Published v${v.version_no}`);
                        void load();
                        reloadTranslations();
                        reloadSignoffs();
                      }} />
      )}
      {previewing && (
        <PreviewModal doc={doc} languages={(translations ?? []).map((t) => t.language)}
                      onClose={() => setPreviewing(false)} />
      )}
    </div>
  );
}
