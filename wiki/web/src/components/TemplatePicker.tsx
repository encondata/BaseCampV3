/** A page's starting point: Blank first, then the space's builtin, other
 *  global and its own templates, in the order `listTemplates` returns them.
 *  Hovering or focusing an option loads and shows its content in the side
 *  pane (fetched once per template, then cached for the picker's life). */
import { useEffect, useRef, useState } from 'react';

import ReadOnlyDoc from '../editor/ReadOnlyDoc';
import { templateTitle } from '../lib/templateIcon';
import type { TemplateDetail, TemplateOut } from '../lib/types';
import { getTemplate, listTemplates } from '../lib/wikiApi';

export interface TemplatePickerProps {
  spaceKey: string;
  /** null = Blank page. */
  value: string | null;
  onChange: (templateId: string | null) => void;
}

type Templates = TemplateOut[] | 'loading' | 'error';

function scopeLabel(t: TemplateOut): string {
  if (t.is_builtin) return 'Built in';
  return t.space_id === null ? 'Global' : 'This space';
}

export default function TemplatePicker({ spaceKey, value, onChange }: TemplatePickerProps) {
  const [templates, setTemplates] = useState<Templates>('loading');
  // what the preview pane shows: starts on the current selection, then
  // follows hover/focus (never reset on mouse-out — the last one hovered
  // stays up, as in a normal preview pane)
  const [previewId, setPreviewId] = useState<string | null>(value);
  const cache = useRef(new Map<string, TemplateDetail>());
  const [preview, setPreview] = useState<TemplateDetail | null>(null);

  useEffect(() => {
    let live = true;
    setTemplates('loading');
    listTemplates(spaceKey).then((t) => { if (live) setTemplates(t); })
      .catch(() => { if (live) setTemplates('error'); });
    return () => { live = false; };
  }, [spaceKey]);

  useEffect(() => {
    if (!previewId) { setPreview(null); return undefined; }
    const cached = cache.current.get(previewId);
    if (cached) { setPreview(cached); return undefined; }
    setPreview(null);
    let live = true;
    getTemplate(previewId).then((t) => {
      cache.current.set(previewId, t);
      if (live) setPreview(t);
    }).catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [previewId]);

  return (
    <div className="wiki-template-picker">
      <div className="wiki-template-options" role="radiogroup" aria-label="Starting point">
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          className={`wiki-template-card${value === null ? ' selected' : ''}`}
          onClick={() => onChange(null)}
          onMouseEnter={() => setPreviewId(null)}
          onFocus={() => setPreviewId(null)}
        >
          <b>Blank page</b>
          <span>Start with nothing</span>
        </button>
        {templates === 'loading' && <p className="page-hint">Loading templates…</p>}
        {templates === 'error' && <p className="pf-error">Couldn't load templates.</p>}
        {Array.isArray(templates) && templates.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={value === t.id}
            className={`wiki-template-card${value === t.id ? ' selected' : ''}`}
            onClick={() => onChange(t.id)}
            onMouseEnter={() => setPreviewId(t.id)}
            onFocus={() => setPreviewId(t.id)}
          >
            <b>{templateTitle(t)}</b>
            <span>{t.description || scopeLabel(t)}</span>
          </button>
        ))}
      </div>
      <div className="wiki-template-preview">
        {!previewId && <p className="page-hint">A blank page — nothing to preview.</p>}
        {previewId && !preview && <p className="page-hint">Loading preview…</p>}
        {previewId && preview && <ReadOnlyDoc content={preview.content_json} />}
      </div>
    </div>
  );
}
