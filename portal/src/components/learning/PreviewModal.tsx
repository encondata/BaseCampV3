/**
 * Preview as worker: the document the way the learn app shows it, in a
 * phone-width frame inside the portal (the learn app can't sign a manager
 * in). The language select shows the newest translation of each configured
 * language, with a note when workers wouldn't see it yet. The HTML fields
 * are the server's own (sanitized when published or saved), so they are
 * rendered as markup; titles and notes stay text.
 */

import { useEffect, useRef, useState } from 'react';

import { getTranslation, languageName, type LearningDocument, type Translation } from '../../lib/learning';
import { textDir, TRANSLATION_STATUS } from '../../lib/learningDoc';
import { ApiError } from '../../lib/api';
import LearningModal from './LearningModal';

export default function PreviewModal({ doc, languages, onClose }: {
  doc: LearningDocument;
  /** Configured target languages (English is always offered). */
  languages: string[];
  onClose: () => void;
}) {
  const [language, setLanguage] = useState('en');
  const [translation, setTranslation] = useState<Translation | 'missing' | 'failed' | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (language === 'en') { setTranslation(null); return undefined; }
    const mine = ++seq.current;
    setTranslation(null);
    getTranslation(doc.id, language)
      .then((t) => { if (mine === seq.current) setTranslation(t); })
      .catch((e) => {
        if (mine === seq.current) setTranslation(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed');
      });
    return () => { seq.current += 1; };
  }, [doc.id, language]);

  const english = language === 'en';
  const loaded = typeof translation === 'object' && translation !== null ? translation : null;
  const title = loaded ? loaded.title : doc.title;
  const html = english ? doc.current_html : loaded?.content_html ?? null;
  const dir = textDir(language);

  return (
    <LearningModal eyebrow={doc.title} title="Preview as worker" onClose={onClose}
                   description={`Version ${doc.current_version_no ?? '—'} as a worker reads it on a phone.`}
                   className="lrn-preview-card">
      <div className="pf-form">
        <div>
          <label htmlFor="lrn-preview-lang">Language</label>
          <select id="lrn-preview-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {['en', ...languages.filter((l) => l !== 'en')].map((l) => (
              <option key={l} value={l}>{languageName(l)}</option>
            ))}
          </select>
        </div>
      </div>
      {loaded && loaded.status !== 'published' && (
        <p className="lrn-note-mute">
          This translation is {TRANSLATION_STATUS[loaded.status].label.toLowerCase()}, so workers still
          see the English until it is approved.
        </p>
      )}
      {translation === 'missing' && (
        <p className="lrn-note-mute">There is no {languageName(language)} translation yet; workers see the English.</p>
      )}
      {translation === 'failed' && <p className="pf-error">Couldn&apos;t load that translation.</p>}
      {/* every HTML field below is the server's own, sanitized on publish or save */}
      <div className="lrn-phone" lang={language} dir={dir}>
        <div className="lrn-phone-title">{title}</div>
        {html === null && !english && translation === null && <p className="page-hint">Loading…</p>}
        {(english || loaded) && html !== null && (
          <div className="lrn-prose" dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {(translation === 'missing' || translation === 'failed') && doc.current_html && (
          <div className="lrn-prose" lang="en" dir="ltr" dangerouslySetInnerHTML={{ __html: doc.current_html }} />
        )}
      </div>
    </LearningModal>
  );
}
