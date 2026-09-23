/**
 * Containers — logistics transport containers: identity, type/status
 * chips, site + location, and asset contents. Directory pattern cloned
 * from Assets.tsx (incl. its deep-link/filter interplay); all mutation
 * lands in ContainerEditModal.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import BulkContainersModal from '../components/containers/BulkContainersModal';
import ContainerBulkImport from '../components/containers/ContainerBulkImport';
import ContainerEditModal from '../components/containers/ContainerEditModal';
import GodDeleteButton from '../components/GodDeleteButton';
import NotesFilesPanel from '../components/NotesFilesPanel';
import { useToast } from '../lib/notificationsContext';
import {
  ApiError,
  listContainerAssets,
  listContainers,
  listContainerStatuses,
  listContainerTypes,
  listInitiatives,
  listSites,
  updateContainer,
  type ContainerAssetRow,
  type ContainerItem,
  type InitiativeItem,
  type SiteItem,
  type StatusValue,
} from '../lib/api';
import {
  CONTAINER_ERRORS, CONTAINER_GOD_FIELDS, containerCellText, containerGroupKey,
  containerGroupKeys, containerSearchText, groupContainers, labelTagText,
  type ContainerListRow,
} from '../lib/containers';
import { LABEL_TAG_OPTIONS } from '../lib/labelTags';
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
import '../styles/containers.css';
import { displayRfid } from '../lib/format';

/** Shared by the list cell and the row detail block so both render the
 *  Label tag the same way: a colored `chip custom`, or a plain '—' when
 *  the container has none. */
function LabelTagChip({ tag }: { tag: ContainerItem['label_tag'] }) {
  const opt = LABEL_TAG_OPTIONS.find((o) => o.key === tag);
  return opt
    ? (
      <span className="chip custom" style={{ '--chip': opt.color } as CSSProperties}>
        <span className="dot" />{opt.label}
      </span>
    )
    : <span className="cell-top cell-line">—</span>;
}

// The always-shown name+type cell — a fixed leading track outside the
// column registry (same shape as the header markup below), so it needs
// its own ColumnDef for listGridStyle/ColHead.
const PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Name', width: '2fr', default: true, min: 180,
};

// Fit: default columns + trailing ≤ 1176px (.portal-page at a 1512px
// window, nav expanded).
const COLUMNS: ColumnDef[] = [
  { key: 'type', label: 'Type', width: '1fr', default: true },
  { key: 'rfid', label: 'RFID', width: '1fr', default: true },
  { key: 'assets', label: 'Assets', width: '0.6fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'site', label: 'Site', width: '1.2fr', default: true },
  { key: 'initiative', label: 'Initiative', width: '1.2fr', default: false },
  { key: 'label_tag', label: 'Label tag', width: '1.1fr', default: true },
  { key: 'location', label: 'Location', width: '1.4fr', default: false },
  { key: 'updated', label: 'Created', width: '1fr', default: false, min: 96 },
];

const ALL_COLUMN_KEYS = new Set<string>(
  [...COLUMNS.map((c) => c.key), 'primary', 'archived']);
const DEFAULT_VISIBLE = new Set<string>(
  COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(c: ContainerItem, key: string): string {
  switch (key) {
    case 'primary': return c.name.toLowerCase();
    case 'type': return (c.type_label ?? '').toLowerCase();
    case 'rfid': return (c.rfid_tag ?? '').toLowerCase();
    case 'assets': return String(c.asset_count).padStart(6, '0');
    case 'status': return c.status_label.toLowerCase();
    case 'site': return (c.site_name ?? '').toLowerCase();
    case 'initiative': return (c.initiative_name ?? '').toLowerCase();
    case 'label_tag': return labelTagText(c).toLowerCase();
    case 'location': return c.location_detail.toLowerCase();
    case 'updated': return c.created_at;
    case 'archived': return c.archived_at ? '1' : '0';
    default: return '';
  }
}

/* View toggle (By name / By initiative). `usePersistentListState` piggybacks
 * on the account-wide preferences PATCH and only knows column-menu shape
 * (visible/sort/filters/order) — it has no room for an extra page-level
 * flag — so the view mode is persisted separately, under a sibling key,
 * via the same plain try/catch localStorage idiom InitiativeTimeline.tsx
 * and Warehouse.tsx already use for their own per-page toolbar state. */
type ViewMode = 'flat' | 'grouped';
const VIEW_STORAGE_KEY = 'containers.view';

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'grouped' ? 'grouped' : 'flat';
  } catch {
    return 'flat';
  }
}
function saveViewMode(v: ViewMode) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch { /* ignore */ }
}

const CSV_COLUMNS: [string, (c: ContainerItem) => string][] = [
  ['ID', (c) => c.id],
  ['Name', (c) => c.name],
  ['Type', (c) => c.type_label ?? ''],
  ['RFID', (c) => c.rfid_tag ?? ''],
  ['Assets', (c) => String(c.asset_count)],
  ['Status', (c) => c.status_label],
  ['Site', (c) => c.site_name ?? ''],
  ['Initiative', (c) => c.initiative_name ?? ''],
  ['Label tag', (c) => labelTagText(c)],
  ['Location', (c) => c.location_detail],
  ['Created', (c) => c.created_at],
];

/** No tooltip for a blank cell — "—" repeated as a title on hover reads
 *  as noise, not information. */
const titleFor = (text: string) => (text === '—' ? undefined : text);

export default function Containers() {
  const { can, godMode, preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const canAdd = can('containers', 'add');
  const canChange = can('containers', 'change');
  const canViewSites = can('sites', 'view');
  const god = useGodEdit();
  const pd = usePendingDeletes(godMode);
  const toast = useToast();               // shared ToastHost (AppShell)

  const [containers, setContainers] = useState<ContainerItem[] | null>(null);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [types, setTypes] = useState<StatusValue[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [initiatives, setInitiatives] = useState<InitiativeItem[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const deepLinkTarget = useRef<string | null>(initialOpenId());
  const focusOpenId = (id: string | null) => {
    deepLinkTarget.current = id;
    clearedDeepLink.current = null;
    setOpenId(id);
  };
  useRecordFocus(containers, (c) => c.id, (c) => c.name, focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'containers', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 },
    ALL_COLUMN_KEYS,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);

  const [viewMode, setViewModeState] = useState<ViewMode>(loadViewMode);
  const setViewMode = (v: ViewMode) => {
    setViewModeState(v);
    saveViewMode(v);
  };
  // Which groups are expanded, keyed by initiative_id (or the
  // "no initiative" sentinel). Collapsed (absent) by default; not
  // persisted — only the view-mode choice itself is.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => {
    // Collapsing the group that holds the currently open row must close
    // that row too — otherwise `openId` outlives the row it named, and
    // the deep-link auto-expand effect below would spring the group back
    // open the next time `containers` refreshes (a god-edit save, a
    // modal's onSaved/onDone reload) even though the user chose to
    // collapse it.
    if (expandedGroups.has(key) && openId && containers) {
      const openRow = containers.find((c) => c.id === openId);
      if (openRow && containerGroupKey(openRow) === key) setOpenId(null);
    }
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const load = async () => {
    try {
      setContainers(await listContainers());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view containers.'
        : 'Failed to load containers.');
    }
  };

  useEffect(() => {
    void load();
    void listContainerStatuses().then(setStatuses).catch(() => {});
    void listContainerTypes().then(setTypes).catch(() => {});
    if (canViewSites) void listSites().then(setSites).catch(() => {});
    void listInitiatives().then(setInitiatives).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const godFields = useMemo(() => CONTAINER_GOD_FIELDS({
    sites: () => (canViewSites ? sites.map((s) => ({ value: s.id, label: s.name })) : []),
    statuses: () => statuses.map((s) => ({ value: s.key, label: s.label })),
    types: () => types.map((t) => ({ value: t.key, label: t.label })),
  }), [sites, statuses, types, canViewSites]);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const replaceRow = (u: ContainerItem) =>
    setContainers((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const haystack = useSearchHaystacks(containers, containerSearchText);

  const visible = useMemo(() => {
    if (!containers) return [];
    const q = query.trim().toLowerCase();
    const showArchived = filters.archived?.values?.includes('Yes') ?? false;
    const rows = containers.filter((c) => {
      if (!showArchived && c.archived_at) return false;
      if (!passesColumnFilters(c, filters, containerCellText)) return false;
      if (!q) return true;
      return haystack(c).includes(q);
    });
    return rows.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [containers, filters, query, sortKey, sortDir, haystack]);

  // Deep-link vs persisted-filter interplay — cloned from Assets.tsx.
  useEffect(() => {
    if (!containers || !openId || visible.some((c) => c.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = containers.find((c) => c.id === openId);
      if (target && !passesColumnFilters(target, filters, containerCellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [containers, visible, openId, filters, clearFilters]);

  useEffect(() => {
    if (deepLinkTarget.current && visible.some((c) => c.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  // Every group key the current (filtered + sorted) rows would produce,
  // independent of which are expanded — Expand all's target set, and
  // used below to auto-expand a deep-linked container's group.
  const groupKeys = useMemo(() => containerGroupKeys(visible), [visible]);
  const expandAllGroups = () => setExpandedGroups(new Set(groupKeys));
  const collapseAllGroups = () => setExpandedGroups(new Set());

  // A deep link (?open=<id> or the global-search "openRow" state) that
  // lands on a container while the nested view is active must expand
  // that container's group, or the row it targets stays hidden.
  useEffect(() => {
    if (viewMode !== 'grouped' || !openId || !containers) return;
    const target = containers.find((c) => c.id === openId);
    if (!target) return;
    const key = containerGroupKey(target);
    setExpandedGroups((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, [viewMode, openId, containers]);

  const listRows: ContainerListRow[] = useMemo(() => (
    viewMode === 'grouped'
      ? groupContainers(visible, expandedGroups)
      : visible.map((item): ContainerListRow => ({ kind: 'container', item }))
  ), [viewMode, visible, expandedGroups]);

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle([PRIMARY_COL, ...shownCols], ['30px'], undefined, listGridScale);
  const rowStyle = {
    gridTemplateColumns: grid.gridTemplateColumns,
    minWidth: god.editing ? undefined : grid.minWidth,
  };

  const cellFor = (c: ContainerItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={c} gf={gf} patch={updateContainer} onRowSaved={replaceRow}
                   errorMap={CONTAINER_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'type':
        return c.type_color
          ? (
            <span className="chip custom" style={{ '--chip': c.type_color } as CSSProperties}>
              <span className="dot" />{c.type_label}
            </span>
          )
          : <span className="cell-top cell-line">—</span>;
      case 'rfid':
        return <span className="mono cell-line" title={c.rfid_tag ?? undefined}>{displayRfid(c.rfid_tag)}</span>;
      case 'assets':
        return <span className="mono cell-line" title={titleFor(String(c.asset_count))}>{c.asset_count}</span>;
      case 'status':
        return (
          <div className="chips">
            <StatusHover entityType="container" entityId={c.id} status={c.status}>
              <span className="chip custom" style={{ '--chip': c.status_color } as CSSProperties}>
                <span className="dot" />{c.status_label}
              </span>
            </StatusHover>
            {c.archived_at && <span className="chip tag">Archived</span>}
            {pd.pendingIds.has(c.id) && <span className="chip tag">Pending delete</span>}
          </div>
        );
      case 'site': {
        const text = c.site_name ?? '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'initiative': {
        const text = c.initiative_name ?? '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'label_tag':
        return <LabelTagChip tag={c.label_tag} />;
      case 'location': {
        const text = c.location_detail || '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'updated': {
        const text = new Date(c.created_at).toLocaleDateString();
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Logistics</div>
          <h1 className="page-title">
            Containers
            <span className="badge-count">{containers?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Transport containers — type, status, site, and asset contents.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={viewMode === 'flat'}
                  className={viewMode === 'flat' ? 'on' : ''}
                  onClick={() => setViewMode('flat')}>
            By name
          </button>
          <button role="tab" aria-selected={viewMode === 'grouped'}
                  className={viewMode === 'grouped' ? 'on' : ''}
                  onClick={() => setViewMode('grouped')}>
            By initiative
          </button>
        </div>
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {containers?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          {viewMode === 'grouped' && (
            <>
              <button className="mini-btn" onClick={expandAllGroups}>Expand all</button>
              <button className="mini-btn" onClick={collapseAllGroups}>Collapse all</button>
            </>
          )}
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols} godMode={godMode} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('containers', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canChange} />
          {canAdd && (
            <button className="mini-btn" onClick={() => setImporting(true)}>
              Import
            </button>
          )}
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New container
            </button>
          )}
          {canAdd && (
            <button className="btn-solid" onClick={() => setBulkCreating(true)}>
              + Add in bulk
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load containers</b>{error}</div>}

      {!error && (
        <div className={`dir-list list-scroll${god.editing ? ' editing' : ''}`}>
          <div className="list-head" style={rowStyle}>
            <ColHead col={PRIMARY_COL} sortDir={sortKey === 'primary' ? sortDir : null}
                     onToggleSort={() => toggleSort('primary')}>
              <ColumnMenu colKey="primary" label="Name"
                          allRows={containers ?? []} filters={filters}
                          text={containerCellText}
                          filter={filters.primary} onFilter={setFilter}
                          sortDir={sortKey === 'primary' ? sortDir : null}
                          onSort={(dir) => setSort('primary', dir)} />
            </ColHead>
            {shownCols.map((c) => (
              <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                       onToggleSort={() => toggleSort(c.key)}
                       className={headerDrag.dropClass(c.key)}
                       dragProps={headerDrag.dragProps(c.key)}>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={containers ?? []} filters={filters}
                            text={containerCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </ColHead>
            ))}
            <ColumnMenu colKey="archived" label="Archived"
                        allRows={containers ?? []} filters={filters}
                        text={containerCellText}
                        filter={filters.archived} onFilter={setFilter}
                        sortDir={sortKey === 'archived' ? sortDir : null}
                        onSort={(dir) => setSort('archived', dir)} />
          </div>

          {containers && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add a container.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows<ContainerListRow> rows={listRows}
            renderRow={(row, vp) => {
            if (row.kind === 'group') {
              return (
                <div key={`g:${row.key}`} className={`dir-row dir-grouprow ${row.expanded ? 'open' : ''}`}
                     {...vp} style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                  <div role="button" tabIndex={0} className="row-main dir-grouprow-main" style={rowStyle}
                       aria-expanded={row.expanded} onClick={() => toggleGroup(row.key)}
                       onKeyDown={(e) => {
                         if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(row.key); }
                       }}>
                    <div className="dir-grouprow-content">
                      <span className="chevron-cell">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                             strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                      </span>
                      <div className="cell cell-primary">
                        <div className="pn"><b>{row.label}</b></div>
                      </div>
                      <span className="chip tag">
                        {`${row.count} container${row.count === 1 ? '' : 's'}`}
                      </span>
                      {row.archivedCount > 0 && (
                        <span className="dir-grouprow-archived">({row.archivedCount} archived)</span>
                      )}
                      <span className="dir-grouprow-hint">{row.expanded ? 'Hide' : 'Show'}</span>
                    </div>
                  </div>
                </div>
              );
            }

            const c = row.item;
            const open = openId === c.id;
            return (
              <div key={c.id} className={`dir-row ${open ? 'open' : ''} ${c.archived_at ? 'archived' : ''}`}
                   {...vp} style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                <div className="row-main" style={rowStyle}
                     onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : c.id); }}>
                  <div className="cell cell-primary">
                    {god.editing && godFieldFor('primary') ? (
                      <div className="pn god-primary-edit">
                        <GodCell row={c} gf={godFieldFor('primary')!} patch={updateContainer}
                                 onRowSaved={replaceRow} errorMap={CONTAINER_ERRORS} disabled={!canChange} />
                      </div>
                    ) : (
                      <div className="pn"><b>{c.name}</b>
                        <span>{c.type_label ?? '—'}</span></div>
                    )}
                  </div>
                  {shownCols.map((col) => (
                    <div className="cell" key={col.key}>{cellFor(c, col.key)}</div>
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
                        <ContainerRowDetail
                          container={c}
                          canEdit={canChange}
                          onEdit={() => setEditingId(c.id)}
                          godVisible={godMode}
                          pending={pd.pendingIds.has(c.id)}
                          onMark={() => pd.mark('container', c.id, c.name)}
                          onUnmark={() => pd.unmark(c.id)}
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
        <ContainerEditModal
          container={containers?.find((c) => c.id === editingId) ?? null}
          statuses={statuses}
          types={types}
          sites={sites}
          initiatives={initiatives}
          canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => load()}
        />
      )}
      {creating && (
        <ContainerEditModal
          container={null}
          statuses={statuses}
          types={types}
          sites={sites}
          initiatives={initiatives}
          canChange={canChange}
          onClose={() => setCreating(false)}
          onSaved={() => load()}
        />
      )}
      {importing && (
        <ContainerBulkImport
          onClose={() => setImporting(false)}
          onDone={() => load()}
        />
      )}
      {bulkCreating && (
        <BulkContainersModal
          types={types}
          sites={sites}
          initiatives={initiatives}
          onClose={() => setBulkCreating(false)}
          onCreated={async (created) => {
            await load();
            toast(`Created ${created.length} container${created.length === 1 ? '' : 's'}`);
          }}
        />
      )}
    </div>
  );
}

/* ── row detail: read-only — the ONLY interactive element is Edit. ── */

function ContainerRowDetail({
  container, canEdit, onEdit, godVisible, pending, onMark, onUnmark,
}: {
  container: ContainerItem; canEdit: boolean; onEdit: () => void;
  godVisible: boolean; pending: boolean;
  onMark: () => Promise<void>; onUnmark: () => Promise<void>;
}) {
  const [contents, setContents] = useState<ContainerAssetRow[] | null>(null);
  useEffect(() => {
    void listContainerAssets(container.id).then(setContents).catch(() => {});
  }, [container.id]);

  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Identity</p>
        <dl className="kv">
          <dt>Name</dt><dd>{container.name}</dd>
          <dt>Type</dt><dd>{container.type_label ?? '—'}</dd>
          <dt>Label tag</dt><dd><LabelTagChip tag={container.label_tag} /></dd>
          <dt>RFID tag</dt><dd className="mono" title={container.rfid_tag ?? undefined}>{displayRfid(container.rfid_tag)}</dd>
          <dt>Last audit</dt>
          <dd>{container.last_audit_at
            ? new Date(container.last_audit_at).toLocaleString() : '—'}</dd>
          <dt>Last validated</dt>
          <dd>{container.last_validated_at
            ? new Date(container.last_validated_at).toLocaleString() : '—'}</dd>
        </dl>
      </div>
      <div className="detail-block">
        <p className="eyebrow-sm">Location</p>
        <dl className="kv">
          <dt>Site</dt><dd>{container.site_name ?? '—'}</dd>
          <dt>Initiative</dt><dd>{container.initiative_name ?? '—'}</dd>
          <dt>Location</dt><dd>{container.location_detail || '—'}</dd>
          <dt>Assets</dt><dd>{container.asset_count}</dd>
        </dl>
      </div>
      <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
        <p className="eyebrow-sm">Contents</p>
        {contents === null && <p className="page-hint">Loading…</p>}
        {contents?.length === 0 && <p className="page-hint">No assets in this container.</p>}
        {contents && contents.length > 0 && (
          <dl className="kv">
            {contents.map((r) => (
              <span key={r.asset_id} style={{ display: 'contents' }}>
                <dt className="mono">{r.serial_number ?? '—'}</dt>
                <dd>{r.name ?? r.model_name ?? '—'} · {r.status_label}</dd>
              </span>
            ))}
          </dl>
        )}
      </div>
      <NotesFilesPanel entityType="container" entityId={container.id} canWrite={canEdit} />
      {(canEdit || godVisible) && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          {canEdit && (
            <button className="btn-solid" onClick={onEdit}>Edit</button>
          )}
          <GodDeleteButton visible={godVisible} entityType="container" entityId={container.id}
                           label={container.name} pending={pending}
                           onChange={pending ? onUnmark : onMark} />
        </div>
      )}
    </div>
  );
}
