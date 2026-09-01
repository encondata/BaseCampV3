/** Fixed Readers — the device-fleet directory list for Zebra FX9600 fixed
 *  RFID readers. Standalone page (own .portal-page/.dir-head, model:
 *  Notifications.tsx) built on the shared directory-list pattern (model:
 *  components/statusRules/RulesTab.tsx — the freshest full-pattern list):
 *  search + toolbar FilterButton facet (Site/Connection/Scan Type) + per-
 *  column ColumnMenu filters + persisted visible/sort/order state
 *  (usePersistentListState) + CSV export + virtualized rows.
 *
 *  Readers self-register via the device agent — there is no create flow
 *  here yet, hence the disabled "Register reader" affordance. Row action
 *  is Delete only, gated on can('scanning_hardware', 'delete'); unlike
 *  Routers there is no row expansion — the trailing track is a single
 *  90px Delete cell, no chevron. */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, deleteDevice, listDevices, type DeviceItem,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import {
  connectionLabel, deviceCellText, deviceSearchText, deviceSortValue,
} from '../lib/devices';
import {
  ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  moveKey, passesFacets, useReorderDrag, useSearchHaystacks, visibleColumnsFor,
  type ColumnDef, type FacetGroup, type FacetState,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';  /* .set-note */
import '../styles/hardware.css';

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: 'minmax(160px, 1.3fr)', default: true },
  { key: 'model', label: 'Model', width: '100px', default: true },
  { key: 'mac', label: 'MAC', width: 'minmax(150px, 1fr)', default: true },
  { key: 'ip', label: 'IP', width: 'minmax(120px, 1fr)', default: true },
  { key: 'uptime', label: 'Uptime', width: '100px', default: true },
  { key: 'tags_24h', label: 'Tags (24h)', width: '100px', default: true },
  { key: 'antennas', label: 'Antennas', width: '95px', default: true },
  { key: 'connection', label: 'Connection', width: '110px', default: true },
  { key: 'scan_status', label: 'Scan Type', width: 'minmax(150px, 1fr)', default: true },
  { key: 'site', label: 'Site', width: 'minmax(120px, 1fr)', default: true },
  { key: 'last_seen', label: 'Last seen', width: 'minmax(150px, 1fr)', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

const deviceCellTextTyped: CellText<DeviceItem> = (d, key) => deviceCellText(d, key);

const CSV_COLUMNS: [string, (d: DeviceItem) => string][] = [
  ['ID', (d) => d.id],
  ['Name', (d) => d.name],
  ['Model', (d) => deviceCellText(d, 'model')],
  ['MAC', (d) => deviceCellText(d, 'mac')],
  ['IP', (d) => deviceCellText(d, 'ip')],
  ['Uptime', (d) => deviceCellText(d, 'uptime')],
  ['Tags (24h)', (d) => deviceCellText(d, 'tags_24h')],
  ['Antennas', (d) => deviceCellText(d, 'antennas')],
  ['Connection', (d) => deviceCellText(d, 'connection')],
  ['Scan Type', (d) => deviceCellText(d, 'scan_status')],
  ['Site', (d) => deviceCellText(d, 'site')],
  ['Last seen', (d) => deviceCellText(d, 'last_seen')],
];

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : "Couldn't delete the reader.";

export default function FixedReaders() {
  const { can } = useAuth();
  const canDelete = can('scanning_hardware', 'delete');

  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'hardware-fixed-readers', { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      setDevices(await listDevices('fixed_reader'));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? "You don't have access to scanning hardware."
        : "Couldn't load fixed readers.");
    }
  };

  useEffect(() => { void load(); }, []);

  const searchText = (d: DeviceItem) => deviceSearchText(d).toLowerCase();
  const haystack = useSearchHaystacks(devices, searchText);

  const facetGroups = useMemo<FacetGroup[]>(() => {
    const sites = new Set<string>();
    const connections = new Set<string>();
    const scanStatuses = new Set<string>();
    for (const d of devices ?? []) {
      sites.add(d.site_name ?? '—');
      connections.add(connectionLabel(d.connection_type));
      scanStatuses.add(d.scan_status_label ?? (d.scan_status ?? '—'));
    }
    return [
      { key: 'site', title: 'Site', options: Array.from(sites).sort().map((v) => (
        { value: v, label: v }
      )) },
      { key: 'connection', title: 'Connection', options: Array.from(connections).sort().map((v) => (
        { value: v, label: v }
      )) },
      { key: 'scan_status', title: 'Scan Type', options: Array.from(scanStatuses).sort().map((v) => (
        { value: v, label: v }
      )) },
    ];
  }, [devices]);

  const facetValues = (d: DeviceItem) => (groupKey: string): string[] => {
    if (groupKey === 'site') return [d.site_name ?? '—'];
    if (groupKey === 'connection') return [connectionLabel(d.connection_type)];
    if (groupKey === 'scan_status') return [d.scan_status_label ?? (d.scan_status ?? '—')];
    return [];
  };

  const visible = useMemo(() => {
    if (!devices) return [];
    const q = query.trim().toLowerCase();
    const rows = devices.filter((d) => {
      if (!passesFacets(facets, facetValues(d))) return false;
      if (!passesColumnFilters(d, filters, deviceCellTextTyped)) return false;
      if (!q) return true;
      return haystack(d).includes(q);
    });
    return rows.sort((a, b) => {
      const va = deviceSortValue(a, sortKey), vb = deviceSortValue(b, sortKey);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
  }, [devices, facets, filters, query, sortKey, sortDir, haystack]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 90px` };

  const remove = async (d: DeviceItem) => {
    if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    setError('');
    try {
      await deleteDevice(d.id);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const cellFor = (d: DeviceItem, key: string) => {
    switch (key) {
      case 'mac':
        return <span className="mono">{deviceCellText(d, key)}</span>;
      case 'connection':
        return d.connection_type == null
          ? <span>—</span>
          : <span className="chip tag">{connectionLabel(d.connection_type)}</span>;
      case 'scan_status':
        return d.scan_status == null
          ? <span>—</span>
          : (
            <span className="chip custom" style={{ '--chip': d.scan_status_color } as CSSProperties}>
              <span className="dot" />{deviceCellText(d, 'scan_status')}
            </span>
          );
      default:
        return <span>{deviceCellText(d, key)}</span>;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Scanning Hardware</div>
          <h1 className="page-title">
            Fixed Readers
            <span className="badge-count">{devices?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">Zebra FX9600 fixed RFID readers.</p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {devices?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('fixed-readers', CSV_COLUMNS, visible)} />
          <button type="button" className="btn-solid" disabled
                  title="Readers self-register — the registration endpoint arrives with the device agent.">
            Register reader
          </button>
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{devices ? "Couldn't complete that action" : 'Cannot load fixed readers'}</b>{error}
        </div>
      )}

      {devices && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={devices ?? []} filters={filters}
                            text={deviceCellTextTyped}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <span />
          </div>

          {visible.length === 0 && (
            devices.length === 0 ? (
              <div className="dir-empty">
                No fixed readers registered yet.
              </div>
            ) : (
              <div className="dir-empty">
                <b>No matches</b>Try a different filter.
                <EmptyClearFilters filters={filters}
                                    onClear={() => { clearFilters(); setFacets({}); }} />
              </div>
            )
          )}

          <VirtualRows rows={visible}
            renderRow={(d, vp) => (
              <div key={d.id} className="dir-row" {...vp} style={vp?.style}>
                <div className="row-main" style={grid}>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(d, c.key)}</div>
                  ))}
                  <div className="cell" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {canDelete && (
                      <button className="mini-btn danger"
                              onClick={(e) => { e.stopPropagation(); void remove(d); }}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )} />
        </div>
      )}
    </div>
  );
}
