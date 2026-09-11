/**
 * Sites — facilities we and our clients operate in. Directory pattern with
 * type/status chips, linked-client chips, and a read-only detail panel
 * (address, coordinates, partner, clients, notes, survey summary). All
 * mutation (create/edit/archive/clients/survey) lands in the Edit and
 * New-site modals — Task 3, not this file. The Edit/New-site buttons here
 * are wired to placeholder state so Task 3 only has to add the modals.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import GodDeleteButton from '../components/GodDeleteButton';
import SiteEditModal from '../components/sites/SiteEditModal';
import SitesMap, { SiteMapModal, SiteMiniMap } from '../components/sites/SitesMap';
import {
  ApiError,
  listClients,
  listPartners,
  listSiteStatuses,
  listSiteSurvey,
  listSiteTypes,
  listSites,
  updateSite,
  type OrgRef,
  type SiteItem,
  type SiteLookup,
  type SiteSurveyRow,
} from '../lib/api';
import { initialOpenId } from '../lib/auditFormat';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import { usePendingDeletes } from '../lib/pendingDeletes';
import { filledCount } from '../lib/siteSurvey';
import {
  formatCoords, naturalCompare, siteCellText, siteSearchText, SITE_ERRORS, SITE_GOD_FIELDS,
} from '../lib/sites';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import {
  applyColumnOrder,
  ColumnsButton,
  ExportButton,
  exportCsv,
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
import '../styles/sites.css';

const COLUMNS: ColumnDef[] = [
  { key: 'type', label: 'Type', width: '1.1fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'clients', label: 'Clients', width: '1.7fr', default: true },
  { key: 'city', label: 'City', width: '1.1fr', default: true },
  { key: 'country', label: 'Country', width: '0.8fr', default: false },
  { key: 'dc_provider', label: 'DC provider', width: '1.2fr', default: false },
  { key: 'coords', label: 'Coords', width: '1.4fr', default: false },
  { key: 'address_line1', label: 'Address line 1', width: '1.4fr', default: false, godOnly: true },
  { key: 'address_line2', label: 'Address line 2', width: '1.4fr', default: false, godOnly: true },
  { key: 'region', label: 'Region', width: '1fr', default: false, godOnly: true },
  { key: 'postal_code', label: 'Postal code', width: '1fr', default: false, godOnly: true },
  { key: 'timezone', label: 'Timezone', width: '1.2fr', default: false, godOnly: true },
  { key: 'notes', label: 'Notes', width: '1.6fr', default: false, godOnly: true },
  { key: 'latitude', label: 'Latitude', width: '0.9fr', default: false, godOnly: true },
  { key: 'longitude', label: 'Longitude', width: '0.9fr', default: false, godOnly: true },
];

// Every column the page can offer (incl. godOnly) plus the 'primary'
// pseudo-column (the always-shown name+code cell). No 'archived'
// pseudo-column here — Sites has never hidden or facet-filtered archived
// rows (they just carry an inline "Archived" chip), so column menus don't
// introduce that behavior either.
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'primary']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Sort value per column key — deliberately separate from `siteCellText`:
 *  that accessor's job is display/filter text (the '—' fallback, the
 *  formatted coords string), which would sort wrong (lat/lon sort
 *  lexicographically, not numerically, once formatted). This stays
 *  raw/lowercase so naturalCompare orders rows the way a user expects. */
function sortValueFor(s: SiteItem, key: string): string {
  switch (key) {
    case 'primary': return s.name.toLowerCase();
    case 'type': return (s.type_label ?? '').toLowerCase();
    case 'status': return s.status_label.toLowerCase();
    case 'clients': return s.clients.map((c) => c.name).join(',').toLowerCase();
    case 'city': return (s.city ?? '').toLowerCase();
    case 'country': return s.country.toLowerCase();
    case 'dc_provider': return (s.dc_provider ?? '').toLowerCase();
    case 'coords': return formatCoords(s.latitude, s.longitude);
    case 'address_line1': return (s.address_line1 ?? '').toLowerCase();
    case 'address_line2': return (s.address_line2 ?? '').toLowerCase();
    case 'region': return (s.region ?? '').toLowerCase();
    case 'postal_code': return (s.postal_code ?? '').toLowerCase();
    case 'timezone': return (s.timezone ?? '').toLowerCase();
    case 'notes': return (s.notes ?? '').toLowerCase();
    case 'latitude': return s.latitude === null ? '' : String(s.latitude);
    case 'longitude': return s.longitude === null ? '' : String(s.longitude);
    default: return '';
  }
}

const CSV_COLUMNS: [string, (s: SiteItem) => string][] = [
  ['ID', (s) => s.id],
  ['Name', (s) => s.name],
  ['Code', (s) => s.code ?? ''],
  ['Type', (s) => s.type_label ?? ''],
  ['Status', (s) => s.status_label],
  ['Address line 1', (s) => s.address_line1 ?? ''],
  ['Address line 2', (s) => s.address_line2 ?? ''],
  ['City', (s) => s.city ?? ''],
  ['Region', (s) => s.region ?? ''],
  ['Postal code', (s) => s.postal_code ?? ''],
  ['Country', (s) => s.country],
  ['Coordinates', (s) => formatCoords(s.latitude, s.longitude)],
  ['Timezone', (s) => s.timezone ?? ''],
  ['DC provider', (s) => s.dc_provider ?? ''],
  ['Partner', (s) => s.partner_name ?? ''],
  ['Clients', (s) => s.clients.map((c) => c.name).join('; ')],
  ['Notes', (s) => s.notes ?? ''],
  ['Archived', (s) => String(Boolean(s.archived_at))],
];

function surveySummary(rows: SiteSurveyRow[]): string {
  const { filled, total } = filledCount(rows);
  return `${filled}/${total} fields filled`;
}

export default function Sites({ initialView = 'list' }: { initialView?: 'list' | 'map' } = {}) {
  const { can, godMode, maxRank } = useAuth();
  const canAdd = can('sites', 'add');
  const canChange = can('sites', 'change');
  const canBulk = canAdd && maxRank >= 60;   // mirrors the API's GATE_BYPASS_RANK bar
  const god = useGodEdit();
  const pd = usePendingDeletes(godMode);

  const [sites, setSites] = useState<SiteItem[] | null>(null);
  const [types, setTypes] = useState<SiteLookup[]>([]);
  const [statuses, setStatuses] = useState<SiteLookup[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [partners, setPartners] = useState<OrgRef[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'list' | 'map'>(initialView);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  // /sites vs /sites/map: the nav's Map entry routes here with the map preselected
  useEffect(() => { setView(initialView); }, [initialView]);
  // Map-only display filters: which site types show as pins (null = all),
  // and whether decommissioned/archived sites appear (hidden by default).
  const [mapTypes, setMapTypes] = useState<Set<string> | null>(null);
  const [mapShowRetired, setMapShowRetired] = useState(false);
  // See Assets.tsx for the full rationale — the id of the most recent
  // deep-link arrival, as opposed to a plain row click (which never touches
  // this ref), so an unrelated later filter edit can't be mistaken for a
  // fresh arrival and re-trigger the once-per-id clearFilters() below.
  const deepLinkTarget = useRef<string | null>(initialOpenId());
  const focusOpenId = (id: string | null) => {
    deepLinkTarget.current = id;
    clearedDeepLink.current = null; // re-arm: a fresh arrival gets its own one-shot clear
    setOpenId(id);
  };
  useRecordFocus(sites, (s) => s.id, (s) => s.name, focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'sites', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  // Edit/New-site modals land in Task 3 — these hold the row/create-mode
  // intent so that task only has to add the modal, not rewire the buttons.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      setSites(await listSites());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view sites.' : 'Failed to load sites.');
    }
  };

  useEffect(() => {
    void load();
    void listSiteTypes().then(setTypes).catch(() => {});
    void listSiteStatuses().then(setStatuses).catch(() => {});
    void listClients().then(setClients).catch(() => {});
    void listPartners().then(setPartners).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const godFields = useMemo(() => SITE_GOD_FIELDS({
    types: () => types.map((t) => ({ value: t.key, label: t.label })),
    statuses: () => statuses.map((s) => ({ value: s.key, label: s.label })),
  }), [types, statuses]);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const replaceRow = (u: SiteItem) =>
    setSites((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const haystack = useSearchHaystacks(sites, siteSearchText);

  const visible = useMemo(() => {
    if (!sites) return [];
    const q = query.trim().toLowerCase();
    const rows = sites.filter((s) => {
      if (!passesColumnFilters(s, filters, siteCellText)) return false;
      if (!q) return true;
      return haystack(s).includes(q);
    });
    return rows.sort((a, b) => naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [sites, filters, query, sortKey, sortDir, haystack]);

  // Auto-close the open row when it drops out of `visible` — EXCEPT the one
  // case where it just arrived via a deep link and the reason it's missing
  // is a persisted column filter: then clear the filters instead. See
  // Assets.tsx for the full rationale.
  useEffect(() => {
    if (!sites || !openId || visible.some((s) => s.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = sites.find((s) => s.id === openId);
      if (target && !passesColumnFilters(target, filters, siteCellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [sites, visible, openId, filters, clearFilters]);

  // Release the deep-link guard once the target row is first confirmed
  // visible — see Assets.tsx for the full rationale.
  useEffect(() => {
    if (deepLinkTarget.current && visible.some((s) => s.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  // Type options for the map dropdown, from the data itself (label per
  // site_type key; null types bucket under ''). Sorted by label.
  const mapTypeOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const s of sites ?? []) {
      byKey.set(s.site_type ?? '', s.type_label ?? 'No type');
    }
    return [...byKey.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sites]);

  const isRetired = (s: SiteItem) =>
    s.archived_at !== null || s.status === 'decommissioned';

  const mapSites = useMemo(
    () => visible.filter((s) => {
      if (!mapShowRetired && isRetired(s)) return false;
      if (mapTypes && !mapTypes.has(s.site_type ?? '')) return false;
      return true;
    }),
    [visible, mapTypes, mapShowRetired],
  );

  const toggleMapType = (value: string) => {
    setMapTypes((cur) => {
      const next = new Set(cur ?? mapTypeOptions.map((o) => o.value));
      if (next.has(value)) next.delete(value); else next.add(value);
      // back to "all" once everything is re-checked, so new types
      // arriving later aren't accidentally filtered out
      return next.size === mapTypeOptions.length ? null : next;
    });
  };

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (s: SiteItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={s} gf={gf} patch={updateSite} onRowSaved={replaceRow}
                   errorMap={SITE_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'type':
        return s.type_color
          ? (
            <span className="chip custom" style={{ '--chip': s.type_color } as CSSProperties}>
              <span className="dot" />{s.type_label}
            </span>
          )
          : <span className="chip tag">{s.type_label ?? '—'}</span>;
      case 'status':
        return (
          <div className="chips">
            <StatusHover entityType="site" entityId={s.id} status={s.status}>
              <span className="chip custom" style={{ '--chip': s.status_color } as CSSProperties}>
                <span className="dot" />{s.status_label}
              </span>
            </StatusHover>
            {s.archived_at && <span className="chip tag">Archived</span>}
            {pd.pendingIds.has(s.id) && <span className="chip tag">Pending delete</span>}
          </div>
        );
      case 'clients': {
        const shown = s.clients.slice(0, 2);
        const extra = s.clients.length - shown.length;
        return (
          <div className="chips">
            {s.clients.length === 0 && <span className="chip tag">—</span>}
            {shown.map((c) => <span key={c.client_id} className="chip c-blue">{c.name}</span>)}
            {extra > 0 && <span className="chip tag">+{extra}</span>}
          </div>
        );
      }
      case 'city':
        return <span className="cell-top">{s.city ?? '—'}</span>;
      case 'country':
        return <span className="cell-top">{s.country}</span>;
      case 'dc_provider':
        return <span className="cell-top">{s.dc_provider ?? '—'}</span>;
      case 'coords':
        return <span className="mono">{formatCoords(s.latitude, s.longitude)}</span>;
      case 'address_line1':
        return <span className="cell-top">{s.address_line1 ?? '—'}</span>;
      case 'address_line2':
        return <span className="cell-top">{s.address_line2 ?? '—'}</span>;
      case 'region':
        return <span className="cell-top">{s.region ?? '—'}</span>;
      case 'postal_code':
        return <span className="cell-top">{s.postal_code ?? '—'}</span>;
      case 'timezone':
        return <span className="cell-top">{s.timezone ?? '—'}</span>;
      case 'notes':
        return <span className="cell-top">{s.notes || '—'}</span>;
      case 'latitude':
        return <span className="mono">{s.latitude ?? '—'}</span>;
      case 'longitude':
        return <span className="mono">{s.longitude ?? '—'}</span>;
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Sites</div>
          <h1 className="page-title">
            Sites
            <span className="badge-count">{sites?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Facilities we and our clients operate in — type, status, and location.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''}
                  onClick={() => setView('list')}>
            List
          </button>
          <button role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'on' : ''}
                  onClick={() => setView('map')}>
            Map
          </button>
        </div>
        <div className="toolbar-right">
          {view === 'map' && (
            <>
              <MapTypeFilter
                options={mapTypeOptions}
                selected={mapTypes}
                onToggle={toggleMapType}
                showRetired={mapShowRetired}
                onToggleRetired={() => setMapShowRetired((v) => !v)}
              />
              <span className="result-count">
                {mapSites.length} of {visible.length} on map
              </span>
            </>
          )}
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {sites?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         godMode={godMode} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('sites', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canChange} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New site
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load sites</b>{error}</div>}

      {!error && view === 'list' && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('primary')}>
                Name {caret('primary')}
              </button>
              <ColumnMenu colKey="primary" label="Name"
                          allRows={sites ?? []} filters={filters}
                          text={siteCellText}
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
                            allRows={sites ?? []} filters={filters}
                            text={siteCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <span />
          </div>

          {sites && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add a site.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows rows={visible}
            renderRow={(s, vp) => {
            const open = openId === s.id;
            return (
              <div key={s.id} className={`dir-row ${open ? 'open' : ''} ${s.archived_at ? 'archived' : ''}`}
                   {...vp} style={vp?.style}>
                <div className="row-main" style={grid}
                     onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : s.id); }}>
                  <div className="cell cell-primary">
                    {god.editing && godFieldFor('primary') && godFieldFor('primary2') ? (
                      <div className="pn god-primary-edit">
                        <GodCell row={s} gf={godFieldFor('primary')!} patch={updateSite}
                                 onRowSaved={replaceRow} errorMap={SITE_ERRORS} disabled={!canChange} />
                        <GodCell row={s} gf={godFieldFor('primary2')!} patch={updateSite}
                                 onRowSaved={replaceRow} errorMap={SITE_ERRORS} disabled={!canChange} />
                      </div>
                    ) : (
                      <div className="pn">
                        <b>{s.name}</b>
                        <span>{s.code ?? '—'}</span>
                      </div>
                    )}
                  </div>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(s, c.key)}</div>
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
                        <SiteRowDetail
                          site={s}
                          canEdit={canChange}
                          onEdit={() => setEditingId(s.id)}
                          godVisible={godMode}
                          pending={pd.pendingIds.has(s.id)}
                          onMark={() => pd.mark('site', s.id, s.name)}
                          onUnmark={() => pd.unmark(s.id)}
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

      {!error && view === 'map' && (
        <div className="sites-map-view">
          <SitesMap sites={mapSites} onSelect={(id) => {
            deepLinkTarget.current = null;
            setOpenId((cur) => (cur === id ? null : id));
          }} />
          {(() => {
            // pin click → the same read-only detail the list rows expand to,
            // shown as a card under the map (shares openId with the list, so
            // switching views keeps the same site selected)
            const sel = mapSites.find((s) => s.id === openId);
            if (!sel) return null;
            return (
              <div className="site-map-detail">
                <div className="site-map-detail-head">
                  <div className="pn">
                    <b>{sel.name}</b>
                    {sel.code && <span>{sel.code}</span>}
                  </div>
                  {sel.type_color && (
                    <span className="chip custom" style={{ '--chip': sel.type_color } as CSSProperties}>
                      <span className="dot" />{sel.type_label}
                    </span>
                  )}
                  <StatusHover entityType="site" entityId={sel.id} status={sel.status}>
                    <span className="chip custom" style={{ '--chip': sel.status_color } as CSSProperties}>
                      <span className="dot" />{sel.status_label}
                    </span>
                  </StatusHover>
                  <button type="button" className="mini-btn sm site-map-detail-close"
                          onClick={() => setOpenId(null)}>
                    Close
                  </button>
                </div>
                <SiteRowDetail
                  site={sel}
                  canEdit={canChange}
                  onEdit={() => setEditingId(sel.id)}
                  godVisible={godMode}
                  pending={pd.pendingIds.has(sel.id)}
                  onMark={() => pd.mark('site', sel.id, sel.name)}
                  onUnmark={() => pd.unmark(sel.id)}
                />
              </div>
            );
          })()}
        </div>
      )}

      {editingId !== null && (
        <SiteEditModal
          site={sites?.find((s) => s.id === editingId) ?? null}
          types={types}
          statuses={statuses}
          clients={clients}
          partners={partners}
          canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => load()}
        />
      )}
      {creating && (
        <SiteEditModal
          site={null}
          types={types}
          statuses={statuses}
          clients={clients}
          partners={partners}
          canChange={canChange}
          canBulk={canBulk}
          onClose={() => setCreating(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

/* ── map display filter: which site types render as pins, plus the
 * decommissioned/archived toggle (off by default). Same pop-menu chrome
 * as the list toolbar's Filters/Columns buttons (directory.css). ────── */
function MapTypeFilter({ options, selected, onToggle, showRetired, onToggleRetired }: {
  options: { value: string; label: string }[];
  selected: Set<string> | null; // null = all types shown
  onToggle: (value: string) => void;
  showRetired: boolean;
  onToggleRetired: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const hiddenTypes = selected === null ? 0 : options.length - selected.size;
  const active = hiddenTypes + (showRetired ? 1 : 0);
  const check = (
    <span className="pop-check">
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2"
           strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
    </span>
  );

  return (
    <div className="pop-wrap" ref={ref}>
      <button className="btn-ghost" onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11z" />
          <circle cx="12" cy="10" r="2.6" />
        </svg>
        Site types
        {active > 0 && <span className="fbadge">{active}</span>}
      </button>
      {open && (
        <div className="pop-menu">
          <div className="pop-title">Site types shown</div>
          {options.map((o) => {
            const on = selected === null || selected.has(o.value);
            return (
              <button key={o.value} className={`pop-item ${on ? 'on' : ''}`}
                      onClick={() => onToggle(o.value)}>
                {check}
                {o.label}
              </button>
            );
          })}
          <div className="pop-sep" />
          <div className="pop-title">Status</div>
          <button className={`pop-item ${showRetired ? 'on' : ''}`}
                  onClick={onToggleRetired}>
            {check}
            Show decommissioned &amp; archived
          </button>
        </div>
      )}
    </div>
  );
}

/* ── row detail: read-only display — the ONLY interactive element is the
 * Edit button. Address/coords/partner/clients/notes come straight off the
 * list row; the survey summary needs a per-row detail fetch (the row
 * endpoint isn't in the list projection), lazily loaded only while the
 * row is open, mirroring Workers.tsx's CertsPanel pattern. ───────────── */

function SiteRowDetail({
  site, canEdit, onEdit, godVisible, pending, onMark, onUnmark,
}: {
  site: SiteItem;
  canEdit: boolean;
  onEdit: () => void;
  godVisible: boolean;
  pending: boolean;
  onMark: () => Promise<void>;
  onUnmark: () => Promise<void>;
}) {
  const [surveyRows, setSurveyRows] = useState<SiteSurveyRow[] | null>(null);
  const [surveyStatus, setSurveyStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [mapOpen, setMapOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSurveyStatus('loading');
    void listSiteSurvey(site.id).then((rows) => {
      if (cancelled) return;
      setSurveyRows(rows);
      setSurveyStatus('loaded');
    }).catch(() => {
      if (!cancelled) setSurveyStatus('error');
    });
    return () => { cancelled = true; };
  }, [site.id]);

  const address = [site.address_line1, site.address_line2, [site.city, site.region]
    .filter(Boolean).join(', '), site.postal_code, site.country].filter(Boolean);

  return (
    <div className="detail-grid site-detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Address</p>
        {address.length === 0 ? (
          <p className="set-note" style={{ padding: 0 }}>No address on file.</p>
        ) : (
          <p className="site-address">{address.join(' · ')}</p>
        )}

        <p className="eyebrow-sm">Coordinates &amp; timezone</p>
        <dl className="kv">
          <dt>Coordinates</dt>
          <dd className="mono">{formatCoords(site.latitude, site.longitude)}</dd>
          <dt>Timezone</dt>
          <dd>{site.timezone ?? '—'}</dd>
        </dl>

        <p className="eyebrow-sm">Partner &amp; DC provider</p>
        <dl className="kv">
          <dt>Supplying partner</dt>
          <dd>{site.partner_name ?? '—'}</dd>
          <dt>DC provider</dt>
          <dd>{site.dc_provider ?? '—'}</dd>
        </dl>
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Clients</p>
        <div className="chips">
          {site.clients.length === 0 && <span className="chip tag">No linked clients</span>}
          {site.clients.map((c) => <span key={c.client_id} className="chip c-blue">{c.name}</span>)}
        </div>

        <p className="eyebrow-sm">Notes</p>
        <p className="set-note" style={{ padding: 0 }}>{site.notes || 'No notes.'}</p>

        <p className="eyebrow-sm">Survey</p>
        {surveyStatus === 'loading' && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
        {surveyStatus === 'error' && (
          <p className="set-note" style={{ padding: 0 }}>Could not load survey data.</p>
        )}
        {surveyStatus === 'loaded' && surveyRows && (
          <p className="survey-summary">{surveySummary(surveyRows)}</p>
        )}
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Location</p>
        {site.latitude !== null && site.longitude !== null ? (
          <SiteMiniMap site={site} onOpen={() => setMapOpen(true)} />
        ) : (
          <p className="set-note" style={{ padding: 0 }}>
            No coordinates — add them in Edit to see the map.
          </p>
        )}
      </div>

      {mapOpen && <SiteMapModal site={site} onClose={() => setMapOpen(false)} />}

      <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
        <Link className="mini-btn" to={`/sites/${site.id}`}>Full Details ↗</Link>
        {canEdit && (
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        )}
        <GodDeleteButton visible={godVisible} entityType="site" entityId={site.id}
                         label={site.name} pending={pending}
                         onChange={pending ? onUnmark : onMark} />
      </div>
    </div>
  );
}
