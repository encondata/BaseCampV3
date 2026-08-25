/**
 * InitiativeDetail — the Full Details page for one initiative
 * (/initiatives/:id), in the spirit of BaseCampV2's ProjectDetail/
 * MoveDetail: header with every top-level field, then section cards.
 * Field edits still route through InitiativeEditModal — this page only
 * owns its own data load plus the sections below the header (People,
 * Linked initiatives, Notes & Attachments follow the same run()/refetch
 * pattern as InitiativeRowDetail in Initiatives.tsx).
 */

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ComboBox from '../components/ComboBox';
import InitiativeEditModal from '../components/initiatives/InitiativeEditModal';
import NotesFilesPanel from '../components/NotesFilesPanel';
import {
  ApiError,
  addInitiativeLink,
  addInitiativePerson,
  getInitiative,
  listClients,
  listInitiativeStatuses,
  listInitiativeSubTypes,
  listInitiativeTypes,
  listInitiativeWorkTypes,
  listInitiatives,
  listPartners,
  listShippingTypes,
  listSites,
  listWorkerOptions,
  removeInitiativeLink,
  removeInitiativePerson,
  updateInitiativePerson,
  type InitiativeDetail as InitiativeDetailOut,
  type InitiativeItem,
  type InitiativePersonRow,
  type OrgRef,
  type SiteItem,
  type StatusValue,
  type WorkerOption,
} from '../lib/api';
import { ADMIN_RANK } from '../lib/access';
import { INITIATIVE_ERRORS, initiativeCellText } from '../lib/initiatives';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import {
  applyColumnOrder,
  ColumnsButton, moveKey, useReorderDrag, visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import { naturalCompare } from '../lib/sites';
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
  const { can, maxRank } = useAuth();
  const canChange = can('initiatives', 'change');
  const canViewSites = can('sites', 'view');
  const canViewClients = can('clients', 'view');
  const canViewPartners = can('partners', 'view');
  const canViewWorkers = can('workers', 'view');
  const isAdmin = maxRank >= ADMIN_RANK;

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
  const visiblePeople = useMemo(() => {
    const rows = initiative?.people ?? [];
    const q = peopleQuery.trim().toLowerCase();
    const filtered = rows.filter((p) => {
      if (!passesColumnFilters(p, peopleFilters, personCellText)) return false;
      if (!q) return true;
      return PEOPLE_COLUMNS.some(
        (c) => personCellText(p, c.key).toLowerCase().includes(q));
    });
    return filtered.sort((a, b) => (peopleSortKey === 'rating'
      ? (personRatingValue(a) - personRatingValue(b)) * peopleSortDir
      : naturalCompare(personCellText(a, peopleSortKey), personCellText(b, peopleSortKey))
        * peopleSortDir));
  }, [initiative, peopleFilters, peopleQuery, peopleSortKey, peopleSortDir]);

  // Linked initiatives section
  const [pendingChild, setPendingChild] = useState('');
  const [linksBusy, setLinksBusy] = useState(false);
  const [linksError, setLinksError] = useState('');

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
            {chip(initiative.status_label, initiative.status_color)}
            {initiative.archived_at && <span className="chip tag">Archived</span>}
          </div>
          {initiative.description && (
            <p className="page-hint idet-desc">{initiative.description}</p>
          )}
        </div>
        {canChange && (
          <button className="btn-solid" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

      <div className="detail-grid idet-grid">
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

        {isMove && (
          <div className="init-panel">
            <p className="eyebrow-sm">Move</p>
            <dl className="kv">
              {kv('Origin → Destination', [initiative.origin_site_name,
                                           initiative.destination_site_name]
                .filter(Boolean).join(' → ') || '—')}
              {kv('Shipping types', initiative.shipping_types.join(', '))}
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
          <p className="eyebrow-sm">Assets</p>
          <p className="page-hint">Asset tracking lands here next.</p>
        </div>

        <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
          <p className="eyebrow-sm">People — {initiative.people.length}</p>
          {initiative.people.length === 0
            ? <p className="page-hint">No one assigned yet.</p>
            : (
              <>
                <div className="dir-toolbar idet-people-toolbar">
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

                  {visiblePeople.map((p) => (
                    <div key={p.id} className="dir-row">
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
                                    onClick={() => void runPeople(
                                      () => removeInitiativePerson(p.id))}>
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
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
          <p className="eyebrow-sm">Linked initiatives</p>
          {initiative.links_children.length === 0
            && initiative.links_parents.length === 0
            ? <p className="page-hint">No linked initiatives.</p>
            : (
              <div className="init-rows">
                {initiative.links_children.map((l) => (
                  <div key={l.id} className="init-row">
                    <span className="init-tag">Contains</span>
                    <button type="button" className="init-name-btn"
                            onClick={() => navigate(`/initiatives/${l.other_id}`)}>
                      {l.other_name}
                    </button>
                    {chip(l.other_type_label, l.other_type_color)}
                    {l.role && <span className="init-sub">{l.role}</span>}
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
                  <div key={l.id} className="init-row">
                    <span className="init-tag">Part of</span>
                    <button type="button" className="init-name-btn"
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
              <button type="button" className="mini-btn"
                      disabled={linksBusy || !pendingChild}
                      onClick={() => void runLinks(async () => {
                        await addInitiativeLink(initiative.id,
                                                { child_id: pendingChild });
                        setPendingChild('');
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
