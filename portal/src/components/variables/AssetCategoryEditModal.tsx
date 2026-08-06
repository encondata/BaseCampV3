/**
 * AssetCategoryEditModal — create/edit for a single asset_categories row.
 * `value === null` opens the modal in create mode; once createAssetCategory
 * succeeds the modal flips itself to edit mode for the created record (the
 * needsAssetCategoryCreate trap in lib/variables.ts) so a retry after a
 * later failure never re-creates the row. `key` is a slug and an FK target
 * (asset_models.category) — free text in create mode, immutable after.
 *
 * Mirrors SiteTypeEditModal.tsx minus the icon column.
 */

import { useState, type FormEvent } from 'react';

import {
  ApiError,
  createAssetCategory,
  updateAssetCategory,
  type AssetCategoryOut,
} from '../../lib/api';
import {
  PRESET_COLORS,
  assetCategoryCreatePayload,
  assetCategoryFormFromValue,
  assetCategoryUpdatePayload,
  needsAssetCategoryCreate,
  parseSortOrder,
  type AssetCategoryForm,
} from '../../lib/variables';
import ColorField from './ColorField';

interface Props {
  value: AssetCategoryOut | null;   // null = create mode
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

const CATEGORY_ERRORS: Record<string, string> = {
  asset_category_exists: 'That key already exists.',
  asset_category_not_found: 'That category no longer exists.',
  label_required: 'Label cannot be empty.',
  forbidden: 'You do not have permission to change asset categories.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (CATEGORY_ERRORS[err.code] ?? fallback) : 'Network error.';
}

const emptyForm: AssetCategoryForm = {
  key: '', label: '', description: '', sort_order: '0',
  color: PRESET_COLORS[0].value,
};

export default function AssetCategoryEditModal({ value, canChange, onClose, onSaved }: Props) {
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdValue, setCreatedValue] = useState<AssetCategoryOut | null>(null);
  const original = value ?? createdValue;

  const [form, setForm] = useState<AssetCategoryForm>(
    () => (value ? assetCategoryFormFromValue(value) : emptyForm));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isCreate = needsAssetCategoryCreate(value, createdKey);
  const locked = saving || (!isCreate && !canChange);

  const setField = (key: keyof AssetCategoryForm, val: string) =>
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
      if (needsAssetCategoryCreate(value, createdKey)) {
        const created = await createAssetCategory(assetCategoryCreatePayload(form));
        // Store immediately — before onSaved's refetch can fail — so a
        // retry after a later failure PATCHes instead of re-creating.
        setCreatedKey(created.key);
        setCreatedValue(created);
        await onSaved();
        onClose();
        return;
      }

      const target = original as AssetCategoryOut;
      const patch = assetCategoryUpdatePayload(form, target);
      if (Object.keys(patch).length > 0) {
        await updateAssetCategory(target.key, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const title = original ? `Edit — ${form.label || original.key}` : 'New asset category';

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
                <label>Sort order *</label>
                <input type="number" min="0" step="1" value={form.sort_order} disabled={locked}
                       onChange={(e) => setField('sort_order', e.target.value)} />
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
                <label>Colour</label>
                <ColorField value={form.color} disabled={locked}
                            onChange={(hex) => setField('color', hex)} />
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreate ? 'Create category' : 'Save')}
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
