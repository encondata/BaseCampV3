/**
 * Edit a translation: the title, the HTML, and a live preview. The preview
 * shows what the user types, which the server hasn't sanitized yet, so it
 * renders in a sandboxed frame (no scripts, no same-origin access) instead of
 * being injected into the portal; the server sanitizes on save.
 */

import { useEffect, useState } from 'react';

import { ApiError } from '../../lib/api';
import { getTranslation, languageName, saveTranslation, type Translation } from '../../lib/learning';
import { apiErrorText, TRANSLATION_ERRORS, textDir } from '../../lib/learningDoc';
import LearningModal from './LearningModal';

const FRAME_CSS = 'body{margin:0;padding:12px;font:14px/1.6 system-ui,sans-serif;color:#2b333d}'
  + 'h1,h2,h3,h4{font-size:15px;margin:12px 0 4px}img{max-width:100%;height:auto}'
  + 'table{border-collapse:collapse}th,td{border:1px solid #d9dde2;padding:4px 8px}';

const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'";

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The frame's document. The body is the user's raw HTML: the frame is
 *  sandboxed (no scripts) and a CSP meta stops it loading anything but
 *  https/data images and its own inline style. */
export function previewDocument(html: string, language: string): string {
  return `<!doctype html><html lang="${escapeAttr(language)}" dir="${textDir(language)}"><head>`
    + `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<style>${FRAME_CSS}</style></head><body>${html}</body></html>`;
}

export default function TranslationEditModal({
  documentId, language, existing, onClose, onSaved,
}: {
  documentId: string;
  language: string;
  /** False for a language with no translation yet: the form starts blank. */
  existing: boolean;
  onClose: () => void;
  onSaved: (translation: Translation) => void;
}) {
  const [loaded, setLoaded] = useState<Translation | null>(null);
  const [loading, setLoading] = useState(existing);
  const [title, setTitle] = useState('');
  const [html, setHtml] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const name = languageName(language);

  useEffect(() => {
    if (!existing) return undefined;
    let alive = true;
    getTranslation(documentId, language)
      .then((t) => {
        if (!alive) return;
        setLoaded(t);
        setTitle(t.title);
        setHtml(t.content_html);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        // a 404 is just "nothing yet": start blank
        if (!(e instanceof ApiError && e.status === 404)) setError(apiErrorText(e, {}, 'Couldn’t load the translation.'));
        setLoading(false);
      });
    return () => { alive = false; };
  }, [documentId, language, existing]);

  const save = async () => {
    if (!title.trim()) { setError(TRANSLATION_ERRORS.title_required); return; }
    if (!html.trim()) { setError(TRANSLATION_ERRORS.content_required); return; }
    setSaving(true);
    setError('');
    try {
      onSaved(await saveTranslation(documentId, language, { title: title.trim(), content_html: html }));
    } catch (e) {
      setError(apiErrorText(e, TRANSLATION_ERRORS));
      setSaving(false);
    }
  };

  const stale = loaded !== null && loaded.current_version_no !== null
    && loaded.version_no !== loaded.current_version_no;

  return (
    <LearningModal eyebrow="Translations" title={`Edit ${name} translation`}
                   label={`Edit ${name} translation`}
                   description={stale
                     ? `This translates version ${loaded?.version_no}. Saving it updates it for version ${loaded?.current_version_no}.`
                     : 'Saving makes this a draft; send it for review to publish it.'}
                   onClose={onClose} busy={saving} wide
                   footer={(
                     <>
                       <button type="button" className="btn-solid" onClick={() => void save()}
                               disabled={loading || saving}>
                         {saving ? 'Saving…' : 'Save translation'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                       {error && <span className="pf-error" role="alert">{error}</span>}
                     </>
                   )}>
      <div className="lrn-edit">
        <div className="pf-form">
          <div className="full">
            <label htmlFor="lrn-tr-title">Title</label>
            <input id="lrn-tr-title" value={title} maxLength={200} disabled={loading || saving}
                   dir={textDir(language)} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="full">
            <label htmlFor="lrn-tr-html">HTML</label>
            <textarea id="lrn-tr-html" className="lrn-html" rows={14} value={html} spellCheck={false}
                      disabled={loading || saving} dir={textDir(language)}
                      onChange={(e) => setHtml(e.target.value)} />
          </div>
        </div>
        <div className="lrn-edit-preview">
          <span className="lrn-lbl">Preview</span>
          <iframe title="Translation preview" className="lrn-frame" sandbox=""
                  srcDoc={previewDocument(html, language)} />
        </div>
      </div>
    </LearningModal>
  );
}
