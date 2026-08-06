/**
 * Assets — the physical inventory registry: servers, network gear, and
 * anything else tracked by serial number. Directory pattern with
 * make/model + category/status chips, and a read-only detail panel
 * (identity, location & ownership). All mutation (create/edit/archive)
 * lands in AssetEditModal.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import AssetEditModal from '../components/assets/AssetEditModal';
import NotesFilesPanel from '../components/NotesFilesPanel';
import {
  ApiError,
  listAssetModels,
  listAssetStatuses,
  listAssets,
  listClients,
  listSites,
  updateAsset,
  type AssetItem,
  type AssetModelItem,
  type OrgRef,
  type SiteItem,
  type StatusValue,
} from '../lib/api';
import {
  ASSET_ERRORS, ASSET_GOD_FIELDS, assetCellText, assetSearchText, duplicateSerials,
} from '../lib/assets';
import { initialOpenId } from '../lib/auditFormat';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  rowsForMenu, usePersistentListState,
} from '../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import { naturalCompare } from '../lib/sites';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import {
  ColumnsButton,
  ExportButton,
  exportCsv,
  visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/assets.css';

const COLUMNS: ColumnDef[] = [
  { key: 'model', label: 'Make / Model', width: '1.5fr', default: true },
  { key: 'category', label: 'Category', width: '1fr', default: true },
  { key: 'client', label: 'Client', width: '1.2fr', default: true },
  { key: 'site', label: 'Site', width: '1.2fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'ru', label: 'RU', width: '0.5fr', default: false },
  { key: 'location', label: 'Location', width: '1.4fr', default: false },
  { key: 'rfid', label: 'RFID', width: '1fr', default: false },
  { key: 'last_seen', label: 'Last seen', width: '1fr', default: false },
  { key: 'has_rails', label: 'Rails', width: '0.8fr', default: false, godOnly: true },
];

// Every column the page can offer (incl. godOnly) plus the two pseudo-
// columns that aren't real COLUMNS entries — 'primary' (the always-shown
// serial+name cell) and 'archived' (the chevron-header filter-only column)
// — so a persisted filter/sort/visibility referencing either one survives
// usePersistentListState's rehydrate-time sanitization.
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'primary', 'archived']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Sort value per column key — deliberately separate from `assetCellText`:
 *  that accessor's job is display/filter text (dashes for blanks, formatted
 *  dates), which would sort wrong (e.g. localized last-seen dates sort
 *  lexicographically by month, not chronologically). This stays lowercase/
 *  raw so naturalCompare orders rows the way a user expects. */
function sortValueFor(a: AssetItem, key: string): string {
  switch (key) {
    case 'primary': return (a.serial_number ?? '').toLowerCase();
    case 'model': return a.model ? `${a.model.make} ${a.model.model}`.toLowerCase() : '';
    case 'category': return (a.model?.category_label ?? '').toLowerCase();
    case 'client': return (a.client_name ?? '').toLowerCase();
    case 'site': return (a.site_name ?? '').toLowerCase();
    case 'status': return a.status_label.toLowerCase();
    case 'ru': return String(a.model?.ru_size ?? 0);
    case 'location': return a.location_detail.toLowerCase();
    case 'rfid': return (a.rfid_tag ?? '').toLowerCase();
    case 'last_seen': return a.last_seen_at ?? '';
    case 'has_rails': return a.has_rails === null ? '' : a.has_rails ? 'yes' : 'no';
    case 'archived': return a.archived_at ? '1' : '0';
    default: return '';
  }
}

const CSV_COLUMNS: [string, (a: AssetItem) => string][] = [
  ['ID', (a) => a.id],
  ['Serial', (a) => a.serial_number ?? ''],
  ['Name', (a) => a.name ?? ''],
  ['Make', (a) => a.model?.make ?? ''],
  ['Model', (a) => a.model?.model ?? ''],
  ['Category', (a) => a.model?.category_label ?? ''],
  ['Client', (a) => a.client_name ?? ''],
  ['Site', (a) => a.site_name ?? ''],
  ['Location', (a) => a.location_detail],
  ['Status', (a) => a.status_label],
  ['RFID', (a) => a.rfid_tag ?? ''],
  ['Has rails', (a) => (a.has_rails === null ? '' : String(a.has_rails))],
  ['Last seen', (a) => a.last_seen_at ?? ''],
  ['Created', (a) => a.created_at],
];

export default function Assets() {
  const { can, godMode } = useAuth();
  const canAdd = can('assets', 'add');
  const canChange = can('assets', 'change');
  const canViewSites = can('sites', 'view');
  const canViewCategories = can('asset_models', 'view');
  const god = useGodEdit();

  const [assets, setAssets] = useState<AssetItem[] | null>(null);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [models, setModels] = useState<AssetModelItem[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  useRecordFocus(assets, (a) => a.id, (a) => a.serial_number ?? a.name ?? '', setOpenId, setQuery);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
  } = usePersistentListState(
    'assets', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      setAssets(await listAssets());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view assets.' : 'Failed to load assets.');
    }
  };

  useEffect(() => {
    void load();
    void listAssetStatuses().then(setStatuses).catch(() => {});
    if (canViewCategories) {
      void listAssetModels().then(setModels).catch(() => {});
    }
    void listClients().then(setClients).catch(() => {});
    if (canViewSites) void listSites().then(setSites).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const godFields = useMemo(() => ASSET_GOD_FIELDS({
    models: () => models.map((m) => ({ value: m.id, label: `${m.make} ${m.model}` })),
    clients: () => clients.map((c) => ({ value: c.id, label: c.name })),
    sites: () => (canViewSites ? sites.map((s) => ({ value: s.id, label: s.name })) : []),
    statuses: () => statuses.map((s) => ({ value: s.key, label: s.label })),
  }), [models, clients, sites, statuses, canViewSites]);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const replaceRow = (u: AssetItem) =>
    setAssets((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const dupes = useMemo(() => duplicateSerials(assets ?? []), [assets]);
  const existingSerials = useMemo(() => new Set(
    (assets ?? []).map((a) => a.serial_number?.trim().toLowerCase()).filter((s): s is string => !!s),
  ), [assets]);

  const visible = useMemo(() => {
    if (!assets) return [];
    const q = query.trim().toLowerCase();
    // Archived rows stay hidden by default — the chevron column's 'Archived'
    // ColumnMenu is the only way back in, and only via its 'Yes' checkbox.
    // (passesColumnFilters below independently enforces whatever the
    // archived filter says once one exists; this covers the no-filter-yet
    // default that passesColumnFilters has no opinion on.)
    const showArchived = filters.archived?.values?.includes('Yes') ?? false;
    const rows = assets.filter((a) => {
      if (!showArchived && a.archived_at) return false;
      if (!passesColumnFilters(a, filters, assetCellText)) return false;
      if (!q) return true;
      return assetSearchText(a).includes(q);
    });
    return rows.sort((a, b) => naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [assets, filters, query, sortKey, sortDir]);

  useEffect(() => {
    if (assets && openId && !visible.some((a) => a.id === openId)) setOpenId(null);
  }, [assets, visible, openId]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);
  const grid = { gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (a: AssetItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={a} gf={gf} patch={updateAsset} onRowSaved={replaceRow}
                   errorMap={ASSET_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'model':
        return <span className="cell-top">{a.model ? `${a.model.make} ${a.model.model}` : '—'}</span>;
      case 'category':
        return a.model?.category_color
          ? (
            <span className="chip custom" style={{ '--chip': a.model.category_color } as CSSProperties}>
              <span className="dot" />{a.model.category_label}
            </span>
          )
          : <span className="chip tag">{a.model?.category_label ?? '—'}</span>;
      case 'client':
        return <span className="cell-top">{a.client_name ?? 'House'}</span>;
      case 'site':
        return <span className="cell-top">{a.site_name ?? '—'}</span>;
      case 'status':
        return (
          <div className="chips">
            <span className="chip custom" style={{ '--chip': a.status_color } as CSSProperties}>
              <span className="dot" />{a.status_label}
            </span>
            {a.archived_at && <span className="chip tag">Archived</span>}
          </div>
        );
      case 'ru':
        return <span className="mono">{a.model?.ru_size ?? '—'}</span>;
      case 'location':
        return <span className="cell-top">{a.location_detail || '—'}</span>;
      case 'rfid':
        return <span className="mono">{a.rfid_tag ?? '—'}</span>;
      case 'last_seen':
        return <span className="cell-top">
          {a.last_seen_at ? new Date(a.last_seen_at).toLocaleDateString() : '—'}
        </span>;
      case 'has_rails':
        return <span className="cell-top">
          {a.has_rails === null ? 'Unknown' : a.has_rails ? 'Yes' : 'No'}
        </span>;
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Assets</div>
          <h1 className="page-title">
            Assets
            <span className="badge-count">{assets?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Physical inventory tracked by serial number — make/model, status, and location.
          </p>
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
          <span className="result-count">{visible.length} of {assets?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} godMode={godMode} />
          <ExportButton onExport={() => exportCsv('assets', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canChange} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New asset
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load assets</b>{error}</div>}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('primary')}>
                Serial {caret('primary')}
              </button>
              <ColumnMenu colKey="primary" label="Serial"
                          rows={rowsForMenu(assets ?? [], filters, 'primary', assetCellText)}
                          text={assetCellText}
                          filter={filters.primary} onFilter={setFilter}
                          sortDir={sortKey === 'primary' ? sortDir : null}
                          onSort={(dir) => setSort('primary', dir)} />
            </span>
            {shownCols.map((c) => (
              <span key={c.key} className="col-head">
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            rows={rowsForMenu(assets ?? [], filters, c.key, assetCellText)}
                            text={assetCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <ColumnMenu colKey="archived" label="Archived"
                        rows={rowsForMenu(assets ?? [], filters, 'archived', assetCellText)}
                        text={assetCellText}
                        filter={filters.archived} onFilter={setFilter}
                        sortDir={sortKey === 'archived' ? sortDir : null}
                        onSort={(dir) => setSort('archived', dir)} />
          </div>

          {assets && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add an asset.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          {visible.map((a) => {
            const open = openId === a.id;
            const isDupe = !!a.serial_number && dupes.has(a.serial_number.toLowerCase());
            return (
              <div key={a.id} className={`dir-row ${open ? 'open' : ''} ${a.archived_at ? 'archived' : ''}`}>
                <div className="row-main" style={grid}
                     onClick={() => setOpenId(open ? null : a.id)}>
                  <div className="cell cell-primary">
                    {god.editing && godFieldFor('primary') && godFieldFor('primary2') ? (
                      <div className="pn god-primary-edit">
                        <GodCell row={a} gf={godFieldFor('primary')!} patch={updateAsset}
                                 onRowSaved={replaceRow} errorMap={ASSET_ERRORS} disabled={!canChange} />
                        <GodCell row={a} gf={godFieldFor('primary2')!} patch={updateAsset}
                                 onRowSaved={replaceRow} errorMap={ASSET_ERRORS} disabled={!canChange} />
                      </div>
                    ) : (
                      <div className="pn"><b>{a.serial_number ?? '—'}</b><span>{a.name ?? '—'}</span></div>
                    )}
                    {isDupe && <span className="chip c-amber">Duplicate SN</span>}
                  </div>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(a, c.key)}</div>
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
                        <AssetRowDetail
                          asset={a}
                          canEdit={canChange}
                          onEdit={() => setEditingId(a.id)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingId !== null && (
        <AssetEditModal
          asset={assets?.find((a) => a.id === editingId) ?? null}
          statuses={statuses}
          clients={clients}
          sites={sites}
          existingSerials={existingSerials}
          canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => load()}
        />
      )}
      {creating && (
        <AssetEditModal
          asset={null}
          statuses={statuses}
          clients={clients}
          sites={sites}
          existingSerials={existingSerials}
          canChange={canChange}
          onClose={() => setCreating(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

/* ── row detail: read-only display — the ONLY interactive element is the
 * Edit button. The Notes & Files panel (Task 13) mounts as a third,
 * full-width detail block below the two here. ────────────────────── */

function AssetRowDetail({ asset, canEdit, onEdit }: {
  asset: AssetItem; canEdit: boolean; onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Identity</p>
        <dl className="kv">
          <dt>Serial</dt><dd className="mono">{asset.serial_number ?? '—'}</dd>
          <dt>Name</dt><dd>{asset.name ?? '—'}</dd>
          <dt>RFID tag</dt><dd className="mono">{asset.rfid_tag ?? '—'}</dd>
          <dt>Model</dt><dd>{asset.model ? `${asset.model.make} ${asset.model.model}` : '—'}</dd>
          <dt>RU</dt><dd>{asset.model?.ru_size ?? '—'}</dd>
          <dt>Rails present</dt>
          <dd>{asset.has_rails === null ? 'Unknown' : asset.has_rails ? 'Yes' : 'No'}</dd>
        </dl>
      </div>
      <div className="detail-block">
        <p className="eyebrow-sm">Location & ownership</p>
        <dl className="kv">
          <dt>Client</dt><dd>{asset.client_name ?? 'House'}</dd>
          <dt>Site</dt><dd>{asset.site_name ?? '—'}</dd>
          <dt>Location</dt><dd>{asset.location_detail || '—'}</dd>
          <dt>Last seen</dt>
          <dd>{asset.last_seen_at ? new Date(asset.last_seen_at).toLocaleString() : '—'}</dd>
        </dl>
      </div>
      <NotesFilesPanel entityType="asset" entityId={asset.id} canWrite={canEdit} />
      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}
