/* ── asset edit dialog — the move Assets table's per-row edit surface
      (Task 4). Same overlay/shell classes as PersonEditDialog above; the
      only place the full move-asset PATCH whitelist gets round-tripped.
      Checkbox note: source_verified/destination_verified/vendor_involved
      are all nullable tri-state booleans in the API (null = not yet
      verified/decided), but a plain checkbox can only represent two
      states — saving always writes an explicit true/false, so an
      unopened null collapses to false the first time this dialog is
      saved. Per the design spec this is acceptable: a move asset either
      gets explicitly verified/flagged here or it doesn't. ────────────── */
import { useState, type FormEvent } from 'react';

import ComboBox from '../ComboBox';
import {
  ApiError,
  updateInitiativeAsset,
  type InitiativeAssetRow,
  type StatusValue,
} from '../../lib/api';
import { MOVE_ASSET_ERRORS } from '../../lib/initiatives';

export default function AssetEditDialog({ asset, moveStatuses, onClose, onSaved }: {
  asset: InitiativeAssetRow;
  moveStatuses: StatusValue[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState(asset.status);
  const [wave, setWave] = useState(asset.priority_wave ?? '');
  const [owner, setOwner] = useState(asset.owner ?? '');
  const [disposition, setDisposition] = useState(asset.disposition ?? '');
  const [cableInfo, setCableInfo] = useState(asset.cable_info ?? '');
  const [sourceRack, setSourceRack] = useState(asset.source_rack ?? '');
  const [sourceRu, setSourceRu] = useState(
    asset.source_ru != null ? String(asset.source_ru) : '');
  const [sourcePosition, setSourcePosition] = useState(asset.source_position ?? '');
  const [sourceVerified, setSourceVerified] = useState(asset.source_verified ?? false);
  const [destinationRack, setDestinationRack] = useState(asset.destination_rack ?? '');
  const [destinationRu, setDestinationRu] = useState(
    asset.destination_ru != null ? String(asset.destination_ru) : '');
  const [destinationPosition, setDestinationPosition] = useState(
    asset.destination_position ?? '');
  const [destinationVerified, setDestinationVerified] = useState(
    asset.destination_verified ?? false);
  const [vendorInvolved, setVendorInvolved] = useState(asset.vendor_involved ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await updateInitiativeAsset(asset.id, {
        status,
        priority_wave: wave || null,
        disposition: disposition || null,
        owner: owner || null,
        source_rack: sourceRack || null,
        source_ru: sourceRu || null,
        source_verified: sourceVerified,
        source_position: sourcePosition || null,
        destination_rack: destinationRack || null,
        destination_ru: destinationRu || null,
        destination_verified: destinationVerified,
        destination_position: destinationPosition || null,
        cable_info: cableInfo || null,
        vendor_involved: vendorInvolved,
      });
      await onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'rule_failed') {
        const d = err.detail as { rule_name?: string; reason?: string } | undefined;
        setError(`Rule '${d?.rule_name ?? '?'}' failed: ${d?.reason ?? 'unknown error'}`);
      } else {
        setError(err instanceof ApiError
          ? (MOVE_ASSET_ERRORS[err.code] ?? 'Could not save — try again.')
          : 'Network error.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card idet-asset-modal-card">
        <div className="modal-head">
          <h3>Edit — {asset.asset.name || asset.asset.serial_number || 'Asset'}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}
                  disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.2" strokeLinecap="round">
              <path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="modal-section">Details</div>
            <div className="pf-form">
              <div className="full"><label>Status</label>
                <ComboBox
                  placeholder="Select status…"
                  value={status}
                  disabled={saving}
                  onChange={setStatus}
                  options={moveStatuses.map((s) => ({ value: s.key, label: s.label }))}
                /></div>
              <div><label>Wave</label>
                <input value={wave} maxLength={30} disabled={saving}
                       onChange={(e) => setWave(e.target.value)} /></div>
              <div><label>Owner</label>
                <input value={owner} disabled={saving}
                       onChange={(e) => setOwner(e.target.value)} /></div>
              <div><label>Disposition</label>
                <input value={disposition} disabled={saving}
                       onChange={(e) => setDisposition(e.target.value)} /></div>
              <div><label>Cable info</label>
                <input value={cableInfo} disabled={saving}
                       onChange={(e) => setCableInfo(e.target.value)} /></div>
            </div>

            <div className="modal-section">Source &amp; destination</div>
            <div className="idet-asset-pair-labels">
              <span>Source</span><span>Destination</span>
            </div>
            <div className="pf-form">
              <div><label>Rack</label>
                <input value={sourceRack} disabled={saving}
                       onChange={(e) => setSourceRack(e.target.value)} /></div>
              <div><label>Rack</label>
                <input value={destinationRack} disabled={saving}
                       onChange={(e) => setDestinationRack(e.target.value)} /></div>
              <div><label>RU</label>
                <input value={sourceRu} disabled={saving}
                       onChange={(e) => setSourceRu(e.target.value)} /></div>
              <div><label>RU</label>
                <input value={destinationRu} disabled={saving}
                       onChange={(e) => setDestinationRu(e.target.value)} /></div>
              <div><label>Position</label>
                <input value={sourcePosition} disabled={saving}
                       onChange={(e) => setSourcePosition(e.target.value)} /></div>
              <div><label>Position</label>
                <input value={destinationPosition} disabled={saving}
                       onChange={(e) => setDestinationPosition(e.target.value)} /></div>
              <div style={{ alignSelf: 'end' }}>
                <label className="init-check">
                  <input type="checkbox" checked={sourceVerified} disabled={saving}
                         onChange={(e) => setSourceVerified(e.target.checked)} />
                  Verified
                </label></div>
              <div style={{ alignSelf: 'end' }}>
                <label className="init-check">
                  <input type="checkbox" checked={destinationVerified} disabled={saving}
                         onChange={(e) => setDestinationVerified(e.target.checked)} />
                  Verified
                </label></div>
            </div>

            <div className="modal-section">Other</div>
            <div className="pf-form">
              <div style={{ alignSelf: 'end' }}>
                <label className="init-check">
                  <input type="checkbox" checked={vendorInvolved} disabled={saving}
                         onChange={(e) => setVendorInvolved(e.target.checked)} />
                  Vendor involved
                </label></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose}
                    disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
