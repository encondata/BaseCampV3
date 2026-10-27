/**
 * New document: pick a page from the learning wiki space (the API lists only
 * pages the user may link) and a title (the page's title until changed).
 * Needs learning:add; the API refuses private pages, other spaces, etc.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  createLearningDocument, listLearningWikiPages,
  type LearningDocument, type WikiPageOption,
} from '../../lib/learning';
import { apiErrorText } from '../../lib/learningDoc';
import { naturalCompare } from '../../lib/sites';
import ComboBox from '../ComboBox';
import LearningModal from './LearningModal';

export default function NewDocumentModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (doc: LearningDocument) => void;
}) {
  const [pages, setPages] = useState<WikiPageOption[] | null>(null);
  const [pageId, setPageId] = useState('');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    listLearningWikiPages()
      .then((p) => { if (alive) setPages(p); })
      .catch(() => { if (alive) { setPages([]); setError('Couldn’t load the wiki pages.'); } });
    return () => { alive = false; };
  }, []);

  const options = useMemo(() => (pages ?? [])
    .slice().sort((a, b) => naturalCompare(a.title, b.title))
    .map((p) => ({
      value: p.id, label: p.title,
      sub: [p.path.join(' / '), p.published_version_no === null ? 'Not published in the wiki' : null]
        .filter(Boolean).join(' · ') || null,
    })), [pages]);

  const pickPage = (id: string) => {
    setPageId(id);
    setError('');
    if (!titleTouched) setTitle(pages?.find((p) => p.id === id)?.title ?? '');
  };

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      onCreated(await createLearningDocument({ title: title.trim(), wiki_node_id: pageId }));
    } catch (e) {
      setError(apiErrorText(e, {
        not_learning_page: 'Pick a page from the Learning space in the wiki.',
        private_page: 'Private pages can’t be used for training.',
        wiki_forbidden: 'You don’t have access to that wiki page.',
      }));
      setSaving(false);
    }
  };

  return (
    <LearningModal eyebrow="Learning library" title="New learning document"
                   description="Workers read a page from the Learning space in the wiki. Pick the page, then set the rules for it on the next screen."
                   onClose={onClose} busy={saving}
                   footer={(
                     <>
                       <button type="button" className="btn-solid" onClick={() => void create()}
                               disabled={!pageId || !title.trim() || saving}>
                         {saving ? 'Creating…' : 'Create document'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                       {error && <span className="pf-error">{error}</span>}
                     </>
                   )}>
      <div className="pf-form">
        <div className="full">
          <label htmlFor="lrn-new-page">Wiki page</label>
          <ComboBox options={options} value={pageId} onChange={pickPage} inputId="lrn-new-page"
                    placeholder={pages === null ? 'Loading…' : 'Type to search pages…'}
                    disabled={saving} />
        </div>
        <div className="full">
          <label htmlFor="lrn-new-title">Title</label>
          <input id="lrn-new-title" value={title} maxLength={200} disabled={saving}
                 onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} />
        </div>
      </div>
    </LearningModal>
  );
}
