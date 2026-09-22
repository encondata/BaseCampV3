/**
 * AssetEditModal — the only place an asset is ever mutated: field edits
 * and archive/unarchive. `asset === null` opens the modal in create mode.
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * conventions from SiteEditModal.tsx.
 */

import { useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError,
  archiveAsset,
  createAsset,
  listAssetModels,
  updateAsset,
  type AssetItem,
  type AssetModelItem,
  type OrgRef,
  type SiteItem,
  type StatusValue,
} from '../../lib/api';
import { ASSET_ERRORS, assetPayload, formFromAsset, type AssetFormState } from '../../lib/assets';
import ComboBox from '../ComboBox';

interface Props {
  asset: AssetItem | null;        // null = create mode
  statuses: StatusValue[];
  clients: OrgRef[];
  sites: SiteItem[];
  existingSerials: Set<string>;   // lowercased serials currently in use, page-computed
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (ASSET_ERRORS[err.code] ?? fallback) : 'Network error.';
}

export default function AssetEditModal({
  asset, statuses, clients, sites, existingSerials, canChange, onClose, onSaved,
}: Props) {
  const { can } = useAuth();
  const canViewModels = can('asset_models', 'view');
  const isCreateMode = asset === null;

  const [form, setForm] = useState<AssetFormState>(() => formFromAsset(asset));
  const [archived, setArchived] = useState<boolean>(!!asset?.archived_at);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [serialWarning, setSerialWarning] = useState(false);
  const [models, setModels] = useState<AssetModelItem[] | null>(null);

  const locked = saving || (!isCreateMode && !canChange);

  const loadModels = () => {
    if (models !== null || !canViewModels) return;
    void listAssetModels().then(setModels).catch(() => {});
  };

  // Client actors never reach this modal (asset writes are staff-only), but
  // guard against fetching the catalog with no view permission anyway:
  // fall back to the asset's own embedded model ref as the sole option.
  const modelOptions = useMemo(() => {
    if (canViewModels) {
      return (models ?? []).map((m) => ({
        value: m.id, label: `${m.make} ${m.model}`, sub: m.category_label,
      }));
    }
    return asset?.model
      ? [{ value: asset.model.id, label: `${asset.model.make} ${asset.model.model}`,
           sub: asset.model.category_label }]
      : [];
  }, [canViewModels, models, asset]);

  // listAssetStatuses() filters to is_active, so an asset sitting on a
  // retired status isn't in it — seed the option back from the row, same
  // trap/fix as Workers.tsx's ProfileForm.
  const statusOptions = useMemo(() => {
    const list = asset && !statuses.some((s) => s.key === asset.status)
      ? [...statuses, { key: asset.status, label: asset.status_label } as StatusValue]
      : statuses;
    return list.map((s) => ({ value: s.key, label: s.label }));
  }, [statuses, asset]);

  const setField = (key: keyof AssetFormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onSerialBlur = () => {
    const v = form.serial_number.trim().toLowerCase();
    if (!v) { setSerialWarning(false); return; }
    const own = asset?.serial_number?.trim().toLowerCase();
    setSerialWarning(v !== own && existingSerials.has(v));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = assetPayload(form);
      if (isCreateMode) {
        await createAsset(payload);
      } else {
        await updateAsset(asset.id, payload);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async () => {
    if (!asset) return;
    setSaving(true);
    setError('');
    try {
      await archiveAsset(asset.id, !archived);
      setArchived((v) => !v);
      await onSaved();
    } catch (err) {
      setError(mapError(err, 'Could not change the archive state — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const title = asset ? `Edit — ${form.serial_number || form.name || 'Asset'}` : 'New asset';

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
              <div><label>Serial number</label>
                <input value={form.serial_number} disabled={locked}
                       onChange={(e) => { setField('serial_number', e.target.value); setSerialWarning(false); }}
                       onBlur={onSerialBlur} />
                {serialWarning && (
                  <span className="pf-error">
                    Another asset already has this serial — allowed, but check it&apos;s not a re-entry.
                  </span>
                )}
              </div>
              <div><label>Name</label>
                <input value={form.name} disabled={locked}
                       onChange={(e) => setField('name', e.target.value)} /></div>
              <div><label>RFID tag</label>
                <input value={form.rfid_tag} disabled={locked}
                       onChange={(e) => setField('rfid_tag', e.target.value)} /></div>
              <div><label>Location detail</label>
                <input value={form.location_detail} disabled={locked}
                       onChange={(e) => setField('location_detail', e.target.value)} /></div>
              <div><label>Pod #</label>
                <input value={form.pod_number} disabled={locked}
                       onChange={(e) => setField('pod_number', e.target.value)} /></div>
            </div>

            <div className="modal-section">Relationships</div>
            <div className="pf-form">
              <div><label>Model</label>
                <ComboBox
                  placeholder="Type to search models…"
                  value={form.model_id}
                  clearable
                  disabled={locked}
                  onOpen={loadModels}
                  onChange={(v) => setField('model_id', v)}
                  options={modelOptions}
                /></div>
              <div><label>Client</label>
                <ComboBox
                  placeholder="Type to search clients…"
                  value={form.client_id}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('client_id', v)}
                  options={clients
                    .filter((c) => !c.archived_at || c.id === form.client_id)
                    .map((c) => ({ value: c.id, label: c.name }))}
                /></div>
              <div><label>Site</label>
                <ComboBox
                  placeholder="Type to search sites…"
                  value={form.site_id}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('site_id', v)}
                  options={sites
                    .filter((s) => !s.archived_at || s.id === form.site_id)
                    .map((s) => ({ value: s.id, label: s.name }))}
                /></div>
              <div><label>Status</label>
                <ComboBox
                  placeholder="Type to search statuses…"
                  value={form.status}
                  disabled={locked}
                  onChange={(v) => setField('status', v)}
                  options={statusOptions}
                /></div>
              <div><label>Rails</label>
                <select className="org-select" value={form.has_rails} disabled={locked}
                        onChange={(e) => setField(
                          'has_rails', e.target.value as AssetFormState['has_rails'],
                        )}>
                  <option value="">Unknown</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreateMode ? 'Create asset' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {asset && canChange && (
              <button className="mini-btn danger" type="button" disabled={saving}
                      onClick={() => void toggleArchive()}>
                {archived ? 'Unarchive' : 'Archive'}
              </button>
            )}
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
