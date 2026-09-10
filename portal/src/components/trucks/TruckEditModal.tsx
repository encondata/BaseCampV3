/**
 * TruckEditModal — the only place a truck is created or edited: identity,
 * drivers, tracking, move/site assignment, and container membership.
 * `truck === null` opens in create mode. In edit mode the incoming
 * `TruckItem` (from the list) lacks `containers`, so the modal fetches
 * the full `TruckDetail` on open to seed the containers picker — mirrors
 * ContainerEditModal's modal shape (pf-form, modal-card, ComboBox,
 * mini-list picker, error banner, save/cancel).
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  ApiError, createTruck, getTruck, listContainers, listInitiatives,
  listSites, listTruckStatuses, updateTruck,
  type ContainerItem, type InitiativeItem, type SiteItem,
  type StatusValue, type TruckItem,
} from '../../lib/api';
import { statusChip } from '../../lib/chips';
import {
  formFromTruck, TRUCK_ERRORS, truckPayload, type TruckFormState,
} from '../../lib/trucks';
import ComboBox from '../ComboBox';

interface Props {
  truck: TruckItem | null;   // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

function mapError(err: unknown): string {
  if (err instanceof ApiError) return TRUCK_ERRORS[err.code] ?? err.message;
  return 'Network error.';
}

export default function TruckEditModal({ truck, onClose, onSaved }: Props) {
  const isCreateMode = truck === null;
  const [loadingDetail, setLoadingDetail] = useState(!isCreateMode);
  // Seed immediately from the row we already have — in edit mode the form
  // is never blank, even before (or if) the full TruckDetail fetch below
  // resolves. Only `containers`/`container_ids` are unknown at this point.
  const [form, setForm] = useState<TruckFormState>(
    () => formFromTruck(truck ? { ...truck, containers: [] } : null),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [detailNotice, setDetailNotice] = useState('');

  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [initiatives, setInitiatives] = useState<InitiativeItem[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [containers, setContainers] = useState<ContainerItem[]>([]);
  const [containerFilter, setContainerFilter] = useState('');

  useEffect(() => {
    void listTruckStatuses().then(setStatuses).catch(() => {});
    void listInitiatives().then(setInitiatives).catch(() => {});
    void listSites().then(setSites).catch(() => {});
    void listContainers().then(setContainers).catch(() => {});
  }, []);

  useEffect(() => {
    if (isCreateMode || !truck) return;
    let cancelled = false;
    setLoadingDetail(true);
    void getTruck(truck.id).then((d) => {
      if (cancelled) return;
      setForm(formFromTruck(d));
      setLoadingDetail(false);
    }).catch(() => {
      if (cancelled) return;
      // Leave the form exactly as seeded from the row above — every field
      // but `containers` already has its real value. Just surface a
      // non-blocking notice; the rest stays editable and saveable.
      setDetailNotice("Couldn't load the containers on this truck.");
      setLoadingDetail(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [truck?.id]);

  const setField = <K extends keyof TruckFormState>(key: K, value: TruckFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const toggleContainer = (id: string) => setForm((f) => ({
    ...f,
    container_ids: f.container_ids.includes(id)
      ? f.container_ids.filter((x) => x !== id)
      : [...f.container_ids, id],
  }));

  // listTruckStatuses() may not include a status the truck already sits
  // on (retired vocab entry) — seed it back in, same trap/fix as
  // ContainerEditModal's statusOptions.
  const statusOptions = useMemo(() => {
    const list = truck && !statuses.some((s) => s.key === truck.status)
      ? [...statuses, { key: truck.status, label: truck.status_label } as StatusValue]
      : statuses;
    return list.map((s) => ({ value: s.key, label: s.label }));
  }, [statuses, truck]);

  const initiativeOptions = useMemo(() => initiatives
    .map((i) => ({ value: i.id, label: i.name })), [initiatives]);

  const siteOptions = useMemo(() => sites
    .filter((s) => !s.archived_at || s.id === form.start_site_id || s.id === form.end_site_id)
    .map((s) => ({ value: s.id, label: s.name })), [sites, form.start_site_id, form.end_site_id]);

  const containerOptions = useMemo(() => {
    const q = containerFilter.trim().toLowerCase();
    return containers
      .filter((c) => !c.archived_at || form.container_ids.includes(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [containers, containerFilter, form.container_ids]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) {
      setError(TRUCK_ERRORS.name_required);
      return;
    }
    setSaving(true);
    try {
      const payload = truckPayload(form);
      if (truck) {
        await updateTruck(truck.id, payload);
      } else {
        await createTruck(payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err));
    } finally {
      setSaving(false);
    }
  };

  const title = truck ? `Edit — ${truck.name}` : 'New truck';

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
        {loadingDetail ? (
          <div className="modal-body"><p className="page-hint">Loading…</p></div>
        ) : (
          <form onSubmit={(e) => void submit(e)} noValidate>
            <div className="modal-body">
              {detailNotice && (
                <p style={{ fontSize: 12.5, color: 'var(--c-amber)', margin: '0 0 14px' }}>
                  {detailNotice}
                </p>
              )}
              <div className="modal-section">Identity</div>
              <div className="pf-form">
                <div><label>Name</label>
                  <input value={form.name} disabled={saving} required
                         onChange={(e) => setField('name', e.target.value)} /></div>
                <div><label>Driver</label>
                  <input value={form.driver_name} disabled={saving}
                         onChange={(e) => setField('driver_name', e.target.value)} /></div>
                <div><label>Co-driver</label>
                  <input value={form.co_driver_name} disabled={saving}
                         onChange={(e) => setField('co_driver_name', e.target.value)} /></div>
                <div style={{ alignSelf: 'end' }}>
                  <label className="pill-check">
                    <input type="checkbox" checked={form.team_drive} disabled={saving}
                           onChange={(e) => setField('team_drive', e.target.checked)} />
                    Team drive
                  </label>
                </div>
                <div><label>Contact info</label>
                  <input value={form.contact_info} disabled={saving}
                         onChange={(e) => setField('contact_info', e.target.value)} /></div>
                <div><label>Status</label>
                  <ComboBox
                    placeholder="Type to search statuses…"
                    value={form.status}
                    disabled={saving}
                    onChange={(v) => setField('status', v)}
                    options={statusOptions}
                  /></div>
              </div>

              <div className="modal-section">Load</div>
              <div className="pf-form">
                <div><label>Load #</label>
                  <input value={form.load_number} disabled={saving}
                         onChange={(e) => setField('load_number', e.target.value)} /></div>
                <div><label>Seal</label>
                  <input value={form.seal_id} disabled={saving}
                         onChange={(e) => setField('seal_id', e.target.value)} /></div>
              </div>

              <div className="modal-section">Tracking</div>
              <div className="pf-form">
                <div><label>Tracking type</label>
                  <input value={form.type} disabled={saving}
                         onChange={(e) => setField('type', e.target.value)} /></div>
                <div><label>Update type</label>
                  <input value={form.update_type} disabled={saving}
                         onChange={(e) => setField('update_type', e.target.value)} /></div>
                <div><label>Tracker id</label>
                  <input value={form.tracker_id} disabled={saving}
                         onChange={(e) => setField('tracker_id', e.target.value)} /></div>
              </div>

              <div className="modal-section">Route</div>
              <div className="pf-form">
                <div><label>Move</label>
                  <ComboBox
                    placeholder="Type to search moves…"
                    value={form.initiative_id}
                    clearable
                    disabled={saving}
                    onChange={(v) => setField('initiative_id', v)}
                    options={initiativeOptions}
                  /></div>
                <div><label>Start site</label>
                  <ComboBox
                    placeholder="Type to search sites…"
                    value={form.start_site_id}
                    clearable
                    disabled={saving}
                    onChange={(v) => setField('start_site_id', v)}
                    options={siteOptions}
                  /></div>
                <div><label>End site</label>
                  <ComboBox
                    placeholder="Type to search sites…"
                    value={form.end_site_id}
                    clearable
                    disabled={saving}
                    onChange={(v) => setField('end_site_id', v)}
                    options={siteOptions}
                  /></div>
              </div>

              <div className="modal-section">
                Containers on truck{form.container_ids.length ? ` — ${form.container_ids.length}` : ''}
              </div>
              <div className="pf-form">
                <div style={{ gridColumn: '1 / -1' }}>
                  <label>Filter containers</label>
                  <input placeholder="Type to filter…" value={containerFilter} disabled={saving}
                         onChange={(e) => setContainerFilter(e.target.value)} />
                </div>
              </div>
              <div className="mini-list truck-container-picker">
                {containerOptions.length === 0 && (
                  <p className="page-hint">No containers match.</p>
                )}
                {containerOptions.map((c) => (
                  <label key={c.id} className="mini-row flex">
                    <input type="checkbox" checked={form.container_ids.includes(c.id)}
                           disabled={saving}
                           onChange={() => toggleContainer(c.id)} />
                    <span className="cell-top">{c.name}</span>
                    {statusChip(c.status_label, c.status_color)}
                    <span className="mono">{c.asset_count}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn-solid" type="submit" disabled={saving}>
                {saving ? 'Saving…' : (isCreateMode ? 'Create truck' : 'Save')}
              </button>
              <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              {error && <span className="pf-error">{error}</span>}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
