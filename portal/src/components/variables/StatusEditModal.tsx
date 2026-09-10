/**
 * StatusEditModal — create/edit for a single status_values row.
 * `value === null` opens the modal in create mode; once createStatusValue
 * succeeds the modal flips itself to edit mode for the created record (the
 * needsStatusCreate trap in lib/variables.ts) so a retry after a later
 * failure (e.g. the parent's refetch throwing) never re-creates the row.
 *
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * conventions from components/sites/SiteEditModal.tsx.
 */

import { useEffect, useState, type FormEvent } from 'react';

import {
  ApiError,
  createStatusValue,
  updateStatusValue,
  type StatusValue,
  listStatusRecordTypes,
  type StatusRecordType,
} from '../../lib/api';
import {
  PRESET_COLORS,
  needsStatusCreate,
  parseProgressWeight,
  parseSortOrder,
  statusCreatePayload,
  statusFormFromValue,
  statusUpdatePayload,
  type StatusForm,
} from '../../lib/variables';
import ColorField from './ColorField';

interface Props {
  value: StatusValue | null;   // null = create mode
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

// Record types are a code registry on the API side (status/registry.py);
// the modal reads it via GET /status-values/record-types so every record
// type is offered and a deploy that adds one needs no portal change.

const STATUS_ERRORS: Record<string, string> = {
  status_value_exists: 'That key already exists for this record type.',
  status_value_not_found: 'That status value no longer exists.',
  unknown_record_type: 'That record type is not recognized.',
  invalid_progress_weight: 'Progress weight must be between 0 and 100, or left blank.',
  forbidden: 'You do not have permission to change the vocabulary.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (STATUS_ERRORS[err.code] ?? fallback) : 'Network error.';
}

// `color` is a free-picked hex now (see ColorField) — render it directly
// rather than resolving it as a --c-* token name.
export function ColorSwatch({ color, title }: { color: string; title?: string }) {
  return (
    <span className="color-swatch" style={{ background: color }}
          title={title ?? color} />
  );
}

const emptyForm: StatusForm = {
  record_type: '', key: '', label: '', description: '',
  color: PRESET_COLORS[0].value, sort_order: '0', is_active: true,
  progress_weight: '',
};

export default function StatusEditModal({ value, canChange, onClose, onSaved }: Props) {
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [recordTypes, setRecordTypes] = useState<StatusRecordType[] | null>(null);
  const [recordTypesError, setRecordTypesError] = useState(false);
  useEffect(() => {
    let alive = true;
    listStatusRecordTypes()
      .then((types) => { if (alive) setRecordTypes(types); })
      .catch(() => { if (alive) setRecordTypesError(true); });
    return () => { alive = false; };
  }, []);
  const recordTypeLabel = (id: string) =>
    recordTypes?.find((t) => t.id === id)?.label ?? id;
  const [createdValue, setCreatedValue] = useState<StatusValue | null>(null);
  // non-null once a record exists to edit — either passed in, or created
  // earlier in this modal session.
  const original = value ?? createdValue;

  const [form, setForm] = useState<StatusForm>(
    () => (value ? statusFormFromValue(value) : emptyForm));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isCreate = needsStatusCreate(value, createdKey);
  const locked = saving || (!isCreate && !canChange);

  const setField = (key: keyof StatusForm, val: string) =>
    setForm((f) => ({ ...f, [key]: val }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (parseSortOrder(form.sort_order) === null) {
      setError('Sort order must be zero or a positive whole number.');
      return;
    }
    if (original?.record_type === 'asset'
        && parseProgressWeight(form.progress_weight) === undefined) {
      setError('Progress weight must be between 0 and 100, or left blank.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (needsStatusCreate(value, createdKey)) {
        const created = await createStatusValue(statusCreatePayload(form));
        // Store immediately — before anything else (onSaved's refetch) can
        // fail — so a retry after a later failure PATCHes instead of
        // re-creating.
        setCreatedKey(created.key);
        setCreatedValue(created);
        await onSaved();
        onClose();
        return;
      }

      const target = original as StatusValue;
      const patch = statusUpdatePayload(form, target);
      if (Object.keys(patch).length > 0) {
        await updateStatusValue(target.record_type, target.key, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const title = original ? `Edit — ${form.label || original.key}` : 'New status value';

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
                <label htmlFor="status-record-type">Record type *</label>
                {original ? (
                  <>
                    <p className="pf-static">
                      {recordTypeLabel(original.record_type)}
                    </p>
                    <p className="set-note" style={{ padding: 0, margin: '6px 0 0' }}>
                      Permanent — can&rsquo;t be changed once created.
                    </p>
                  </>
                ) : (
                  <>
                    <select id="status-record-type" className="org-select" required
                            value={form.record_type}
                            disabled={locked || recordTypes === null}
                            onChange={(e) => setField('record_type', e.target.value)}>
                      <option value="" disabled>
                        {recordTypes === null && !recordTypesError ? 'Loading record types…' : 'Select a record type…'}
                      </option>
                      {(recordTypes ?? []).map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    {recordTypesError && (
                      <p className="pf-error">Could not load record types — reload and try again.</p>
                    )}
                  </>
                )}
              </div>

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

              <div className="full">
                <label>Color</label>
                <ColorField value={form.color} disabled={locked}
                            onChange={(hex) => setField('color', hex)} />
              </div>

              <div>
                <label>Sort order *</label>
                <input type="number" min="0" step="1" value={form.sort_order} disabled={locked}
                       onChange={(e) => setField('sort_order', e.target.value)} />
              </div>

              {original?.record_type === 'asset' && (
                <div>
                  <label>Progress weight</label>
                  <input type="number" min="0" max="100" step="1"
                         value={form.progress_weight} disabled={locked}
                         placeholder="0-100, blank = excluded from progress"
                         onChange={(e) => setField('progress_weight', e.target.value)} />
                </div>
              )}

              {original && (
                <div className="full">
                  <label>
                    <input type="checkbox" checked={form.is_active} disabled={locked}
                           onChange={(e) =>
                             setForm((f) => ({ ...f, is_active: e.target.checked }))} />
                    Available in pickers
                  </label>
                  {!!original.usage_count && (
                    <p className="set-note" style={{ padding: 0, margin: '8px 0 0' }}>
                      {original.usage_count} record{original.usage_count === 1 ? '' : 's'} use
                      this value. They keep their label and colour.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreate ? 'Create status' : 'Save')}
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
