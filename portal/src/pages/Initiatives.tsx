/**
 * Initiatives — unified projects / events / moves: one list, a type
 * chip, conditional move columns, people + links + notes in the row
 * detail. Directory pattern cloned from Containers.tsx; all field
 * mutation lands in InitiativeEditModal.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ComboBox from '../components/ComboBox';
import GodDeleteButton from '../components/GodDeleteButton';
import InitiativeEditModal from '../components/initiatives/InitiativeEditModal';
import InlineTextField from '../components/InlineTextField';
import NotesFilesPanel from '../components/NotesFilesPanel';
import {
  ApiError,
  addInitiativeLink,
  addInitiativePerson,
  getInitiative,
  listClients,
  listInitiatives,
  listInitiativeStatuses,
  listInitiativeSubTypes,
  listInitiativeTypes,
  listInitiativeWorkTypes,
  listPartners,
  listShippingTypes,
  listSites,
  listWorkerOptions,
  removeInitiativeLink,
  removeInitiativePerson,
  updateInitiative,
  updateInitiativeLink,
  type InitiativeDetail,
  type InitiativeItem,
  type OrgRef,
  type SiteItem,
  type StatusValue,
  type WorkerOption,
} from '../lib/api';
import {
  INITIATIVE_ERRORS, INITIATIVE_GOD_FIELDS, initiativeCellText,
  initiativeSearchText,
} from '../lib/initiatives';
import { ADMIN_RANK } from '../lib/access';
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
  ColumnsButton, ExportButton, exportCsv, moveKey, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import StatusHover from '../components/StatusHover';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/assets.css';

const COLUMNS: ColumnDef[] = [
  { key: 'type', label: 'Type', width: '0.9fr', default: true },
  { key: 'sub_type', label: 'Sub-type', width: '1fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'client', label: 'Client', width: '1.2fr', default: true },
  { key: 'site', label: 'Site', width: '1.2fr', default: true },
  { key: 'start', label: 'Start', width: '0.9fr', default: true },
  { key: 'end', label: 'End', width: '0.9fr', default: false },
  { key: 'location', label: 'Location', width: '1.2fr', default: false },
  { key: 'origin', label: 'Origin', width: '1.2fr', default: false },
  { key: 'destination', label: 'Destination', width: '1.2fr', default: false },
  { key: 'shipping', label: 'Shipping', width: '1fr', default: false },
  { key: 'people', label: 'People', width: '0.6fr', default: false },
  { key: 'links', label: 'Links', width: '0.6fr', default: false },
  { key: 'created', label: 'Created', width: '0.9fr', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(
  [...COLUMNS.map((c) => c.key), 'primary', 'archived']);
const DEFAULT_VISIBLE = new Set<string>(
  COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(i: InitiativeItem, key: string): string {
  switch (key) {
    case 'primary': return i.name.toLowerCase();
    case 'type': return i.type_label.toLowerCase();
    case 'sub_type': return (i.sub_type_label ?? '').toLowerCase();
    case 'status': return i.status_label.toLowerCase();
    case 'client': return (i.client_name ?? '').toLowerCase();
    case 'site': return (i.site_name ?? '').toLowerCase();
    case 'start': return i.scheduled_start ?? '';
    case 'end': return i.scheduled_end ?? '';
    case 'location': return (i.location ?? '').toLowerCase();
    case 'origin': return (i.origin_site_name ?? '').toLowerCase();
    case 'destination': return (i.destination_site_name ?? '').toLowerCase();
    case 'shipping': return i.shipping_types.join(',');
    case 'people': return String(i.people_count).padStart(6, '0');
    case 'links': return String(i.links_count).padStart(6, '0');
    case 'created': return i.created_at;
    case 'archived': return i.archived_at ? '1' : '0';
    default: return '';
  }
}

const csvColumnsFor = (
  shippingLabels: Record<string, string>,
): [string, (i: InitiativeItem) => string][] => [
  ['ID', (i) => i.id],
  ['Name', (i) => i.name],
  ['Type', (i) => i.type_label],
  ['Sub-type', (i) => i.sub_type_label ?? ''],
  ['Status', (i) => i.status_label],
  ['Client', (i) => i.client_name ?? ''],
  ['Site', (i) => i.site_name ?? ''],
  ['Location', (i) => i.location ?? ''],
  ['Scheduled start', (i) => i.scheduled_start ?? ''],
  ['Scheduled end', (i) => i.scheduled_end ?? ''],
  ['Origin', (i) => i.origin_site_name ?? ''],
  ['Destination', (i) => i.destination_site_name ?? ''],
  ['Shipping',
   (i) => i.shipping_types.map((k) => shippingLabels[k] ?? k).join('; ')],
  ['People', (i) => String(i.people_count)],
  ['Links', (i) => String(i.links_count)],
  ['Created', (i) => i.created_at],
];

const TYPE_PILLS = [
  { key: 'all', label: 'All' },
  { key: 'project', label: 'Projects' },
  { key: 'event', label: 'Events' },
  { key: 'move', label: 'Moves' },
];

export default function Initiatives() {
  const { can, godMode, maxRank } = useAuth();
  const canAdd = can('initiatives', 'add');
  const canChange = can('initiatives', 'change');
  const canViewSites = can('sites', 'view');
  const canViewClients = can('clients', 'view');
  const canViewPartners = can('partners', 'view');
  const canViewWorkers = can('workers', 'view');
  const isAdmin = maxRank >= ADMIN_RANK;
  const god = useGodEdit();
  const pd = usePendingDeletes(godMode);

  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [types, setTypes] = useState<StatusValue[]>([]);
  const [subTypes, setSubTypes] = useState<StatusValue[]>([]);
  const [workTypes, setWorkTypes] = useState<StatusValue[]>([]);
  const [shippingTypes, setShippingTypes] = useState<StatusValue[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [partners, setPartners] = useState<OrgRef[]>([]);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [typePill, setTypePill] = useState('all');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const deepLinkTarget = useRef<string | null>(initialOpenId());
  const focusOpenId = (id: string | null) => {
    deepLinkTarget.current = id;
    clearedDeepLink.current = null;
    setOpenId(id);
  };
  useRecordFocus(initiatives, (i) => i.id, (i) => i.name, focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'initiatives', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 },
    ALL_COLUMN_KEYS,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      setInitiatives(await listInitiatives());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view initiatives.'
        : 'Failed to load initiatives.');
    }
  };

  useEffect(() => {
    void load();
    void listInitiativeStatuses().then(setStatuses).catch(() => {});
    void listInitiativeTypes().then(setTypes).catch(() => {});
    void listInitiativeSubTypes().then(setSubTypes).catch(() => {});
    void listInitiativeWorkTypes().then(setWorkTypes).catch(() => {});
    void listShippingTypes().then(setShippingTypes).catch(() => {});
    if (canViewSites) void listSites().then(setSites).catch(() => {});
    if (canViewClients) void listClients().then(setClients).catch(() => {});
    if (canViewPartners) void listPartners().then(setPartners).catch(() => {});
    if (canViewWorkers) void listWorkerOptions().then(setWorkers).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const godFields = useMemo(() => INITIATIVE_GOD_FIELDS({
    clients: () => (canViewClients
      ? clients.map((c) => ({ value: c.id, label: c.name })) : []),
    sites: () => (canViewSites
      ? sites.map((s) => ({ value: s.id, label: s.name })) : []),
    statuses: () => statuses.map((s) => ({ value: s.key, label: s.label })),
    types: () => (isAdmin
      ? types.map((t) => ({ value: t.key, label: t.label })) : []),
    subTypes: () => subTypes.map((t) => ({ value: t.key, label: t.label })),
  }), [clients, sites, statuses, types, subTypes, canViewClients,
       canViewSites, isAdmin]);
  const godFieldFor = (column: string) =>
    godFields.find((f) => f.column === column);
  const replaceRow = (u: InitiativeItem) =>
    setInitiatives((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const shippingLabels = useMemo(
    () => Object.fromEntries(shippingTypes.map((s) => [s.key, s.label])),
    [shippingTypes]);
  const cellText = useMemo(
    () => (i: InitiativeItem, colKey: string) =>
      initiativeCellText(i, colKey, shippingLabels),
    [shippingLabels]);

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = { all: initiatives?.length ?? 0 };
    for (const pl of TYPE_PILLS.slice(1)) c[pl.key] = 0;
    for (const i of initiatives ?? []) {
      c[i.initiative_type] = (c[i.initiative_type] ?? 0) + 1;
    }
    return c;
  }, [initiatives]);

  const haystack = useSearchHaystacks(initiatives, initiativeSearchText);

  const visible = useMemo(() => {
    if (!initiatives) return [];
    const q = query.trim().toLowerCase();
    const showArchived = filters.archived?.values?.includes('Yes') ?? false;
    const rows = initiatives.filter((i) => {
      if (!showArchived && i.archived_at) return false;
      if (typePill !== 'all' && i.initiative_type !== typePill) return false;
      if (!passesColumnFilters(i, filters, cellText)) return false;
      if (!q) return true;
      return haystack(i).includes(q);
    });
    return rows.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [initiatives, filters, query, sortKey, sortDir, typePill, haystack, cellText]);

  // Deep-link vs persisted-filter interplay — cloned from Containers.tsx.
  useEffect(() => {
    if (!initiatives || !openId || visible.some((i) => i.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = initiatives.find((i) => i.id === openId);
      if (target) {
        // a deep link must win over whatever view state hides its row
        if (typePill !== 'all' && target.initiative_type !== typePill) {
          setTypePill('all');
          return;
        }
        if (!passesColumnFilters(target, filters, cellText)) {
          clearFilters();
          return;
        }
      }
    }
    setOpenId(null);
  }, [initiatives, visible, openId, filters, clearFilters, typePill, cellText]);

  useEffect(() => {
    if (deepLinkTarget.current
        && visible.some((i) => i.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  const caret = (key: string) =>
    sortKey === key
      ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns:
    `2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const chip = (label: string | null, color: string | null) =>
    label && color
      ? (
        <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
          <span className="dot" />{label}
        </span>
      )
      : <span className="cell-top">—</span>;

  const cellFor = (i: InitiativeItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={i} gf={gf} patch={updateInitiative} onRowSaved={replaceRow}
                   errorMap={INITIATIVE_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'type': return chip(i.type_label, i.type_color);
      case 'sub_type': return chip(i.sub_type_label, i.sub_type_color);
      case 'status':
        return (
          <div className="chips">
            <StatusHover entityType="initiative" entityId={i.id} status={i.status}>
              {chip(i.status_label, i.status_color)}
            </StatusHover>
            {i.archived_at && <span className="chip tag">Archived</span>}
            {pd.pendingIds.has(i.id) && <span className="chip tag">Pending delete</span>}
          </div>
        );
      case 'client': return <span className="cell-top">{i.client_name ?? '—'}</span>;
      case 'site': return <span className="cell-top">{i.site_name ?? '—'}</span>;
      case 'location': return <span className="cell-top">{i.location || '—'}</span>;
      case 'start':
        return <span className="mono">{cellText(i, 'start')}</span>;
      case 'end':
        return <span className="mono">{cellText(i, 'end')}</span>;
      case 'origin':
        return <span className="cell-top">{i.origin_site_name ?? '—'}</span>;
      case 'destination':
        return <span className="cell-top">{i.destination_site_name ?? '—'}</span>;
      case 'shipping':
        return <span className="cell-top">{cellText(i, 'shipping')}</span>;
      case 'people': return <span className="mono">{i.people_count}</span>;
      case 'links': return <span className="mono">{i.links_count}</span>;
      case 'created':
        return <span className="mono">{cellText(i, 'created')}</span>;
      default: return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Initiatives</div>
          <h1 className="page-title">
            Initiatives
            <span className="badge-count">{initiatives?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Projects, events, and moves — one list, discriminated by type.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist">
          {TYPE_PILLS.map((pl) => (
            <button key={pl.key} className={typePill === pl.key ? 'on' : ''}
                    onClick={() => setTypePill(pl.key)}>
              {pl.label} <span className="n">{typeCounts[pl.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">
            {visible.length} of {initiatives?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols}
                         onChange={setVisibleCols} godMode={godMode}
                         onReorder={setColOrder} />
          <ExportButton onExport={() =>
            exportCsv('initiatives', csvColumnsFor(shippingLabels), visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle}
                         visible={godMode && canChange} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New initiative
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load initiatives</b>{error}</div>
      )}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('primary')}>
                Name {caret('primary')}
              </button>
              <ColumnMenu colKey="primary" label="Name"
                          allRows={initiatives ?? []} filters={filters}
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
                            allRows={initiatives ?? []} filters={filters}
                            text={cellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <ColumnMenu colKey="archived" label="Archived"
                        allRows={initiatives ?? []} filters={filters}
                        text={cellText}
                        filter={filters.archived} onFilter={setFilter}
                        sortDir={sortKey === 'archived' ? sortDir : null}
                        onSort={(dir) => setSort('archived', dir)} />
          </div>

          {initiatives && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add an initiative.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows rows={visible}
            renderRow={(i, vp) => {
            const open = openId === i.id;
            return (
              <div key={i.id}
                   className={`dir-row ${open ? 'open' : ''} ${i.archived_at ? 'archived' : ''}`}
                   {...vp} style={vp?.style}>
                <div className="row-main" style={grid}
                     onClick={() => {
                       deepLinkTarget.current = null;
                       setOpenId(open ? null : i.id);
                     }}>
                  <div className="cell cell-primary">
                    {god.editing && godFieldFor('primary') ? (
                      <div className="pn god-primary-edit">
                        <GodCell row={i} gf={godFieldFor('primary')!}
                                 patch={updateInitiative} onRowSaved={replaceRow}
                                 errorMap={INITIATIVE_ERRORS}
                                 disabled={!canChange} />
                      </div>
                    ) : (
                      <div className="pn"><b>{i.name}</b>
                        <span>{i.type_label}</span></div>
                    )}
                  </div>
                  {shownCols.map((col) => (
                    <div className="cell" key={col.key}>{cellFor(i, col.key)}</div>
                  ))}
                  <div className="cell chevron-cell">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round"
                         strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                  </div>
                </div>

                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <InitiativeRowDetail
                          initiative={i}
                          canEdit={canChange}
                          workTypes={workTypes}
                          workers={workers}
                          shippingLabels={shippingLabels}
                          allInitiatives={initiatives ?? []}
                          onEdit={() => setEditingId(i.id)}
                          onChanged={() => void load()}
                          onNavigate={(id) => focusOpenId(id)}
                          godVisible={godMode}
                          pending={pd.pendingIds.has(i.id)}
                          onMark={() => pd.mark('initiative', i.id, i.name)}
                          onUnmark={() => pd.unmark(i.id)}
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
        <InitiativeEditModal
          initiative={initiatives?.find((i) => i.id === editingId) ?? null}
          statuses={statuses} types={types} subTypes={subTypes}
          shippingTypes={shippingTypes}
          sites={sites} clients={clients} partners={partners}
          isAdmin={isAdmin} canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => load()}
        />
      )}
      {creating && (
        <InitiativeEditModal
          initiative={null}
          statuses={statuses} types={types} subTypes={subTypes}
          shippingTypes={shippingTypes}
          sites={sites} clients={clients} partners={partners}
          isAdmin={isAdmin} canChange={canChange}
          onClose={() => setCreating(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

/* ── row detail: people, links, notes — association mutations live
      here (the modal owns field edits). ─────────────────────────── */

function InitiativeRowDetail({
  initiative, canEdit, workTypes, workers, allInitiatives, shippingLabels,
  onEdit, onChanged, onNavigate, godVisible, pending, onMark, onUnmark,
}: {
  initiative: InitiativeItem;
  canEdit: boolean;
  workTypes: StatusValue[];
  workers: WorkerOption[];
  allInitiatives: InitiativeItem[];
  shippingLabels: Record<string, string>;
  onEdit: () => void;
  onChanged: () => void;
  onNavigate: (id: string) => void;
  godVisible: boolean;
  pending: boolean;
  onMark: () => Promise<void>;
  onUnmark: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<InitiativeDetail | null>(null);
  const [pendingPerson, setPendingPerson] = useState('');
  const [pendingWorkType, setPendingWorkType] = useState('');
  const [pendingChild, setPendingChild] = useState('');
  const [pendingRole, setPendingRole] = useState('');
  const [panelError, setPanelError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDetail = () => {
    void getInitiative(initiative.id).then(setDetail).catch(() => {});
  };
  useEffect(loadDetail, [initiative.id]);

  const run = async (op: () => Promise<unknown>) => {
    setBusy(true);
    setPanelError('');
    try {
      await op();
      loadDetail();
      onChanged();
    } catch (err) {
      setPanelError(err instanceof ApiError
        ? (INITIATIVE_ERRORS[err.code] ?? 'Could not save — try again.')
        : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const onPeople = new Set((detail?.people ?? []).map((p) => p.person_id));
  const personOptions = workers
    .filter((w) => !onPeople.has(w.person_id))
    .map((w) => ({ value: w.person_id, label: w.display_name }));
  const linked = new Set([
    initiative.id,
    ...(detail?.links_children ?? []).map((l) => l.other_id),
    ...(detail?.links_parents ?? []).map((l) => l.other_id),
  ]);
  const childOptions = allInitiatives
    .filter((i) => !linked.has(i.id) && !i.archived_at)
    .map((i) => ({ value: i.id, label: i.name, sub: i.type_label }));

  const kv = (label: string, value: string | null | undefined) => (
    <><dt>{label}</dt><dd>{value || '—'}</dd></>
  );

  const typeChip = (label: string, color: string) => (
    <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  );

  return (
    <div className="detail-grid">
      <div className="init-panel"
           style={initiative.initiative_type !== 'move'
             ? { gridColumn: '1 / -1' } : undefined}>
        <p className="eyebrow-sm">Overview</p>
        <dl className="kv">
          {kv('Type', initiative.type_label)}
          {kv('Sub-type', initiative.sub_type_label)}
          {kv('Client', initiative.client_name)}
          {initiative.initiative_type !== 'move'
            && kv('Site', initiative.site_name)}
          {kv('Location', initiative.location)}
          {kv('Scheduled', [initiativeCellText(initiative, 'start'),
                            initiativeCellText(initiative, 'end')]
            .filter((s) => s !== '—').join(' → ') || '—')}
          {initiative.initiative_type === 'project'
            && kv('Sky Command ID', initiative.sky_command_project_id)}
        </dl>
      </div>
      {initiative.initiative_type === 'move' && (
        <div className="init-panel">
          <p className="eyebrow-sm">Move</p>
          <dl className="kv">
            {kv('Origin', initiative.origin_site_name)}
            {kv('Destination', initiative.destination_site_name)}
            {kv('Shipping', initiative.shipping_types
              .map((k) => shippingLabels[k] ?? k).join(', '))}
            {kv('Shipping partner', initiative.shipping_partner_name)}
            {kv('Priority devices',
                initiative.priority_devices == null ? null
                  : initiative.priority_devices ? 'Yes' : 'No')}
          </dl>
        </div>
      )}

      <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
        <p className="eyebrow-sm">Linked initiatives</p>
        {detail === null && <p className="page-hint">Loading…</p>}
        {detail && detail.links_children.length === 0
          && detail.links_parents.length === 0
          && <p className="page-hint">No linked initiatives.</p>}
        {detail && (detail.links_children.length > 0
          || detail.links_parents.length > 0) && (
          <div className="mini-list init-rows">
            {detail.links_children.map((l) => (
              <div key={l.id} className="mini-row flex init-row">
                <span className="init-tag mono">Contains</span>
                <button type="button" className="init-name-btn cell-top"
                        onClick={() => onNavigate(l.other_id)}>
                  {l.other_name}
                </button>
                {typeChip(l.other_type_label, l.other_type_color)}
                {canEdit ? (
                  <InlineTextField value={l.role} placeholder="Role…"
                                   maxWidth={140} disabled={busy}
                                   onCommit={(v) => void run(
                                     () => updateInitiativeLink(
                                       l.id, { role: v }))} />
                ) : (
                  l.role && <span className="cell-sub">{l.role}</span>
                )}
                {canEdit && (
                  <button type="button" className="mini-btn sm danger spacer"
                          disabled={busy}
                          onClick={() => void run(
                            () => removeInitiativeLink(l.id))}>
                    Unlink
                  </button>
                )}
              </div>
            ))}
            {detail.links_parents.map((l) => (
              <div key={l.id} className="mini-row flex init-row">
                <span className="init-tag mono">Part of</span>
                <button type="button" className="init-name-btn cell-top"
                        onClick={() => onNavigate(l.other_id)}>
                  {l.other_name}
                </button>
                {typeChip(l.other_type_label, l.other_type_color)}
              </div>
            ))}
          </div>
        )}
        {canEdit && (
          <div className="init-add">
            <div className="init-field">
              <label>Link an initiative (as child)</label>
              <ComboBox
                placeholder="Type to search initiatives…"
                value={pendingChild}
                disabled={busy}
                onChange={setPendingChild}
                options={childOptions}
              />
            </div>
            <div className="init-field">
              <label>Role</label>
              <input type="text" className="org-select" value={pendingRole}
                     disabled={busy} placeholder="e.g. Phase 1"
                     onChange={(e) => setPendingRole(e.target.value)} />
            </div>
            <button type="button" className="mini-btn"
                    disabled={busy || !pendingChild}
                    onClick={() => void run(async () => {
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
        {panelError && <span className="pf-error">{panelError}</span>}
      </div>

      <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
        <NotesFilesPanel entityType="initiative" entityId={initiative.id}
                         canWrite={canEdit} />
      </div>

      <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
        <p className="eyebrow-sm">People{detail ? ` — ${detail.people.length}` : ''}</p>
        {detail === null && <p className="page-hint">Loading…</p>}
        {detail?.people.length === 0
          && <p className="page-hint">No one assigned yet.</p>}
        {detail && detail.people.length > 0 && (
          <div className="mini-list init-rows">
            {detail.people.map((p) => (
              <div key={p.id} className="mini-row flex init-row">
                <span className="cell-top">{p.person_name}</span>
                {p.work_type_label && p.work_type_color
                  && typeChip(p.work_type_label, p.work_type_color)}
                {p.rating != null
                  && <span className="cell-sub">★ {p.rating}</span>}
                {canEdit && (
                  <button type="button" className="mini-btn sm danger spacer"
                          disabled={busy}
                          onClick={() => void run(
                            () => removeInitiativePerson(p.id))}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {canEdit && (
          <div className="init-add">
            <div className="init-field">
              <label>Add person</label>
              <ComboBox
                placeholder="Type to search people…"
                value={pendingPerson}
                disabled={busy}
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
                disabled={busy}
                onChange={setPendingWorkType}
                options={workTypes.map((w) => ({ value: w.key, label: w.label }))}
              />
            </div>
            <button type="button" className="mini-btn"
                    disabled={busy || !pendingPerson}
                    onClick={() => void run(async () => {
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
      </div>

      <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
        <button className="btn-ghost"
                onClick={() => navigate(`/initiatives/${initiative.id}`)}>
          Full details
        </button>
        {canEdit && (
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        )}
        <GodDeleteButton visible={godVisible} entityType="initiative" entityId={initiative.id}
                         label={initiative.name} pending={pending}
                         onChange={pending ? onUnmark : onMark} />
      </div>
    </div>
  );
}
