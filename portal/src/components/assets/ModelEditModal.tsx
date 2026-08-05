/**
 * ModelEditModal — the only place a catalog make/model is ever mutated:
 * field edits and the aliases list. `model === null` opens the modal in
 * create mode; once createAssetModel succeeds the modal flips itself to
 * edit mode for the created record (see the needsModelCreate trap in
 * lib/assets.ts) so a retry after a failed alias-save step never
 * re-creates the model. Follows the modal-scrim/modal-card/modal-head/
 * modal-body/modal-foot conventions from SiteEditModal.tsx.
 *
 * Dual-unit weight/dimension inputs are display convenience only — each
 * side is a real, independently-editable form field; the OTHER side's
 * live-converted value is shown as a hint (via `partnerFor`), never
 * written back into the form, so `modelPayload` still sends only the
 * side the user actually touched and lets the API compute its partner.
 */

import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import {
  ApiError,
  createAssetModel,
  setAssetModelAliases,
  updateAssetModel,
  type AssetCategoryOut,
  type AssetModelItem,
} from '../../lib/api';
import {
  formFromModel, formatDims, IN_TO_CM, LB_TO_KG, modelPayload, needsModelCreate, parseDims,
  partnerFor, type ModelFormState,
} from '../../lib/assets';
import ComboBox from '../ComboBox';

interface Props {
  model: AssetModelItem | null;   // null = create mode
  categories: AssetCategoryOut[];
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

const MOUNT_TYPES = [
  { value: 'rails', label: 'Rails' },
  { value: 'ears', label: 'Ears' },
  { value: 'shelf', label: 'Shelf' },
  { value: 'custom', label: 'Custom' },
];

const MODEL_ERRORS: Record<string, string> = {
  duplicate_model: 'A model with this make + model already exists.',
  unknown_category: 'Pick a category from the list.',
  unknown_mount_type: 'Mount type must be rails, ears, shelf, or custom.',
  alias_in_use: 'One of these aliases already belongs to another model.',
  make_required: 'Make is required.',
  model_required: 'Model is required.',
  forbidden: 'You do not have permission to change the catalog.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (MODEL_ERRORS[err.code] ?? fallback) : 'Network error.';
}

const toNum = (s: string): number | null => (s.trim() === '' ? null : Number(s));

const joinDims = (l: string, w: string, h: string): string =>
  (l !== '' && w !== '' && h !== '' ? `${l} x ${w} x ${h}` : '');

/** Order-independent, case-insensitive alias-set comparison. */
function sameAliasSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => sa.has(x.toLowerCase()));
}

export default function ModelEditModal({
  model, categories, canChange, onClose, onSaved,
}: Props) {
  const isCreateMode = model === null;

  const [createdId, setCreatedId] = useState<string | null>(null);
  const [createdModel, setCreatedModel] = useState<AssetModelItem | null>(null);
  const editingId = model?.id ?? createdId; // non-null once a record exists to edit
  const originalForDiff = model ?? createdModel; // diff baseline: server record, or the
                                                   // just-created one when recovering
  const needsCreate = needsModelCreate({ isCreateMode, createdId });

  const [form, setForm] = useState<ModelFormState>(() => formFromModel(model));
  const [aliases, setAliases] = useState<string[]>(() => model?.aliases ?? []);
  const [aliasInput, setAliasInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [dimsImpText, setDimsImpText] = useState(
    () => joinDims(form.length_in, form.width_in, form.height_in));
  const [dimsMetText, setDimsMetText] = useState(
    () => joinDims(form.length_cm, form.width_cm, form.height_cm));
  const [dimsImpWarn, setDimsImpWarn] = useState(false);
  const [dimsMetWarn, setDimsMetWarn] = useState(false);

  // Which side the user last touched — drives which side's preview shows,
  // without a server round-trip.
  const weightEdited = useRef<'imp' | 'met' | null>(null);
  const dimsEdited = useRef<'imp' | 'met' | null>(null);

  const locked = saving || (!needsCreate && !canChange);

  const setField = (key: keyof ModelFormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onWeightLbChange = (v: string) => {
    weightEdited.current = 'imp';
    setField('weight_lbs', v);
  };
  const onWeightKgChange = (v: string) => {
    weightEdited.current = 'met';
    setField('weight_kg', v);
  };
  const previewKg = weightEdited.current === 'imp'
    ? partnerFor(toNum(form.weight_lbs), LB_TO_KG, true) : null;
  const previewLb = weightEdited.current === 'met'
    ? partnerFor(toNum(form.weight_kg), LB_TO_KG, false) : null;

  const onImpDimChange = (key: 'length_in' | 'width_in' | 'height_in', v: string) => {
    dimsEdited.current = 'imp';
    setField(key, v);
  };
  const onMetDimChange = (key: 'length_cm' | 'width_cm' | 'height_cm', v: string) => {
    dimsEdited.current = 'met';
    setField(key, v);
  };
  const previewMet = dimsEdited.current === 'imp'
    ? formatDims(
        partnerFor(toNum(form.length_in), IN_TO_CM, true),
        partnerFor(toNum(form.width_in), IN_TO_CM, true),
        partnerFor(toNum(form.height_in), IN_TO_CM, true),
        'cm',
      )
    : null;
  const previewImp = dimsEdited.current === 'met'
    ? formatDims(
        partnerFor(toNum(form.length_cm), IN_TO_CM, false),
        partnerFor(toNum(form.width_cm), IN_TO_CM, false),
        partnerFor(toNum(form.height_cm), IN_TO_CM, false),
        'in',
      )
    : null;

  const onDimsBlur = (unit: 'imp' | 'met') => {
    const text = unit === 'imp' ? dimsImpText : dimsMetText;
    const parsed = parseDims(text);
    if (!parsed) {
      (unit === 'imp' ? setDimsImpWarn : setDimsMetWarn)(text.trim() !== '');
      return;
    }
    (unit === 'imp' ? setDimsImpWarn : setDimsMetWarn)(false);
    const [l, w, h] = parsed;
    dimsEdited.current = unit;
    if (unit === 'imp') {
      setForm((f) => ({ ...f, length_in: String(l), width_in: String(w), height_in: String(h) }));
    } else {
      setForm((f) => ({ ...f, length_cm: String(l), width_cm: String(w), height_cm: String(h) }));
    }
  };

  const addAlias = () => {
    const v = aliasInput.trim();
    if (!v) return;
    if (!aliases.some((a) => a.toLowerCase() === v.toLowerCase())) {
      setAliases((list) => [...list, v]);
    }
    setAliasInput('');
  };
  const onAliasKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); addAlias(); }
  };
  const removeAlias = (a: string) => setAliases((list) => list.filter((x) => x !== a));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    const payload = modelPayload(form, needsCreate ? null : originalForDiff);
    const baselineAliases = needsCreate ? [] : (originalForDiff?.aliases ?? []);
    const aliasesChanged = !sameAliasSet(baselineAliases, aliases);

    if (!needsCreate && Object.keys(payload).length === 0 && !aliasesChanged) {
      setSaving(false);
      onClose();
      return;
    }

    let id = editingId;
    try {
      if (needsCreate) {
        const created = await createAssetModel(payload);
        id = created.id;
        setCreatedId(created.id);
        setCreatedModel(created);
      } else if (Object.keys(payload).length > 0) {
        await updateAssetModel(id as string, payload);
      }
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
      setSaving(false);
      return;
    }

    if (aliasesChanged && id) {
      try {
        await setAssetModelAliases(id, aliases);
      } catch (err) {
        setError(`Model saved, but: ${mapError(err, 'could not save aliases — try again.')}`);
        setSaving(false);
        await onSaved();   // the model fields already persisted — reflect them
        return;
      }
    }

    setError('');
    await onSaved();
    setSaving(false);
    onClose();
  };

  const title = editingId ? `Edit — ${form.make} ${form.model}` : 'New model';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="modal-section">Identity</div>
            <div className="pf-form">
              <div><label>Make *</label>
                <input value={form.make} disabled={locked} required
                       onChange={(e) => setField('make', e.target.value)} /></div>
              <div><label>Model *</label>
                <input value={form.model} disabled={locked} required
                       onChange={(e) => setField('model', e.target.value)} /></div>
              <div><label>Category</label>
                <ComboBox
                  placeholder="Type to search categories…"
                  value={form.category}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('category', v)}
                  options={categories.map((c) => ({ value: c.key, label: c.label }))}
                /></div>
              <div><label>RU size</label>
                <input inputMode="numeric" value={form.ru_size} disabled={locked}
                       onChange={(e) => setField('ru_size', e.target.value)} /></div>
            </div>

            <div className="modal-section">Weight</div>
            <div className="pf-form">
              <div><label>Weight (lb)</label>
                <input inputMode="decimal" value={form.weight_lbs} disabled={locked}
                       onChange={(e) => onWeightLbChange(e.target.value)} />
                {previewLb !== null && <p className="set-note">≈ {previewLb} lb</p>}</div>
              <div><label>Weight (kg)</label>
                <input inputMode="decimal" value={form.weight_kg} disabled={locked}
                       onChange={(e) => onWeightKgChange(e.target.value)} />
                {previewKg !== null && <p className="set-note">≈ {previewKg} kg</p>}</div>
            </div>

            <div className="modal-section">Dimensions</div>
            <div className="pf-form">
              <div className="full"><label>Imperial — L x W x H (in)</label>
                <input placeholder="e.g. 32 x 1.5 x 18.5" value={dimsImpText} disabled={locked}
                       onChange={(e) => setDimsImpText(e.target.value)}
                       onBlur={() => onDimsBlur('imp')} />
                {dimsImpWarn && (
                  <span className="pf-error">Couldn&apos;t parse — use L x W x H.</span>
                )}
                {previewImp !== null && <p className="set-note">≈ {previewImp}</p>}</div>
              <div><label>Length (in)</label>
                <input inputMode="decimal" value={form.length_in} disabled={locked}
                       onChange={(e) => onImpDimChange('length_in', e.target.value)} /></div>
              <div><label>Width (in)</label>
                <input inputMode="decimal" value={form.width_in} disabled={locked}
                       onChange={(e) => onImpDimChange('width_in', e.target.value)} /></div>
              <div><label>Height (in)</label>
                <input inputMode="decimal" value={form.height_in} disabled={locked}
                       onChange={(e) => onImpDimChange('height_in', e.target.value)} /></div>

              <div className="full"><label>Metric — L x W x H (cm)</label>
                <input placeholder="e.g. 81.28 x 3.81 x 46.99" value={dimsMetText} disabled={locked}
                       onChange={(e) => setDimsMetText(e.target.value)}
                       onBlur={() => onDimsBlur('met')} />
                {dimsMetWarn && (
                  <span className="pf-error">Couldn&apos;t parse — use L x W x H.</span>
                )}
                {previewMet !== null && <p className="set-note">≈ {previewMet}</p>}</div>
              <div><label>Length (cm)</label>
                <input inputMode="decimal" value={form.length_cm} disabled={locked}
                       onChange={(e) => onMetDimChange('length_cm', e.target.value)} /></div>
              <div><label>Width (cm)</label>
                <input inputMode="decimal" value={form.width_cm} disabled={locked}
                       onChange={(e) => onMetDimChange('width_cm', e.target.value)} /></div>
              <div><label>Height (cm)</label>
                <input inputMode="decimal" value={form.height_cm} disabled={locked}
                       onChange={(e) => onMetDimChange('height_cm', e.target.value)} /></div>
            </div>

            <div className="modal-section">Mounting</div>
            <div className="pf-form">
              <div><label>Mount type</label>
                <select className="org-select" value={form.mount_type} disabled={locked}
                        onChange={(e) => setField('mount_type', e.target.value)}>
                  <option value="">No mount type set</option>
                  {MOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select></div>
              <div><label>Rail type</label>
                <input value={form.rail_type} disabled={locked}
                       onChange={(e) => setField('rail_type', e.target.value)} /></div>
            </div>

            <div className="modal-section">Field knowledge</div>
            <div className="pf-form">
              <div className="full">
                <textarea rows={5} value={form.knowledge} disabled={locked}
                          onChange={(e) => setField('knowledge', e.target.value)} />
              </div>
            </div>

            <div className="modal-section">Aliases</div>
            <div className="pf-form">
              <div className="full">
                <div className="chips" style={{ marginBottom: 8 }}>
                  {aliases.length === 0 && <span className="chip tag">No aliases</span>}
                  {aliases.map((a) => (
                    <span key={a} className="chip tag tag-chip">
                      {a}
                      {!locked && (
                        <button type="button" aria-label={`Remove ${a}`}
                                onClick={() => removeAlias(a)}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                               strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input placeholder="Add an alias…" value={aliasInput} disabled={locked}
                         onChange={(e) => setAliasInput(e.target.value)}
                         onKeyDown={onAliasKey} />
                  <button type="button" className="mini-btn" disabled={locked || !aliasInput.trim()}
                          onClick={addAlias}>
                    Add
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (needsCreate ? 'Create model' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
