/** Routers — the device-fleet directory list for GL.iNet site routers.
 *  Standalone page (own .portal-page/.dir-head, model: Notifications.tsx)
 *  built on the shared directory-list pattern (model:
 *  components/statusRules/RulesTab.tsx — the freshest full-pattern
 *  list): search + toolbar FilterButton facet (Site) + per-column
 *  ColumnMenu filters + persisted visible/sort/order state
 *  (usePersistentListState) + CSV export + virtualized rows.
 *
 *  Routers self-register through the GL.iNet agent (router_agent/) and
 *  stay Pending — reports held — until approved here or from the inbox.
 *  "How to add a router" shows the one-line installer. Row actions
 *  (Approve / Revoke / Delete) live behind the shared RowActionsMenu;
 *  ?focus=<id> (the approval notification's link) opens that row. */

import { compareValues, naturalCompare } from '../lib/naturalSort';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, apiUrl, approveRouter, deleteDevice, listDevices, revokeRouter, type DeviceItem,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import {
  approvalLabel, deviceCellText, deviceSearchText, deviceSortValue, routerStatus,
  routerStatusLabel, vpnChipClass, vpnLabel,
} from '../lib/devices';
import {
  ColHead, ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  listGridStyle, listScale, moveKey, passesFacets, titleFor, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor, type ColumnDef, type FacetGroup, type FacetState,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import AddRouterModal from '../components/hardware/AddRouterModal';
import RouterDetail from '../components/hardware/RouterDetail';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';  /* .set-note */
import '../styles/hardware.css';

// Fit: default columns + trailing compute to well under LIST_FIT.page
// (1172px — measured 1174px in the browser at a 1512px window, nav expanded).
const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.4fr', default: true, min: 140 },
  { key: 'approval', label: 'Approval', width: '1fr', default: true, min: 110 },
  { key: 'status', label: 'Status', width: '80px', default: true },
  { key: 'wan_ip', label: 'WAN IP', width: '1fr', default: true, min: 100 },
  { key: 'lan_ip', label: 'LAN IP', width: '1fr', default: true, min: 100 },
  { key: 'mac', label: 'MAC', width: '1fr', default: true, min: 116 },
  { key: 'vpn', label: 'VPN', width: '72px', default: true },
  { key: 'connected', label: 'Clients', width: '72px', default: true },
  { key: 'uptime', label: 'Uptime', width: '75px', default: true },
  { key: 'model', label: 'Model', width: '1fr', default: false, min: 110 },
  { key: 'serial', label: 'Serial', width: '1fr', default: false, min: 110 },
  { key: 'last_seen', label: 'Last seen', width: '1fr', default: false, min: 96 },
  { key: 'site', label: 'Site', width: '1fr', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

const deviceCellTextTyped: CellText<DeviceItem> = (d, key) => deviceCellText(d, key);

const CSV_COLUMNS: [string, (d: DeviceItem) => string][] = [
  ['ID', (d) => d.id],
  ['Name', (d) => d.name],
  ['Approval', (d) => deviceCellText(d, 'approval')],
  ['Status', (d) => deviceCellText(d, 'status')],
  ['WAN IP', (d) => deviceCellText(d, 'wan_ip')],
  ['LAN IP', (d) => deviceCellText(d, 'lan_ip')],
  ['MAC', (d) => deviceCellText(d, 'mac')],
  ['VPN', (d) => deviceCellText(d, 'vpn')],
  ['Clients', (d) => deviceCellText(d, 'connected')],
  ['Uptime', (d) => deviceCellText(d, 'uptime')],
  ['Model', (d) => deviceCellText(d, 'model')],
  ['Serial', (d) => deviceCellText(d, 'serial')],
  ['Last seen', (d) => deviceCellText(d, 'last_seen')],
  ['Site', (d) => deviceCellText(d, 'site')],
  ['Reporting from', (d) => d.agent_source_ip ?? ''],
];

const msgFor = (err: unknown, what: string): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : `Couldn't ${what} the router.`;

export default function Routers() {
  const { can, preferences } = useAuth();
  const canDelete = can('scanning_hardware', 'delete');
  const canChange = can('scanning_hardware', 'change');
  const listGridScale = listScale(preferences?.list_size);

  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('focus');

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

  // The approval notification links here with ?focus=<id>: open that row
  // once the list has it, and bring it into view.
  useEffect(() => {
    if (!focusId || !devices?.some((d) => d.id === focusId)) return;
    setOpenId(focusId);
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(focusId) : focusId;
    document.querySelector(`[data-device-id="${esc}"]`)
      ?.scrollIntoView?.({ block: 'center' });
  }, [focusId, devices]);

  const searchText = (d: DeviceItem) => deviceSearchText(d).toLowerCase();
  const haystack = useSearchHaystacks(devices, searchText);

  const facetGroups = useMemo<FacetGroup[]>(() => {
    const sites = new Set<string>();
    const vpns = new Set<string>();
    const approvals = new Set<string>();
    for (const d of devices ?? []) {
      sites.add(d.site_name ?? '—');
      vpns.add(vpnLabel(d.vpn_status));
      approvals.add(approvalLabel(d.approval_state));
    }
    return [
      { key: 'site', title: 'Site', options: Array.from(sites).sort(naturalCompare).map((v) => (
        { value: v, label: v }
      )) },
      { key: 'approval', title: 'Approval', options: Array.from(approvals).sort(naturalCompare).map((v) => (
        { value: v, label: v }
      )) },
      { key: 'vpn', title: 'VPN', options: Array.from(vpns).sort(naturalCompare).map((v) => (
        { value: v, label: v }
      )) },
    ];
  }, [devices]);

  const facetValues = (d: DeviceItem) => (groupKey: string): string[] => {
    if (groupKey === 'site') return [d.site_name ?? '—'];
    if (groupKey === 'vpn') return [vpnLabel(d.vpn_status)];
    if (groupKey === 'approval') return [approvalLabel(d.approval_state)];
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
      return compareValues(va, vb) * sortDir;
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

  const act = async (fn: () => Promise<unknown>, what: string) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(msgFor(err, what));
    }
  };

  const remove = (d: DeviceItem) => {
    if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    void act(() => deleteDevice(d.id), 'delete');
  };

  const approve = (d: DeviceItem) => {
    if (!window.confirm(
      `Approve "${d.name}"? MAC ${d.mac ?? '—'} · ${d.model ?? 'unknown model'} · `
      + `reporting from ${d.agent_source_ip ?? 'an unknown address'}. `
      + 'Its reports are stored from its next check-in.',
    )) return;
    void act(() => approveRouter(d.id), 'approve');
  };

  const revoke = (d: DeviceItem) => {
    if (!window.confirm(
      `Revoke "${d.name}"? Its reports stop being stored right away; `
      + 'it shows as pending again the next time it checks in.',
    )) return;
    void act(() => revokeRouter(d.id), 'revoke');
  };

  const actionsFor = (d: DeviceItem) => {
    const agent = d.approval_state != null;
    return [
      ...(canChange && agent && d.approval_state !== 'approved'
        ? [{ key: 'approve', label: 'Approve', onSelect: () => approve(d) }] : []),
      ...(canChange && d.approval_state === 'approved'
        ? [{ key: 'revoke', label: 'Revoke', onSelect: () => revoke(d) }] : []),
      ...(canDelete
        ? [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => remove(d) }] : []),
    ];
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
          : <span className={'chip' + vpnChipClass(d.vpn_status)}>{vpnLabel(d.vpn_status)}</span>;
      case 'approval': {
        if (d.approval_state == null) return <span>—</span>;
        const tone = d.approval_state === 'approved' ? ' c-green'
          : d.approval_state === 'pending' ? ' c-amber' : '';
        return (
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            <span className={'chip' + tone}>{approvalLabel(d.approval_state)}</span>
            {d.secret_mismatch && (
              <span className="chip c-red"
                    title="This MAC reported with a different secret — the router was reset, reinstalled, or is being impersonated.">
                Secret changed
              </span>
            )}
          </span>
        );
      }
      case 'status': {
        const state = routerStatus(d.last_seen_at);
        return (
          <span className={'chip' + (state === 'online' ? ' c-green' : '')}>
            {routerStatusLabel(state)}
          </span>
        );
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
          <button type="button" className="btn-solid" onClick={() => setAdding(true)}>
            How to add a router
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
            <span className="col-head" aria-hidden="true" />
            <span className="col-head" aria-hidden="true" />
          </div>

          {visible.length === 0 && (
            devices.length === 0 ? (
              <div className="dir-empty">
                No routers yet. Use “How to add a router” to install the agent on a GL.iNet router.
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
                <div key={d.id} data-device-id={d.id} className={`dir-row ${open ? 'open' : ''}`} {...vp}
                     style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                  <div className="row-main" style={rowStyle}
                       onClick={() => setOpenId(open ? null : d.id)}>
                    {shownCols.map((c) => (
                      <div className="cell" key={c.key}>{cellFor(d, c.key)}</div>
                    ))}
                    <div className="cell" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <RowActionsMenu actions={actionsFor(d)} />
                    </div>
                    <div className="cell chevron-cell">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                    </div>
                  </div>

                  <div className="detail">
                    <div className="detail-clip">
                      <div className="detail-inner">
                        {open && <RouterDetail device={d} />}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }} />
        </div>
      )}

      {adding && <AddRouterModal apiBase={apiUrl()} onClose={() => setAdding(false)} />}
    </div>
  );
}
