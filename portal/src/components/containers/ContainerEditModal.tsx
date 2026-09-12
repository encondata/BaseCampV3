/**
 * ContainerEditModal — the only place a container is mutated: field
 * edits, archive/unarchive, and contents (asset membership). `container
 * === null` opens in create mode (contents section hidden — membership
 * needs an id). Membership add/remove hits the API immediately; field
 * edits save on submit. Follows AssetEditModal's modal conventions.
 */

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';

import {
  addContainerAssets,
  ApiError,
  archiveContainer,
  createContainer,
  listAssets,
  listContainerAssets,
  removeContainerAsset,
  updateContainer,
  type AssetItem,
  type ContainerAssetRow,
  type ContainerItem,
  type InitiativeItem,
  type SiteItem,
  type StatusValue,
} from '../../lib/api';
import {
  CONTAINER_ERRORS, containerPayload, formFromContainer,
  type ContainerFormState,
} from '../../lib/containers';
import ComboBox from '../ComboBox';

interface Props {
  container: ContainerItem | null;   // null = create mode
  statuses: StatusValue[];
  types: StatusValue[];
  sites: SiteItem[];
  // Optional (defaults to none) so callers outside this task's file scope
  // (e.g. Warehouse.tsx, which reuses this modal but doesn't load
  // initiatives) keep compiling unchanged — they just won't offer the
  // Initiative field's options.
  initiatives?: InitiativeItem[];
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
  initialSiteId?: string;   // create mode only: seeds form.site_id
}

function mapError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'assets_in_containers') {
      const conflicts = (err.detail as {
        conflicts?: { container_name: string }[];
      } | undefined)?.conflicts ?? [];
      const names = [...new Set(conflicts.map((c) => c.container_name))];
      return names.length
        ? `Already in another container: ${names.join(', ')} — remove there first.`
        : CONTAINER_ERRORS.assets_in_containers;
    }
    return CONTAINER_ERRORS[err.code] ?? fallback;
  }
  return 'Network error.';
}

export default function ContainerEditModal({
  container, statuses, types, sites, initiatives = [], canChange, onClose, onSaved, initialSiteId,
}: Props) {
  const isCreateMode = container === null;
  const [form, setForm] = useState<ContainerFormState>(() => {
    const f = formFromContainer(container);
    return isCreateMode && initialSiteId ? { ...f, site_id: initialSiteId } : f;
  });
  // Kept out of `ContainerFormState`/`containerPayload` (lib/containers.ts
  // is out of this task's file scope) — tracked separately and merged
  // into the payload on submit instead.
  const [initiativeId, setInitiativeId] = useState(container?.initiative_id ?? '');
  const [archived, setArchived] = useState<boolean>(!!container?.archived_at);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // contents (edit mode only)
  const [contents, setContents] = useState<ContainerAssetRow[] | null>(null);
  const [allAssets, setAllAssets] = useState<AssetItem[] | null>(null);
  const [pendingAdd, setPendingAdd] = useState('');
  const [contentsError, setContentsError] = useState('');
  const [busyContents, setBusyContents] = useState(false);

  const locked = saving || (!isCreateMode && !canChange);

  useEffect(() => {
    if (isCreateMode || !container) return;
    void listContainerAssets(container.id).then(setContents).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAssets = () => {
    if (allAssets !== null) return;
    void listAssets().then(setAllAssets).catch(() => {});
  };

  const inContainer = useMemo(
    () => new Set((contents ?? []).map((r) => r.asset_id)), [contents]);
  const assetOptions = useMemo(() => (allAssets ?? [])
    .filter((a) => !a.archived_at && !inContainer.has(a.id))
    .map((a) => ({
      value: a.id,
      label: a.serial_number ?? a.name ?? a.id,
      sub: a.name ?? undefined,
    })), [allAssets, inContainer]);

  const setField = (key: keyof ContainerFormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  // listContainerStatuses() filters to is_active, so a container sitting on a
  // retired status isn't in it — seed the option back from the row, same
  // trap/fix as AssetEditModal.
  const statusOptions = useMemo(() => {
    const list = container && !statuses.some((s) => s.key === container.status)
      ? [...statuses, { key: container.status, label: container.status_label } as StatusValue]
      : statuses;
    return list.map((s) => ({ value: s.key, label: s.label }));
  }, [statuses, container]);

  const typeOptions = useMemo(() => {
    const list = container?.container_type
      && !types.some((t) => t.key === container.container_type)
      ? [...types, { key: container.container_type,
                     label: container.type_label ?? container.container_type } as StatusValue]
      : types;
    return list.map((t) => ({ value: t.key, label: t.label }));
  }, [types, container]);

  // Same trap/fix as statusOptions/typeOptions above: `initiatives` may not
  // include the container's own initiative (e.g. it's finished/archived, or
  // no list was even passed — Warehouse.tsx's callsite doesn't load one) —
  // seed that option back in so the field still shows its name.
  const initiativeOptions = useMemo(() => {
    const list = container?.initiative_id && !initiatives.some((i) => i.id === container.initiative_id)
      ? [...initiatives, {
          id: container.initiative_id, name: container.initiative_name ?? container.initiative_id,
        } as InitiativeItem]
      : initiatives;
    // Spec: "initiatives, newest first, finished ones still selectable" —
    // sort only, never filter (a finished/archived initiative the
    // container already points at, or that the operator wants to pick,
    // stays in the list).
    const sorted = [...list].sort(
      (a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
    return sorted.map((i) => ({ value: i.id, label: i.name, sub: i.client_name ?? undefined }));
  }, [initiatives, container]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { ...containerPayload(form), initiative_id: initiativeId || null };
      if (isCreateMode) {
        await createContainer(payload);
      } else {
        await updateContainer(container.id, payload);
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
    if (!container) return;
    setSaving(true);
    setError('');
    try {
      await archiveContainer(container.id, !archived);
      setArchived((v) => !v);
      await onSaved();
    } catch (err) {
      setError(mapError(err, 'Could not change the archive state — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const addAsset = async (assetId: string) => {
    if (!container || !assetId) return;
    setBusyContents(true);
    setContentsError('');
    try {
      setContents(await addContainerAssets(container.id, [assetId]));
      setPendingAdd('');
      await onSaved();   // asset_count changed
    } catch (err) {
      setContentsError(mapError(err, 'Could not add that asset — try again.'));
    } finally {
      setBusyContents(false);
    }
  };

  const removeAsset = async (assetId: string) => {
    if (!container) return;
    setBusyContents(true);
    setContentsError('');
    try {
      await removeContainerAsset(container.id, assetId);
      setContents((rows) => rows?.filter((r) => r.asset_id !== assetId) ?? rows);
      await onSaved();
    } catch (err) {
      setContentsError(mapError(err, 'Could not remove that asset — try again.'));
    } finally {
      setBusyContents(false);
    }
  };

  const title = container ? `Edit — ${form.name || 'Container'}` : 'New container';

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
              <div><label>Name</label>
                <input value={form.name} disabled={locked} required
                       onChange={(e) => setField('name', e.target.value)} /></div>
              <div><label>RFID tag</label>
                <input value={form.rfid_tag} disabled={locked}
                       onChange={(e) => setField('rfid_tag', e.target.value)} /></div>
              <div><label>Location detail</label>
                <input value={form.location_detail} disabled={locked}
                       onChange={(e) => setField('location_detail', e.target.value)} /></div>
            </div>

            <div className="modal-section">Classification</div>
            <div className="pf-form">
              <div><label>Type</label>
                <ComboBox
                  placeholder="Type to search types…"
                  value={form.container_type}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('container_type', v)}
                  options={typeOptions}
                /></div>
              <div><label>Status</label>
                <ComboBox
                  placeholder="Type to search statuses…"
                  value={form.status}
                  disabled={locked}
                  onChange={(v) => setField('status', v)}
                  options={statusOptions}
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
              <div><label>Initiative</label>
                <ComboBox
                  placeholder="Type to search initiatives…"
                  value={initiativeId}
                  clearable
                  disabled={locked}
                  onChange={setInitiativeId}
                  options={initiativeOptions}
                /></div>
            </div>

            {!isCreateMode && (
              <>
                <div className="modal-section">
                  Contents{contents ? ` — ${contents.length}` : ''}
                </div>
                {canChange && (
                  <div className="pf-form">
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label>Add asset</label>
                      <ComboBox
                        placeholder="Type to search assets…"
                        value={pendingAdd}
                        disabled={busyContents}
                        onOpen={loadAssets}
                        onChange={(v) => void addAsset(v)}
                        options={assetOptions}
                      />
                      {contentsError && <span className="pf-error">{contentsError}</span>}
                    </div>
                  </div>
                )}
                <div className="mini-list contents-list">
                  {contents === null && <p className="page-hint">Loading…</p>}
                  {contents?.length === 0 && (
                    <p className="page-hint">No assets in this container yet.</p>
                  )}
                  {contents?.map((r) => (
                    <div key={r.asset_id} className="mini-row contents-row">
                      <span className="mono">{r.serial_number ?? '—'}</span>
                      <span className="cell-top">{r.name ?? r.model_name ?? '—'}</span>
                      <span className="chip custom"
                            style={{ '--chip': r.status_color } as CSSProperties}>
                        <span className="dot" />{r.status_label}
                      </span>
                      {canChange && (
                        <button type="button" className="mini-btn danger"
                                disabled={busyContents}
                                onClick={() => void removeAsset(r.asset_id)}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreateMode ? 'Create container' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {container && canChange && (
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
