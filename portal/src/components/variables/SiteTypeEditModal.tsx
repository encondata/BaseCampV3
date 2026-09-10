/**
 * SiteTypeEditModal — create/edit for a single site_types row.
 * `value === null` opens the modal in create mode; once createSiteType
 * succeeds the modal flips itself to edit mode for the created record (the
 * needsSiteTypeCreate trap in lib/variables.ts) so a retry after a later
 * failure (e.g. the parent's refetch throwing) never re-creates the row.
 * `key` is a slug and an FK target (sites.site_type) — free text in create
 * mode, immutable text after.
 *
 * Mirrors StatusEditModal.tsx; see that file's header for the pattern.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, createSiteType, updateSiteType, type SiteLookup } from '../../lib/api';
import {
  PRESET_COLORS,
  needsSiteTypeCreate,
  parseSortOrder,
  siteTypeCreatePayload,
  siteTypeFormFromValue,
  siteTypeUpdatePayload,
  type SiteTypeForm,
} from '../../lib/variables';
import ColorField from './ColorField';

interface Props {
  value: SiteLookup | null;   // null = create mode
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

const SITE_TYPE_ERRORS: Record<string, string> = {
  site_type_exists: 'That key already exists.',
  site_type_not_found: 'That site type no longer exists.',
  label_required: 'Label cannot be empty.',
  forbidden: 'You do not have permission to change site types.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (SITE_TYPE_ERRORS[err.code] ?? fallback) : 'Network error.';
}

const emptyForm: SiteTypeForm = {
  key: '', label: '', description: '', sort_order: '0', icon: '',
  color: PRESET_COLORS[0].value,
};

export default function SiteTypeEditModal({ value, canChange, onClose, onSaved }: Props) {
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdValue, setCreatedValue] = useState<SiteLookup | null>(null);
  // non-null once a record exists to edit — either passed in, or created
  // earlier in this modal session.
  const original = value ?? createdValue;

  const [form, setForm] = useState<SiteTypeForm>(
    () => (value ? siteTypeFormFromValue(value) : emptyForm));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isCreate = needsSiteTypeCreate(value, createdKey);
  const locked = saving || (!isCreate && !canChange);

  const setField = (key: keyof SiteTypeForm, val: string) =>
    setForm((f) => ({ ...f, [key]: val }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (parseSortOrder(form.sort_order) === null) {
      setError('Sort order must be zero or a positive whole number.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (needsSiteTypeCreate(value, createdKey)) {
        const created = await createSiteType(siteTypeCreatePayload(form));
        // Store immediately — before anything else (onSaved's refetch) can
        // fail — so a retry after a later failure PATCHes instead of
        // re-creating.
        setCreatedKey(created.key);
        setCreatedValue(created);
        await onSaved();
        onClose();
        return;
      }

      const target = original as SiteLookup;
      const patch = siteTypeUpdatePayload(form, target);
      if (Object.keys(patch).length > 0) {
        await updateSiteType(target.key, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const title = original ? `Edit — ${form.label || original.key}` : 'New site type';

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
              <div>
                <label>Icon</label>
                <input value={form.icon} disabled={locked}
                       onChange={(e) => setField('icon', e.target.value)} />
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
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreate ? 'Create site type' : 'Save')}
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
