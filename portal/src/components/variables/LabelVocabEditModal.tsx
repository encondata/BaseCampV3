/**
 * LabelVocabEditModal — create/edit for a single label_vocab row (one of
 * the four kinds: type, size, dpi, language). `value === null` opens the
 * modal in create mode; once createLabelVocab succeeds the modal flips
 * itself to edit mode for the created record so a retry after a later
 * failure (e.g. the parent's refetch throwing) never re-creates the row.
 *
 * Meta is kind-specific and built from its own fields on save:
 *   size:     { width_in, height_in, has_tab }
 *   dpi:      { dots }
 *   language: { family: 'zebra' | 'brother' }
 *   type:     no meta fields — {}
 *
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * conventions from StatusEditModal.tsx.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, createLabelVocab, updateLabelVocab, type LabelVocab } from '../../lib/api';
import { parseSortOrder } from '../../lib/variables';
import { sizeMeta, type VocabKind } from '../../lib/labels';

interface Props {
  kind: VocabKind;
  value: LabelVocab | null;   // null = create mode
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

const VOCAB_ERRORS: Record<string, string> = {
  label_vocab_exists: 'A value with this key already exists.',
  bad_meta: 'Check the size/DPI/family fields.',
  unknown_vocab: 'That value no longer exists.',
  forbidden: 'You do not have permission to change label variables.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (VOCAB_ERRORS[err.code] ?? fallback) : 'Network error.';
}

interface Form {
  key: string; label: string; description: string; sort_order: string; is_active: boolean;
  width_in: string; height_in: string; has_tab: boolean;   // size
  dots: string;                                             // dpi
  family: 'zebra' | 'brother';                              // language
}

function emptyForm(): Form {
  return {
    key: '', label: '', description: '', sort_order: '0', is_active: true,
    width_in: '4', height_in: '2', has_tab: false,
    dots: '203',
    family: 'zebra',
  };
}

function formFromValue(v: LabelVocab): Form {
  const base = emptyForm();
  if (v.kind === 'size') {
    const m = sizeMeta(v);
    base.width_in = String(m.width_in);
    base.height_in = String(m.height_in);
    base.has_tab = m.has_tab;
  } else if (v.kind === 'dpi') {
    base.dots = typeof v.meta.dots === 'number' ? String(v.meta.dots) : '203';
  } else if (v.kind === 'language') {
    base.family = v.meta.family === 'brother' ? 'brother' : 'zebra';
  }
  return {
    ...base,
    key: v.key, label: v.label, description: v.description,
    sort_order: String(v.sort_order), is_active: v.is_active,
  };
}

function buildMeta(kind: VocabKind, form: Form): Record<string, unknown> | null {
  if (kind === 'size') {
    const w = Number(form.width_in), h = Number(form.height_in);
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) return null;
    return { width_in: w, height_in: h, has_tab: form.has_tab };
  }
  if (kind === 'dpi') {
    const dots = Number(form.dots);
    if (!Number.isInteger(dots) || dots <= 0) return null;
    return { dots };
  }
  if (kind === 'language') {
    return { family: form.family };
  }
  return {};
}

export default function LabelVocabEditModal({ kind, value, canChange, onClose, onSaved }: Props) {
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdValue, setCreatedValue] = useState<LabelVocab | null>(null);
  // non-null once a record exists to edit — either passed in, or created
  // earlier in this modal session.
  const original = value ?? createdValue;

  const [form, setForm] = useState<Form>(() => (value ? formFromValue(value) : emptyForm()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isCreate = value === null && createdKey === null;
  const locked = saving || (!isCreate && !canChange);

  const setField = <K extends keyof Form>(key: K, val: Form[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const sortOrder = parseSortOrder(form.sort_order);
    if (sortOrder === null) {
      setError('Sort order must be zero or a positive whole number.');
      return;
    }
    const meta = buildMeta(kind, form);
    if (meta === null) {
      setError('Check the size/DPI/family fields.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isCreate) {
        const created = await createLabelVocab({
          kind, key: form.key, label: form.label, description: form.description,
          meta, sort_order: sortOrder,
        });
        // Store immediately — before anything else (onSaved's refetch) can
        // fail — so a retry after a later failure PATCHes instead of
        // re-creating.
        setCreatedKey(created.key);
        setCreatedValue(created);
        await onSaved();
        onClose();
        return;
      }

      const target = original as LabelVocab;
      const patch: Record<string, unknown> = {};
      if (form.label !== target.label) patch.label = form.label;
      if (form.description !== target.description) patch.description = form.description;
      if (sortOrder !== target.sort_order) patch.sort_order = sortOrder;
      if (form.is_active !== target.is_active) patch.is_active = form.is_active;
      if (JSON.stringify(meta) !== JSON.stringify(target.meta)) patch.meta = meta;
      if (Object.keys(patch).length > 0) {
        await updateLabelVocab(target.kind, target.key, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const title = original ? `Edit — ${form.label || original.key}` : `New ${kind} value`;

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
            <div className="modal-section">Details</div>
            <div className="pf-form">
              <div>
                <label>Key *</label>
                {original ? (
                  <>
                    <p className="pf-static mono">{original.key}</p>
                    <p className="set-note" style={{ padding: 0, margin: '6px 0 0' }}>
                      Permanent — can&rsquo;t be changed once created.
                    </p>
                  </>
                ) : (
                  <input value={form.key} required disabled={locked}
                         onChange={(e) => setField('key', e.target.value)} />
                )}
              </div>

              <div className="full">
                <label>Label *</label>
                <input value={form.label} required disabled={locked}
                       onChange={(e) => setField('label', e.target.value)} />
              </div>

              <div className="full">
                <label>Description</label>
                <textarea value={form.description} disabled={locked} rows={2}
                          onChange={(e) => setField('description', e.target.value)} />
              </div>

              {kind === 'size' && (
                <>
                  <div>
                    <label>Width (in) *</label>
                    <input type="number" min="0.1" step="any" value={form.width_in}
                           disabled={locked}
                           onChange={(e) => setField('width_in', e.target.value)} />
                  </div>
                  <div>
                    <label>Height (in) *</label>
                    <input type="number" min="0.1" step="any" value={form.height_in}
                           disabled={locked}
                           onChange={(e) => setField('height_in', e.target.value)} />
                  </div>
                  <div className="full">
                    <label>
                      <input type="checkbox" checked={form.has_tab} disabled={locked}
                             onChange={(e) => setField('has_tab', e.target.checked)} />
                      Has tab
                    </label>
                  </div>
                </>
              )}

              {kind === 'dpi' && (
                <div>
                  <label>Dots per inch *</label>
                  <input type="number" min="1" step="1" value={form.dots} disabled={locked}
                         onChange={(e) => setField('dots', e.target.value)} />
                </div>
              )}

              {kind === 'language' && (
                <div>
                  <label>Family *</label>
                  <select className="org-select" value={form.family} disabled={locked}
                          onChange={(e) => setField('family', e.target.value as Form['family'])}>
                    <option value="zebra">Zebra</option>
                    <option value="brother">Brother</option>
                  </select>
                </div>
              )}

              <div>
                <label>Sort order *</label>
                <input type="number" min="0" step="1" value={form.sort_order} disabled={locked}
                       onChange={(e) => setField('sort_order', e.target.value)} />
              </div>

              {original && (
                <div className="full">
                  <label>
                    <input type="checkbox" checked={form.is_active} disabled={locked}
                           onChange={(e) => setField('is_active', e.target.checked)} />
                    Available in pickers
                  </label>
                  {!!original.usage_count && (
                    <p className="set-note" style={{ padding: 0, margin: '8px 0 0' }}>
                      {original.usage_count} template{original.usage_count === 1 ? '' : 's'} use
                      this value.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreate ? 'Create value' : 'Save')}
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
