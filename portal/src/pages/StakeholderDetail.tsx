/**
 * StakeholderDetail — the Full Details page for one client or partner
 * (/stakeholders/clients/:id, /stakeholders/partners/:id), parameterized
 * by `kind` the way OrgDirectory.tsx serves both from one component.
 * Hero mirrors /me (Profile.tsx's .profile-hero chrome); everything below
 * follows InitiativeDetail's .init-panel section-card convention, with
 * three fully-featured standard lists (Previous initiatives, People,
 * and — partners only — Workers) sharing the house sort/filter/columns/
 * export/virtualized-rows machinery.
 */

import {
  useCallback, useEffect, useMemo, useState, type CSSProperties,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import NotesFilesPanel from '../components/NotesFilesPanel';
import StatusHover from '../components/StatusHover';
import { TIER_LABEL } from '../components/TierSelect';
import {
  ApiError,
  getOrg,
  listInitiatives,
  listOrgContacts,
  listPartnerTypes,
  listPartnerWorkers,
  type ContactItem,
  type InitiativeItem,
  type StatusValue,
} from '../lib/api';
import {
  partnerTypeColor, partnerTypeLabel, STATUS_META, type OrgItem,
} from '../lib/orgs';
import type { WorkerItem } from '../lib/workers';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
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
import { naturalCompare } from '../lib/sites';
import { longDate } from '../lib/format';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/initiatives.css';

/* ── shared pure helpers ────────────────────────────────────────────── */

/* real_start_at/scheduled_* are date-only fields stored as midnight UTC —
   slicing the ISO string (rather than toLocaleDateString) avoids the
   day-west-of-UTC shift documented on lib/initiatives.ts's dateOnly. */
const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

const TIER_META: Record<string, string> = {
  standard: 'tag', preferred: 'c-blue', strategic: 'c-amber',
};

/** Which InitiativeItem partner-slot fields count as "this partner is
 *  involved", and the human label for each slot — used both to filter the
 *  Previous initiatives list for a partner and to build the Role column's
 *  comma-joined text. */
const PARTNER_ROLE_FIELDS: { key: keyof InitiativeItem; label: string }[] = [
  { key: 'shipping_partner_id', label: 'Shipping' },
  { key: 'origin_tech_partner_id', label: 'Origin tech' },
  { key: 'origin_cable_partner_id', label: 'Origin cable' },
  { key: 'origin_logistics_partner_id', label: 'Origin logistics' },
  { key: 'destination_tech_partner_id', label: 'Destination tech' },
  { key: 'destination_cable_partner_id', label: 'Destination cable' },
  { key: 'destination_logistics_partner_id', label: 'Destination logistics' },
];

function roleFor(i: InitiativeItem, orgId: string): string {
  return PARTNER_ROLE_FIELDS.filter((f) => i[f.key] === orgId).map((f) => f.label).join(', ');
}

function chip(label: string | null | undefined, color: string | null | undefined) {
  return label
    ? (
      <span className="chip custom" style={{ '--chip': color ?? '#51606f' } as CSSProperties}>
        <span className="dot" />{label}
      </span>
    )
    : <span className="cell-top">—</span>;
}

/* ── Previous initiatives — standard list ───────────────────────────── */

const INIT_COLUMNS: (ColumnDef & { partnerOnly?: boolean })[] = [
  { key: 'name', label: 'Name', width: '1.6fr', default: true },
  { key: 'type', label: 'Type', width: '1fr', default: true },
  { key: 'sub_type', label: 'Sub-type', width: '1fr', default: false },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'start', label: 'Start', width: '0.9fr', default: true },
  { key: 'end', label: 'End', width: '0.9fr', default: false },
  { key: 'role', label: 'Role', width: '1.1fr', default: true, partnerOnly: true },
];
const INIT_ALL_KEYS = new Set(INIT_COLUMNS.map((c) => c.key));
const INIT_DEFAULT_VISIBLE = new Set(INIT_COLUMNS.filter((c) => c.default).map((c) => c.key));

function initRowCellText(i: InitiativeItem, key: string, orgId: string): string {
  switch (key) {
    case 'name': return i.name;
    case 'type': return i.type_label;
    case 'sub_type': return i.sub_type_label ?? '—';
    case 'status': return i.status_label;
    case 'start': return dateOnly(i.scheduled_start);
    case 'end': return dateOnly(i.scheduled_end);
    case 'role': return roleFor(i, orgId) || '—';
    default: return '';
  }
}

/* ── People (org contacts) — standard list ──────────────────────────── */

const CONTACT_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.4fr', default: true },
  { key: 'tier', label: 'Contact tier', width: '0.9fr', default: true },
  { key: 'email', label: 'Email', width: '1.4fr', default: true },
  { key: 'phone', label: 'Phone', width: '1fr', default: true },
  { key: 'job_title', label: 'Job title', width: '1.1fr', default: true },
];
const CONTACT_ALL_KEYS = new Set(CONTACT_COLUMNS.map((c) => c.key));
const CONTACT_DEFAULT_VISIBLE = new Set(CONTACT_COLUMNS.map((c) => c.key));

function contactRowCellText(c: ContactItem, key: string): string {
  switch (key) {
    case 'name': return c.display_name;
    case 'tier': return TIER_LABEL[c.tier];
    case 'email': return c.email ?? '—';
    case 'phone': return c.phone ?? '—';
    case 'job_title': return c.job_title ?? '—';
    default: return '';
  }
}

const CONTACT_CSV_COLUMNS: [string, (c: ContactItem) => string][] =
  CONTACT_COLUMNS.map((c) => [c.label, (row: ContactItem) => contactRowCellText(row, c.key)]);

/* ── Workers (partners only) — standard list ────────────────────────── */

const WORKER_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.4fr', default: true },
  { key: 'trade', label: 'Trade', width: '1fr', default: true },
  { key: 'level', label: 'Level', width: '0.9fr', default: true },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'certs', label: 'Certs', width: '0.7fr', default: true },
];
const WORKER_ALL_KEYS = new Set(WORKER_COLUMNS.map((c) => c.key));
const WORKER_DEFAULT_VISIBLE = new Set(WORKER_COLUMNS.map((c) => c.key));

function workerRowCellText(w: WorkerItem, key: string): string {
  switch (key) {
    case 'name': return w.display_name;
    case 'trade': return w.trade ?? '—';
    case 'level': return w.level ?? '—';
    case 'status': return w.status_label;
    case 'certs': return w.certs_expired > 0 ? `${w.certs_expired} expired` : String(w.cert_count);
    default: return '';
  }
}

const WORKER_CSV_COLUMNS: [string, (w: WorkerItem) => string][] =
  WORKER_COLUMNS.map((c) => [c.label, (row: WorkerItem) => workerRowCellText(row, c.key)]);

export default function StakeholderDetail({ kind }: { kind: 'client' | 'partner' }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const resource = kind === 'client' ? 'clients' : 'partners';
  const canChange = can(resource, 'change');
  const listLabel = kind === 'client' ? 'Clients' : 'Partners';
  const backTo = kind === 'client' ? '/stakeholders/clients' : '/stakeholders/partners';

  const [org, setOrg] = useState<OrgItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [partnerTypes, setPartnerTypes] = useState<StatusValue[]>([]);
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [contacts, setContacts] = useState<ContactItem[] | null>(null);
  const [workers, setWorkers] = useState<WorkerItem[] | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setOrg(null);
    setNotFound(false);
    setLoadError('');
    void getOrg(kind, id).then((o) => { if (alive) setOrg(o); }).catch((err) => {
      if (!alive) return;
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setLoadError(`Failed to load ${kind === 'client' ? 'client' : 'partner'}.`);
    });
    return () => { alive = false; };
  }, [kind, id]);

  useEffect(() => {
    if (kind !== 'partner') return;
    void listPartnerTypes().then(setPartnerTypes).catch(() => {});
  }, [kind]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setInitiatives(null);
    void listInitiatives()
      .then((all) => {
        if (!alive) return;
        const filtered = kind === 'client'
          ? all.filter((i) => i.client_id === id)
          : all.filter((i) => PARTNER_ROLE_FIELDS.some((f) => i[f.key] === id));
        setInitiatives(filtered);
      })
      .catch(() => { if (alive) setInitiatives([]); });
    return () => { alive = false; };
  }, [kind, id]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setContacts(null);
    void listOrgContacts(kind, id)
      .then((list) => { if (alive) setContacts(list); })
      .catch(() => { if (alive) setContacts([]); });
    return () => { alive = false; };
  }, [kind, id]);

  useEffect(() => {
    if (kind !== 'partner' || !id) { setWorkers([]); return; }
    let alive = true;
    setWorkers(null);
    void listPartnerWorkers(id)
      .then((list) => { if (alive) setWorkers(list); })
      .catch(() => { if (alive) setWorkers([]); });
    return () => { alive = false; };
  }, [kind, id]);

  const typeVocab = useMemo(
    () => new Map(partnerTypes.map((t) => [t.key, t])), [partnerTypes]);

  /* ── Previous initiatives list state ──────────────────────────────── */

  const {
    visibleCols: initVisibleCols, setVisibleCols: setInitVisibleCols,
    sortKey: initSortKey, sortDir: initSortDir, setSort: setInitSort, toggleSort: toggleInitSort,
    filters: initFilters, setFilter: setInitFilter, clearFilters: clearInitFilters,
    colOrder: initColOrder, setColOrder: setInitColOrder,
  } = usePersistentListState(
    'stakeholder_initiatives',
    { visible: INIT_DEFAULT_VISIBLE, sortKey: 'start', sortDir: -1 },
    INIT_ALL_KEYS,
  );
  const [initQuery, setInitQuery] = useState('');

  const initColumns = useMemo(
    () => INIT_COLUMNS.filter((c) => kind === 'partner' || !c.partnerOnly), [kind]);
  const initOrderedCols = applyColumnOrder(initColumns, initColOrder);
  const initShownCols = visibleColumnsFor(initOrderedCols, initVisibleCols, false);
  const initHeaderDrag = useReorderDrag(
    (src, dst, before) => setInitColOrder(
      moveKey(initOrderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );

  const initCellText = useCallback(
    (i: InitiativeItem, key: string) => initRowCellText(i, key, id ?? ''), [id]);
  const initHaystackText = useCallback(
    (i: InitiativeItem) => initColumns.map((c) => initCellText(i, c.key)).join(' ').toLowerCase(),
    [initColumns, initCellText]);
  const initHaystack = useSearchHaystacks(initiatives, initHaystackText);

  const visibleInitiatives = useMemo(() => {
    const rows = initiatives ?? [];
    const q = initQuery.trim().toLowerCase();
    const filtered = rows.filter((i) => {
      if (!passesColumnFilters(i, initFilters, initCellText)) return false;
      if (!q) return true;
      return initHaystack(i).includes(q);
    });
    return filtered.sort((a, b) => {
      if (initSortKey === 'start' || initSortKey === 'end') {
        const field = initSortKey === 'start' ? 'scheduled_start' : 'scheduled_end';
        const av = a[field] ? Date.parse(a[field] as string) : 0;
        const bv = b[field] ? Date.parse(b[field] as string) : 0;
        return (av - bv) * initSortDir;
      }
      return naturalCompare(initCellText(a, initSortKey), initCellText(b, initSortKey)) * initSortDir;
    });
  }, [initiatives, initFilters, initQuery, initSortKey, initSortDir, initHaystack, initCellText]);

  const initCsvColumns = useMemo<[string, (i: InitiativeItem) => string][]>(
    () => initColumns.map((c) => [c.label, (i: InitiativeItem) => initCellText(i, c.key)]),
    [initColumns, initCellText]);

  const initGrid = { gridTemplateColumns: initShownCols.map((c) => c.width).join(' ') };
  const initCaret = (key: string) =>
    initSortKey === key ? <span className="caret">{initSortDir === 1 ? '▲' : '▼'}</span> : null;

  const initCellFor = (i: InitiativeItem, key: string) => {
    switch (key) {
      case 'name': return <span className="cell-top">{i.name}</span>;
      case 'type': return chip(i.type_label, i.type_color);
      case 'sub_type': return <span className="chip tag">{i.sub_type_label ?? '—'}</span>;
      case 'status':
        return (
          <StatusHover entityType="initiative" entityId={i.id} status={i.status}>
            {chip(i.status_label, i.status_color)}
          </StatusHover>
        );
      case 'start': return <span className="mono">{dateOnly(i.scheduled_start)}</span>;
      case 'end': return <span className="mono">{dateOnly(i.scheduled_end)}</span>;
      case 'role': return <span className="cell-top">{roleFor(i, id ?? '') || '—'}</span>;
      default: return null;
    }
  };

  /* ── People (contacts) list state ─────────────────────────────────── */

  const {
    visibleCols: contactVisibleCols, setVisibleCols: setContactVisibleCols,
    sortKey: contactSortKey, sortDir: contactSortDir,
    setSort: setContactSort, toggleSort: toggleContactSort,
    filters: contactFilters, setFilter: setContactFilter, clearFilters: clearContactFilters,
    colOrder: contactColOrder, setColOrder: setContactColOrder,
  } = usePersistentListState(
    'stakeholder_contacts',
    { visible: CONTACT_DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 },
    CONTACT_ALL_KEYS,
  );
  const [contactQuery, setContactQuery] = useState('');

  const contactOrderedCols = applyColumnOrder(CONTACT_COLUMNS, contactColOrder);
  const contactShownCols = visibleColumnsFor(contactOrderedCols, contactVisibleCols, false);
  const contactHeaderDrag = useReorderDrag(
    (src, dst, before) => setContactColOrder(
      moveKey(contactOrderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );

  const contactHaystackText = useCallback(
    (c: ContactItem) => CONTACT_COLUMNS.map((col) => contactRowCellText(c, col.key))
      .join(' ').toLowerCase(),
    []);
  const contactHaystack = useSearchHaystacks(contacts, contactHaystackText);

  const visibleContacts = useMemo(() => {
    const rows = contacts ?? [];
    const q = contactQuery.trim().toLowerCase();
    const filtered = rows.filter((c) => {
      if (!passesColumnFilters(c, contactFilters, contactRowCellText)) return false;
      if (!q) return true;
      return contactHaystack(c).includes(q);
    });
    return filtered.sort((a, b) => naturalCompare(
      contactRowCellText(a, contactSortKey), contactRowCellText(b, contactSortKey),
    ) * contactSortDir);
  }, [contacts, contactFilters, contactQuery, contactSortKey, contactSortDir, contactHaystack]);

  const contactGrid = { gridTemplateColumns: contactShownCols.map((c) => c.width).join(' ') };
  const contactCaret = (key: string) =>
    contactSortKey === key
      ? <span className="caret">{contactSortDir === 1 ? '▲' : '▼'}</span> : null;

  const contactCellFor = (c: ContactItem, key: string) => {
    switch (key) {
      case 'name': return <span className="cell-top">{c.display_name}</span>;
      case 'tier': return <span className="chip tag">{TIER_LABEL[c.tier]}</span>;
      case 'email': return <span className="mono">{c.email ?? '—'}</span>;
      case 'phone': return <span className="mono">{c.phone ?? '—'}</span>;
      case 'job_title': return <span className="cell-top">{c.job_title ?? '—'}</span>;
      default: return null;
    }
  };

  /* ── Workers list state (partners only) ───────────────────────────── */

  const {
    visibleCols: workerVisibleCols, setVisibleCols: setWorkerVisibleCols,
    sortKey: workerSortKey, sortDir: workerSortDir,
    setSort: setWorkerSort, toggleSort: toggleWorkerSort,
    filters: workerFilters, setFilter: setWorkerFilter, clearFilters: clearWorkerFilters,
    colOrder: workerColOrder, setColOrder: setWorkerColOrder,
  } = usePersistentListState(
    'stakeholder_workers',
    { visible: WORKER_DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 },
    WORKER_ALL_KEYS,
  );
  const [workerQuery, setWorkerQuery] = useState('');

  const workerOrderedCols = applyColumnOrder(WORKER_COLUMNS, workerColOrder);
  const workerShownCols = visibleColumnsFor(workerOrderedCols, workerVisibleCols, false);
  const workerHeaderDrag = useReorderDrag(
    (src, dst, before) => setWorkerColOrder(
      moveKey(workerOrderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );

  const workerHaystackText = useCallback(
    (w: WorkerItem) => WORKER_COLUMNS.map((col) => workerRowCellText(w, col.key))
      .join(' ').toLowerCase(),
    []);
  const workerHaystack = useSearchHaystacks(workers, workerHaystackText);

  const visibleWorkers = useMemo(() => {
    const rows = workers ?? [];
    const q = workerQuery.trim().toLowerCase();
    const filtered = rows.filter((w) => {
      if (!passesColumnFilters(w, workerFilters, workerRowCellText)) return false;
      if (!q) return true;
      return workerHaystack(w).includes(q);
    });
    return filtered.sort((a, b) => naturalCompare(
      workerRowCellText(a, workerSortKey), workerRowCellText(b, workerSortKey),
    ) * workerSortDir);
  }, [workers, workerFilters, workerQuery, workerSortKey, workerSortDir, workerHaystack]);

  const workerGrid = { gridTemplateColumns: `${workerShownCols.map((c) => c.width).join(' ')} 120px` };
  const workerCaret = (key: string) =>
    workerSortKey === key
      ? <span className="caret">{workerSortDir === 1 ? '▲' : '▼'}</span> : null;

  const workerCellFor = (w: WorkerItem, key: string) => {
    switch (key) {
      case 'name': return <span className="cell-top">{w.display_name}</span>;
      case 'trade': return <span className="cell-top">{w.trade ?? '—'}</span>;
      case 'level': return <span className="cell-top">{w.level ?? '—'}</span>;
      case 'status':
        return (
          <StatusHover entityType="worker" entityId={w.person_id} status={w.status}>
            {chip(w.status_label, w.status_color)}
          </StatusHover>
        );
      case 'certs':
        return (
          <span className="mono">
            {w.certs_expired > 0 ? `${w.certs_expired} expired` : w.cert_count}
          </span>
        );
      default: return null;
    }
  };

  /* ── loading / not-found / error gates ────────────────────────────── */

  if (notFound) {
    return (
      <div className="portal-page">
        <Link to={backTo} className="idet-back">← {listLabel}</Link>
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>{kind === 'client' ? 'Client not found' : 'Partner not found'}</b>
          It may have been deleted, or you may not have access.
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="portal-page">
        <Link to={backTo} className="idet-back">← {listLabel}</Link>
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Cannot load {kind}</b>{loadError}
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="portal-page">
        <Link to={backTo} className="idet-back">← {listLabel}</Link>
        <p className="page-hint" style={{ marginTop: 16 }}>Loading…</p>
      </div>
    );
  }

  return (
    <div className="portal-page">
      <Link to={backTo} className="idet-back">← {listLabel}</Link>

      <div className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-id">
          <AvatarUpload
            name={org.name}
            url={org.logo_url}
            entityType={kind}
            entityId={org.id}
            editable={canChange}
            size={104}
            radius={26}
            onUploaded={(att) => setOrg((prev) => (prev ? { ...prev, logo_url: att.url } : prev))}
          />
          <div className="profile-meta">
            <h1>
              {org.name}
              <span className="chip tag">{kind === 'client' ? 'Client' : 'Partner'}</span>
              <StatusHover entityType={kind} entityId={org.id} status={org.status}>
                <span className={`chip ${(STATUS_META[org.status] ?? STATUS_META.prospect).cls}`}>
                  <span className="dot" />{(STATUS_META[org.status] ?? { label: org.status }).label}
                </span>
              </StatusHover>
              {org.archived_at && <span className="chip tag">Archived</span>}
              {kind === 'client' && org.tier && (
                <span className={`chip ${TIER_META[org.tier] ?? 'tag'}`}>{org.tier}</span>
              )}
              {kind === 'partner' && org.service_region && (
                <span className="chip tag">{org.service_region}</span>
              )}
              {kind === 'partner' && org.partner_types.map((t) => (
                <span key={t} className="chip custom"
                      style={{ '--chip': partnerTypeColor(t, typeVocab) } as CSSProperties}>
                  <span className="dot" />{partnerTypeLabel(t, typeVocab)}
                </span>
              ))}
            </h1>
            <div className="pm-sub">
              <span>Manager: {org.account_manager?.display_name ?? '—'}</span>
              {org.website && (
                <span>
                  <a href={org.website} target="_blank" rel="noreferrer">{org.website}</a>
                </span>
              )}
              {org.phone && <span>☏ {org.phone}</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Details</h3>
        </div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Code</dt><dd className="mono">{org.code ?? '—'}</dd>
            <dt>Address</dt>
            <dd>{[org.address_line1, org.address_line2,
              [org.city, org.region, org.postal_code].filter(Boolean).join(', '),
              org.country].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>Phone</dt><dd className="mono">{org.phone ?? '—'}</dd>
            <dt>Website</dt>
            <dd className="mono">{org.website
              ? <a href={org.website} target="_blank" rel="noreferrer">{org.website}</a>
              : '—'}</dd>
            <dt>Account manager</dt><dd>{org.account_manager?.display_name ?? '—'}</dd>
            <dt>{kind === 'client' ? 'Tier' : 'Region'}</dt>
            <dd>{(kind === 'client' ? org.tier : org.service_region) ?? '—'}</dd>
            <dt>Created</dt><dd className="mono">{longDate(org.created_at)}</dd>
            {org.notes && <><dt>Directory notes</dt><dd>{org.notes}</dd></>}
          </dl>
        </div>
      </div>

      {/* ── Previous initiatives ────────────────────────────────────── */}
      <div className="init-panel" style={{ marginTop: 18 }}>
        <p className="eyebrow-sm">Previous initiatives</p>
        {initiatives === null && <p className="page-hint">Loading…</p>}
        {initiatives !== null && initiatives.length === 0 && (
          <p className="page-hint">No initiatives yet.</p>
        )}
        {initiatives !== null && initiatives.length > 0 && (
          <>
            <div className="dir-toolbar idet-people-toolbar">
              <div className="toolbar-right">
                <div className="dir-search" style={{ marginLeft: 0 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                  <input placeholder="Filter initiatives…" value={initQuery}
                         onChange={(e) => setInitQuery(e.target.value)} />
                </div>
                <span className="result-count">
                  {visibleInitiatives.length} of {initiatives.length} shown</span>
                <FilterSummaryChip filters={initFilters} onClear={clearInitFilters} />
                <ColumnsButton columns={initOrderedCols} visible={initVisibleCols}
                               onChange={setInitVisibleCols}
                               onReorder={setInitColOrder} />
                <ExportButton onExport={() =>
                  exportCsv('initiatives', initCsvColumns, visibleInitiatives)} />
              </div>
            </div>

            <div className="dir-list">
              <div className="list-head" style={initGrid}>
                {initShownCols.map((c) => (
                  <span key={c.key}
                        className={`col-head ${initHeaderDrag.dropClass(c.key)}`}
                        {...initHeaderDrag.dragProps(c.key)}>
                    <button type="button" className="sortable"
                            onClick={() => toggleInitSort(c.key)}>
                      {c.label} {initCaret(c.key)}
                    </button>
                    <ColumnMenu colKey={c.key} label={c.label}
                                allRows={initiatives} filters={initFilters}
                                text={initCellText}
                                filter={initFilters[c.key]} onFilter={setInitFilter}
                                sortDir={initSortKey === c.key ? initSortDir : null}
                                onSort={(dir) => setInitSort(c.key, dir)} />
                  </span>
                ))}
              </div>

              {visibleInitiatives.length === 0 && (
                <div className="dir-empty">
                  <b>No matches</b>Try a different search or filter.
                  <EmptyClearFilters filters={initFilters} onClear={clearInitFilters} />
                </div>
              )}

              <VirtualRows rows={visibleInitiatives}
                renderRow={(i, vp) => (
                  <div key={i.id} className="dir-row" {...vp} style={vp?.style}>
                    <div className="row-main" style={initGrid}
                         onClick={() => navigate(`/initiatives/${i.id}`)}>
                      {initShownCols.map((c) => (
                        <div className="cell" key={c.key}>{initCellFor(i, c.key)}</div>
                      ))}
                    </div>
                  </div>
                )} />
            </div>
          </>
        )}
      </div>

      {/* ── People (org contacts) ───────────────────────────────────── */}
      <div className="init-panel" style={{ marginTop: 18 }}>
        <p className="eyebrow-sm">People</p>
        {contacts === null && <p className="page-hint">Loading…</p>}
        {contacts !== null && contacts.length === 0 && (
          <p className="page-hint">No contacts yet.</p>
        )}
        {contacts !== null && contacts.length > 0 && (
          <>
            <div className="dir-toolbar idet-people-toolbar">
              <div className="toolbar-right">
                <div className="dir-search" style={{ marginLeft: 0 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                  <input placeholder="Filter people…" value={contactQuery}
                         onChange={(e) => setContactQuery(e.target.value)} />
                </div>
                <span className="result-count">
                  {visibleContacts.length} of {contacts.length} shown</span>
                <FilterSummaryChip filters={contactFilters} onClear={clearContactFilters} />
                <ColumnsButton columns={contactOrderedCols} visible={contactVisibleCols}
                               onChange={setContactVisibleCols}
                               onReorder={setContactColOrder} />
                <ExportButton onExport={() =>
                  exportCsv('contacts', CONTACT_CSV_COLUMNS, visibleContacts)} />
              </div>
            </div>

            <div className="dir-list idet-people-list">
              <div className="list-head" style={contactGrid}>
                {contactShownCols.map((c) => (
                  <span key={c.key}
                        className={`col-head ${contactHeaderDrag.dropClass(c.key)}`}
                        {...contactHeaderDrag.dragProps(c.key)}>
                    <button type="button" className="sortable"
                            onClick={() => toggleContactSort(c.key)}>
                      {c.label} {contactCaret(c.key)}
                    </button>
                    <ColumnMenu colKey={c.key} label={c.label}
                                allRows={contacts} filters={contactFilters}
                                text={contactRowCellText}
                                filter={contactFilters[c.key]} onFilter={setContactFilter}
                                sortDir={contactSortKey === c.key ? contactSortDir : null}
                                onSort={(dir) => setContactSort(c.key, dir)} />
                  </span>
                ))}
              </div>

              {visibleContacts.length === 0 && (
                <div className="dir-empty">
                  <b>No matches</b>Try a different search or filter.
                  <EmptyClearFilters filters={contactFilters} onClear={clearContactFilters} />
                </div>
              )}

              <VirtualRows rows={visibleContacts}
                renderRow={(c, vp) => (
                  <div key={c.person_id} className="dir-row" {...vp} style={vp?.style}>
                    <div className="row-main" style={contactGrid}>
                      {contactShownCols.map((col) => (
                        <div className="cell" key={col.key}>{contactCellFor(c, col.key)}</div>
                      ))}
                    </div>
                  </div>
                )} />
            </div>
          </>
        )}
      </div>

      {/* ── Workers (partners only) ──────────────────────────────────── */}
      {kind === 'partner' && (
        <div className="init-panel" style={{ marginTop: 18 }}>
          <p className="eyebrow-sm">Workers</p>
          {workers === null && <p className="page-hint">Loading…</p>}
          {workers !== null && workers.length === 0 && (
            <p className="page-hint">No workers supplied yet.</p>
          )}
          {workers !== null && workers.length > 0 && (
            <>
              <div className="dir-toolbar idet-people-toolbar">
                <div className="toolbar-right">
                  <div className="dir-search" style={{ marginLeft: 0 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round">
                      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                    <input placeholder="Filter workers…" value={workerQuery}
                           onChange={(e) => setWorkerQuery(e.target.value)} />
                  </div>
                  <span className="result-count">
                    {visibleWorkers.length} of {workers.length} shown</span>
                  <FilterSummaryChip filters={workerFilters} onClear={clearWorkerFilters} />
                  <ColumnsButton columns={workerOrderedCols} visible={workerVisibleCols}
                                 onChange={setWorkerVisibleCols}
                                 onReorder={setWorkerColOrder} />
                  <ExportButton onExport={() =>
                    exportCsv('workers', WORKER_CSV_COLUMNS, visibleWorkers)} />
                </div>
              </div>

              <div className="dir-list idet-people-list">
                <div className="list-head" style={workerGrid}>
                  {workerShownCols.map((c) => (
                    <span key={c.key}
                          className={`col-head ${workerHeaderDrag.dropClass(c.key)}`}
                          {...workerHeaderDrag.dragProps(c.key)}>
                      <button type="button" className="sortable"
                              onClick={() => toggleWorkerSort(c.key)}>
                        {c.label} {workerCaret(c.key)}
                      </button>
                      <ColumnMenu colKey={c.key} label={c.label}
                                  allRows={workers} filters={workerFilters}
                                  text={workerRowCellText}
                                  filter={workerFilters[c.key]} onFilter={setWorkerFilter}
                                  sortDir={workerSortKey === c.key ? workerSortDir : null}
                                  onSort={(dir) => setWorkerSort(c.key, dir)} />
                    </span>
                  ))}
                  <span className="col-head" />
                </div>

                {visibleWorkers.length === 0 && (
                  <div className="dir-empty">
                    <b>No matches</b>Try a different search or filter.
                    <EmptyClearFilters filters={workerFilters} onClear={clearWorkerFilters} />
                  </div>
                )}

                <VirtualRows rows={visibleWorkers}
                  renderRow={(w, vp) => (
                    <div key={w.person_id} className="dir-row" {...vp} style={vp?.style}>
                      <div className="row-main" style={workerGrid}>
                        {workerShownCols.map((c) => (
                          <div className="cell" key={c.key}>{workerCellFor(w, c.key)}</div>
                        ))}
                        <div className="cell">
                          <Link className="mini-btn sm" to={`/people/workers/${w.person_id}`}>
                            Full Details ↗
                          </Link>
                        </div>
                      </div>
                    </div>
                  )} />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Notes & uploads ──────────────────────────────────────────── */}
      <div className="init-panel" style={{ marginTop: 18 }}>
        <NotesFilesPanel entityType={kind} entityId={org.id} canWrite={canChange} />
      </div>
    </div>
  );
}
