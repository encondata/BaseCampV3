/**
 * InitiativeDetail — the Full Details page for one initiative
 * (/initiatives/:id), in the spirit of BaseCampV2's ProjectDetail/
 * MoveDetail: header with every top-level field, then section cards.
 * Field edits still route through InitiativeEditModal — this page only
 * owns its own data load plus the sections below the header (People,
 * Linked initiatives, Notes & Attachments follow the same run()/refetch
 * pattern as InitiativeRowDetail in Initiatives.tsx).
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ComboBox, { type ComboOption } from '../components/ComboBox';
import AssetEditDialog from '../components/initiatives/AssetEditDialog';
import InitiativeEditModal from '../components/initiatives/InitiativeEditModal';
import RackViewModal from '../components/initiatives/RackViewModal';
import InlineTextField from '../components/InlineTextField';
import NotesFilesPanel from '../components/NotesFilesPanel';
import ScanHistoryTable from '../components/scans/ScanHistoryTable';
import {
  ApiError,
  addInitiativeLink,
  addInitiativePerson,
  getInitiative,
  getTimeSummary,
  listAssetStatuses,
  listClients,
  listInitiativeAssets,
  listInitiativeStatuses,
  listInitiativeSubTypes,
  listInitiativeTypes,
  listInitiativeWorkTypes,
  listInitiatives,
  listPartners,
  listShippingTypes,
  listSites,
  listWorkerOptions,
  removeInitiativeAsset,
  removeInitiativeLink,
  removeInitiativePerson,
  updateInitiativeAsset,
  updateInitiativeLink,
  updateInitiativePerson,
  type InitiativeAssetRow,
  type InitiativeDetail as InitiativeDetailOut,
  type InitiativeItem,
  type InitiativePersonRow,
  type OrgRef,
  type SiteItem,
  type StatusValue,
  type TimeSummaryOut,
  type WorkerOption,
} from '../lib/api';
import { ADMIN_RANK } from '../lib/access';
import { relativeTime } from '../lib/format';
import {
  INITIATIVE_ERRORS, MOVE_ASSET_COLUMNS, MOVE_ASSET_EDIT_FIELDS, MOVE_ASSET_ERRORS,
  initiativeCellText, moveAssetCellText, moveAssetProgress, moveAssetStatusBreakdown,
} from '../lib/initiatives';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import {
  GodCell, GodEditToggle, numberToPatch, useGodEdit, type GodField,
} from '../lib/godEdit';
import {
  applyColumnOrder,
  ColumnsButton, ExportButton, exportCsv, moveKey, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import { naturalCompare } from '../lib/sites';
import { formatMinutes } from '../lib/timeFormat';
import StatusHover from '../components/StatusHover';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';

/** real_start_at/real_end_at are date-only fields stored as midnight UTC
 *  — slicing the ISO string (rather than toLocaleDateString) avoids the
 *  day-west-of-UTC shift documented on lib/initiatives.ts's dateOnly. */
const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/* ── People section — standard list machinery (mirrors Initiatives.tsx's
      COLUMNS/sortValueFor pattern; see lib/columnMenu.tsx + lib/listTools.tsx
      for the shared sort/filter/columns/search plumbing). ────────────── */

const PEOPLE_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.4fr', default: true },
  { key: 'work_type', label: 'Work type', width: '1fr', default: true },
  { key: 'site_worked', label: 'Site worked', width: '1fr', default: true },
  { key: 'rating', label: 'Rating', width: '0.7fr', default: true },
  { key: 'added', label: 'Added', width: '0.9fr', default: false },
];

const PEOPLE_ALL_COLUMN_KEYS = new Set<string>(PEOPLE_COLUMNS.map((c) => c.key));
const PEOPLE_DEFAULT_VISIBLE = new Set<string>(
  PEOPLE_COLUMNS.filter((c) => c.default).map((c) => c.key));

const NO_PEOPLE: InitiativePersonRow[] = [];

/** God-edit descriptors for the People roster (lib/initiatives.ts
 *  INITIATIVE_GOD_FIELDS factory pattern) — name/added stay non-editable,
 *  so godFieldFor returns undefined for those and personCellFor's normal
 *  switch renders them. */
interface PeopleGodLookups {
  workTypes: () => ComboOption[];
  sites: () => ComboOption[];
}

function PEOPLE_GOD_FIELDS(lookups: PeopleGodLookups): GodField<InitiativePersonRow>[] {
  return [
    { column: 'work_type', field: 'work_type', kind: 'select',
      fromRow: (p) => p.work_type ?? '', options: lookups.workTypes },
    { column: 'site_worked', field: 'site_worked_id', kind: 'combo',
      fromRow: (p) => p.site_worked_id ?? '', options: lookups.sites },
    { column: 'rating', field: 'rating', kind: 'number',
      fromRow: (p) => (p.rating != null ? String(p.rating) : ''),
      toPatch: numberToPatch },
  ];
}

/* ── Assets section (moves only) — same list machinery as People above,
      built on the pure helpers in lib/initiatives.ts. Read-only this slice
      (Task 3); edit dialog + remove land in Task 4. ────────────────── */

const MOVE_ASSET_ALL_COLUMN_KEYS = new Set<string>(MOVE_ASSET_COLUMNS.map((c) => c.key));
const MOVE_ASSET_DEFAULT_VISIBLE = new Set<string>(
  MOVE_ASSET_COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Columns whose header + body cells are center-aligned rather than the
 *  table's default left alignment — status/verify-style columns read
 *  better centered. Page-local to the assets table; doesn't touch the
 *  shared ColumnDef type or any other page's tables. */
const ASSET_CENTERED_COLS = new Set<string>([
  'status', 'source_ru', 'destination_ru', 'source_position',
  'destination_position', 'source_verified', 'destination_verified',
]);

/** Full column set, in CSV column order — exported columns always mirror
 *  MOVE_ASSET_COLUMNS regardless of which ones are currently shown/hidden
 *  on screen (same convention as Initiatives.tsx's CSV_COLUMNS). */
const ASSET_CSV_COLUMNS: [string, (r: InitiativeAssetRow) => string][] =
  MOVE_ASSET_COLUMNS.map((c) => [c.label, (r: InitiativeAssetRow) => moveAssetCellText(r, c.key)]);

/** Same date formatting `initiativeCellText`'s 'created' column uses
 *  elsewhere on this page (toLocaleDateString) — `created_at` here is a
 *  full timestamp, not a date-only field like real_start_at/real_end_at
 *  above, so it doesn't need the UTC-slice treatment `dateOnly` exists for. */
const personAddedText = (iso: string) => new Date(iso).toLocaleDateString();

/** One row's display text per column key — feeds both the per-column
 *  filter menus (via `passesColumnFilters`) and the toolbar search box. */
function personCellText(row: InitiativePersonRow, colKey: string): string {
  switch (colKey) {
    case 'name': return row.person_name;
    case 'work_type': return row.work_type_label ?? '';
    case 'site_worked': return row.site_worked_name ?? '';
    case 'rating': return row.rating != null ? String(row.rating) : '';
    case 'added': return personAddedText(row.created_at);
    default: return '';
  }
}

/** Rating sorts numerically (1–5), not as text — everything else sorts via
 *  `naturalCompare` over `personCellText`. Unrated rows sort lowest. */
function personRatingValue(row: InitiativePersonRow): number {
  return row.rating ?? -1;
}

export default function InitiativeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can, godMode, maxRank } = useAuth();
  const canChange = can('initiatives', 'change');
  const canViewSites = can('sites', 'view');
  const canViewClients = can('clients', 'view');
  const canViewPartners = can('partners', 'view');
  const canViewWorkers = can('workers', 'view');
  const isAdmin = maxRank >= ADMIN_RANK;
  const god = useGodEdit();

  const [initiative, setInitiative] = useState<InitiativeDetailOut | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [types, setTypes] = useState<StatusValue[]>([]);
  const [subTypes, setSubTypes] = useState<StatusValue[]>([]);
  const [shippingTypes, setShippingTypes] = useState<StatusValue[]>([]);
  const [workTypes, setWorkTypes] = useState<StatusValue[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [partners, setPartners] = useState<OrgRef[]>([]);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [allInitiatives, setAllInitiatives] = useState<InitiativeItem[]>([]);
  const [editing, setEditing] = useState(false);

  // People section
  const [editingPerson, setEditingPerson] = useState<InitiativePersonRow | null>(null);
  const [pendingPerson, setPendingPerson] = useState('');
  const [pendingWorkType, setPendingWorkType] = useState('');
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [peopleError, setPeopleError] = useState('');
  const [peopleQuery, setPeopleQuery] = useState('');
  const {
    visibleCols: peopleVisibleCols, setVisibleCols: setPeopleVisibleCols,
    sortKey: peopleSortKey, sortDir: peopleSortDir, setSort: setPeopleSort,
    toggleSort: togglePeopleSort,
    filters: peopleFilters, setFilter: setPeopleFilter,
    clearFilters: clearPeopleFilters,
    colOrder: peopleColOrder, setColOrder: setPeopleColOrder,
  } = usePersistentListState(
    'initiative_people', { visible: PEOPLE_DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 },
    PEOPLE_ALL_COLUMN_KEYS,
  );
  const peopleOrderedCols = applyColumnOrder(PEOPLE_COLUMNS, peopleColOrder);
  const peopleShownCols = visibleColumnsFor(peopleOrderedCols, peopleVisibleCols, false);
  const peopleHeaderDrag = useReorderDrag(
    (src, dst, before) => setPeopleColOrder(
      moveKey(peopleOrderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const peopleHaystackText = useCallback((p: InitiativePersonRow) =>
    PEOPLE_COLUMNS.map((c) => personCellText(p, c.key)).join(' ').toLowerCase(), []);
  const peopleRows = initiative?.people ?? NO_PEOPLE;
  const peopleHaystack = useSearchHaystacks(peopleRows, peopleHaystackText);
  const visiblePeople = useMemo(() => {
    const q = peopleQuery.trim().toLowerCase();
    const filtered = peopleRows.filter((p) => {
      if (!passesColumnFilters(p, peopleFilters, personCellText)) return false;
      if (!q) return true;
      return peopleHaystack(p).includes(q);
    });
    return filtered.sort((a, b) => (peopleSortKey === 'rating'
      ? (personRatingValue(a) - personRatingValue(b)) * peopleSortDir
      : naturalCompare(personCellText(a, peopleSortKey), personCellText(b, peopleSortKey))
        * peopleSortDir));
  }, [peopleRows, peopleFilters, peopleQuery, peopleSortKey, peopleSortDir, peopleHaystack]);
  const godFields = useMemo(() => PEOPLE_GOD_FIELDS({
    workTypes: () => workTypes.map((w) => ({ value: w.key, label: w.label })),
    sites: () => (canViewSites ? sites.map((s) => ({ value: s.id, label: s.name })) : []),
  }), [workTypes, sites, canViewSites]);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const shippingLabels = useMemo(
    () => Object.fromEntries(shippingTypes.map((s) => [s.key, s.label])),
    [shippingTypes]);
  // Direct state splice, not a load() refetch — people live on the
  // InitiativeDetail object held in `initiative`, not a separate array.
  const replacePerson = (u: InitiativePersonRow) =>
    setInitiative((cur) => (cur
      ? { ...cur, people: cur.people.map((p) => (p.id === u.id ? u : p)) }
      : cur));

  // Assets section (moves only) — fetched separately from getInitiative,
  // since GET /initiatives/{id}/assets is its own endpoint (Task 2).
  const [assets, setAssets] = useState<InitiativeAssetRow[]>([]);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [assetsError, setAssetsError] = useState('');
  const [assetsQuery, setAssetsQuery] = useState('');
  const [moveStatuses, setMoveStatuses] = useState<StatusValue[]>([]);
  const [editingAsset, setEditingAsset] = useState<InitiativeAssetRow | null>(null);
  const [assetsBusy, setAssetsBusy] = useState(false);
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const canViewScans = can('scans', 'view');
  const [assetsActionError, setAssetsActionError] = useState('');
  // Inline edit-table mode for Assets — a separate toggle from the People
  // section's god.editing (Task 5b): gated on maxRank/canChange, not
  // godMode, so it isn't tied to useGodEdit()'s godMode-derived `editing`.
  const [assetsEditing, setAssetsEditing] = useState(false);
  // Rack elevation modal (Task 6) — opened from a Source/Destination Rack
  // cell button in read-only display mode; null when closed.
  const [rackView, setRackView] = useState<
    { rackName: string; side: 'source' | 'destination' } | null>(null);
  const {
    visibleCols: assetsVisibleCols, setVisibleCols: setAssetsVisibleCols,
    sortKey: assetsSortKey, sortDir: assetsSortDir, setSort: setAssetsSort,
    toggleSort: toggleAssetsSort,
    filters: assetsFilters, setFilter: setAssetsFilter,
    clearFilters: clearAssetsFilters,
    colOrder: assetsColOrder, setColOrder: setAssetsColOrder,
  } = usePersistentListState(
    'initiative_assets', { visible: MOVE_ASSET_DEFAULT_VISIBLE, sortKey: 'wave', sortDir: 1 },
    MOVE_ASSET_ALL_COLUMN_KEYS,
  );
  const assetsOrderedCols = applyColumnOrder(MOVE_ASSET_COLUMNS, assetsColOrder);
  const assetsShownCols = visibleColumnsFor(assetsOrderedCols, assetsVisibleCols, false);
  const assetsHeaderDrag = useReorderDrag(
    (src, dst, before) => setAssetsColOrder(
      moveKey(assetsOrderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const assetsProgress = useMemo(
    () => moveAssetProgress(assets, moveStatuses), [assets, moveStatuses]);
  const assetsHaystackText = useCallback((a: InitiativeAssetRow) =>
    MOVE_ASSET_COLUMNS.map((c) => moveAssetCellText(a, c.key)).join(' ').toLowerCase(), []);
  const assetsHaystack = useSearchHaystacks(assets, assetsHaystackText);

  const visibleAssets = useMemo(() => {
    const q = assetsQuery.trim().toLowerCase();
    const filtered = assets.filter((a) => {
      if (!passesColumnFilters(a, assetsFilters, moveAssetCellText)) return false;
      if (!q) return true;
      return assetsHaystack(a).includes(q);
    });
    return filtered.sort((a, b) => {
      // Timestamp columns sort by the real instant, not the locale date
      // text (same rule as MoveDashboard's roster).
      if (assetsSortKey === 'updated' || assetsSortKey === 'added') {
        const field = assetsSortKey === 'updated' ? 'updated_at' : 'created_at';
        return (Date.parse(a[field]) - Date.parse(b[field])) * assetsSortDir;
      }
      const aText = moveAssetCellText(a, assetsSortKey);
      const bText = moveAssetCellText(b, assetsSortKey);
      // Wave column: blank ('—', unwaved) always sorts last regardless of
      // sort direction — matches v2/spec's NULLS LAST intent. This is a
      // deliberate simplification scoped to 'wave' only, not a general
      // "blanks always last for every column" rule.
      if (assetsSortKey === 'wave') {
        const aBlank = aText === '—';
        const bBlank = bText === '—';
        if (aBlank !== bBlank) return aBlank ? 1 : -1;
      }
      const primary = naturalCompare(aText, bText) * assetsSortDir;
      if (primary !== 0) return primary;
      // Default sort is wave; break ties by serial (v2 parity) — a
      // secondary key only meaningful while wave is still the active sort.
      if (assetsSortKey === 'wave') {
        return naturalCompare(moveAssetCellText(a, 'serial'), moveAssetCellText(b, 'serial'))
          * assetsSortDir;
      }
      return 0;
    });
  }, [assets, assetsFilters, assetsQuery, assetsSortKey, assetsSortDir, assetsHaystack]);
  const assetGodFields = useMemo(() => MOVE_ASSET_EDIT_FIELDS({
    statuses: () => moveStatuses.map((s) => ({ value: s.key, label: s.label })),
  }), [moveStatuses]);
  const assetGodFieldFor = (column: string) => assetGodFields.find((f) => f.column === column);
  // Direct state splice, not a runAssets()/refetch — mirrors People's
  // replacePerson: the freshly-patched row comes back from PATCH already.
  const replaceAsset = (u: InitiativeAssetRow) =>
    setAssets((cur) => cur.map((a) => (a.id === u.id ? u : a)));

  // Linked initiatives section
  const [pendingChild, setPendingChild] = useState('');
  const [pendingRole, setPendingRole] = useState('');
  const [linksBusy, setLinksBusy] = useState(false);
  const [linksError, setLinksError] = useState('');

  // Time tracking panel (page bottom) — /time/summary is initiatives:view,
  // so it loads for every viewer of this page regardless of type; a failed
  // fetch is swallowed and just renders as the empty state (Task brief).
  const [timeSummary, setTimeSummary] = useState<TimeSummaryOut | null>(null);
  const [timeLoaded, setTimeLoaded] = useState(false);

  const load = () => {
    if (!id) return;
    void getInitiative(id).then((data) => {
      setInitiative(data);
      setNotFound(false);
      setError('');
    }).catch((err) => {
      setNotFound(err instanceof ApiError
        && (err.status === 403 || err.status === 404));
      setError(err instanceof ApiError && (err.status === 403 || err.status === 404)
        ? '' : 'Failed to load initiative.');
    });
  };
  useEffect(load, [id]);

  useEffect(() => {
    if (!initiative || initiative.initiative_type !== 'move') return;
    setAssetsLoaded(false);
    void listInitiativeAssets(initiative.id)
      .then((rows) => {
        setAssets(rows);
        setAssetsError('');
      })
      .catch(() => setAssetsError('Failed to load assets.'))
      .finally(() => setAssetsLoaded(true));
  }, [initiative?.id, initiative?.initiative_type]);

  // Asset status vocabulary (merged: lifecycle + move workflow keys) —
  // only needed for moves, feeds the edit dialog's Status ComboBox below.
  useEffect(() => {
    if (!initiative || initiative.initiative_type !== 'move') return;
    void listAssetStatuses().then(setMoveStatuses).catch(() => {});
  }, [initiative?.id, initiative?.initiative_type]);

  useEffect(() => {
    if (!initiative) return;
    setTimeLoaded(false);
    setTimeSummary(null);
    void getTimeSummary(initiative.id)
      .then(setTimeSummary)
      .catch(() => setTimeSummary(null))
      .finally(() => setTimeLoaded(true));
  }, [initiative?.id]);

  useEffect(() => {
    void listInitiativeStatuses().then(setStatuses).catch(() => {});
    void listInitiativeTypes().then(setTypes).catch(() => {});
    void listInitiativeSubTypes().then(setSubTypes).catch(() => {});
    void listShippingTypes().then(setShippingTypes).catch(() => {});
    void listInitiativeWorkTypes().then(setWorkTypes).catch(() => {});
    void listInitiatives().then(setAllInitiatives).catch(() => {});
    if (canViewSites) void listSites().then(setSites).catch(() => {});
    if (canViewClients) void listClients().then(setClients).catch(() => {});
    if (canViewPartners) void listPartners().then(setPartners).catch(() => {});
    if (canViewWorkers) void listWorkerOptions().then(setWorkers).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runPeople = async (op: () => Promise<unknown>) => {
    setPeopleBusy(true);
    setPeopleError('');
    try {
      await op();
      load();
    } catch (err) {
      setPeopleError(err instanceof ApiError
        ? (INITIATIVE_ERRORS[err.code] ?? 'Could not save — try again.')
        : 'Network error.');
    } finally {
      setPeopleBusy(false);
    }
  };

  const runAssets = async (op: () => Promise<unknown>) => {
    if (!id) return;
    setAssetsBusy(true);
    setAssetsActionError('');
    try {
      await op();
      const rows = await listInitiativeAssets(id);
      setAssets(rows);
    } catch (err) {
      setAssetsActionError(err instanceof ApiError
        ? (MOVE_ASSET_ERRORS[err.code] ?? 'Could not save — try again.')
        : 'Network error.');
    } finally {
      setAssetsBusy(false);
    }
  };

  const runLinks = async (op: () => Promise<unknown>) => {
    setLinksBusy(true);
    setLinksError('');
    try {
      await op();
      load();
    } catch (err) {
      setLinksError(err instanceof ApiError
        ? (INITIATIVE_ERRORS[err.code] ?? 'Could not save — try again.')
        : 'Network error.');
    } finally {
      setLinksBusy(false);
    }
  };

  const kv = (label: string, value: string | null | undefined) => (
    <><dt>{label}</dt><dd>{value || '—'}</dd></>
  );

  const chip = (label: string | null | undefined, color: string | null | undefined) =>
    label && color
      ? (
        <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
          <span className="dot" />{label}
        </span>
      )
      : null;

  const partnerName = (partnerId: string | null) => {
    if (!partnerId || !canViewPartners) return null;
    return partners.find((p) => p.id === partnerId)?.name ?? null;
  };

  if (notFound) {
    return (
      <div className="portal-page">
        <Link to="/initiatives" className="idet-back">← Initiatives</Link>
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Initiative not found</b>
          It may have been deleted, or you may not have access.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="portal-page">
        <Link to="/initiatives" className="idet-back">← Initiatives</Link>
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Cannot load initiative</b>
          {error}
        </div>
      </div>
    );
  }

  if (!initiative) {
    return (
      <div className="portal-page">
        <Link to="/initiatives" className="idet-back">← Initiatives</Link>
        <p className="page-hint" style={{ marginTop: 16 }}>Loading…</p>
      </div>
    );
  }

  const isMove = initiative.initiative_type === 'move';

  const onPeople = new Set(initiative.people.map((p) => p.person_id));
  const personOptions = workers
    .filter((w) => !onPeople.has(w.person_id))
    .map((w) => ({ value: w.person_id, label: w.display_name }));
  const linked = new Set([
    initiative.id,
    ...initiative.links_children.map((l) => l.other_id),
    ...initiative.links_parents.map((l) => l.other_id),
  ]);
  const childOptions = allInitiatives
    .filter((i) => !linked.has(i.id) && !i.archived_at)
    .map((i) => ({ value: i.id, label: i.name, sub: i.type_label }));

  const peopleGrid = { gridTemplateColumns:
    `${peopleShownCols.map((c) => c.width).join(' ')}${canChange ? ' 132px' : ''}` };

  const peopleCaret = (key: string) =>
    peopleSortKey === key
      ? <span className="caret">{peopleSortDir === 1 ? '▲' : '▼'}</span> : null;

  const personCellFor = (p: InitiativePersonRow, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={p} gf={gf} patch={updateInitiativePerson} onRowSaved={replacePerson}
                   errorMap={INITIATIVE_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'name': return <span className="cell-top">{p.person_name}</span>;
      case 'work_type':
        return p.work_type_label
          ? (chip(p.work_type_label, p.work_type_color)
             ?? <span className="cell-top">{p.work_type_label}</span>)
          : <span className="cell-top">—</span>;
      case 'site_worked':
        return <span className="cell-top">{p.site_worked_name || '—'}</span>;
      case 'rating':
        return <span className="cell-top">{p.rating != null ? `★ ${p.rating}` : '—'}</span>;
      case 'added':
        return <span className="cell-top">{personCellText(p, 'added')}</span>;
      default: return null;
    }
  };

  const assetsGrid = { gridTemplateColumns:
    `${assetsShownCols.map((c) => c.width).join(' ')}${canChange ? ' 132px' : ''} 30px` };

  const assetsCaret = (key: string) =>
    assetsSortKey === key
      ? <span className="caret">{assetsSortDir === 1 ? '▲' : '▼'}</span> : null;

  /** Status/Asset Status render as chips (move-status and the asset's own
   *  status, respectively); every other column reuses moveAssetCellText's
   *  display text verbatim — it already carries the '—' blank convention. */
  const assetCellFor = (a: InitiativeAssetRow, key: string) => {
    if (assetsEditing) {
      const gf = assetGodFieldFor(key);
      if (gf) {
        return (
          <GodCell row={a} gf={gf} patch={(id, body) => updateInitiativeAsset(id, body)}
                   onRowSaved={replaceAsset} errorMap={MOVE_ASSET_ERRORS}
                   disabled={!canChange} />
        );
      }
    }
    if (key === 'status') {
      return (
        <StatusHover entityType="initiative_asset" entityId={a.id} status={a.status}>
          {chip(a.status_label, a.status_color)
            ?? <span className="cell-top">{a.status_label}</span>}
        </StatusHover>
      );
    }
    if (key === 'asset_status') {
      return (
        <StatusHover entityType="asset" entityId={a.asset_id} status={a.asset.status}>
          {chip(a.asset.status_label, a.asset.status_color)
            ?? <span className="cell-top">{a.asset.status_label}</span>}
        </StatusHover>
      );
    }
    // Verified columns (Yes) get a small green check beside the text —
    // No/Unknown fall through to the plain moveAssetCellText rendering
    // below. CSV export / moveAssetCellText stay text-only by design.
    if (key === 'source_verified' || key === 'destination_verified') {
      const verified = key === 'source_verified' ? a.source_verified : a.destination_verified;
      if (verified) {
        return (
          <span className="cell-top idet-verified-yes">
            Yes
            <svg className="idet-check-yes" viewBox="0 0 12 12" fill="none"
                 stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
                 strokeLinejoin="round">
              <path d="M2 6.5 4.8 9.5 10 2.8" />
            </svg>
          </span>
        );
      }
    }
    // Rack view (Task 6) — non-empty Source/Destination Rack cells open the
    // elevation modal for that rack; edit-table mode is handled above via
    // assetGodFieldFor, so this only ever renders in read-only display mode.
    if (key === 'source_rack' || key === 'destination_rack') {
      const side: 'source' | 'destination' =
        key === 'source_rack' ? 'source' : 'destination';
      const rackName = side === 'source' ? a.source_rack : a.destination_rack;
      if (rackName) {
        return (
          <button type="button" className="idet-rack-cell-btn"
                  onClick={(e) => { e.stopPropagation(); setRackView({ rackName, side }); }}>
            {rackName}
          </button>
        );
      }
    }
    return <span className="cell-top">{moveAssetCellText(a, key)}</span>;
  };

  return (
    <div className="portal-page">
      <Link to="/initiatives" className="idet-back">← Initiatives</Link>

      <div className="idet-header">
        <div className="idet-heading">
          <div className="idet-title-row">
            <h1 className="page-title">{initiative.name}</h1>
            {chip(initiative.type_label, initiative.type_color)}
            {initiative.sub_type_label
              && chip(initiative.sub_type_label, initiative.sub_type_color)}
            <StatusHover entityType="initiative" entityId={initiative.id} status={initiative.status}>
              {chip(initiative.status_label, initiative.status_color)}
            </StatusHover>
            {initiative.archived_at && <span className="chip tag">Archived</span>}
          </div>
          {initiative.description && (
            <p className="page-hint idet-desc">{initiative.description}</p>
          )}
        </div>
        {canChange && (
          <div className="idet-header-actions">
            {isMove && (
              <Link className="mini-btn"
                    to={`/initiatives/${initiative.id}/import-assets`}>
                Import assets
              </Link>
            )}
            <button className="btn-solid" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
        )}
      </div>

      <div className={`detail-grid idet-grid${isMove && assets.length > 0 ? ' idet-grid-3col' : ''}`}>
        <div className="init-panel"
             style={!isMove ? { gridColumn: '1 / -1' } : undefined}>
          <p className="eyebrow-sm">Overview</p>
          <dl className="kv">
            {kv('Type', initiative.type_label)}
            {kv('Sub-type', initiative.sub_type_label)}
            {kv('Status', initiative.status_label)}
            {kv('Client', initiative.client_name)}
            {!isMove && kv('Site', initiative.site_name)}
            {kv('Location', initiative.location)}
            {kv('Scheduled', [initiativeCellText(initiative, 'start'),
                              initiativeCellText(initiative, 'end')]
              .filter((s) => s !== '—').join(' → ') || '—')}
            {kv('Actual', [dateOnly(initiative.real_start_at),
                           dateOnly(initiative.real_end_at)]
              .filter((s): s is string => !!s).join(' → ') || '—')}
            {initiative.initiative_type === 'project'
              && kv('Sky Command ID', initiative.sky_command_project_id)}
            {kv('Created', initiativeCellText(initiative, 'created'))}
          </dl>
        </div>

        {isMove && assets.length > 0 && (
          <div className="init-panel">
            <p className="eyebrow-sm">Assets by status</p>
            <AssetStatusDonut rows={assets} statuses={moveStatuses} />
          </div>
        )}

        {isMove && (
          <div className="init-panel">
            <p className="eyebrow-sm">Move</p>
            <dl className="kv">
              {kv('Origin → Destination', [initiative.origin_site_name,
                                           initiative.destination_site_name]
                .filter(Boolean).join(' → ') || '—')}
              {kv('Shipping types', initiative.shipping_types
                .map((k) => shippingLabels[k] ?? k).join(', '))}
              {kv('Shipping partner', initiative.shipping_partner_name)}
              {kv('Priority devices',
                  initiative.priority_devices == null ? null
                    : initiative.priority_devices ? 'Yes' : 'No')}
              {kv('Origin vendor involved',
                  initiative.origin_vendor_involved == null ? null
                    : initiative.origin_vendor_involved ? 'Yes' : 'No')}
              {kv('Destination vendor involved',
                  initiative.destination_vendor_involved == null ? null
                    : initiative.destination_vendor_involved ? 'Yes' : 'No')}
              {kv('Origin tech partner',
                  partnerName(initiative.origin_tech_partner_id))}
              {kv('Origin cable partner',
                  partnerName(initiative.origin_cable_partner_id))}
              {kv('Origin logistics partner',
                  partnerName(initiative.origin_logistics_partner_id))}
              {kv('Destination tech partner',
                  partnerName(initiative.destination_tech_partner_id))}
              {kv('Destination cable partner',
                  partnerName(initiative.destination_cable_partner_id))}
              {kv('Destination logistics partner',
                  partnerName(initiative.destination_logistics_partner_id))}
            </dl>
          </div>
        )}

        <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
          <p className="eyebrow-sm">Assets{isMove ? ` — ${assets.length}` : ''}</p>
          {!isMove && <p className="page-hint">Asset tracking lands here next.</p>}
          {isMove && assetsError && (
            <div className="dir-empty" style={{ marginBottom: 12 }}>
              <b>Cannot load assets</b>{assetsError}
            </div>
          )}
          {isMove && !assetsError && assetsLoaded && assets.length === 0 && (
            <p className="page-hint">
              No assets on this move yet — assets arrive via bulk import.
            </p>
          )}
          {isMove && !assetsError && assets.length > 0 && (
            <>
              {assetsProgress.countable > 0 && (
                <div className="idet-assets-progress">
                  <div className="idet-assets-progress-label">
                    <span>{assetsProgress.pct}%</span>
                  </div>
                  <div className="idet-assets-progress-track">
                    <div className="idet-assets-progress-fill"
                         style={{ width: `${assetsProgress.pct}%` }} />
                  </div>
                </div>
              )}

              <div className="dir-toolbar idet-assets-toolbar">
                <div className="toolbar-right">
                  <div className="dir-search" style={{ marginLeft: 0 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round">
                      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                    <input placeholder="Filter assets…" value={assetsQuery}
                           onChange={(e) => setAssetsQuery(e.target.value)} />
                  </div>
                  <span className="result-count">
                    {visibleAssets.length} of {assets.length} shown</span>
                  <FilterSummaryChip filters={assetsFilters} onClear={clearAssetsFilters} />
                  <ColumnsButton columns={assetsOrderedCols} visible={assetsVisibleCols}
                                 onChange={setAssetsVisibleCols}
                                 onReorder={setAssetsColOrder} />
                  <ExportButton onExport={() =>
                    exportCsv('move-assets', ASSET_CSV_COLUMNS, visibleAssets)} />
                  <GodEditToggle editing={assetsEditing}
                                 onToggle={() => setAssetsEditing((e) => !e)}
                                 visible={maxRank >= ADMIN_RANK && canChange} />
                </div>
              </div>

              <div className="dir-list idet-assets-list">
                <div className="list-head" style={assetsGrid}>
                  {assetsShownCols.map((c) => (
                    <span key={c.key}
                          className={`col-head ${assetsHeaderDrag.dropClass(c.key)}`
                            + `${ASSET_CENTERED_COLS.has(c.key) ? ' idet-col-center' : ''}`}
                          {...assetsHeaderDrag.dragProps(c.key)}>
                      <button type="button" className="sortable"
                              onClick={() => toggleAssetsSort(c.key)}>
                        {c.label} {assetsCaret(c.key)}
                      </button>
                      <ColumnMenu colKey={c.key} label={c.label}
                                  allRows={assets} filters={assetsFilters}
                                  text={moveAssetCellText}
                                  filter={assetsFilters[c.key]} onFilter={setAssetsFilter}
                                  sortDir={assetsSortKey === c.key ? assetsSortDir : null}
                                  onSort={(dir) => setAssetsSort(c.key, dir)} />
                    </span>
                  ))}
                  {canChange && <span className="col-head" />}
                  <span className="col-head" />
                </div>

                {visibleAssets.length === 0 && (
                  <div className="dir-empty">
                    <b>No matches</b>Try a different search or filter.
                    <EmptyClearFilters filters={assetsFilters} onClear={clearAssetsFilters} />
                  </div>
                )}

                <VirtualRows rows={visibleAssets}
                  renderRow={(a, vp) => {
                    const open = openAssetId === a.id;
                    return (
                      <div key={a.id} className={`dir-row ${open ? 'open' : ''}`} {...vp} style={vp?.style}>
                        <div className="row-main" style={assetsGrid}
                             onClick={() => setOpenAssetId(open ? null : a.id)}>
                          {assetsShownCols.map((c) => (
                            <div className={`cell${ASSET_CENTERED_COLS.has(c.key)
                              ? ' idet-col-center' : ''}`}
                                 key={c.key}>{assetCellFor(a, c.key)}</div>
                          ))}
                          {canChange && (
                            <div className="cell idet-assets-actions">
                              <button type="button" className="mini-btn sm"
                                      disabled={assetsBusy}
                                      onClick={(e) => { e.stopPropagation(); setEditingAsset(a); }}>
                                Edit
                              </button>
                              <button type="button" className="mini-btn sm danger"
                                      disabled={assetsBusy}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const label = a.asset.name
                                          ?? a.asset.serial_number ?? 'this asset';
                                        if (!confirm(
                                          `Remove "${label}" from this initiative?`)) return;
                                        void runAssets(() => removeInitiativeAsset(a.id));
                                      }}>
                                Remove
                              </button>
                            </div>
                          )}
                          <div className="cell chevron-cell">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                 strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                          </div>
                        </div>
                        <div className="detail">
                          <div className="detail-clip">
                            <div className="detail-inner">
                              {open && (
                                <MoveAssetExpansion row={a} initiativeId={id!}
                                                     canViewScans={canViewScans} />
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }} />
              </div>
              {assetsActionError && <span className="pf-error">{assetsActionError}</span>}
            </>
          )}
        </div>

        <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
          <p className="eyebrow-sm">Linked initiatives</p>
          {initiative.links_children.length === 0
            && initiative.links_parents.length === 0
            ? <p className="page-hint">No linked initiatives.</p>
            : (
              <div className="mini-list init-rows">
                {initiative.links_children.map((l) => (
                  <div key={l.id} className="mini-row init-row">
                    <span className="init-tag mono">Contains</span>
                    <button type="button" className="init-name-btn cell-top"
                            onClick={() => navigate(`/initiatives/${l.other_id}`)}>
                      {l.other_name}
                    </button>
                    {chip(l.other_type_label, l.other_type_color)}
                    {canChange ? (
                      <InlineTextField value={l.role} placeholder="Role…"
                                       maxWidth={140} disabled={linksBusy}
                                       onCommit={(v) => void runLinks(
                                         () => updateInitiativeLink(
                                           l.id, { role: v }))} />
                    ) : (
                      l.role && <span className="cell-sub">{l.role}</span>
                    )}
                    {canChange && (
                      <button type="button" className="mini-btn sm danger spacer"
                              disabled={linksBusy}
                              onClick={() => void runLinks(
                                () => removeInitiativeLink(l.id))}>
                        Unlink
                      </button>
                    )}
                  </div>
                ))}
                {initiative.links_parents.map((l) => (
                  <div key={l.id} className="mini-row init-row">
                    <span className="init-tag mono">Part of</span>
                    <button type="button" className="init-name-btn cell-top"
                            onClick={() => navigate(`/initiatives/${l.other_id}`)}>
                      {l.other_name}
                    </button>
                    {chip(l.other_type_label, l.other_type_color)}
                  </div>
                ))}
              </div>
            )}
          {canChange && (
            <div className="init-add">
              <div className="init-field">
                <label>Link an initiative (as child)</label>
                <ComboBox
                  placeholder="Type to search initiatives…"
                  value={pendingChild}
                  disabled={linksBusy}
                  onChange={setPendingChild}
                  options={childOptions}
                />
              </div>
              <div className="init-field">
                <label>Role</label>
                <input type="text" className="org-select" value={pendingRole}
                       disabled={linksBusy} placeholder="e.g. Phase 1"
                       onChange={(e) => setPendingRole(e.target.value)} />
              </div>
              <button type="button" className="mini-btn"
                      disabled={linksBusy || !pendingChild}
                      onClick={() => void runLinks(async () => {
                        await addInitiativeLink(initiative.id, {
                          child_id: pendingChild,
                          role: pendingRole.trim() || null,
                        });
                        setPendingChild('');
                        setPendingRole('');
                      })}>
                Link
              </button>
            </div>
          )}
          {linksError && <span className="pf-error">{linksError}</span>}
        </div>

        <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
          <NotesFilesPanel entityType="initiative" entityId={initiative.id}
                           canWrite={canChange} />
        </div>

        <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
          <p className="eyebrow-sm">People — {initiative.people.length}</p>
          {initiative.people.length === 0
            ? <p className="page-hint">No one assigned yet.</p>
            : (
              <>
                <div className="dir-toolbar idet-people-toolbar">
                  <div className="toolbar-right">
                    <div className="dir-search" style={{ marginLeft: 0 }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="2" strokeLinecap="round">
                        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                      <input placeholder="Filter people…" value={peopleQuery}
                             onChange={(e) => setPeopleQuery(e.target.value)} />
                    </div>
                    <span className="result-count">
                      {visiblePeople.length} of {initiative.people.length} shown</span>
                    <FilterSummaryChip filters={peopleFilters} onClear={clearPeopleFilters} />
                    <ColumnsButton columns={peopleOrderedCols} visible={peopleVisibleCols}
                                   onChange={setPeopleVisibleCols}
                                   onReorder={setPeopleColOrder} />
                    <GodEditToggle editing={god.editing} onToggle={god.toggle}
                                   visible={godMode && canChange} />
                  </div>
                </div>

                <div className="dir-list idet-people-list">
                  <div className="list-head" style={peopleGrid}>
                    {peopleShownCols.map((c) => (
                      <span key={c.key}
                            className={`col-head ${peopleHeaderDrag.dropClass(c.key)}`}
                            {...peopleHeaderDrag.dragProps(c.key)}>
                        <button type="button" className="sortable"
                                onClick={() => togglePeopleSort(c.key)}>
                          {c.label} {peopleCaret(c.key)}
                        </button>
                        <ColumnMenu colKey={c.key} label={c.label}
                                    allRows={initiative.people} filters={peopleFilters}
                                    text={personCellText}
                                    filter={peopleFilters[c.key]} onFilter={setPeopleFilter}
                                    sortDir={peopleSortKey === c.key ? peopleSortDir : null}
                                    onSort={(dir) => setPeopleSort(c.key, dir)} />
                      </span>
                    ))}
                    {canChange && <span className="col-head" />}
                  </div>

                  {visiblePeople.length === 0 && (
                    <div className="dir-empty">
                      <b>No matches</b>Try a different search or filter.
                      <EmptyClearFilters filters={peopleFilters} onClear={clearPeopleFilters} />
                    </div>
                  )}

                  <VirtualRows rows={visiblePeople}
                    renderRow={(p, vp) => (
                    <div key={p.id} className="dir-row" {...vp} style={vp?.style}>
                      <div className="row-main" style={peopleGrid}>
                        {peopleShownCols.map((c) => (
                          <div className="cell" key={c.key}>{personCellFor(p, c.key)}</div>
                        ))}
                        {canChange && (
                          <div className="cell idet-people-actions">
                            <button type="button" className="mini-btn sm"
                                    disabled={peopleBusy}
                                    onClick={() => setEditingPerson(p)}>
                              Edit
                            </button>
                            <button type="button" className="mini-btn sm danger"
                                    disabled={peopleBusy}
                                    onClick={() => {
                                      if (!confirm(
                                        `Remove "${p.person_name}" from this initiative?`)) return;
                                      void runPeople(() => removeInitiativePerson(p.id));
                                    }}>
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )} />
                </div>
              </>
            )}
          {canChange && (
            <div className="init-add">
              <div className="init-field">
                <label>Add person</label>
                <ComboBox
                  placeholder="Type to search people…"
                  value={pendingPerson}
                  disabled={peopleBusy}
                  onChange={setPendingPerson}
                  options={personOptions}
                />
              </div>
              <div className="init-field">
                <label>Work type</label>
                <ComboBox
                  placeholder="Type to search work types…"
                  value={pendingWorkType}
                  clearable
                  disabled={peopleBusy}
                  onChange={setPendingWorkType}
                  options={workTypes.map((w) => ({ value: w.key, label: w.label }))}
                />
              </div>
              <button type="button" className="mini-btn"
                      disabled={peopleBusy || !pendingPerson}
                      onClick={() => void runPeople(async () => {
                        await addInitiativePerson(initiative.id, {
                          person_id: pendingPerson,
                          work_type: pendingWorkType || null,
                        });
                        setPendingPerson('');
                        setPendingWorkType('');
                      })}>
                Add
              </button>
            </div>
          )}
          {peopleError && <span className="pf-error">{peopleError}</span>}
        </div>

        <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
          <p className="eyebrow-sm">Time tracking</p>
          {!timeLoaded ? (
            <p className="page-hint">Loading…</p>
          ) : (
            <>
              <div className="idet-time-stats">
                <div className="idet-time-stat">
                  <span className="idet-time-stat-label">Approved hours</span>
                  <span className="idet-time-stat-value">
                    {formatMinutes(timeSummary?.approved_minutes ?? 0)}
                  </span>
                </div>
                <div className="idet-time-stat">
                  <span className="idet-time-stat-label">Pending hours</span>
                  <span className="idet-time-stat-value">
                    {formatMinutes(timeSummary?.pending_minutes ?? 0)}
                  </span>
                </div>
                <div className="idet-time-stat">
                  <span className="idet-time-stat-label">People</span>
                  <span className="idet-time-stat-value">
                    {timeSummary?.people.length ?? 0}
                  </span>
                </div>
                <div className="idet-time-stat">
                  <span className="idet-time-stat-label">On the clock now</span>
                  <span className="idet-time-stat-value">{timeSummary?.open_count ?? 0}</span>
                </div>
              </div>

              {timeSummary && timeSummary.people.length > 0 ? (
                <div className="mini-list idet-time-list">
                  <div className="mini-list-head idet-time-list-head">
                    <span>Person</span>
                    <span>Approved</span>
                    <span>Pending</span>
                    <span>Entries</span>
                    <span>Last activity</span>
                  </div>
                  {timeSummary.people.map((p) => (
                    <div key={p.person_id} className="mini-row idet-time-row">
                      <span className="cell-top">{p.person_name}</span>
                      <span className="mono">{formatMinutes(p.approved_minutes)}</span>
                      <span className="mono">{formatMinutes(p.pending_minutes)}</span>
                      <span className="mono">{p.entry_count}</span>
                      <span className="mono">{relativeTime(p.last_entry_at)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="page-hint">No time recorded against this initiative yet.</p>
              )}
            </>
          )}
          {can('time') && (
            <div className="detail-actions">
              <Link className="mini-btn" to="/people/time">Time Management →</Link>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <InitiativeEditModal
          initiative={initiative}
          statuses={statuses} types={types} subTypes={subTypes}
          shippingTypes={shippingTypes}
          sites={sites} clients={clients} partners={partners}
          isAdmin={isAdmin} canChange={canChange}
          onClose={() => setEditing(false)}
          onSaved={() => load()}
        />
      )}

      {editingPerson && (
        <PersonEditDialog
          person={editingPerson}
          workTypes={workTypes}
          sites={sites}
          onClose={() => setEditingPerson(null)}
          onSaved={() => load()}
        />
      )}

      {editingAsset && (
        <AssetEditDialog
          asset={editingAsset}
          moveStatuses={moveStatuses}
          onClose={() => setEditingAsset(null)}
          onSaved={async () => {
            if (!id) return;
            const rows = await listInitiativeAssets(id);
            setAssets(rows);
          }}
        />
      )}

      {rackView && (
        <RackViewModal
          rackName={rackView.rackName}
          side={rackView.side}
          rows={assets}
          onClose={() => setRackView(null)}
        />
      )}
    </div>
  );
}

/* ── person edit dialog — small modal reusing InitiativeEditModal's
      overlay/shell classes; the only place work_type/site_worked/rating
      are patched for one person on an initiative. ────────────────── */
function PersonEditDialog({ person, workTypes, sites, onClose, onSaved }: {
  person: InitiativePersonRow;
  workTypes: StatusValue[];
  sites: SiteItem[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [workType, setWorkType] = useState(person.work_type ?? '');
  const [siteWorked, setSiteWorked] = useState(person.site_worked_id ?? '');
  const [rating, setRating] = useState(
    person.rating != null ? String(person.rating) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await updateInitiativePerson(person.id, {
        work_type: workType || null,
        site_worked_id: siteWorked || null,
        rating: rating.trim() === '' ? null : Number(rating),
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError
        ? (INITIATIVE_ERRORS[err.code] ?? 'Could not save — try again.')
        : 'Network error.');
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
          <h3>Edit — {person.person_name}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}
                  disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.2" strokeLinecap="round">
              <path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="pf-form">
              <div><label>Work type</label>
                <ComboBox
                  placeholder="Type to search work types…"
                  value={workType}
                  clearable
                  disabled={saving}
                  onChange={setWorkType}
                  options={workTypes.map((w) => ({ value: w.key, label: w.label }))}
                /></div>
              <div><label>Site worked</label>
                <ComboBox
                  placeholder="Type to search sites…"
                  value={siteWorked}
                  clearable
                  disabled={saving}
                  onChange={setSiteWorked}
                  options={sites.map((s) => ({ value: s.id, label: s.name }))}
                /></div>
              <div><label>Rating (1–5)</label>
                <input type="number" min={1} max={5} value={rating}
                       disabled={saving}
                       onChange={(e) => setRating(e.target.value)} /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose}
                    disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

/** Roster expansion: Move Details / Scan History tabs + page links.
 *  Remounts per open, so the tab resets to Move Details each expand. */
function MoveAssetExpansion({ row, initiativeId, canViewScans }: {
  row: InitiativeAssetRow; initiativeId: string; canViewScans: boolean;
}) {
  const [view, setView] = useState<'move' | 'scans'>('move');
  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');
  const chip = (label: string | null | undefined, color: string | null | undefined) =>
    label && color
      ? (
        <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
          <span className="dot" />{label}
        </span>
      )
      : null;
  return (
    <div>
      <div className="idet-expand-bar">
        <div className="sysconf-tabbar" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'move'}
                  className={`sysconf-tab${view === 'move' ? ' active' : ''}`}
                  onClick={() => setView('move')}>
            Move Details
          </button>
          {canViewScans && (
            <button type="button" role="tab" aria-selected={view === 'scans'}
                    className={`sysconf-tab${view === 'scans' ? ' active' : ''}`}
                    onClick={() => setView('scans')}>
              Scan History
            </button>
          )}
        </div>
        <div className="idet-expand-links">
          <Link className="mini-btn"
                to={`/initiatives/${initiativeId}/assets/${row.id}`}>
            Full Details ↗
          </Link>
          <Link className="mini-btn" to={`/assets/${row.asset_id}`}>
            Parent Asset ↗
          </Link>
        </div>
      </div>
      {view === 'move' ? (
        <div className="detail-grid">
          <div className="detail-block">
            <p className="eyebrow-sm">Placement</p>
            <dl className="kv">
              <dt>Source rack</dt><dd>{row.source_rack ?? '—'}</dd>
              <dt>Source RU</dt><dd>{row.source_ru ?? '—'}</dd>
              <dt>Source position</dt><dd>{row.source_position ?? '—'}</dd>
              <dt>Source verified</dt><dd>{yesNo(row.source_verified)}</dd>
              <dt>Destination rack</dt><dd>{row.destination_rack ?? '—'}</dd>
              <dt>Destination RU</dt><dd>{row.destination_ru ?? '—'}</dd>
              <dt>Destination position</dt><dd>{row.destination_position ?? '—'}</dd>
              <dt>Destination verified</dt><dd>{yesNo(row.destination_verified)}</dd>
            </dl>
          </div>
          <div className="detail-block">
            <p className="eyebrow-sm">Logistics</p>
            <dl className="kv">
              <dt>Wave</dt><dd>{row.priority_wave ?? '—'}</dd>
              <dt>Disposition</dt><dd>{row.disposition ?? '—'}</dd>
              <dt>Owner</dt><dd>{row.owner ?? '—'}</dd>
              <dt>Cable info</dt><dd>{row.cable_info ?? '—'}</dd>
              <dt>Vendor involved</dt><dd>{yesNo(row.vendor_involved)}</dd>
            </dl>
          </div>
          <div className="detail-block">
            <p className="eyebrow-sm">Status</p>
            <dl className="kv">
              <dt>Move status</dt>
              <dd>{chip(row.status_label, row.status_color)
                ?? row.status_label}</dd>
              <dt>Asset status</dt>
              <dd>{chip(row.asset.status_label, row.asset.status_color)
                ?? row.asset.status_label}</dd>
              <dt>Added</dt><dd>{new Date(row.created_at).toLocaleDateString()}</dd>
              <dt>Updated</dt><dd>{new Date(row.updated_at).toLocaleDateString()}</dd>
            </dl>
          </div>
        </div>
      ) : (
        <ScanHistoryTable assetId={row.asset_id} limit={15} capHint={15} />
      )}
    </div>
  );
}

/* ── move asset status donut — Overview card, Move initiatives with assets
      only (Task: donut-task-1). Pure SVG, no chart libraries; geometry
      constants and the annular-sector path builder live here since they're
      presentational, not testable-pure-function material like
      `moveAssetStatusBreakdown` (lib/initiatives.ts) which supplies the
      ordered entries this component just draws. Hover/tooltip follows
      RackViewModal's pattern: a real HTML tooltip positioned off the
      hovered element's bounding rect within a `position: relative`
      container, not a CSS-only or native-title-only tooltip (though every
      segment also carries an SVG <title> as a non-JS fallback). ────────── */
const DONUT_CX = 98;
const DONUT_CY = 98;
const DONUT_OUTER_R = 92;
const DONUT_RING_THICKNESS = 28;
const DONUT_INNER_R = DONUT_OUTER_R - DONUT_RING_THICKNESS;

function polarToPoint(angleDeg: number, r: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: DONUT_CX + r * Math.cos(rad), y: DONUT_CY + r * Math.sin(rad) };
}

/** One annular-sector "d" path from startAngle to endAngle (degrees,
 *  clockwise from 12 o'clock). Never called with a span at/near 360° —
 *  callers split a full ring into two 180° halves first (see
 *  `donutSegments` below), since a start==end angle produces a
 *  degenerate/broken path for a naive single-arc computation. */
function donutSectorPath(startAngle: number, endAngle: number): string {
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  const outerStart = polarToPoint(startAngle, DONUT_OUTER_R);
  const outerEnd = polarToPoint(endAngle, DONUT_OUTER_R);
  const innerEnd = polarToPoint(endAngle, DONUT_INNER_R);
  const innerStart = polarToPoint(startAngle, DONUT_INNER_R);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${DONUT_OUTER_R} ${DONUT_OUTER_R} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${DONUT_INNER_R} ${DONUT_INNER_R} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ');
}

interface DonutBreakdownEntry {
  key: string; label: string; color: string; count: number; pct: number;
}
interface DonutSegment { key: string; color: string; d: string; }

/** Walks the breakdown in order, turning each entry's pct into an angular
 *  span. A single-entry breakdown always covers 100% (every counted row
 *  falls under the one entry) — rendered as two 180° halves sharing that
 *  entry's key/color rather than one 0→360° sector, per the full-ring
 *  workaround called out in the task spec. */
function donutSegments(entries: DonutBreakdownEntry[]): DonutSegment[] {
  if (entries.length === 1) {
    const { key, color } = entries[0];
    return [
      { key, color, d: donutSectorPath(0, 180) },
      { key, color, d: donutSectorPath(180, 360) },
    ];
  }
  const segments: DonutSegment[] = [];
  let cursor = 0;
  for (const entry of entries) {
    const span = (entry.pct / 100) * 360;
    segments.push({ key: entry.key, color: entry.color, d: donutSectorPath(cursor, cursor + span) });
    cursor += span;
  }
  return segments;
}

function donutTooltipText(entry: DonutBreakdownEntry): string {
  return `${entry.label} — ${entry.count} (${Math.round(entry.pct)}%)`;
}

function AssetStatusDonut({ rows, statuses }: {
  rows: InitiativeAssetRow[];
  statuses: StatusValue[];
}) {
  const entries = useMemo(() => moveAssetStatusBreakdown(rows, statuses), [rows, statuses]);
  const segments = useMemo(() => donutSegments(entries), [entries]);
  const entryByKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const total = rows.length;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  if (entries.length === 0) return null;

  const handleHover = (key: string, e: ReactMouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const targetRect = e.currentTarget.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setHoverKey(key);
    setTooltipPos({
      x: targetRect.left - containerRect.left + targetRect.width / 2,
      y: targetRect.top - containerRect.top,
    });
  };
  const handleLeave = () => { setHoverKey(null); setTooltipPos(null); };

  const hoveredEntry = hoverKey ? entryByKey.get(hoverKey) : undefined;

  return (
    <div className="idet-donut-panel" ref={containerRef} onMouseLeave={handleLeave}>
      <svg className="idet-donut" viewBox="0 0 196 196" role="img"
           aria-label={`Asset status breakdown — ${total} assets`}>
        {segments.map((seg, i) => (
          <path key={`${seg.key}-${i}`} d={seg.d} fill={seg.color}
                className="idet-donut-seg"
                style={{ opacity: hoverKey && hoverKey !== seg.key ? 0.45 : 1 }}
                onMouseEnter={(e) => handleHover(seg.key, e)}>
            <title>{donutTooltipText(entryByKey.get(seg.key)!)}</title>
          </path>
        ))}
        <text x={DONUT_CX} y={DONUT_CY - 7} textAnchor="middle" dominantBaseline="middle"
              className="idet-donut-total">
          {total}
        </text>
        <text x={DONUT_CX} y={DONUT_CY + 23} textAnchor="middle" dominantBaseline="middle"
              className="idet-donut-caption">
          assets
        </text>
      </svg>
      <ul className="idet-donut-legend">
        {entries.map((entry) => (
          <li key={entry.key} className="idet-donut-legend-row mini-row compact"
              style={{ opacity: hoverKey && hoverKey !== entry.key ? 0.45 : 1 }}
              onMouseEnter={(e) => handleHover(entry.key, e)}>
            <span className="idet-donut-swatch" style={{ background: entry.color }}
                  aria-hidden="true" />
            <span className="idet-donut-legend-label cell-top" title={entry.label}>{entry.label}</span>
            <span className="idet-donut-legend-count mono">{entry.count}</span>
          </li>
        ))}
      </ul>
      {hoveredEntry && tooltipPos && (
        <div className="idet-donut-tooltip" style={{ left: tooltipPos.x, top: tooltipPos.y }}>
          {donutTooltipText(hoveredEntry)}
        </div>
      )}
    </div>
  );
}
