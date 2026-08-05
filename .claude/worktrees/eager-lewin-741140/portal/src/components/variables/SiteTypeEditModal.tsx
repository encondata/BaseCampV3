/**
 * SiteTypeEditModal — edit-only. Site types have no create/delete path from
 * the portal (that's a deploy-time decision, like status record types), so
 * this modal never creates a row — it only PATCHes label/description/
 * sort_order/icon on an existing one. `key` is immutable (it's a path
 * param on the API, not a body field) and renders as plain text.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, updateSiteType, type SiteLookup } from '../../lib/api';
import {
  parseSortOrder,
  siteTypeFormFromValue,
  siteTypeUpdatePayload,
  type SiteTypeForm,
} from '../../lib/variables';

interface Props {
  value: SiteLookup;
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

const SITE_TYPE_ERRORS: Record<string, string> = {
  site_type_not_found: 'That site type no longer exists.',
  label_required: 'Label cannot be empty.',
  forbidden: 'You do not have permission to change site types.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (SITE_TYPE_ERRORS[err.code] ?? fallback) : 'Network error.';
}

export default function SiteTypeEditModal({ value, canChange, onClose, onSaved }: Props) {
  const [form, setForm] = useState<SiteTypeForm>(() => siteTypeFormFromValue(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const locked = saving || !canChange;

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
      const patch = siteTypeUpdatePayload(form, value);
      if (Object.keys(patch).length > 0) {
        await updateSiteType(value.key, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Edit — {form.label || value.key}</h3>
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
                <label>Key</label>
                <p className="pf-static mono">{value.key}</p>
                <p className="set-note" style={{ padding: 0, margin: '6px 0 0' }}>
                  Permanent — set at deploy time.
                </p>
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
              <div>
                <label>Sort order *</label>
                <input type="number" min="0" step="1" value={form.sort_order} disabled={locked}
                       onChange={(e) => setField('sort_order', e.target.value)} />
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
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
