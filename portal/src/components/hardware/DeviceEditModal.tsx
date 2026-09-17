/**
 * DeviceEditModal — create/edit for a single scanning-hardware device row
 * (kiosk, fixed reader, …) that's provisioned from the portal rather
 * than self-registering. `device === null` opens in create mode;
 * otherwise saves via patchDevice(id, changedFieldsOnly). Generalized
 * from the kiosk-only KioskEditModal: the caller supplies `deviceType`
 * (the wire `device_type`), `noun` (used in copy — "New {noun}", "Create
 * {noun}"), and `typeOptions` (the Type select's `sub_type` choices).
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * skeleton and error-mapping conventions of
 * components/statusRules/RuleEditorModal.tsx (house form styling: .pf-form
 * 2-col grid, .modal-section headings, .pf-error).
 *
 * Self-contained: fetches listInitiatives() + listStatusValues() +
 * listSites() itself on mount (Promise.all) rather than taking them as
 * props — the move/scan-type/site vocabularies are cheap lookups this
 * modal is the only consumer of. Moves are filtered to unarchived
 * planned/in_progress MOVE initiatives (the only ones a device should be
 * assigned to); scan types to active asset-record-type status values.
 *
 * Registration dates (`token_expires_at`/`registered_at`) are never
 * editable here — that's RegisterDaysModal + the page's Register/Renew/
 * De-Register actions.
 */

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';

import {
  ApiError, createDevice, listInitiatives, listSites, listStatusValues, patchDevice,
  type DeviceItem, type DeviceWrite, type InitiativeItem, type SiteItem, type StatusValue,
} from '../../lib/api';

interface TypeOption { value: string; label: string }

interface Props {
  deviceType: string; // wire device_type for create, e.g. 'kiosk' | 'fixed_reader'
  noun: string; // e.g. 'kiosk' | 'fixed reader' — drives heading/button copy
  typeOptions: TypeOption[]; // Type select choices (sub_type)
  device: DeviceItem | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  subType: string;
  mac: string;
  ip: string;
  version: string;
  siteId: string;
  moveId: string;
  scanStatus: string;
}

interface LoadedData {
  initiatives: InitiativeItem[];
  statuses: StatusValue[];
  sites: SiteItem[];
}

const ERRORS = (noun: string): Record<string, string> => ({
  bad_scan_status: 'Pick a valid scan type.',
  bad_initiative: 'Pick a valid move.',
  bad_field: 'One of the fields is invalid.',
  bad_name: `Enter a name for this ${noun}.`,
  bad_device_type: 'Invalid device type.',
});

const msgFor = (err: unknown, noun: string): string =>
  err instanceof ApiError
    ? (ERRORS(noun)[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

function formFromDevice(device: DeviceItem | null): FormState {
  return {
    name: device?.name ?? '',
    subType: device?.sub_type ?? '',
    mac: device?.mac ?? '',
    ip: device?.lan_ip ?? '',
    version: device?.version ?? '',
    siteId: device?.site_id ?? '',
    moveId: device?.current_initiative_id ?? '',
    scanStatus: device?.scan_status ?? '',
  };
}

/** Only the fields that actually changed vs. the incoming device — empty
 *  text inputs map to null for the nullable string fields. */
function changedFields(device: DeviceItem, form: FormState): DeviceWrite {
  const patch: DeviceWrite = {};
  const name = form.name.trim();
  if (name !== device.name) patch.name = name;
  const subType = form.subType || null;
  if (subType !== device.sub_type) patch.sub_type = subType;
  const mac = form.mac.trim() || null;
  if (mac !== device.mac) patch.mac = mac;
  const ip = form.ip.trim() || null;
  if (ip !== device.lan_ip) patch.lan_ip = ip;
  const version = form.version.trim() || null;
  if (version !== device.version) patch.version = version;
  const siteId = form.siteId || null;
  if (siteId !== device.site_id) patch.site_id = siteId;
  const moveId = form.moveId || null;
  if (moveId !== device.current_initiative_id) patch.current_initiative_id = moveId;
  const scanStatus = form.scanStatus || null;
  if (scanStatus !== device.scan_status) patch.scan_status = scanStatus;
  return patch;
}

function createPayload(
  deviceType: string, form: FormState,
): DeviceWrite & { device_type: string; name: string } {
  return {
    device_type: deviceType,
    name: form.name.trim(),
    sub_type: form.subType || null,
    mac: form.mac.trim() || null,
    lan_ip: form.ip.trim() || null,
    version: form.version.trim() || null,
    site_id: form.siteId || null,
    current_initiative_id: form.moveId || null,
    scan_status: form.scanStatus || null,
  };
}

export default function DeviceEditModal({
  deviceType, noun, typeOptions, device, onClose, onSaved,
}: Props) {
  const isCreate = device === null;

  const [data, setData] = useState<LoadedData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<FormState>(() => formFromDevice(device));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([listInitiatives(), listStatusValues(), listSites()])
      .then(([initiatives, statuses, sites]) => {
        if (!cancelled) setData({ initiatives, statuses, sites });
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't load form data — try again.");
      });
    return () => { cancelled = true; };
  }, []);

  const moveOptions = useMemo(() => (data?.initiatives ?? []).filter((i) =>
    i.initiative_type === 'move' && (i.status === 'planned' || i.status === 'in_progress') && i.archived_at == null,
  ), [data]);

  const scanOptions = useMemo(() => (data?.statuses ?? []).filter((s) =>
    s.record_type === 'asset' && s.is_active,
  ), [data]);

  const scanPreview = scanOptions.find((s) => s.key === form.scanStatus);

  const canSave = form.name.trim() !== '' && !!data;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (isCreate) {
        await createDevice(createPayload(deviceType, form));
      } else {
        const patch = changedFields(device, form);
        if (Object.keys(patch).length > 0) {
          await patchDevice(device.id, patch);
        }
      }
      onSaved();
    } catch (err) {
      setError(msgFor(err, noun));
    } finally {
      setSaving(false);
    }
  };

  const locked = saving || !data;

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{isCreate ? `New ${noun}` : `Edit — ${device.name}`}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="modal-section">Details</div>

            {loadError ? (
              <p className="pf-error">{loadError}</p>
            ) : !data ? (
              <p className="set-note" style={{ padding: 0 }}>Loading…</p>
            ) : (
              <div className="pf-form">
                <div>
                  <label>Name *</label>
                  <input aria-label="Name" value={form.name} disabled={locked}
                         onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <label>Type</label>
                  <select aria-label="Type" value={form.subType} disabled={locked}
                          onChange={(e) => setForm((f) => ({ ...f, subType: e.target.value }))}>
                    <option value="">— none</option>
                    {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>

                <div>
                  <label>MAC</label>
                  <input aria-label="MAC" value={form.mac} disabled={locked}
                         onChange={(e) => setForm((f) => ({ ...f, mac: e.target.value }))} />
                </div>
                <div>
                  <label>IP</label>
                  <input aria-label="IP" value={form.ip} disabled={locked}
                         onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))} />
                </div>

                <div>
                  <label>Version</label>
                  <input aria-label="Version" value={form.version} disabled={locked}
                         onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))} />
                </div>
                <div>
                  <label>Site</label>
                  <select aria-label="Site" value={form.siteId} disabled={locked}
                          onChange={(e) => setForm((f) => ({ ...f, siteId: e.target.value }))}>
                    <option value="">— none</option>
                    {data.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                <div>
                  <label>Current Move</label>
                  <select aria-label="Current Move" value={form.moveId} disabled={locked}
                          onChange={(e) => setForm((f) => ({ ...f, moveId: e.target.value }))}>
                    <option value="">— none</option>
                    {moveOptions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </div>
                <div>
                  <label>Scan Type</label>
                  <select aria-label="Scan Type" value={form.scanStatus} disabled={locked}
                          onChange={(e) => setForm((f) => ({ ...f, scanStatus: e.target.value }))}>
                    <option value="">— none</option>
                    {scanOptions.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                  {scanPreview && (
                    <div className="chips" style={{ marginTop: 8 }}>
                      <span className="chip custom" style={{ '--chip': scanPreview.color } as CSSProperties}>
                        <span className="dot" />{scanPreview.label}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={!canSave || saving}>
              {saving ? 'Saving…' : (isCreate ? `Create ${noun}` : 'Save')}
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
