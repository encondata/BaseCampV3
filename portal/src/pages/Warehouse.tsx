/**
 * Warehouse (/logistics/warehouse) — one warehouse site at a time: its
 * containers (with contents), loose tagged assets, and counted stock
 * lines, flattened into the standard directory list (cloned from
 * Containers.tsx's skeleton). Containers and assets are never written
 * here — their existing modals (ContainerEditModal / AssetEditModal) are
 * reused; only stock lines are owned by this page (StockLineModal /
 * StockMoveModal).
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ComboBox from '../components/ComboBox';
import ContainerEditModal from '../components/containers/ContainerEditModal';
import AssetEditModal from '../components/assets/AssetEditModal';
import StockLineModal from '../components/warehouse/StockLineModal';
import StockMoveModal from '../components/warehouse/StockMoveModal';
import { RowActionsMenu, type RowAction } from '../components/hardware/RowActionsMenu';
import {
  ApiError, archiveStockLine, getAsset, getWarehouseInventory, listAssetStatuses,
  listClients, listContainerStatuses, listContainerTypes, listSites, listWarehouseSites,
  type AssetItem, type AssetRef, type ContainerItem, type OrgRef, type SiteItem,
  type StatusValue, type StockLine, type WarehouseContainer, type WarehouseInventory,
  type WarehouseSite,
} from '../lib/api';
import {
  flattenInventory, inventoryCellText, inventorySearchText, KIND_LABEL, modelLabel,
  type InventoryRow, type InventoryRowKind,
} from '../lib/warehouse';
import { relativeTime } from '../lib/format';
import { statusChip } from '../lib/chips';
import { naturalCompare } from '../lib/sites';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import {
  applyColumnOrder, ColumnsButton, ExportButton, exportCsv, moveKey,
  useReorderDrag, useSearchHaystacks, visibleColumnsFor, type ColumnDef,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/dashboard.css';
import '../styles/containers.css';
import '../styles/warehouse.css';

const nf = new Intl.NumberFormat();
const skel = <span className="dash-skel" aria-label="loading" />;

const KIND_PILLS: { key: 'all' | InventoryRowKind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'container', label: 'Containers' },
  { key: 'asset', label: 'Assets' },
  { key: 'stock', label: 'Stock' },
];

const COLUMNS: ColumnDef[] = [
  { key: 'kind', label: 'Kind', width: '0.8fr', default: true },
  { key: 'model', label: 'Model', width: '1.3fr', default: true },
  { key: 'qty', label: 'Qty', width: '1fr', default: true },
  { key: 'location', label: 'Location', width: '1.3fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'updated', label: 'Updated', width: '1fr', default: false },
];
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'primary']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(r: InventoryRow, key: string): string {
  switch (key) {
    case 'primary': return r.primary.toLowerCase();
    case 'kind': return KIND_LABEL[r.kind].toLowerCase();
    case 'model': return r.model.toLowerCase();
    case 'qty': return r.qtyText.toLowerCase();
    case 'location': return r.location.toLowerCase();
    case 'status': return (r.status?.label ?? '').toLowerCase();
    case 'updated': return r.updated ?? '';
    default: return '';
  }
}

const CSV_COLUMNS: [string, (r: InventoryRow) => string][] = [
  ['Item', (r) => r.primary],
  ['Kind', (r) => KIND_LABEL[r.kind]],
  ['Model', (r) => r.model],
  ['Qty', (r) => r.qtyText],
  ['Location', (r) => r.location],
  ['Status', (r) => r.status?.label ?? ''],
  ['Updated', (r) => r.updated ?? ''],
];

const MINI_GRID: CSSProperties = { gridTemplateColumns: '2fr 1.3fr 0.8fr 1fr auto' };

// inventoryCellText's colKey is a narrow union (its callers always know
// the exact key); ColumnMenu/passesColumnFilters want the wider
// CellText<T> = (row, colKey: string) => string shape — same pattern as
// Initiatives.tsx's `cellText` wrapper around `initiativeCellText`.
const cellText = (r: InventoryRow, colKey: string): string =>
  inventoryCellText(r, colKey as Parameters<typeof inventoryCellText>[1]);

function toContainerItem(c: WarehouseContainer, siteId: string, siteName: string): ContainerItem {
  return {
    id: c.id, name: c.name, rfid_tag: c.rfid_tag,
    container_type: c.container_type, type_label: c.type_label, type_color: c.type_color,
    status: c.status, status_label: c.status_label, status_color: c.status_color,
    site_id: siteId, site_name: siteName,
    location_detail: c.location_detail, asset_count: c.assets.length,
    last_audit_at: null, last_validated_at: null,
    archived_at: null, created_at: c.updated_at,
  };
}

export default function Warehouse() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const canAddStock = can('warehouse', 'add');
  const canChangeStock = can('warehouse', 'change');
  const canDeleteStock = can('warehouse', 'delete');
  const canAddContainer = can('containers', 'add');
  const canChangeContainer = can('containers', 'change');
  const canChangeAsset = can('assets', 'change');
  const canViewSites = can('sites', 'view');

  const [whSites, setWhSites] = useState<WarehouseSite[] | null>(null);
  const [sitesError, setSitesError] = useState('');
  const [siteId, setSiteId] = useState<string>('');
  const [inventory, setInventory] = useState<WarehouseInventory | null>(null);
  const [error, setError] = useState('');

  const [containerStatuses, setContainerStatuses] = useState<StatusValue[]>([]);
  const [containerTypes, setContainerTypes] = useState<StatusValue[]>([]);
  const [allSites, setAllSites] = useState<SiteItem[]>([]);
  const [assetStatuses, setAssetStatuses] = useState<StatusValue[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);

  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | InventoryRowKind>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);

  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [editingStockLine, setEditingStockLine] = useState<StockLine | null>(null);
  const [movingLine, setMovingLine] = useState<StockLine | null>(null);
  const [editingContainer, setEditingContainer] = useState<ContainerItem | null>(null);
  const [creatingContainer, setCreatingContainer] = useState(false);
  const [editingAsset, setEditingAsset] = useState<AssetItem | null>(null);

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'warehouse', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const loadSites = () => {
    void listWarehouseSites().then((rows) => { setWhSites(rows); setSitesError(''); })
      .catch((err) => {
        setSitesError(err instanceof ApiError && err.status === 403
          ? 'You do not have permission to view warehouse.'
          : 'Failed to load warehouse sites.');
      });
  };

  const loadInventory = (id: string, initial: boolean) => {
    if (initial) setInventory(null);
    getWarehouseInventory(id).then((inv) => { setInventory(inv); setError(''); })
      .catch((err) => {
        setError(err instanceof ApiError && err.status === 403
          ? 'You do not have permission to view warehouse inventory.'
          : 'Failed to load inventory.');
      });
  };

  const refetchAll = () => {
    loadSites();
    if (siteId) loadInventory(siteId, false);
  };

  useEffect(() => {
    loadSites();
    void listContainerStatuses().then(setContainerStatuses).catch(() => {});
    void listContainerTypes().then(setContainerTypes).catch(() => {});
    if (canViewSites) void listSites().then(setAllSites).catch(() => {});
    void listAssetStatuses().then(setAssetStatuses).catch(() => {});
    void listClients().then(setClients).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick the initial site once the list has loaded: ?site= in the URL,
  // else the last one persisted in localStorage, else the first site.
  useEffect(() => {
    if (!whSites || whSites.length === 0 || siteId) return;
    let fromStorage: string | null = null;
    try { fromStorage = localStorage.getItem('warehouse.site'); } catch { /* ignore */ }
    const candidates = [searchParams.get('site'), fromStorage];
    const found = candidates.find((id) => id && whSites.some((s) => s.id === id));
    setSiteId(found ?? whSites[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whSites]);

  // Persist the chosen site (URL + localStorage) and load its inventory.
  useEffect(() => {
    if (!siteId) return;
    try { localStorage.setItem('warehouse.site', siteId); } catch { /* ignore */ }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('site', siteId);
      return next;
    }, { replace: true });
    loadInventory(siteId, true);
    setOpenKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const selectedSite = whSites?.find((s) => s.id === siteId) ?? null;
  const existingSerials = useMemo(() => {
    const s = new Set<string>();
    if (inventory) {
      for (const c of inventory.containers) {
        for (const a of c.assets) if (a.serial_number) s.add(a.serial_number.trim().toLowerCase());
      }
      for (const a of inventory.loose_assets) if (a.serial_number) s.add(a.serial_number.trim().toLowerCase());
    }
    return s;
  }, [inventory]);
  const siteOptions = useMemo(() => (whSites ?? []).map((s) => ({
    value: s.id, label: s.name,
    sub: `${nf.format(s.container_count)} containers · ${nf.format(s.stock_units)} units`,
  })), [whSites]);

  const rows = useMemo(() => (inventory ? flattenInventory(inventory) : []), [inventory]);
  const kindCounts = useMemo(() => {
    const c: Record<'all' | InventoryRowKind, number> = { all: rows.length, container: 0, asset: 0, stock: 0 };
    for (const r of rows) c[r.kind] += 1;
    return c;
  }, [rows]);

  const haystack = useSearchHaystacks(rows, inventorySearchText);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false;
      if (!passesColumnFilters(r, filters, cellText)) return false;
      if (!q) return true;
      return haystack(r).includes(q);
    });
    return filtered.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [rows, kindFilter, filters, query, sortKey, sortDir, haystack]);

  const openAssetEdit = (id: string) => {
    void getAsset(id).then(setEditingAsset).catch(() => setError('Failed to load asset.'));
  };

  const doArchiveStock = (line: StockLine) => {
    if (!window.confirm('Archive this stock line?')) return;
    void archiveStockLine(line.id, true)
      .then(() => refetchAll())
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not save — try again.'));
  };

  const actionsFor = (r: InventoryRow): RowAction[] => {
    if (r.kind === 'container' && r.container) {
      const c = r.container;
      return [
        ...(canChangeContainer ? [{
          key: 'edit', label: 'Edit',
          onSelect: () => setEditingContainer(toContainerItem(c, siteId, selectedSite?.name ?? '')),
        }] : []),
        { key: 'open', label: 'Open in Containers', onSelect: () => navigate(`/logistics/containers?open=${c.id}`) },
      ];
    }
    if (r.kind === 'asset' && r.asset) {
      const a = r.asset;
      return [
        ...(canChangeAsset ? [{ key: 'edit', label: 'Edit', onSelect: () => openAssetEdit(a.id) }] : []),
        { key: 'open', label: 'Open in Assets', onSelect: () => navigate(`/assets?open=${a.id}`) },
      ];
    }
    if (r.kind === 'stock' && r.stock) {
      const s = r.stock;
      return [
        ...(canChangeStock ? [{
          key: 'edit', label: 'Edit',
          onSelect: () => { setEditingStockLine(s); setStockModalOpen(true); },
        }] : []),
        ...(canChangeStock ? [{ key: 'move', label: 'Move', onSelect: () => setMovingLine(s) }] : []),
        ...(canDeleteStock ? [{
          key: 'archive', label: 'Archive', destructive: true, onSelect: () => doArchiveStock(s),
        }] : []),
      ];
    }
    return [];
  };

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `2fr ${shownCols.map((c) => c.width).join(' ')} 88px 30px` };

  const cellFor = (r: InventoryRow, key: string) => {
    switch (key) {
      case 'kind':
        if (r.kind === 'container') return <span className="chip tag">Container</span>;
        if (r.kind === 'asset') return <span className="chip">Asset</span>;
        return (
          <span className="chip custom" style={{ '--chip': '#a36207' } as CSSProperties}>
            <span className="dot" />Stock
          </span>
        );
      case 'model':
        return <span className="cell-sub">{r.model || '—'}</span>;
      case 'qty':
        return <span className="mono">{r.qtyText || '—'}</span>;
      case 'location':
        return <span className="cell-sub">{r.location || '—'}</span>;
      case 'status':
        return r.status ? statusChip(r.status.label, r.status.color) : <span className="cell-top">—</span>;
      case 'updated':
        return <span className="mono">{r.updated ? relativeTime(r.updated) : ''}</span>;
      default:
        return null;
    }
  };

  if (sitesError) {
    return (
      <div className="portal-page">
        <div className="dir-head"><div>
          <div className="eyebrow">Logistics</div>
          <h1 className="page-title">Warehouse</h1>
        </div></div>
        <div className="dir-empty"><b>Cannot load warehouse</b>{sitesError}</div>
      </div>
    );
  }

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Logistics</div>
          <h1 className="page-title">Warehouse</h1>
          <p className="page-hint">
            One warehouse at a time — containers, tagged assets, and counted stock.
          </p>
        </div>
      </div>

      {whSites && whSites.length === 0 && (
        <p className="page-hint">No sites are typed Warehouse yet. <Link to="/sites">Open Sites</Link></p>
      )}

      {whSites && whSites.length > 0 && (
        <>
          <div className="wh-head">
            <div className="wh-selector">
              <ComboBoxSiteSelector
                options={siteOptions}
                value={siteId}
                onChange={setSiteId}
              />
            </div>
            <div className="dash-kpis wh-tiles">
              <div className="dash-kpi">
                <span className="dash-kpi-label">Containers</span>
                <span className="dash-kpi-value">{inventory ? nf.format(inventory.site.container_count) : skel}</span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-label">Tagged assets</span>
                <span className="dash-kpi-value">{inventory ? nf.format(inventory.site.asset_count) : skel}</span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-label">Stock lines</span>
                <span className="dash-kpi-value">{inventory ? nf.format(inventory.site.stock_line_count) : skel}</span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-label">Units in stock</span>
                <span className="dash-kpi-value">{inventory ? nf.format(inventory.site.stock_units) : skel}</span>
              </div>
            </div>
          </div>

          {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load inventory</b>{error}</div>}

          {!error && (
            <>
              <div className="dir-toolbar">
                <div className="segmented" role="tablist">
                  {KIND_PILLS.map((pl) => (
                    <button key={pl.key} className={kindFilter === pl.key ? 'on' : ''}
                            onClick={() => setKindFilter(pl.key)}>
                      {pl.label} <span className="n">{kindCounts[pl.key] ?? 0}</span>
                    </button>
                  ))}
                </div>
                <div className="toolbar-right">
                  <div className="dir-search" style={{ marginLeft: 0 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                         strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                    <input placeholder="Filter this list…" value={query}
                           onChange={(e) => setQuery(e.target.value)} />
                  </div>
                  <span className="result-count">{visible.length} of {rows.length} shown</span>
                  <FilterSummaryChip filters={filters} onClear={clearFilters} />
                  <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                                 onReorder={setColOrder} />
                  <ExportButton onExport={() => exportCsv('warehouse', CSV_COLUMNS, visible)} />
                  {canAddStock && (
                    <button className="btn-solid" onClick={() => { setEditingStockLine(null); setStockModalOpen(true); }}>
                      + Add stock
                    </button>
                  )}
                  {canAddContainer && (
                    <button className="btn-ghost" onClick={() => setCreatingContainer(true)}>
                      + New container
                    </button>
                  )}
                </div>
              </div>

              <div className="dir-list">
                <div className="list-head" style={grid}>
                  <span className="col-head">
                    <button className="sortable" onClick={() => toggleSort('primary')}>
                      Item {caret('primary')}
                    </button>
                    <ColumnMenu colKey="primary" label="Item"
                                allRows={rows} filters={filters}
                                text={cellText}
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
                                  allRows={rows} filters={filters}
                                  text={cellText}
                                  filter={filters[c.key]} onFilter={setFilter}
                                  sortDir={sortKey === c.key ? sortDir : null}
                                  onSort={(dir) => setSort(c.key, dir)} />
                    </span>
                  ))}
                  <span className="col-head" />
                  <span className="col-head" />
                </div>

                {inventory && visible.length === 0 && (
                  <div className="dir-empty">
                    <b>No matches</b>Try a different filter.
                    <EmptyClearFilters filters={filters} onClear={clearFilters} />
                  </div>
                )}

                <VirtualRows rows={visible}
                  renderRow={(r, vp) => {
                  const open = r.kind === 'container' && openKey === r.key;
                  return (
                    <div key={r.key} className={`dir-row ${open ? 'open' : ''}`} {...vp} style={vp?.style}>
                      <div className="row-main" style={grid}
                           onClick={() => {
                             if (r.kind !== 'container') return;
                             setOpenKey(openKey === r.key ? null : r.key);
                           }}>
                        <div className="cell cell-primary">
                          <div className="pn"><b>{r.primary}</b><span>{r.secondary || '—'}</span></div>
                        </div>
                        {shownCols.map((col) => (
                          <div className="cell" key={col.key}>{cellFor(r, col.key)}</div>
                        ))}
                        <div className="cell" onClick={(e) => e.stopPropagation()}
                             style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <RowActionsMenu actions={actionsFor(r)} />
                        </div>
                        <div className="cell chevron-cell">
                          {r.kind === 'container' && (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                 strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                          )}
                        </div>
                      </div>

                      {r.kind === 'container' && r.container && (
                        <div className="detail">
                          <div className="detail-clip">
                            <div className="detail-inner">
                              {open && (
                                <ContainerMiniList
                                  container={r.container}
                                  canChangeAsset={canChangeAsset}
                                  canChangeStock={canChangeStock}
                                  onEditAsset={openAssetEdit}
                                  onEditStock={(s) => { setEditingStockLine(s); setStockModalOpen(true); }}
                                  onMoveStock={(s) => setMovingLine(s)}
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }} />
              </div>
            </>
          )}
        </>
      )}

      {stockModalOpen && inventory && (
        <StockLineModal
          siteId={siteId}
          siteName={inventory.site.name}
          containers={inventory.containers}
          line={editingStockLine}
          onClose={() => setStockModalOpen(false)}
          onSaved={() => refetchAll()}
        />
      )}
      {movingLine && inventory && (
        <StockMoveModal
          line={movingLine}
          containers={inventory.containers}
          onClose={() => setMovingLine(null)}
          onSaved={() => refetchAll()}
        />
      )}
      {(editingContainer || creatingContainer) && (
        <ContainerEditModal
          container={editingContainer}
          statuses={containerStatuses}
          types={containerTypes}
          sites={allSites}
          canChange={canChangeContainer}
          onClose={() => { setEditingContainer(null); setCreatingContainer(false); }}
          onSaved={() => refetchAll()}
        />
      )}
      {editingAsset && (
        <AssetEditModal
          asset={editingAsset}
          statuses={assetStatuses}
          clients={clients}
          sites={allSites}
          existingSerials={existingSerials}
          canChange={canChangeAsset}
          onClose={() => setEditingAsset(null)}
          onSaved={() => refetchAll()}
        />
      )}
    </div>
  );
}

/* ── site selector: thin ComboBox wrapper (kept local — the page is the
 * only consumer of this exact "warehouse site with counts" shape). ──── */
function ComboBoxSiteSelector({ options, value, onChange }: {
  options: { value: string; label: string; sub: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <ComboBox options={options} value={value} onChange={(v) => v && onChange(v)}
              placeholder="Select a warehouse…" />
  );
}

/* ── expanded container contents: assets + stock, each with its own
 * Edit (and, for stock, Move) mini-btn. Read-only otherwise. ────────── */
function ContainerMiniList({
  container, canChangeAsset, canChangeStock, onEditAsset, onEditStock, onMoveStock,
}: {
  container: WarehouseContainer;
  canChangeAsset: boolean;
  canChangeStock: boolean;
  onEditAsset: (id: string) => void;
  onEditStock: (line: StockLine) => void;
  onMoveStock: (line: StockLine) => void;
}) {
  if (container.assets.length === 0 && container.stock.length === 0) {
    return <p className="page-hint wh-mini-indent">Nothing inside this container.</p>;
  }
  return (
    <div className="mini-list wh-mini-indent">
      <div className="mini-list-head" style={MINI_GRID}>
        <span>Item</span><span>Model</span><span>Qty</span><span>Status</span><span />
      </div>
      {container.assets.map((a: AssetRef) => (
        <div className="mini-row" style={MINI_GRID} key={`a:${a.id}`}>
          <span className="cell-top">{a.serial_number ?? a.name ?? '—'}</span>
          <span className="cell-sub">{a.model_name ?? '—'}</span>
          <span className="mono">1</span>
          <span className="cell-top">{statusChip(a.status_label, a.status_color) ?? '—'}</span>
          <span className="mini-row-actions">
            {canChangeAsset && (
              <button type="button" className="mini-btn" onClick={() => onEditAsset(a.id)}>Edit</button>
            )}
          </span>
        </div>
      ))}
      {container.stock.map((s: StockLine) => (
        <div className="mini-row" style={MINI_GRID} key={`s:${s.id}`}>
          <span className="cell-top">{s.description}</span>
          <span className="cell-sub">
            {s.model_make && s.model_model ? modelLabel({ make: s.model_make, model: s.model_model }) : '—'}
          </span>
          <span className="mono">{s.quantity} {s.unit}</span>
          <span className="cell-top">—</span>
          <span className="mini-row-actions">
            {canChangeStock && (
              <button type="button" className="mini-btn" onClick={() => onEditStock(s)}>Edit</button>
            )}
            {canChangeStock && (
              <button type="button" className="mini-btn" onClick={() => onMoveStock(s)}>Move</button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
