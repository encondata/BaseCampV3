/** Routers — the device-fleet directory list for GL.iNet site routers.
 *  Standalone page (own .portal-page/.dir-head, model: Notifications.tsx)
 *  built on the shared directory-list pattern (model:
 *  components/statusRules/RulesTab.tsx — the freshest full-pattern
 *  list): search + toolbar FilterButton facet (Site) + per-column
 *  ColumnMenu filters + persisted visible/sort/order state
 *  (usePersistentListState) + CSV export + virtualized rows.
 *
 *  Routers self-register via the device agent — there is no create flow
 *  here yet, hence the disabled "Register router" affordance. Row action
 *  is Delete only, gated on can('scanning_hardware', 'delete'). */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, deleteDevice, listDevices, type DeviceItem,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import {
  deviceCellText, deviceSearchText, deviceSortValue, tokenExpiryState, vpnLabel,
} from '../lib/devices';
import {
  ColHead, ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  listGridStyle, listScale, moveKey, passesFacets, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor, type ColumnDef, type FacetGroup, type FacetState,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import RouterLeases from '../components/hardware/RouterLeases';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';  /* .set-note */
import '../styles/hardware.css';

// Fit: default columns + trailing ≤ 1176px (.portal-page at a 1512px
// window, nav expanded).
const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.4fr', default: true, min: 140 },
  { key: 'wan_ip', label: 'WAN IP', width: '1fr', default: true, min: 100 },
  { key: 'lan_ip', label: 'LAN IP', width: '1fr', default: true, min: 100 },
  { key: 'mac', label: 'MAC', width: '1fr', default: true, min: 120 },
  { key: 'serial', label: 'Serial', width: '1fr', default: true, min: 110 },
  { key: 'vpn', label: 'VPN', width: '72px', default: true },
  { key: 'connected', label: 'Devices', width: '82px', default: true },
  {
    key: 'token_expires', label: 'Token expires', short: 'Expires',
    width: '1fr', default: true, min: 96,
  },
  { key: 'uptime', label: 'Uptime', width: '75px', default: true },
  { key: 'last_seen', label: 'Last seen', width: '1fr', default: false, min: 96 },
  { key: 'site', label: 'Site', width: '1fr', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

const deviceCellTextTyped: CellText<DeviceItem> = (d, key) => deviceCellText(d, key);

const CSV_COLUMNS: [string, (d: DeviceItem) => string][] = [
  ['ID', (d) => d.id],
  ['Name', (d) => d.name],
  ['WAN IP', (d) => deviceCellText(d, 'wan_ip')],
  ['LAN IP', (d) => deviceCellText(d, 'lan_ip')],
  ['MAC', (d) => deviceCellText(d, 'mac')],
  ['Serial', (d) => deviceCellText(d, 'serial')],
  ['VPN', (d) => deviceCellText(d, 'vpn')],
  ['Devices', (d) => deviceCellText(d, 'connected')],
  ['Token expires', (d) => deviceCellText(d, 'token_expires')],
  ['Uptime', (d) => deviceCellText(d, 'uptime')],
  ['Last seen', (d) => deviceCellText(d, 'last_seen')],
  ['Site', (d) => deviceCellText(d, 'site')],
];

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : "Couldn't delete the router.";

/** No tooltip for a blank cell — "—" repeated as a title on hover reads
 *  as noise, not information. */
const titleFor = (text: string) => (text === '—' ? undefined : text);

export default function Routers() {
  const { can, preferences } = useAuth();
  const canDelete = can('scanning_hardware', 'delete');
  const listGridScale = listScale(preferences?.list_size);

  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'hardware-routers', { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      setDevices(await listDevices('router'));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? "You don't have access to scanning hardware."
        : "Couldn't load routers.");
    }
  };

  useEffect(() => { void load(); }, []);

  const searchText = (d: DeviceItem) => deviceSearchText(d).toLowerCase();
  const haystack = useSearchHaystacks(devices, searchText);

  const facetGroups = useMemo<FacetGroup[]>(() => {
    const sites = new Set<string>();
    const vpns = new Set<string>();
    for (const d of devices ?? []) {
      sites.add(d.site_name ?? '—');
      vpns.add(vpnLabel(d.vpn_status));
    }
    return [
      { key: 'site', title: 'Site', options: Array.from(sites).sort().map((v) => (
        { value: v, label: v }
      )) },
      { key: 'vpn', title: 'VPN', options: Array.from(vpns).sort().map((v) => (
        { value: v, label: v }
      )) },
    ];
  }, [devices]);

  const facetValues = (d: DeviceItem) => (groupKey: string): string[] => {
    if (groupKey === 'site') return [d.site_name ?? '—'];
    if (groupKey === 'vpn') return [vpnLabel(d.vpn_status)];
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

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle(shownCols, ['90px', '30px'], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

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
      case 'serial': {
        const text = deviceCellText(d, key);
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'vpn':
        return d.vpn_status == null
          ? <span>—</span>
          : (
            <span className={'chip' + (d.vpn_status === 'connected' ? ' c-green'
              : d.vpn_status === 'disconnected' ? ' c-red' : '')}>
              {vpnLabel(d.vpn_status)}
            </span>
          );
      case 'token_expires': {
        const state = tokenExpiryState(d.token_expires_at);
        const text = deviceCellText(d, 'token_expires');
        if (state === 'expired') return <span className="chip c-red">expired</span>;
        if (state === 'soon') return <span className="chip c-amber">{text}</span>;
        return <span className="cell-line" title={titleFor(text)}>{text}</span>;
      }
      default: {
        const text = deviceCellText(d, key);
        return <span className="cell-line" title={titleFor(text)}>{text}</span>;
      }
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Scanning Hardware</div>
          <h1 className="page-title">
            Routers
            <span className="badge-count">{devices?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">GL.iNet site routers.</p>
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
          <ExportButton onExport={() => exportCsv('routers', CSV_COLUMNS, visible)} />
          <button type="button" className="btn-solid" disabled
                  title="Routers self-register — the registration endpoint arrives with the device agent.">
            Register router
          </button>
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{devices ? "Couldn't complete that action" : 'Cannot load routers'}</b>{error}
        </div>
      )}

      {devices && (
        <div className="dir-list list-scroll">
          <div className="list-head" style={rowStyle}>
            {shownCols.map((c) => (
              <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                       onToggleSort={() => toggleSort(c.key)} className={headerDrag.dropClass(c.key)}
                       dragProps={headerDrag.dragProps(c.key)}>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={devices ?? []} filters={filters}
                            text={deviceCellTextTyped}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </ColHead>
            ))}
            <span />
            <span />
          </div>

          {visible.length === 0 && (
            devices.length === 0 ? (
              <div className="dir-empty">
                No routers registered yet.
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
            renderRow={(d, vp) => {
              const open = openId === d.id;
              return (
                <div key={d.id} className={`dir-row ${open ? 'open' : ''}`} {...vp}
                     style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                  <div className="row-main" style={rowStyle}
                       onClick={() => setOpenId(open ? null : d.id)}>
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
                    <div className="cell chevron-cell">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                    </div>
                  </div>

                  <div className="detail">
                    <div className="detail-clip">
                      <div className="detail-inner">
                        {open && <RouterLeases deviceId={d.id} />}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }} />
        </div>
      )}
    </div>
  );
}
