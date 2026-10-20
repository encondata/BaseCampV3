/**
 * A code template's editor (/labels/templates/:id/code), the "Edit as raw
 * ZPL" escape hatch of spec §4.11: name, description, the type/size/DPI/
 * language selectors, sites and the printer code itself, with the
 * generated-code panel (sample compile + Labelary preview). New templates
 * are designs made in the label builder (pages/LabelBuilder.tsx); a design
 * template opened here goes there. A code template's generation_rules are
 * kept as they are (the API still takes them).
 */

import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import CodePanel from '../components/labels/CodePanel';
import TagInput from '../components/TagInput';
import {
  ApiError, getLabelTemplate, listLabelVocab, listSites, updateLabelTemplate,
  type LabelVocab, type SiteItem,
} from '../lib/api';
import { vocabOfKind, type VocabKind } from '../lib/labels';
import '../styles/labels.css';

const SAVE_ERROR_MAP: Record<string, string> = {
  label_template_exists: 'A template with this name already exists.',
  unknown_vocab: 'One of the selected options no longer exists.',
  active_conflict: 'Another active template already prints this family, type and DPI.',
};

interface Meta {
  name: string;
  description: string;
  label_type: string;
  size_key: string;
  dpi_key: string;
  language_key: string;
}

export default function LabelTemplateEditor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [vocab, setVocab] = useState<LabelVocab[] | null>(null);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [meta, setMeta] = useState<Meta>({
    name: '', description: '', label_type: '', size_key: '', dpi_key: '', language_key: '',
  });
  const [design, setDesign] = useState(false);
  const [codeText, setCodeText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [v, s, t] = await Promise.all([
          listLabelVocab(), listSites().catch(() => []), getLabelTemplate(id),
        ]);
        if (cancelled) return;
        if (t.kind !== 'code') {
          setDesign(true);
          return;
        }
        setVocab(v);
        setSites(s);
        setMeta({
          name: t.name, description: t.description, label_type: t.label_type,
          size_key: t.size_key, dpi_key: t.dpi_key, language_key: t.language_key,
        });
        setSiteIds(t.site_ids);
        setCodeText(t.code ?? '');
      } catch {
        if (!cancelled) setLoadError("Couldn't load the template.");
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await updateLabelTemplate(id, { ...meta, site_ids: siteIds, code: codeText });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(SAVE_ERROR_MAP[err.code] ?? 'Save failed.');
      } else {
        setError('Network error.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (design) return <Navigate to={`/labels/templates/${id}/edit`} replace />;

  if (loadError) {
    return (
      <div className="portal-page">
        <div className="dir-empty">{loadError}</div>
      </div>
    );
  }

  if (!vocab) {
    return <div className="portal-page" />;
  }

  // A template's current vocab value may have since been deactivated; the
  // active-only list would then have no matching <option> and the select
  // would render blank even though meta.<field> holds a valid value, so
  // that row is spliced back in from the full list.
  const withCurrent = (kind: VocabKind, currentKey: string) => {
    const options = vocabOfKind(vocab, kind);
    if (options.some((v) => v.key === currentKey)) return options;
    const row = vocabOfKind(vocab, kind, { activeOnly: false }).find((v) => v.key === currentKey);
    return row ? [...options, row] : options;
  };
  const select = (kind: VocabKind, field: keyof Meta, label: string) => (
    <>
      <label htmlFor={`tpl-${kind}`}>{label}</label>
      <select id={`tpl-${kind}`} value={meta[field]}
              onChange={(e) => setMeta((m) => ({ ...m, [field]: e.target.value }))}>
        {withCurrent(kind, meta[field]).map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
      </select>
    </>
  );

  return (
    <div className="portal-page">
      <div className="label-editor-top">
        <button type="button" className="mini-btn" onClick={() => navigate('/labels/templates')}>
          ← Back
        </button>
        <input id="tpl-name" aria-label="Name" value={meta.name}
               onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))} />
        <input id="tpl-description" aria-label="Description" value={meta.description}
               onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))} />
        {select('type', 'label_type', 'Type')}
        {select('size', 'size_key', 'Size')}
        {select('dpi', 'dpi_key', 'DPI')}
        {select('language', 'language_key', 'Language')}
        <button type="button" className="btn-solid"
                disabled={saving || !can('labels', 'change')}
                onClick={() => void save()}>
          Save
        </button>
        {error && <span className="pf-error">{error}</span>}
      </div>

      <div className="label-editor-sites">
        <span className="eyebrow-sm">Sites</span>
        <TagInput value={siteIds} onChange={setSiteIds}
                  options={sites.map((s) => ({ value: s.id, label: s.name }))}
                  placeholder={siteIds.length ? 'Add a site…' : 'All sites — add to narrow'} />
      </div>

      <div className="label-editor-code">
        <label htmlFor="tpl-code">Template code</label>
        <textarea id="tpl-code" className="mono" rows={18} value={codeText}
                  onChange={(e) => setCodeText(e.target.value)} />
      </div>
      <CodePanel codeText={codeText} sizeKey={meta.size_key} dpiKey={meta.dpi_key}
                 languageKey={meta.language_key} />
    </div>
  );
}
