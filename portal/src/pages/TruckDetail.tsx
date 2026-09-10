/**
 * TruckDetail (/logistics/trucks/:id) — full read view of one truck:
 * profile-hero chrome (mirrors WorkerDetail/StakeholderDetail), route +
 * tracking panels, the trail map, the location-updates log (manual
 * "Add update" / "Clear updates"), containers on the truck, and
 * Notes & Files. Editing goes through the same TruckEditModal Trucks.tsx
 * uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import DataTable from '../components/DataTable';
import NotesFilesPanel from '../components/NotesFilesPanel';
import StatusHover from '../components/StatusHover';
import TruckEditModal from '../components/trucks/TruckEditModal';
import TrucksMap from '../components/trucks/TrucksMap';
import {
  addTruckUpdate, ApiError, clearTruckUpdates, getTruck, listTruckUpdates,
  type TruckDetail as TruckDetailData, type TruckMapPoint, type TruckUpdate,
} from '../lib/api';
import { statusChip as chip } from '../lib/chips';
import { parseLocationText, TRUCK_ERRORS } from '../lib/trucks';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';
import '../styles/trucks.css';

function AddUpdateModal({ truckId, onClose, onDone }: {
  truckId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [location, setLocation] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!parseLocationText(location)) {
      setError(TRUCK_ERRORS.invalid_location);
      return;
    }
    setSaving(true);
    try {
      await addTruckUpdate(truckId, {
        location: location.trim(),
        approximate_address: address.trim(),
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? (TRUCK_ERRORS[err.code] ?? err.message) : 'Could not save — try again.');
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
          <h3>Add update</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="pf-form">
              <div><label htmlFor="tu-location">Location</label>
                <input id="tu-location" placeholder="lat, lng" value={location} disabled={saving}
                       onChange={(e) => setLocation(e.target.value)} /></div>
              <div><label htmlFor="tu-address">Address</label>
                <input id="tu-address" value={address} disabled={saving}
                       onChange={(e) => setAddress(e.target.value)} /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Add update'}
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

export default function TruckDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const canWrite = can('trucks', 'change');

  const [truck, setTruck] = useState<TruckDetailData | null>(null);
  const [updates, setUpdates] = useState<TruckUpdate[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addingUpdate, setAddingUpdate] = useState(false);
  const [error, setError] = useState('');

  // Stale-response/unmount guard for the id-keyed loads below, mirroring
  // TruckEditModal's `let cancelled = false` pattern: idRef always holds
  // the id the page is *currently* showing, so a late response for a
  // truck the user has already navigated away from (or after unmount)
  // never calls setState.
  const idRef = useRef(id);
  idRef.current = id;
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const stale = (forId: string | undefined) => !mountedRef.current || idRef.current !== forId;

  const loadTruck = useCallback(async () => {
    if (!id) return;
    try {
      const data = await getTruck(id);
      if (stale(id)) return;
      setTruck(data);
      setMissing(false);
    } catch {
      if (stale(id)) return;
      setMissing(true);
    }
  }, [id]);

  const loadUpdates = useCallback(async () => {
    if (!id) return;
    try {
      const data = await listTruckUpdates(id);
      if (stale(id)) return;
      setUpdates(data);
    } catch {
      if (stale(id)) return;
      setUpdates([]);
    }
  }, [id]);

  useEffect(() => { void loadTruck(); void loadUpdates(); }, [loadTruck, loadUpdates]);

  const locatedUpdates = useMemo(
    () => (updates ?? []).filter((u) => u.lat !== null && u.lng !== null),
    [updates],
  );

  // listTruckUpdates returns newest-first — the first located row is the
  // latest fix, and the trail runs oldest→newest for the polyline.
  const trailPoint: TruckMapPoint | null = useMemo(() => {
    if (!truck) return null;
    if (locatedUpdates.length === 0) {
      // The updates log has no located rows (its own fetch may have
      // failed, or it's genuinely empty) — the truck detail payload is a
      // separate source that already loaded successfully, so fall back
      // to its last-known fix as a single point rather than showing the
      // empty state when we already have a position in memory.
      const lu = truck.last_update;
      if (!lu || lu.lat === null || lu.lng === null) return null;
      return {
        id: truck.id,
        name: truck.name,
        status: truck.status,
        status_label: truck.status_label,
        status_color: truck.status_color,
        driver_name: truck.driver_name,
        load_number: truck.load_number,
        seal_id: truck.seal_id,
        last_update: lu,
        trail: [],
      };
    }
    const newest = locatedUpdates[0];
    return {
      id: truck.id,
      name: truck.name,
      status: truck.status,
      status_label: truck.status_label,
      status_color: truck.status_color,
      driver_name: truck.driver_name,
      load_number: truck.load_number,
      seal_id: truck.seal_id,
      last_update: {
        recorded_at: newest.recorded_at,
        lat: newest.lat,
        lng: newest.lng,
        approximate_address: newest.approximate_address,
      },
      trail: [...locatedUpdates].reverse().map((u) => ({
        recorded_at: u.recorded_at, lat: u.lat as number, lng: u.lng as number,
      })),
    };
  }, [truck, locatedUpdates]);

  const doClear = async () => {
    if (!truck) return;
    if (!window.confirm('Clear every location update for this truck?')) return;
    setError('');
    try {
      await clearTruckUpdates(truck.id);
      void loadUpdates();
    } catch (err) {
      setError(err instanceof ApiError ? (TRUCK_ERRORS[err.code] ?? err.message) : 'Could not clear updates — try again.');
    }
  };

  const back = <Link to="/logistics/trucks" className="idet-back">← Back to trucks</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Truck not found</b>{TRUCK_ERRORS.truck_not_found}
        </div>
      </div>
    );
  }
  if (!truck) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const tracking = truck.tracking_type ?? {};
  const trackingStr = (key: string) =>
    (typeof tracking[key] === 'string' ? (tracking[key] as string) : '');

  return (
    <div className="portal-page">
      {back}

      <div className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-id">
          <div className="truck-hero-mark" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="7" width="13" height="9" rx="1.5" />
              <path d="M14 10h4l3 3v3h-7z" />
              <circle cx="5.5" cy="18" r="1.8" />
              <circle cx="17.5" cy="18" r="1.8" />
            </svg>
          </div>
          <div className="profile-meta">
            <h1>
              {truck.name}
              <StatusHover entityType="truck" entityId={truck.id} status={truck.status}>
                {chip(truck.status_label, truck.status_color)}
              </StatusHover>
              {truck.team_drive && <span className="chip tag">Team drive</span>}
              {truck.archived_at && <span className="chip tag">Archived</span>}
            </h1>
            <div className="pm-sub">
              <span className="mono">Load {truck.load_number ?? '—'}</span>
              <span className="mono">Seal {truck.seal_id ?? '—'}</span>
            </div>
          </div>
          {canWrite && (
            <div className="truck-hero-actions">
              <button className="btn-solid" onClick={() => setEditing(true)}>Edit</button>
            </div>
          )}
        </div>
      </div>

      <div className="truck-detail-panels">
        <div className="panel">
          <div className="panel-head"><h3>Drivers &amp; contact</h3></div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Driver</dt><dd>{truck.driver_name ?? '—'}</dd>
              <dt>Co-driver</dt><dd>{truck.co_driver_name ?? '—'}</dd>
              <dt>Contact</dt><dd>{truck.contact_info || '—'}</dd>
            </dl>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>Tracking</h3></div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Type</dt><dd>{trackingStr('type') || '—'}</dd>
              <dt>Update type</dt><dd>{trackingStr('update_type') || '—'}</dd>
              <dt>Tracker id</dt><dd className="mono">{trackingStr('tracker_id') || '—'}</dd>
            </dl>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>Route</h3></div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Start site</dt>
              <dd>{truck.start_site_id
                ? <Link to={`/sites/${truck.start_site_id}`}>{truck.start_site_name}</Link>
                : '—'}</dd>
              <dt>End site</dt>
              <dd>{truck.end_site_id
                ? <Link to={`/sites/${truck.end_site_id}`}>{truck.end_site_name}</Link>
                : '—'}</dd>
              <dt>Move</dt>
              <dd>{truck.initiative_id
                ? <Link to={`/initiatives/${truck.initiative_id}`}>{truck.initiative_name}</Link>
                : '—'}</dd>
            </dl>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>Trail</h3></div>
          <div className="panel-body">
            {trailPoint ? (
              <TrucksMap points={[trailPoint]} trails onOpen={() => {}} className="trucks-map" />
            ) : (
              <p className="page-hint">No location reported yet.</p>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>Location updates</h3>
            {canWrite && (
              <div className="truck-updates-actions">
                <button className="mini-btn" type="button" onClick={() => setAddingUpdate(true)}>
                  Add update
                </button>
                <button className="mini-btn danger" type="button" onClick={() => void doClear()}>
                  Clear updates
                </button>
              </div>
            )}
          </div>
          <div className="panel-body">
            {error && <p className="pf-error">{error}</p>}
            <DataTable
              ariaLabel="Location updates"
              columns={[
                { key: 'when', label: 'When', mono: true },
                { key: 'location', label: 'Location', mono: true },
                { key: 'address', label: 'Address' },
                { key: 'source', label: 'Source' },
              ]}
              rows={(updates ?? []).map((u) => ({
                key: u.id,
                cells: [
                  new Date(u.recorded_at).toLocaleString(),
                  u.location,
                  u.approximate_address || '—',
                  u.source || '—',
                ],
              }))}
              emptyText="No location updates yet."
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>Containers on truck</h3></div>
          <div className="panel-body">
            {truck.containers.length === 0 ? (
              <p className="page-hint">No containers on this truck.</p>
            ) : (
              <div className="mini-list">
                {truck.containers.map((c) => (
                  <div key={c.id} className="mini-row flex">
                    <Link to={`/logistics/containers?focus=${c.id}`} className="cell-top">{c.name}</Link>
                    {chip(c.status_label, c.status_color)}
                    <span className="mono">{c.asset_count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-body">
            <NotesFilesPanel entityType="truck" entityId={truck.id} canWrite={canWrite} />
          </div>
        </div>
      </div>

      {editing && (
        <TruckEditModal truck={truck} onClose={() => setEditing(false)} onSaved={() => void loadTruck()} />
      )}
      {addingUpdate && (
        <AddUpdateModal truckId={truck.id} onClose={() => setAddingUpdate(false)}
                         onDone={() => { void loadUpdates(); void loadTruck(); }} />
      )}
    </div>
  );
}
