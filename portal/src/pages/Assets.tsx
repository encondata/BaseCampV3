/**
 * Assets — the physical inventory registry: servers, network gear, and
 * anything else tracked by serial number. Directory pattern with
 * make/model + category/status chips, and a read-only detail panel
 * (identity, location & ownership). All mutation (create/edit/archive)
 * lands in AssetEditModal.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AssetEditModal from '../components/assets/AssetEditModal';
import GodDeleteButton from '../components/GodDeleteButton';
import { RowActionsMenu, type RowAction } from '../components/hardware/RowActionsMenu';
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
  identityFirst, migrateIdentityColumns,
} from '../lib/assets';
import { initialOpenId } from '../lib/auditFormat';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import { usePendingDeletes } from '../lib/pendingDeletes';
import { naturalCompare } from '../lib/sites';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import {
  applyColumnOrder,
  ColHead,
  ColumnsButton,
  ExportButton,
  exportCsv,
  listGridStyle,
  listScale,
  moveKey,
  titleFor,
  useReorderDrag,
  useSearchHaystacks,
  visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import StatusHover from '../components/StatusHover';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/assets.css';
import { displayRfid } from '../lib/format';

// Fit: default columns + trailing ≤ LIST_FIT.page
// (1172px — .portal-page at a 1512px window, nav expanded).
const COLUMNS: ColumnDef[] = [
  // The identity trio: the combined serial+name cell stays the default,
  // with its two halves offered as separate columns for anyone who wants
  // them side by side (or only one of them).
  {
    key: 'primary', label: 'Serial / Name', short: 'Serial/Name',
    width: '2.2fr', default: true, min: 180,
  },
  { key: 'serial', label: 'Serial', width: '1.2fr', default: false, min: 100 },
  { key: 'name', label: 'Name', width: '1.4fr', default: false, min: 140 },
  { key: 'asset_id', label: 'Asset ID', width: '0.7fr', default: true, min: 100 },
  { key: 'model', label: 'Make / Model', short: 'Model', width: '1.5fr', default: true },
  { key: 'category', label: 'Category', width: '1fr', default: true },
  { key: 'client', label: 'Client', width: '1.2fr', default: true },
  { key: 'site', label: 'Site', width: '1.2fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'ru', label: 'RU', width: '0.5fr', default: false },
  { key: 'location', label: 'Location', width: '1.4fr', default: false },
  { key: 'pod', label: 'Pod #', width: '0.7fr', default: false },
  { key: 'rfid', label: 'RFID', width: '1fr', default: false },
  { key: 'last_seen', label: 'Last seen', width: '1fr', default: false, min: 96 },
  { key: 'has_rails', label: 'Rails', width: '0.8fr', default: false, godOnly: true },
];

// Every column the page can offer (incl. godOnly) plus the one pseudo-
// column that isn't a real COLUMNS entry — 'archived', the chevron-header
// filter-only column — so a persisted filter/sort/visibility referencing
// it survives usePersistentListState's rehydrate-time sanitization.
// ('primary' needs no special case any more: it's a real column now, and
// keeping that key is what lets an old saved sort/filter survive.)
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'archived']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Sort value per column key — deliberately separate from `assetCellText`:
 *  that accessor's job is display/filter text (dashes for blanks, formatted
 *  dates), which would sort wrong (e.g. localized last-seen dates sort
 *  lexicographically by month, not chronologically). This stays lowercase/
 *  raw so naturalCompare orders rows the way a user expects. */
function sortValueFor(a: AssetItem, key: string): string {
  switch (key) {
    case 'primary': return (a.serial_number ?? '').toLowerCase();
    case 'serial': return (a.serial_number ?? '').toLowerCase();
    case 'name': return (a.name ?? '').toLowerCase();
    case 'asset_id': return a.legacy_id != null ? String(a.legacy_id).padStart(12, '0') : '';
    case 'model': return a.model ? `${a.model.make} ${a.model.model}`.toLowerCase() : '';
    case 'category': return (a.model?.category_label ?? '').toLowerCase();
    case 'client': return (a.client_name ?? '').toLowerCase();
    case 'site': return (a.site_name ?? '').toLowerCase();
    case 'status': return a.status_label.toLowerCase();
    case 'ru': return String(a.model?.ru_size ?? 0);
    case 'location': return a.location_detail.toLowerCase();
    case 'rfid': return (a.rfid_tag ?? '').toLowerCase();
    case 'pod': return (a.pod_number ?? '').toLowerCase();
    case 'last_seen': return a.last_seen_at ?? '';
    case 'has_rails': return a.has_rails === null ? '' : a.has_rails ? 'yes' : 'no';
    case 'archived': return a.archived_at ? '1' : '0';
    default: return '';
  }
}

const CSV_COLUMNS: [string, (a: AssetItem) => string][] = [
  ['Asset ID', (a) => (a.legacy_id != null ? String(a.legacy_id) : '')],
  ['ID', (a) => a.id],
  ['Serial', (a) => a.serial_number ?? ''],
  ['Name', (a) => a.name ?? ''],
  ['Make', (a) => a.model?.make ?? ''],
  ['Model', (a) => a.model?.model ?? ''],
  ['Category', (a) => a.model?.category_label ?? ''],
  ['Client', (a) => a.client_name ?? ''],
  ['Site', (a) => a.site_name ?? ''],
  ['Location', (a) => a.location_detail],
  ['Pod #', (a) => a.pod_number ?? ''],
  ['Status', (a) => a.status_label],
  ['RFID', (a) => a.rfid_tag ?? ''],
  ['Has rails', (a) => (a.has_rails === null ? '' : String(a.has_rails))],
  ['Last seen', (a) => a.last_seen_at ?? ''],
  ['Created', (a) => a.created_at],
];

export default function Assets() {
  const navigate = useNavigate();
  const { can, godMode, preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const canAdd = can('assets', 'add');
  const canChange = can('assets', 'change');
  const canViewSites = can('sites', 'view');
  const canViewCategories = can('asset_models', 'view');
  const god = useGodEdit();
  const pd = usePendingDeletes(godMode);

  const [assets, setAssets] = useState<AssetItem[] | null>(null);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [models, setModels] = useState<AssetModelItem[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  // The id of the most recent deep-link arrival (?open= param at mount, or
  // a later location.state.openRow from the topbar search) — as opposed to
  // a plain row click, which calls `setOpenId` directly and never touches
  // this ref. Template for Tasks 3-5: any page adopting useRecordFocus
  // alongside column-menu filters needs this same wrapper + the effect
  // below, or a filter saved from a previous visit can permanently hide a
  // record someone just followed a link to.
  const deepLinkTarget = useRef<string | null>(initialOpenId());
  const focusOpenId = (id: string | null) => {
    deepLinkTarget.current = id;
    clearedDeepLink.current = null; // re-arm: a fresh arrival gets its own one-shot clear
    setOpenId(id);
  };
  useRecordFocus(assets, (a) => a.id, (a) => a.serial_number ?? a.name ?? '', focusOpenId, setQuery);
  // Guards the auto-clear below so it fires at most once per deep-link
  // arrival, not on every subsequent filter edit.
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'assets',
    {
      visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1,
      migrate: migrateIdentityColumns,
    },
    ALL_COLUMN_KEYS,
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

  const haystack = useSearchHaystacks(assets, assetSearchText);

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
      return haystack(a).includes(q);
    });
    return rows.sort((a, b) => naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [assets, filters, query, sortKey, sortDir, haystack]);

  // Auto-close the open row when it drops out of `visible` — EXCEPT the one
  // case where it just arrived via a deep link and the reason it's missing
  // is a persisted column filter: then clear the filters instead, so the
  // record the link pointed at actually surfaces (the FilterSummaryChip
  // disappearing makes that state change obvious). `visible` here still
  // reflects the pre-clear filters within this same render; the `return`
  // after clearFilters() lets the next render (post-clear) settle whether
  // the row is visible now, rather than racing this effect against that
  // state update. Template for Tasks 3-5.
  useEffect(() => {
    if (!assets || !openId || visible.some((a) => a.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId; // once per deep-link arrival
      const target = assets.find((a) => a.id === openId);
      if (target && !passesColumnFilters(target, filters, assetCellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [assets, visible, openId, filters, clearFilters]);

  // Release the deep-link guard the moment the target row is first confirmed
  // visible — otherwise `deepLinkTarget.current` sits there indefinitely,
  // and a much later, unrelated filter edit that happens to hide that same
  // row again (after the user reopened it with a plain click) would still
  // read as "the deep link just arrived" and fire the once-per-id
  // clearFilters() above. Clearing here (rather than inside the effect
  // above) leaves the arrival behavior — including its "row missing on
  // first render because of a persisted filter" clearFilters() path —
  // untouched.
  useEffect(() => {
    if (deepLinkTarget.current && visible.some((a) => a.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  // Saved layouts predate the identity columns: usePersistentListState's
  // `seen` surfacing turns the (default-visible) combined column on for
  // them, and identityFirst puts identity keys an old order never
  // mentioned at the front, where the combined cell always sat — not
  // appended last, which is applyColumnOrder's rule for unknown keys.
  const orderedCols = identityFirst(applyColumnOrder(COLUMNS, colOrder), colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle(shownCols, ['100px', '30px'], undefined, listGridScale);
  const rowStyle = {
    gridTemplateColumns: grid.gridTemplateColumns,
    minWidth: god.editing ? undefined : grid.minWidth,
  };

  /** The amber chip the serial-bearing cells carry when a serial is shared
   *  by two or more assets. Rendered by whichever identity column is on. */
  const dupeChip = (isDupe: boolean) =>
    (isDupe ? <span className="chip c-amber">Duplicate SN</span> : null);

  // Actions available for the row's own trailing RowActionsMenu. Full
  // details is always offered; Edit joins it only for editors — the
  // god-mode delete stays its own control in the expansion.
  const rowActions = (a: AssetItem): RowAction[] => [
    { key: 'details', label: 'Full details', onSelect: () => navigate(`/assets/${a.id}`) },
    ...(canChange
      ? [{ key: 'edit', label: 'Edit', onSelect: () => setEditingId(a.id) }]
      : []),
  ];

  const cellFor = (a: AssetItem, key: string, isDupe = false) => {
    // The identity trio comes first, ahead of the generic god-edit branch
    // below: 'primary' has a god field of its own (serial) that the generic
    // branch would render alone, losing the name half, and 'serial'/'name'
    // have no god field under those column keys at all — they borrow
    // 'primary'/'primary2'.
    // In god mode all three visible at once means three editors bound to the
    // same two fields; they only reconcile when the row saves and re-renders.
    switch (key) {
      case 'primary':
        return (
          <>
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
            {dupeChip(isDupe)}
          </>
        );
      case 'serial': {
        if (god.editing && godFieldFor('primary')) {
          return (
            <GodCell row={a} gf={godFieldFor('primary')!} patch={updateAsset}
                     onRowSaved={replaceRow} errorMap={ASSET_ERRORS} disabled={!canChange} />
          );
        }
        const text = a.serial_number ?? '—';
        return <><span className="mono cell-line" title={titleFor(text)}>{text}</span>{dupeChip(isDupe)}</>;
      }
      case 'name': {
        if (god.editing && godFieldFor('primary2')) {
          return (
            <GodCell row={a} gf={godFieldFor('primary2')!} patch={updateAsset}
                     onRowSaved={replaceRow} errorMap={ASSET_ERRORS} disabled={!canChange} />
          );
        }
        const text = a.name ?? '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      default:
        break;
    }
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
      case 'asset_id': {
        const text = a.legacy_id != null ? String(a.legacy_id) : '—';
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'model': {
        const text = a.model ? `${a.model.make} ${a.model.model}` : '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'category':
        return a.model?.category_color
          ? (
            <span className="chip custom" style={{ '--chip': a.model.category_color } as CSSProperties}>
              <span className="dot" />{a.model.category_label}
            </span>
          )
          : <span className="chip tag">{a.model?.category_label ?? '—'}</span>;
      case 'client': {
        const text = a.client_name ?? 'House';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'site': {
        const text = a.site_name ?? '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'status':
        return (
          <div className="chips">
            <StatusHover entityType="asset" entityId={a.id} status={a.status}>
              <span className="chip custom" style={{ '--chip': a.status_color } as CSSProperties}>
                <span className="dot" />{a.status_label}
              </span>
            </StatusHover>
            {a.archived_at && <span className="chip tag">Archived</span>}
            {pd.pendingIds.has(a.id) && <span className="chip tag">Pending delete</span>}
          </div>
        );
      case 'ru': {
        const text = a.model?.ru_size != null ? String(a.model.ru_size) : '—';
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'location': {
        const text = a.location_detail || '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'rfid':
        return <span className="mono cell-line" title={a.rfid_tag ?? undefined}>{displayRfid(a.rfid_tag)}</span>;
      case 'pod': {
        const text = a.pod_number ?? '—';
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'last_seen': {
        const text = a.last_seen_at ? new Date(a.last_seen_at).toLocaleDateString() : '—';
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'has_rails': {
        const text = a.has_rails === null ? 'Unknown' : a.has_rails ? 'Yes' : 'No';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
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
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         godMode={godMode} onReorder={setColOrder} />
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
        <div className={`dir-list list-scroll${god.editing ? ' editing' : ''}`}>
          <div className="list-head" style={rowStyle}>
            {shownCols.map((c) => (
              <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                       onToggleSort={() => toggleSort(c.key)}
                       className={headerDrag.dropClass(c.key)}
                       dragProps={headerDrag.dragProps(c.key)}>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={assets ?? []} filters={filters}
                            text={assetCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </ColHead>
            ))}
            <span className="col-head" aria-hidden="true" />
            <ColumnMenu colKey="archived" label="Archived"
                        allRows={assets ?? []} filters={filters}
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

          <VirtualRows rows={visible}
            renderRow={(a, vp) => {
            const open = openId === a.id;
            const isDupe = !!a.serial_number && dupes.has(a.serial_number.toLowerCase());
            return (
              <div key={a.id} className={`dir-row ${open ? 'open' : ''} ${a.archived_at ? 'archived' : ''}`}
                   {...vp} style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                <div className="row-main" style={rowStyle}
                     onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : a.id); }}>
                  {shownCols.map((c) => (
                    // `.cell-primary` (two-line layout, and the mobile
                    // grid-column: 1 / -1 rule) belongs to the combined cell
                    // alone — the split halves are ordinary cells.
                    <div className={`cell${c.key === 'primary' ? ' cell-primary' : ''}`} key={c.key}>
                      {cellFor(a, c.key, isDupe)}
                    </div>
                  ))}
                  <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}
                       onClick={(e) => e.stopPropagation()}>
                    <RowActionsMenu actions={rowActions(a)} />
                  </div>
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
                          godVisible={godMode}
                          pending={pd.pendingIds.has(a.id)}
                          onMark={() => pd.mark('asset', a.id, a.name ?? a.serial_number ?? 'Asset')}
                          onUnmark={() => pd.unmark(a.id)}
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

/* ── row detail: read-only display — Full details and Edit live in the
 * row's own RowActionsMenu now, so the only interactive elements left
 * here are the Notes & Files panel and, in god mode, the delete
 * control. The Notes & Files panel mounts as a third, full-width detail
 * block below the two here. ────────────────────────────────────────── */

function AssetRowDetail({
  asset, canEdit, godVisible, pending, onMark, onUnmark,
}: {
  asset: AssetItem; canEdit: boolean;
  godVisible: boolean; pending: boolean;
  onMark: () => Promise<void>; onUnmark: () => Promise<void>;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Identity</p>
        <dl className="kv">
          <dt>Serial</dt><dd className="mono">{asset.serial_number ?? '—'}</dd>
          <dt>Name</dt><dd>{asset.name ?? '—'}</dd>
          <dt>RFID tag</dt><dd className="mono" title={asset.rfid_tag ?? undefined}>{displayRfid(asset.rfid_tag)}</dd>
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
      {godVisible && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <GodDeleteButton visible={godVisible} entityType="asset" entityId={asset.id}
                           label={asset.name ?? asset.serial_number ?? 'Asset'} pending={pending}
                           onChange={pending ? onUnmark : onMark} />
        </div>
      )}
    </div>
  );
}
