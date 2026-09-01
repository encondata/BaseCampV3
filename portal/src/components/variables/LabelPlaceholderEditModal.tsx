/**
 * LabelPlaceholderEditModal — create/edit for a single label_placeholders
 * row. `value === null` opens the modal in create mode; once
 * createLabelPlaceholder succeeds the modal flips itself to edit mode for
 * the created record so a retry after a later failure (e.g. the parent's
 * refetch throwing) never re-creates the row.
 *
 * `applies_to` is a checkbox per `typeOptions` row (the kind='type' vocab)
 * rather than free text — the server 422s (`bad_applies_to`) on any key
 * that isn't a live type.
 *
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * conventions from StatusEditModal.tsx.
 */

import { useState, type FormEvent } from 'react';

import {
  ApiError, createLabelPlaceholder, updateLabelPlaceholder,
  type LabelPlaceholder, type LabelVocab,
} from '../../lib/api';

interface Props {
  value: LabelPlaceholder | null;   // null = create mode
  typeOptions: LabelVocab[];        // kind='type' rows, for applies_to
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

const PLACEHOLDER_ERRORS: Record<string, string> = {
  label_placeholder_exists: 'A placeholder with this key already exists.',
  bad_applies_to: 'One of the selected label types no longer exists.',
  unknown_placeholder: 'That placeholder no longer exists.',
  forbidden: 'You do not have permission to change label variables.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (PLACEHOLDER_ERRORS[err.code] ?? fallback) : 'Network error.';
}

interface Form {
  key: string; label: string; description: string; sample_value: string;
  applies_to: string[]; sort_order: string; is_active: boolean;
}

const emptyForm: Form = {
  key: '', label: '', description: '', sample_value: '',
  applies_to: [], sort_order: '0', is_active: true,
};

function formFromValue(p: LabelPlaceholder): Form {
  return {
    key: p.key, label: p.label, description: p.description,
    sample_value: p.sample_value, applies_to: p.applies_to,
    sort_order: String(p.sort_order), is_active: p.is_active,
  };
}

function parseSortOrder(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

const KEY_PATTERN = /^[a-z0-9_]+$/;

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

export default function LabelPlaceholderEditModal({
  value, typeOptions, canChange, onClose, onSaved,
}: Props) {
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdValue, setCreatedValue] = useState<LabelPlaceholder | null>(null);
  // non-null once a record exists to edit — either passed in, or created
  // earlier in this modal session.
  const original = value ?? createdValue;

  const [form, setForm] = useState<Form>(() => (value ? formFromValue(value) : emptyForm));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isCreate = value === null && createdKey === null;
  const locked = saving || (!isCreate && !canChange);

  const setField = <K extends keyof Form>(key: K, val: Form[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const toggleAppliesTo = (key: string) =>
    setForm((f) => ({
      ...f,
      applies_to: f.applies_to.includes(key)
        ? f.applies_to.filter((k) => k !== key)
        : [...f.applies_to, key],
    }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (isCreate && !KEY_PATTERN.test(form.key.trim())) {
      setError('Key must be lowercase letters, numbers, and underscores only.');
      return;
    }
    const sortOrder = parseSortOrder(form.sort_order);
    if (sortOrder === null) {
      setError('Sort order must be zero or a positive whole number.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isCreate) {
        const created = await createLabelPlaceholder({
          key: form.key, label: form.label, description: form.description,
          sample_value: form.sample_value, applies_to: form.applies_to,
          sort_order: sortOrder,
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

      const target = original as LabelPlaceholder;
      const patch: Record<string, unknown> = {};
      if (form.label !== target.label) patch.label = form.label;
      if (form.description !== target.description) patch.description = form.description;
      if (form.sample_value !== target.sample_value) patch.sample_value = form.sample_value;
      if (!sameStrings(form.applies_to, target.applies_to)) patch.applies_to = form.applies_to;
      if (sortOrder !== target.sort_order) patch.sort_order = sortOrder;
      if (form.is_active !== target.is_active) patch.is_active = form.is_active;
      if (Object.keys(patch).length > 0) {
        await updateLabelPlaceholder(target.key, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const title = original ? `Edit — ${form.label || original.key}` : 'New placeholder';

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
                         pattern="[a-z0-9_]+"
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

              <div className="full">
                <label>Sample value</label>
                <input value={form.sample_value} disabled={locked}
                       onChange={(e) => setField('sample_value', e.target.value)} />
              </div>

              <div className="full">
                <label>Applies to</label>
                <div className="chips">
                  {typeOptions.length === 0 && (
                    <span className="set-note" style={{ padding: 0 }}>
                      No label types defined yet.
                    </span>
                  )}
                  {typeOptions.map((t) => (
                    <label key={t.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={form.applies_to.includes(t.key)}
                             disabled={locked}
                             onChange={() => toggleAppliesTo(t.key)} />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>

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
                      this placeholder.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreate ? 'Create placeholder' : 'Save')}
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
