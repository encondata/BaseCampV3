/**
 * Label template editor — full-page builder shell. Top bar: name +
 * vocab-driven type/size/DPI/language selectors + Save. Design kind:
 * palette / canvas / properties (slots filled by Tasks 16-17) over a
 * CodePanel (Task 18). Code kind: a mono textarea (this file). The
 * element model lives in a useReducer over lib/labelModel; size changes
 * dispatch setSize so the canvas outline follows the size vocab row.
 */

import { useEffect, useReducer, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import CodePanel from '../components/labels/CodePanel';
import EditorCanvas from '../components/labels/EditorCanvas';
import ElementPalette from '../components/labels/ElementPalette';
import GenerationRulesPanel from '../components/labels/GenerationRulesPanel';
import PropertiesPanel from '../components/labels/PropertiesPanel';
import TagInput from '../components/TagInput';
import {
  ApiError, convertLabelTemplate, createLabelTemplate, getLabelTemplate, listLabelPlaceholders,
  listLabelVocab, listSites, updateLabelTemplate,
  type LabelPlaceholder, type LabelVocab, type SiteItem,
} from '../lib/api';
import { jsonToRuleRows, ruleRowsToJson, validateRuleRows, type GenerationRulesRows } from '../lib/generateLabels';
import { sizeMeta, vocabOfKind, type VocabKind } from '../lib/labels';
import {
  editorReducer, emptyDesign, initialEditorState, newElement, type LabelDesign,
} from '../lib/labelModel';
import '../styles/labels.css';

const ZOOM_OPTIONS = [1, 1.5, 2];

const SAVE_ERROR_MAP: Record<string, string> = {
  label_template_exists: 'A template with this name already exists.',
  bad_design: 'The design has invalid elements.',
  unknown_vocab: 'One of the selected options no longer exists.',
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
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const isCreate = !id;
  const [kind, setKind] = useState<'design' | 'code'>(
    (searchParams.get('kind') === 'code' ? 'code' : 'design'));
  const [vocab, setVocab] = useState<LabelVocab[] | null>(null);
  const [placeholders, setPlaceholders] = useState<LabelPlaceholder[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [rules, setRules] = useState<GenerationRulesRows>(jsonToRuleRows(undefined));
  const [meta, setMeta] = useState<Meta>({
    name: '', description: '', label_type: '', size_key: '', dpi_key: '', language_key: '',
  });
  const [state, dispatch] = useReducer(editorReducer, emptyDesign(4, 2), initialEditorState);
  const [zoom, setZoom] = useState(1);
  const [codeText, setCodeText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [v, p, s] = await Promise.all([
          listLabelVocab(), listLabelPlaceholders(), listSites().catch(() => []),
        ]);
        if (cancelled) return;
        setVocab(v);
        setPlaceholders(p);
        setSites(s);

        if (id) {
          const t = await getLabelTemplate(id);
          if (cancelled) return;
          setKind(t.kind);
          setMeta({
            name: t.name, description: t.description, label_type: t.label_type,
            size_key: t.size_key, dpi_key: t.dpi_key, language_key: t.language_key,
          });
          setSiteIds(t.site_ids);
          setRules(jsonToRuleRows(t.generation_rules));
          setCodeText(t.code ?? '');
          if (t.kind === 'design' && t.design) {
            dispatch({ type: 'replace', design: t.design as unknown as LabelDesign });
          }
        } else {
          setMeta((m) => ({
            ...m,
            label_type: vocabOfKind(v, 'type')[0]?.key ?? '',
            size_key: vocabOfKind(v, 'size')[0]?.key ?? '',
            dpi_key: vocabOfKind(v, 'dpi')[0]?.key ?? '',
            language_key: vocabOfKind(v, 'language')[0]?.key ?? '',
          }));
        }
      } catch {
        if (!cancelled) setLoadError("Couldn't load the label editor.");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleSizeChange = (sizeKey: string) => {
    setMeta((m) => ({ ...m, size_key: sizeKey }));
    const row = (vocab ?? []).find((v) => v.kind === 'size' && v.key === sizeKey);
    if (row) {
      const sm = sizeMeta(row);
      dispatch({ type: 'setSize', w: sm.width_in, h: sm.height_in });
    }
  };

  const rulesError = validateRuleRows(rules);

  const save = async () => {
    if (rulesError) return;
    setSaving(true);
    setError('');
    const body = {
      ...meta,
      kind,
      site_ids: siteIds,
      generation_rules: ruleRowsToJson(rules),
      design: kind === 'design' ? (state.design as unknown as Record<string, unknown>) : null,
      code: kind === 'code' ? codeText : null,
    };
    try {
      if (isCreate) {
        const created = await createLabelTemplate(body);
        navigate(`/labels/templates/${created.id}/edit`, { replace: true });
      } else {
        const { kind: _omit, ...patch } = body;
        await updateLabelTemplate(id, patch);
      }
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

  const convertToCode = async () => {
    if (!id) return;
    if (!window.confirm(
      'One-way: the draggable elements are discarded and this becomes a '
      + 'raw-code template. Unsaved canvas edits are not included. Continue?')) return;
    try {
      const t = await convertLabelTemplate(id);
      setKind('code');
      setCodeText(t.code ?? '');
      setError('');
    } catch {
      setError('Convert failed.');
    }
  };

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
  // would render blank even though meta.<field> holds a valid value. When
  // editing (not creating), splice that row back in from the full list.
  const withCurrent = (kind: VocabKind, options: LabelVocab[], currentKey: string) => {
    if (isCreate || options.some((v) => v.key === currentKey)) return options;
    const row = vocabOfKind(vocab, kind, { activeOnly: false })
      .find((v) => v.key === currentKey);
    return row ? [...options, row] : options;
  };
  const typeOptions = withCurrent('type', vocabOfKind(vocab, 'type'), meta.label_type);
  const sizeOptions = withCurrent('size', vocabOfKind(vocab, 'size'), meta.size_key);
  const dpiOptions = withCurrent('dpi', vocabOfKind(vocab, 'dpi'), meta.dpi_key);
  const languageOptions = withCurrent('language', vocabOfKind(vocab, 'language'), meta.language_key);
  const sizeRow = vocab.find((v) => v.kind === 'size' && v.key === meta.size_key);
  const hasTab = sizeRow ? sizeMeta(sizeRow).has_tab : false;
  const selected = state.design.elements.find((e) => e.id === state.selectedId) ?? null;

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
        <label htmlFor="tpl-type">Type</label>
        <select id="tpl-type" value={meta.label_type}
                onChange={(e) => setMeta((m) => ({ ...m, label_type: e.target.value }))}>
          {typeOptions.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
        <label htmlFor="tpl-size">Size</label>
        <select id="tpl-size" value={meta.size_key}
                onChange={(e) => handleSizeChange(e.target.value)}>
          {sizeOptions.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
        <label htmlFor="tpl-dpi">DPI</label>
        <select id="tpl-dpi" value={meta.dpi_key}
                onChange={(e) => setMeta((m) => ({ ...m, dpi_key: e.target.value }))}>
          {dpiOptions.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
        <label htmlFor="tpl-language">Language</label>
        <select id="tpl-language" value={meta.language_key}
                onChange={(e) => setMeta((m) => ({ ...m, language_key: e.target.value }))}>
          {languageOptions.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
        {kind === 'design' && (
          <>
            <label htmlFor="tpl-zoom">Zoom</label>
            <select id="tpl-zoom" value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}>
              {ZOOM_OPTIONS.map((z) => <option key={z} value={z}>{z}x</option>)}
            </select>
            <button type="button" className="mini-btn" disabled={state.past.length === 0}
                    onClick={() => dispatch({ type: 'undo' })}>
              Undo
            </button>
            <button type="button" className="mini-btn" disabled={state.future.length === 0}
                    onClick={() => dispatch({ type: 'redo' })}>
              Redo
            </button>
          </>
        )}
        {!isCreate && kind === 'design' && can('labels', 'change') && (
          <button className="mini-btn" type="button" onClick={() => void convertToCode()}>
            {meta.language_key === 'zpl' ? 'Edit as raw ZPL' : 'Edit as raw code'}
          </button>
        )}
        <button type="button" className="btn-solid"
                disabled={saving || !!rulesError || !can('labels', isCreate ? 'add' : 'change')}
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

      <GenerationRulesPanel rows={rules} onChange={setRules} />

      {kind === 'code' ? (
        <>
          <div className="label-editor-code">
            <label htmlFor="tpl-code">Template code</label>
            <textarea id="tpl-code" className="mono" rows={18} value={codeText}
                      onChange={(e) => setCodeText(e.target.value)} />
          </div>
          <CodePanel kind={kind} design={null}
                     codeText={codeText} sizeKey={meta.size_key} dpiKey={meta.dpi_key}
                     languageKey={meta.language_key} />
        </>
      ) : (
        <>
          <div className="label-editor-body">
            <ElementPalette
              onAdd={(t) => dispatch({ type: 'add', element: newElement(t, state.design) })}
              layers={state.design.elements}
              selectedId={state.selectedId}
              onSelect={(elId) => dispatch({ type: 'select', id: elId })}
              onReorder={(elId, dir) => dispatch({ type: 'reorder', id: elId, dir })}
              onRemove={(elId) => dispatch({ type: 'remove', id: elId })}
            />
            <EditorCanvas
              design={state.design}
              selectedId={state.selectedId}
              hasTab={hasTab}
              zoom={zoom}
              onSelect={(elId) => dispatch({ type: 'select', id: elId })}
              onPatch={(elId, patch) => dispatch({ type: 'patch', id: elId, patch })}
            />
            <PropertiesPanel
              element={selected}
              placeholders={placeholders}
              labelType={meta.label_type}
              onPatch={(elId, patch) => dispatch({ type: 'patch', id: elId, patch })}
              onRemove={(elId) => dispatch({ type: 'remove', id: elId })}
            />
          </div>
          <CodePanel kind={kind} design={kind === 'design' ? state.design : null}
                     codeText={codeText} sizeKey={meta.size_key} dpiKey={meta.dpi_key}
                     languageKey={meta.language_key} />
        </>
      )}
    </div>
  );
}
