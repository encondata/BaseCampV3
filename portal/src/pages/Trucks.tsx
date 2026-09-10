/**
 * Trucks / Shipments (/logistics/trucks) — a map panel of the fleet's
 * latest reported positions sitting above the standard directory list
 * (cloned from Containers.tsx's list skeleton: usePersistentListState,
 * ColumnMenu, VirtualRows, row expansion). The map's markers follow the
 * list's own filter/search state (V2 behavior per the design spec) —
 * there's exactly one "visible trucks" set, and both halves read it.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
import StatusHover from '../components/StatusHover';
import TruckEditModal from '../components/trucks/TruckEditModal';
import TrucksMap from '../components/trucks/TrucksMap';
import {
  ApiError, archiveTruck, getTrucksMap, listTrucks,
  type TruckItem, type TruckMapPoint,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import {
  applyColumnOrder, ColumnsButton, ExportButton, exportCsv, moveKey,
  useReorderDrag, useSearchHaystacks, visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import { naturalCompare } from '../lib/sites';
import { driversText, TRUCK_ERRORS, truckCellText, truckSearchText, updateAge } from '../lib/trucks';
import { VirtualRows } from '../lib/virtualRows';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/trucks.css';

const REFRESH_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '15s', seconds: 15 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
];

const COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'drivers', label: 'Driver(s)', width: '1.3fr', default: true },
  { key: 'seal', label: 'Seal', width: '0.8fr', default: true },
  { key: 'move', label: 'Move', width: '1.2fr', default: true },
  { key: 'route', label: 'From → To', width: '1.4fr', default: true },
  { key: 'last_update', label: 'Last update', width: '1fr', default: true },
  { key: 'containers', label: 'Containers', width: '0.8fr', default: true },
];

const ALL_COLUMN_KEYS = new Set<string>(
  [...COLUMNS.map((c) => c.key), 'primary', 'archived']);
const DEFAULT_VISIBLE = new Set<string>(
  COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(t: TruckItem, key: string): string {
  switch (key) {
    case 'primary': return t.name.toLowerCase();
    case 'status': return t.status_label.toLowerCase();
    case 'drivers': return driversText(t).toLowerCase();
    case 'seal': return (t.seal_id ?? '').toLowerCase();
    case 'move': return (t.initiative_name ?? '').toLowerCase();
    case 'route': return `${t.start_site_name ?? ''} ${t.end_site_name ?? ''}`.toLowerCase();
    case 'last_update': return t.last_update?.recorded_at ?? '';
    case 'containers': return String(t.container_count).padStart(6, '0');
    case 'archived': return t.archived_at ? '1' : '0';
    default: return '';
  }
}

const CSV_COLUMNS: [string, (t: TruckItem) => string][] = [
  ['ID', (t) => t.id],
  ['Name', (t) => t.name],
  ['Status', (t) => t.status_label],
  ['Drivers', (t) => driversText(t)],
  ['Load #', (t) => t.load_number ?? ''],
  ['Seal', (t) => t.seal_id ?? ''],
  ['Move', (t) => t.initiative_name ?? ''],
  ['From', (t) => t.start_site_name ?? ''],
  ['To', (t) => t.end_site_name ?? ''],
  ['Last update', (t) => updateAge(t.last_update?.recorded_at ?? null)],
  ['Containers', (t) => String(t.container_count)],
];

function truckStatusChip(t: TruckItem) {
  return (
    <StatusHover entityType="truck" entityId={t.id} status={t.status}>
      <span className="chip custom" style={{ '--chip': t.status_color } as CSSProperties}>
        <span className="dot" />{t.status_label}
      </span>
    </StatusHover>
  );
}

export default function Trucks() {
  const { can, godMode } = useAuth();
  const canAdd = can('trucks', 'add');
  const canChange = can('trucks', 'change');
  const navigate = useNavigate();

  const [trucks, setTrucks] = useState<TruckItem[] | null>(null);
  const [mapPoints, setMapPoints] = useState<TruckMapPoint[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showHistorical, setShowHistorical] = useState(false);
  const [trails, setTrails] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [refreshSec, setRefreshSec] = useState(0);

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'trucks', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 },
    ALL_COLUMN_KEYS,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadTrucks = (initial: boolean) => {
    if (initial) setTrucks(null);
    listTrucks()
      .then((rows) => { setTrucks(rows); setError(''); })
      .catch((err) => {
        if (!initial) return;
        setError(err instanceof ApiError && err.status === 403
          ? 'You do not have permission to view trucks.'
          : 'Failed to load trucks.');
      });
  };
  const loadMap = (withTrails: boolean) => {
    void getTrucksMap(withTrails).then(setMapPoints).catch(() => {});
  };

  // The map is loaded by the [trails] effect below (which also runs on
  // mount) — fetching it here too doubled every map request.
  useEffect(() => {
    loadTrucks(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trails toggle carries its own coordinates (the API only returns the
  // trail array when asked), so it needs its own re-fetch.
  useEffect(() => {
    loadMap(trails);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trails]);

  // Auto-refresh cadence — re-fetches both halves without blanking the
  // currently rendered rows (loadTrucks(false) / loadMap keep `trucks`
  // and `mapPoints` populated across the refetch).
  useEffect(() => {
    if (!refreshSec) return;
    const t = setInterval(() => { loadTrucks(false); loadMap(trails); }, refreshSec * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSec, trails]);

  const haystack = useSearchHaystacks(trucks, truckSearchText);

  const visible = useMemo(() => {
    if (!trucks) return [];
    const q = query.trim().toLowerCase();
    const showArchived = filters.archived?.values?.includes('Yes') ?? false;
    const rows = trucks.filter((t) => {
      if (!showArchived && t.archived_at) return false;
      if (!showHistorical && t.status === 'historical') return false;
      if (!passesColumnFilters(t, filters, truckCellText)) return false;
      if (!q) return true;
      return haystack(t).includes(q);
    });
    return rows.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [trucks, filters, query, showHistorical, sortKey, sortDir, haystack]);

  const visibleIds = useMemo(() => new Set(visible.map((t) => t.id)), [visible]);
  const mapPointsShown = useMemo(
    () => mapPoints.filter((p) => visibleIds.has(p.id)),
    [mapPoints, visibleIds],
  );

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (t: TruckItem, key: string) => {
    switch (key) {
      case 'status':
        return (
          <div className="chips">
            {truckStatusChip(t)}
            {t.archived_at && <span className="chip tag">Archived</span>}
          </div>
        );
      case 'drivers':
        return <span className="cell-top">{driversText(t) || '—'}</span>;
      case 'seal':
        return <span className="mono">{t.seal_id ?? '—'}</span>;
      case 'move':
        return t.initiative_id
          ? <Link to={`/initiatives/${t.initiative_id}`} className="cell-top">{t.initiative_name}</Link>
          : <span className="cell-top">—</span>;
      case 'route':
        if (!t.start_site_name && !t.end_site_name) return <span className="cell-top">—</span>;
        return (
          <>
            <div className="cell-top">{t.start_site_name ?? '—'}</div>
            <div className="cell-sub">→ {t.end_site_name ?? '—'}</div>
          </>
        );
      case 'last_update':
        return (
          <span className="mono" title={t.last_update?.recorded_at
            ? new Date(t.last_update.recorded_at).toLocaleString() : undefined}>
            {updateAge(t.last_update?.recorded_at ?? null)}
          </span>
        );
      case 'containers':
        return <span className="mono">{t.container_count}</span>;
      default:
        return null;
    }
  };

  const doArchive = async (t: TruckItem) => {
    try {
      await archiveTruck(t.id, !t.archived_at);
      loadTrucks(false);
    } catch (err) {
      setError(err instanceof ApiError ? (TRUCK_ERRORS[err.code] ?? err.message) : 'Could not save — try again.');
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Logistics</div>
          <h1 className="page-title">
            Trucks / Shipments
            <span className="badge-count">{trucks?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Outbound and inbound truckloads — drivers, tracking, and live position.
          </p>
        </div>
      </div>

      <div className="trucks-map-panel">
        <div className="trucks-map-ctrls">
          <label className="pill-check">
            <input type="checkbox" checked={trails}
                   onChange={(e) => setTrails(e.target.checked)} />
            Trails
          </label>
          <button type="button" className="mini-btn" onClick={() => setFullscreen(true)}>
            Fullscreen
          </button>
        </div>
        <TrucksMap points={mapPointsShown} trails={trails}
                   onOpen={(id) => navigate(`/logistics/trucks/${id}`)}
                   className="trucks-map" />
      </div>

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {trucks?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <label className="pill-check">
            <input type="checkbox" checked={showHistorical}
                   onChange={(e) => setShowHistorical(e.target.checked)} />
            Show historical
          </label>
          <label className="trucks-refresh">
            <span>Refresh</span>
            <select value={refreshSec} onChange={(e) => setRefreshSec(Number(e.target.value))}>
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>{o.label}</option>
              ))}
            </select>
          </label>
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols} godMode={godMode} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('trucks', CSV_COLUMNS, visible)} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New truck
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load trucks</b>{error}</div>}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('primary')}>
                Truck {caret('primary')}
              </button>
              <ColumnMenu colKey="primary" label="Truck"
                          allRows={trucks ?? []} filters={filters}
                          text={truckCellText}
                          filter={filters.primary} onFilter={setFilter}
                          sortDir={sortKey === 'primary' ? sortDir : null}
                          onSort={(dir) => setSort('primary', dir)} />
            </span>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={trucks ?? []} filters={filters}
                            text={truckCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <ColumnMenu colKey="archived" label="Archived"
                        allRows={trucks ?? []} filters={filters}
                        text={truckCellText}
                        filter={filters.archived} onFilter={setFilter}
                        sortDir={sortKey === 'archived' ? sortDir : null}
                        onSort={(dir) => setSort('archived', dir)} />
          </div>

          {trucks && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add a truck.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows rows={visible}
            renderRow={(t, vp) => {
            const open = openId === t.id;
            return (
              <div key={t.id} className={`dir-row ${open ? 'open' : ''} ${t.archived_at ? 'archived' : ''}`}
                   {...vp} style={vp?.style}>
                <div className="row-main" style={grid}
                     onClick={() => setOpenId(open ? null : t.id)}>
                  <div className="cell cell-primary">
                    <div className="pn"><b>{t.name}</b>
                      <span>{t.load_number ? `Load ${t.load_number}` : '—'}</span></div>
                  </div>
                  {shownCols.map((col) => (
                    <div className="cell" key={col.key}>{cellFor(t, col.key)}</div>
                  ))}
                  <div className="cell chevron-cell">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                         strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                  </div>
                </div>

                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <TruckRowDetail
                          truck={t}
                          canEdit={canChange}
                          onEdit={() => setEditingId(t.id)}
                          onArchive={() => void doArchive(t)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          }} />
        </div>
      )}

      {fullscreen && (
        <div className="modal-scrim" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setFullscreen(false);
        }}>
          <div className="modal-card trucks-fullscreen-card">
            <div className="modal-head">
              <h3>Trucks — map</h3>
              <button className="modal-close" aria-label="Close" onClick={() => setFullscreen(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                     strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
              </button>
            </div>
            <div className="modal-body trucks-fullscreen-body">
              <TrucksMap points={mapPointsShown} trails={trails}
                         onOpen={(id) => navigate(`/logistics/trucks/${id}`)}
                         className="trucks-map" />
            </div>
          </div>
        </div>
      )}

      {editingId !== null && (
        <TruckEditModal
          truck={trucks?.find((t) => t.id === editingId) ?? null}
          onClose={() => setEditingId(null)}
          onSaved={() => loadTrucks(false)}
        />
      )}
      {creating && (
        <TruckEditModal
          truck={null}
          onClose={() => setCreating(false)}
          onSaved={() => loadTrucks(false)}
        />
      )}
    </div>
  );
}

/* ── row detail: read-only summary + Full details + RowActionsMenu ── */

function TruckRowDetail({ truck, canEdit, onEdit, onArchive }: {
  truck: TruckItem;
  canEdit: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const navigate = useNavigate();
  const kv = (label: string, value: string | null | undefined) => (
    <><dt>{label}</dt><dd>{value || '—'}</dd></>
  );

  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Drivers &amp; contact</p>
        <dl className="kv">
          {kv('Driver(s)', driversText(truck))}
          {kv('Contact', truck.contact_info)}
          {kv('Tracking type', typeof truck.tracking_type.type === 'string' ? truck.tracking_type.type : null)}
          {kv('Tracker', typeof truck.tracking_type.tracker_id === 'string' ? truck.tracking_type.tracker_id : null)}
        </dl>
      </div>
      <div className="detail-block">
        <p className="eyebrow-sm">Route</p>
        <dl className="kv">
          {kv('Move', truck.initiative_name)}
          {kv('From', truck.start_site_name)}
          {kv('To', truck.end_site_name)}
          {kv('Seal', truck.seal_id)}
          {kv('Last update', truck.last_update
            ? `${updateAge(truck.last_update.recorded_at)} — ${truck.last_update.approximate_address || '—'}`
            : null)}
        </dl>
      </div>
      <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
        <button className="btn-ghost" onClick={() => navigate(`/logistics/trucks/${truck.id}`)}>
          Full details
        </button>
        <RowActionsMenu actions={[
          ...(canEdit ? [{ key: 'edit', label: 'Edit', onSelect: onEdit }] : []),
          ...(canEdit ? [{
            key: 'archive',
            label: truck.archived_at ? 'Unarchive' : 'Archive',
            onSelect: onArchive,
            destructive: !truck.archived_at,
          }] : []),
        ]} />
      </div>
    </div>
  );
}
