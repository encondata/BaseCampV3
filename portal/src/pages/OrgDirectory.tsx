/**
 * OrgDirectory — the stakeholders list pattern (fibertrace directory),
 * parameterized for Clients and Partners: status pills, filter, sortable
 * columns, expandable detail with logo upload, org editing, archive, and
 * a contacts panel backed by scoped role grants.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type FormEvent, type ReactNode,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import ComboBox from '../components/ComboBox';
import GodDeleteButton from '../components/GodDeleteButton';
import TagInput from '../components/TagInput';
import TierSelect, { TIER_LABEL } from '../components/TierSelect';
import {
  addContactLink, apiFetch, ApiError, listPartnerTypes, type ContactTier, type StatusValue,
} from '../lib/api';
import {
  afterLinkFailure, buildNewContactPersonPayload, planAddContact,
} from '../lib/external';
import { initialOpenId } from '../lib/auditFormat';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import { usePendingDeletes } from '../lib/pendingDeletes';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import { avatarGradient, initials, longDate } from '../lib/format';
import { safeHref } from '../lib/safeHref';
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
import {
  effectiveStatus, ORG_ERRORS, ORG_GOD_FIELDS, orgCellText, partnerTypeColor, partnerTypeLabel,
  STATUS_META, type OrgItem,
} from '../lib/orgs';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';

export interface OrgConfig {
  kind: 'client' | 'partner';
  apiBase: string;
  title: string;
  blurb: string;
  addLabel: string;
  hasType: boolean;
}

interface ContactItem {
  person_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  avatar_url: string | null;
  has_account: boolean;
  granted_at: string;
  tier: ContactTier;
  org_title: string | null;
  functions: string[];
}

interface SuppliedWorker {
  person_id: string;
  display_name: string;
  avatar_url: string | null;
  trade: string | null;
  level: string | null;
  status: string;
  // denormalised by the server (schemas.py WorkerItem), so this page renders the
  // live worker vocabulary without holding a copy of it or fetching status-values
  status_label: string;
  status_color: string;
  // likewise for the level badge: this panel is reachable with partners:view,
  // but /worker-levels needs workers:view (which vendor_viewer lacks), so
  // fetching the scale here would silently grey out every badge for them.
  level_color: string | null;
}

interface PersonPick {
  person_id: string;
  display_name: string;
  email: string | null;
  job_title: string | null;
  has_account: boolean;
}

const TIER_META: Record<string, string> = {
  standard: 'tag', preferred: 'c-blue', strategic: 'c-amber',
};

/* prospect is a client-lifecycle concept — partners are engaged or they
   aren't, so their page hides the pill (and the modal's option below). */
const PILLS: { key: string; label: string; clientOnly?: boolean }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'prospect', label: 'Prospect', clientOnly: true },
  { key: 'inactive', label: 'In-Active' },
  { key: 'archived', label: 'Archived' },
];

/* column registry (Name is fixed-first, chevron fixed-last). `type` and
   `service_region` are partner-only, `tier` is client-only — all three
   are filtered out for the other kind at render time. */
const ALL_COLUMNS: (ColumnDef & { partnerOnly?: boolean; clientOnly?: boolean })[] = [
  { key: 'type', label: 'Type', width: '1.1fr', default: true, partnerOnly: true },
  { key: 'tier', label: 'Tier', width: '1fr', default: true, clientOnly: true },
  { key: 'service_region', label: 'Region', width: '1fr', default: true, partnerOnly: true },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'manager', label: 'Account manager', width: '1.4fr', default: true },
  { key: 'contacts', label: 'Contacts', width: '0.8fr', default: true },
  { key: 'website', label: 'Website', width: '1.5fr', default: false },
  { key: 'phone', label: 'Phone', width: '1.1fr', default: false },
  { key: 'location', label: 'Location', width: '1.3fr', default: false },
  { key: 'created', label: 'Created', width: '1.1fr', default: false },
  // God-only columns: hidden from the column picker until god mode is on.
  { key: 'city', label: 'City', width: '1.1fr', default: false, godOnly: true },
  { key: 'region', label: 'Region', width: '1fr', default: false, godOnly: true },
  { key: 'postal_code', label: 'Postal code', width: '1fr', default: false, godOnly: true },
  { key: 'country', label: 'Country', width: '0.8fr', default: false, godOnly: true },
  { key: 'address_line1', label: 'Address line 1', width: '1.4fr', default: false, godOnly: true },
  { key: 'address_line2', label: 'Address line 2', width: '1.4fr', default: false, godOnly: true },
  { key: 'notes', label: 'Notes', width: '1.6fr', default: false, godOnly: true },
];

// Every column either kind can offer (incl. godOnly and the partner-only
// 'type' column — harmless to include for clients too, since `columns`
// below still excludes it from what actually renders) plus 'primary' (the
// always-shown name+code/city cell). No archived pseudo-column: archived
// already lives inside 'status' via effectiveStatus.
const ALL_COLUMN_KEYS = new Set<string>([...ALL_COLUMNS.map((c) => c.key), 'primary']);
const DEFAULT_VISIBLE = new Set<string>(ALL_COLUMNS.filter((c) => c.default).map((c) => c.key));

/** The org detail panel's Website row: a link when it's a safe http(s)
 *  URL, otherwise the raw text (a stored value can predate server-side
 *  normalization, or a bad value could reach here some other way — never
 *  trust it into an anchor untested; security-fixes task 7). */
function renderWebsite(website: string | null): ReactNode {
  if (!website) return '—';
  const href = safeHref(website);
  return href
    ? <a href={href} target="_blank" rel="noreferrer">{website}</a>
    : <span className="cell-sub">{website}</span>;
}

/** Sort value per column key — deliberately separate from `orgCellText`:
 *  that accessor's job is display/filter text (the STATUS_META label, the
 *  joined type-labels list), which would sort wrong (labels don't order
 *  prospect/active/inactive/archived the way the raw status key does).
 *  This stays raw/lowercase so naturalCompare orders rows the way a user
 *  expects. */
function sortValueFor(o: OrgItem, key: string): string | number {
  switch (key) {
    case 'primary': return o.name.toLowerCase();
    case 'type': return o.partner_types.join(',');
    case 'tier': return o.tier ?? '';
    case 'service_region': return (o.service_region ?? '').toLowerCase();
    case 'status': return effectiveStatus(o);
    case 'manager': return o.account_manager?.display_name.toLowerCase() ?? '';
    case 'contacts': return o.contact_count;
    case 'created': return o.created_at;
    case 'website': return o.website ?? '';
    case 'phone': return o.phone ?? '';
    case 'location': return `${o.city ?? ''} ${o.region ?? ''}`.toLowerCase();
    case 'city': return (o.city ?? '').toLowerCase();
    case 'region': return (o.region ?? '').toLowerCase();
    case 'postal_code': return (o.postal_code ?? '').toLowerCase();
    case 'country': return o.country.toLowerCase();
    case 'address_line1': return (o.address_line1 ?? '').toLowerCase();
    case 'address_line2': return (o.address_line2 ?? '').toLowerCase();
    case 'notes': return (o.notes ?? '').toLowerCase();
    default: return '';
  }
}

function csvColumns(hasType: boolean): [string, (o: OrgItem) => string][] {
  const cols: [string, (o: OrgItem) => string][] = [
    ['ID', (o) => o.id],
    ['Name', (o) => o.name],
    ['Code', (o) => o.code ?? ''],
  ];
  if (hasType) cols.push(['Types', (o) => o.partner_types.join('; ')]);
  // 'Region' is already used below for the address region (city/state) —
  // partners' service region is a distinct freeform field, so it gets its
  // own CSV header rather than colliding with that one.
  cols.push(
    hasType
      ? ['Service region', (o) => o.service_region ?? '']
      : ['Tier', (o) => o.tier ?? ''],
    ['Status', (o) => effectiveStatus(o)],
    ['Account manager', (o) => o.account_manager?.display_name ?? ''],
    ['Contacts', (o) => String(o.contact_count)],
    ['Phone', (o) => o.phone ?? ''],
    ['Website', (o) => o.website ?? ''],
    ['City', (o) => o.city ?? ''],
    ['Region', (o) => o.region ?? ''],
    ['Country', (o) => o.country],
    ['Created', (o) => o.created_at],
  );
  return cols;
}

export default function OrgDirectory({ cfg }: { cfg: OrgConfig }) {
  const { can, godMode } = useAuth();
  const navigate = useNavigate();
  const god = useGodEdit();
  const pd = usePendingDeletes(godMode);

  const [orgs, setOrgs] = useState<OrgItem[] | null>(null);
  const [error, setError] = useState('');
  // partner_type vocabulary (Partners only — cfg.hasType). Active values
  // only, per /status-values?record_type=; a retired key still on some org's
  // partner_types just falls through orgs.ts's TYPE_LABEL/raw-key fallback.
  const [partnerTypes, setPartnerTypes] = useState<StatusValue[]>([]);
  const [pill, setPill] = useState('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
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
  useRecordFocus(orgs, (o) => o.id, (o) => o.name, focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const [contacts, setContacts] = useState<Record<string, ContactItem[]>>({});
  const [editing, setEditing] = useState<OrgItem | 'new' | null>(null);

  // Clients and Partners persist their list state independently — same
  // component, two pageKeys, one per cfg.kind.
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    `${cfg.kind}s`, { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const columns = useMemo(
    () => ALL_COLUMNS.filter((c) => (cfg.hasType || !c.partnerOnly)
      && (!cfg.hasType || !c.clientOnly)),
    [cfg.hasType]);

  const load = async () => {
    const resp = await apiFetch(cfg.apiBase);
    if (!resp.ok) {
      setError(resp.status === 403
        ? `You do not have permission to view ${cfg.title.toLowerCase()}.`
        : `Failed to load ${cfg.title.toLowerCase()}.`);
      return;
    }
    setOrgs(await resp.json());
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [cfg.apiBase]);

  useEffect(() => {
    if (!cfg.hasType) return;
    void listPartnerTypes().then(setPartnerTypes).catch(() => {});
  }, [cfg.hasType]);

  const typeVocab = useMemo(
    () => new Map(partnerTypes.map((t) => [t.key, t])), [partnerTypes]);
  // orgCellText's `typeVocab` param defaults to an empty map so it still
  // satisfies columnMenu's 2-arg `CellText<OrgItem>` — bind the loaded
  // vocab here once, rather than re-deriving it at every call site.
  const cellText = (o: OrgItem, colKey: string) => orgCellText(o, colKey, typeVocab);

  // global-search / palette handoff now lives in useRecordFocus
  // (expands AND filters the row to the top)

  // fetch contacts when a row opens
  useEffect(() => {
    if (!openId) return;
    let cancelled = false;
    void apiFetch(`${cfg.apiBase}/${openId}/contacts`).then(async (r) => {
      if (r.ok && !cancelled) {
        const list = await r.json();
        setContacts((prev) => ({ ...prev, [openId]: list }));
      }
    });
    return () => { cancelled = true; };
  }, [openId, cfg.apiBase]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: orgs?.length ?? 0 };
    for (const p of PILLS.slice(1)) c[p.key] = 0;
    for (const o of orgs ?? []) {
      const s = effectiveStatus(o);
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [orgs]);

  const orgsHaystackText = useCallback((o: OrgItem) =>
    (`${o.name} ${o.code ?? ''} ${o.city ?? ''} ${o.region ?? ''} ` +
      `${o.partner_types.join(' ')} ${o.account_manager?.display_name ?? ''}`).toLowerCase(), []);
  const haystack = useSearchHaystacks(orgs, orgsHaystackText);

  const visible = useMemo(() => {
    if (!orgs) return [];
    const q = query.trim().toLowerCase();
    const rows = orgs.filter((o) => {
      if (pill !== 'all' && effectiveStatus(o) !== pill) return false;
      if (!passesColumnFilters(o, filters, cellText)) return false;
      if (!q) return true;
      return haystack(o).includes(q);
    });
    return rows.sort((a, b) => {
      const va = sortValueFor(a, sortKey), vb = sortValueFor(b, sortKey);
      return naturalCompare(String(va), String(vb)) * sortDir;
    });
  }, [orgs, pill, query, filters, sortKey, sortDir, typeVocab, haystack]);

  // Auto-close the open row when it drops out of `visible` — EXCEPT the one
  // case where it just arrived via a deep link and the reason it's missing
  // is a persisted column filter: then clear the filters instead. See
  // Assets.tsx for the full rationale.
  useEffect(() => {
    if (!orgs || !openId || visible.some((o) => o.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = orgs.find((o) => o.id === openId);
      if (target && !passesColumnFilters(target, filters, cellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [orgs, visible, openId, filters, clearFilters, typeVocab]);

  // Release the deep-link guard once the target row is first confirmed
  // visible — see Assets.tsx for the full rationale.
  useEffect(() => {
    if (deepLinkTarget.current && visible.some((o) => o.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const setArchived = async (org: OrgItem, archive: boolean) => {
    await apiFetch(`${cfg.apiBase}/${org.id}/${archive ? 'archive' : 'unarchive'}`,
      { method: 'POST' });
    void load();
  };

  const orderedCols = applyColumnOrder(columns, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = {
    gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px`,
  };

  const canManage = can(cfg.kind === 'client' ? 'clients' : 'partners', 'change');
  const canViewUsers = can('users', 'view');

  const godFields = useMemo(() => ORG_GOD_FIELDS(), []);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const patchOrg = (id: string, body: Record<string, unknown>) =>
    apiFetch(`${cfg.apiBase}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (!r.ok) {
        let code = 'unknown';
        try { code = (await r.json())?.detail?.code ?? code; } catch { /* noop */ }
        throw new ApiError(r.status, code);
      }
      return r.json();
    });
  const replaceRow = (u: OrgItem) =>
    setOrgs((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const cellFor = (o: OrgItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={o} gf={gf} patch={patchOrg} onRowSaved={replaceRow}
                   errorMap={ORG_ERRORS} disabled={!canManage} />
        );
      }
    }
    switch (key) {
      case 'type':
        return (
          <div className="chips">
            {o.partner_types.length === 0 && <span className="chip tag">—</span>}
            {o.partner_types.map((t) => (
              <span key={t} className="chip custom"
                    style={{ '--chip': partnerTypeColor(t, typeVocab) } as CSSProperties}>
                <span className="dot" />{partnerTypeLabel(t, typeVocab)}
              </span>
            ))}
          </div>
        );
      case 'tier':
        return o.tier
          ? <span className={`chip ${TIER_META[o.tier] ?? 'tag'}`}>{o.tier}</span>
          : <span className="chip tag">—</span>;
      case 'service_region':
        return <span className="cell-top">{o.service_region || '—'}</span>;
      case 'status': {
        const s = STATUS_META[effectiveStatus(o)];
        return (
          <div className="chips">
            <span className={`chip ${s.cls}`}><span className="dot" />{s.label}</span>
            {pd.pendingIds.has(o.id) && <span className="chip tag">Pending delete</span>}
          </div>
        );
      }
      case 'manager':
        return <span className="cell-top">{o.account_manager?.display_name ?? '—'}</span>;
      case 'contacts':
        return <span className="mono">{o.contact_count}</span>;
      case 'website':
        return <span className="mono">{o.website ?? '—'}</span>;
      case 'phone':
        return <span className="mono">{o.phone ?? '—'}</span>;
      case 'location':
        return <span className="cell-top">{[o.city, o.region].filter(Boolean).join(', ') || '—'}</span>;
      case 'created':
        return <span className="mono">{longDate(o.created_at)}</span>;
      case 'city':
        return <span className="cell-top">{o.city ?? '—'}</span>;
      case 'region':
        return <span className="cell-top">{o.region ?? '—'}</span>;
      case 'postal_code':
        return <span className="mono">{o.postal_code ?? '—'}</span>;
      case 'country':
        return <span className="mono">{o.country}</span>;
      case 'address_line1':
        return <span className="cell-top">{o.address_line1 ?? '—'}</span>;
      case 'address_line2':
        return <span className="cell-top">{o.address_line2 ?? '—'}</span>;
      case 'notes':
        return <span className="cell-top">{o.notes || '—'}</span>;
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Stakeholders</div>
          <h1 className="page-title">
            {cfg.title}
            <span className="badge-count">{orgs?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">{cfg.blurb}</p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist">
          {PILLS.filter((p) => !p.clientOnly || cfg.kind === 'client').map((p) => (
            <button key={p.key} className={pill === p.key ? 'on' : ''}
                    onClick={() => setPill(p.key)}>
              {p.label} <span className="n">{counts[p.key] ?? 0}</span>
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
          <span className="result-count">{visible.length} of {orgs?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         godMode={godMode} onReorder={setColOrder} />
          <ExportButton onExport={() =>
            exportCsv(cfg.title.toLowerCase(), csvColumns(cfg.hasType), visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canManage} />
          {canManage && (
            <button className="btn-solid" onClick={() => setEditing('new')}>
              + {cfg.addLabel}
            </button>
          )}
        </div>
      </div>

      <div className="dir-list">
        <div className="list-head" style={grid}>
          <span className="col-head">
            <button className="sortable" onClick={() => toggleSort('primary')}>
              Name {caret('primary')}
            </button>
            <ColumnMenu colKey="primary" label="Name"
                        allRows={orgs ?? []} filters={filters}
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
                          allRows={orgs ?? []} filters={filters}
                          text={cellText}
                          filter={filters[c.key]} onFilter={setFilter}
                          sortDir={sortKey === c.key ? sortDir : null}
                          onSort={(dir) => setSort(c.key, dir)} />
            </span>
          ))}
          <span />
        </div>

        {error && <div className="dir-empty"><b>Cannot load</b>{error}</div>}
        {!error && orgs && visible.length === 0 && (
          <div className="dir-empty">
            <b>No matches</b>Try a different filter — or add one.
            <EmptyClearFilters filters={filters} onClear={clearFilters} />
          </div>
        )}

        <VirtualRows rows={visible}
          renderRow={(o, vp) => {
          const open = openId === o.id;
          return (
            <div key={o.id} className={`dir-row ${open ? 'open' : ''}`}
                 {...vp} style={vp?.style}>
              <div className="row-main" style={grid}
                   onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : o.id); }}>
                <div className="cell cell-primary">
                  <div className="dir-avatar"
                       style={{ background: o.logo_url ? 'var(--surface-2)' : avatarGradient(o.name) }}>
                    {o.logo_url ? <img src={o.logo_url} alt="" /> : initials(o.name)}
                  </div>
                  {god.editing && godFieldFor('primary') && godFieldFor('primary2') ? (
                    <div className="pn god-primary-edit">
                      <GodCell row={o} gf={godFieldFor('primary')!} patch={patchOrg}
                               onRowSaved={replaceRow} errorMap={ORG_ERRORS} disabled={!canManage} />
                      <GodCell row={o} gf={godFieldFor('primary2')!} patch={patchOrg}
                               onRowSaved={replaceRow} errorMap={ORG_ERRORS} disabled={!canManage} />
                    </div>
                  ) : (
                    <div className="pn">
                      <b>{o.name}</b>
                      <span>{[o.code, [o.city, o.region].filter(Boolean).join(', ')]
                        .filter(Boolean).join(' · ') || '—'}</span>
                    </div>
                  )}
                </div>
                {shownCols.map((c) => (
                  <div className="cell" key={c.key}>{cellFor(o, c.key)}</div>
                ))}
                <div className="cell chevron-cell">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                </div>
              </div>

              <div className="detail">
                <div className="detail-clip">
                  <div className="detail-inner">
                    <div className="detail-grid">
                      <div className="detail-block">
                        <p className="eyebrow-sm">Organization</p>
                        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                          <AvatarUpload
                            name={o.name}
                            url={o.logo_url}
                            entityType={cfg.kind}
                            entityId={o.id}
                            editable={canManage}
                            size={64}
                            radius={14}
                            onUploaded={() => void load()}
                          />
                          <dl className="kv" style={{ flex: 1 }}>
                            <dt>Code</dt><dd className="mono">{o.code ?? '—'}</dd>
                            <dt>Website</dt>
                            <dd className="mono">{renderWebsite(o.website)}</dd>
                            <dt>Phone</dt><dd className="mono">{o.phone ?? '—'}</dd>
                            <dt>Address</dt>
                            <dd>{[o.address_line1, o.address_line2,
                              [o.city, o.region, o.postal_code].filter(Boolean).join(', '),
                              o.country].filter(Boolean).join(' · ') || '—'}</dd>
                            <dt>Manager</dt><dd>{o.account_manager?.display_name ?? '—'}</dd>
                            <dt>Notes</dt><dd>{o.notes ?? '—'}</dd>
                            <dt>Created</dt><dd className="mono">{longDate(o.created_at)}</dd>
                          </dl>
                        </div>
                        <div className="detail-actions">
                          <Link className="mini-btn" to={`/stakeholders/${cfg.kind}s/${o.id}`}>
                            Full Details ↗
                          </Link>
                          {canManage && (<>
                          <button className="mini-btn accent" onClick={() => setEditing(o)}>
                            Edit {cfg.kind}
                          </button>
                          {o.archived_at ? (
                            <button className="mini-btn" onClick={() => void setArchived(o, false)}>
                              Unarchive
                            </button>
                          ) : (
                            <button className="mini-btn danger" onClick={() => void setArchived(o, true)}>
                              Archive
                            </button>
                          )}
                          </>)}
                          <GodDeleteButton visible={godMode} entityType={cfg.kind} entityId={o.id}
                                           label={o.name} pending={pd.pendingIds.has(o.id)}
                                           onChange={pd.pendingIds.has(o.id)
                                             ? () => pd.unmark(o.id)
                                             : () => pd.mark(cfg.kind, o.id, o.name)} />
                        </div>
                      </div>
                      <div className="detail-block">
                        <div style={{
                          display: 'flex', alignItems: 'baseline',
                          justifyContent: 'space-between', gap: 12,
                        }}>
                          <p className="eyebrow-sm" style={{ margin: 0 }}>
                            Contacts — people {cfg.kind === 'client'
                              ? 'at this client (client role, scoped here)'
                              : 'at this partner (vendor role, scoped here)'}
                          </p>
                          {canViewUsers && (
                            <Link className="link-plain" to="/people/external">
                              Manage in External →
                            </Link>
                          )}
                        </div>
                        <ContactsPanel
                          cfg={cfg}
                          orgId={o.id}
                          contacts={contacts[o.id]}
                          canManage={canManage}
                          onChanged={(list) => {
                            setContacts((prev) => ({ ...prev, [o.id]: list }));
                            void load(); // refresh contact counts
                          }}
                        />
                        {cfg.kind === 'partner' && open && (
                          <SuppliedWorkersPanel partnerId={o.id} navigate={navigate} />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }} />
      </div>

      {editing && (
        <OrgFormModal
          cfg={cfg}
          org={editing === 'new' ? null : editing}
          partnerTypes={partnerTypes}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            deepLinkTarget.current = null;
            void load().then(() => setOpenId(id));
          }}
        />
      )}
    </div>
  );
}

/* ── contacts panel ─────────────────────────────────────────────── */

/* ── supplied workers (partners only) ───────────────────────────── */

function SuppliedWorkersPanel({ partnerId, navigate }: {
  partnerId: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [workers, setWorkers] = useState<SuppliedWorker[] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiFetch(`/partners/${partnerId}/workers`).then(async (r) => {
      if (r.ok && !cancelled) setWorkers(await r.json());
    });
    return () => { cancelled = true; };
  }, [partnerId]);

  // one chip per status actually present, not per status this file remembers —
  // the old fixed three counted an unknown status and then never rendered it.
  // Sorted by label because sort_order isn't denormalised onto the row; that
  // drops the old active→standby→blacklist order for a deterministic one.
  const breakdown = useMemo(() => {
    const b = new Map<string, { key: string; label: string; color: string; n: number }>();
    for (const w of workers ?? []) {
      const seen = b.get(w.status);
      if (seen) seen.n += 1;
      else b.set(w.status, {
        key: w.status, label: w.status_label, color: w.status_color, n: 1 });
    }
    return [...b.values()].sort((x, y) => x.label.localeCompare(y.label));
  }, [workers]);

  return (
    <>
      <p className="eyebrow-sm">Supplied workers — crews from this partner</p>
      {workers === null && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
      {workers?.length === 0 && (
        <p className="set-note" style={{ padding: 0 }}>
          No workers assigned. Set a worker's supplying partner on the Workers page.
        </p>
      )}
      {workers && workers.length > 0 && (
        <div className="supplied-summary">
          <div className="supplied-count">
            <b>{workers.length}</b>
            <span>worker{workers.length === 1 ? '' : 's'}</span>
          </div>
          <div className="chips">
            {breakdown.map((s) => (
              <span key={s.key} className="chip custom" style={{ '--chip': s.color } as CSSProperties}>
                <span className="dot" />{s.n} {s.label.toLowerCase()}
              </span>
            ))}
          </div>
          <button className="mini-btn accent" onClick={() => setModalOpen(true)}>
            View workers
          </button>
        </div>
      )}
      {modalOpen && workers && (
        <SuppliedWorkersModal
          workers={workers}
          onClose={() => setModalOpen(false)}
          onPick={(id) => {
            setModalOpen(false);
            navigate('/people/workers', { state: { openRow: id } });
          }}
        />
      )}
    </>
  );
}

function SuppliedWorkersModal({ workers, onClose, onPick }: {
  workers: SuppliedWorker[];
  onClose: () => void;
  onPick: (personId: string) => void;
}) {
  const [q, setQ] = useState('');
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return workers;
    return workers.filter((w) =>
      `${w.display_name} ${w.trade ?? ''} ${w.level ?? ''} ${w.status}`
        .toLowerCase().includes(needle));
  }, [workers, q]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card" style={{ width: 'min(560px, 96vw)' }}>
        <div className="modal-head">
          <h3>Supplied workers · {workers.length}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div style={{ padding: '14px 20px 6px' }}>
          <div className="dir-search" style={{ marginLeft: 0, width: '100%' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter by name, trade, level…" value={q} autoFocus
                   onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
          </div>
        </div>
        <div className="supplied-modal-list">
          {visible.length === 0 && (
            <p className="set-note" style={{ padding: '10px 20px' }}>No matches.</p>
          )}
          {visible.map((w) => (
            <button className="supplied-modal-row" key={w.person_id}
                    onClick={() => onPick(w.person_id)}>
              <div className="dir-avatar sm" style={{
                borderRadius: 9,
                background: w.avatar_url ? 'var(--surface-2)' : avatarGradient(w.display_name),
              }}>
                {w.avatar_url ? <img src={w.avatar_url} alt="" /> : initials(w.display_name)}
              </div>
              <div className="session-main cell">
                <div className="cell-top"><b>{w.display_name}</b></div>
                <div className="cell-sub">{[w.trade, w.level].filter(Boolean).join(' · ') || 'no profile'}</div>
              </div>
              {w.level && (
                <span className="lvl-badge">
                  <b style={{ '--lvl': w.level_color ?? '#8a93a6' } as CSSProperties}>{w.level}</b>
                </span>
              )}
              <span className="chip custom" style={{ '--chip': w.status_color } as CSSProperties}>
                <span className="dot" />{w.status_label}
              </span>
            </button>
          ))}
        </div>
        <div className="modal-foot">
          <span className="result-count">{visible.length} of {workers.length} shown</span>
        </div>
      </div>
    </div>
  );
}

const NEW_CONTACT_ERRORS: Record<string, string> = {
  email_in_use: 'That email is already in use.',
  already_a_contact: 'That person is already a contact of this org.',
  rank_too_low: "You don't have permission to grant that tier.",
  invalid_functions: 'Functions must be short, unique tags (max 12).',
};

function ContactsPanel({ cfg, orgId, contacts, canManage, onChanged }: {
  cfg: OrgConfig;
  orgId: string;
  contacts: ContactItem[] | undefined;
  canManage: boolean;
  onChanged: (list: ContactItem[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const refresh = async () => {
    const resp = await apiFetch(`${cfg.apiBase}/${orgId}/contacts`);
    if (resp.ok) onChanged(await resp.json());
  };

  const errorFor = async (resp: Response, fallback: string): Promise<string> => {
    try {
      const code = (await resp.json())?.detail?.code;
      return NEW_CONTACT_ERRORS[code] ?? fallback;
    } catch {
      return fallback;
    }
  };

  const remove = async (personId: string) => {
    setBusy(true);
    setError('');
    const resp = await apiFetch(`${cfg.apiBase}/${orgId}/contacts/${personId}`, { method: 'DELETE' });
    if (!resp.ok) {
      setError(await errorFor(resp, 'Could not remove contact — try again.'));
      setBusy(false);
      return;
    }
    await refresh();
    setBusy(false);
  };

  const linked = new Set((contacts ?? []).map((c) => c.person_id));

  return (
    <>
      {contacts === undefined && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
      {contacts?.length === 0 && (
        <p className="set-note" style={{ padding: 0 }}>No contacts linked yet.</p>
      )}
      {contacts?.map((c) => (
        <div className="session-item" key={c.person_id} style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="dir-avatar sm" style={{
            borderRadius: 9,
            background: c.avatar_url ? 'var(--surface-2)' : avatarGradient(c.display_name),
          }}>
            {c.avatar_url ? <img src={c.avatar_url} alt="" /> : initials(c.display_name)}
          </div>
          <div className="session-main cell">
            <div className="cell-top"><b>{c.display_name}</b></div>
            <div className="mono">{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</div>
          </div>
          {c.has_account
            ? <span className="chip c-green" title="Has portal access"><span className="dot" />portal</span>
            : <span className="chip tag">no login</span>}
          <span className="chip tag">{TIER_LABEL[c.tier]}</span>
          {canManage && (
            <button className="mini-btn" disabled={busy} title="Remove contact"
                    onClick={() => void remove(c.person_id)}>✕</button>
          )}
          <div style={{
            flexBasis: '100%', display: 'flex', gap: 8, marginTop: 8,
            alignItems: 'center', flexWrap: 'wrap',
          }}>
            <span className="chip tag">{c.org_title ?? 'no title'}</span>
            <div className="chips">
              {c.functions.length === 0 && <span className="chip tag">no functions</span>}
              {c.functions.map((f) => <span key={f} className="chip c-blue">{f}</span>)}
            </div>
          </div>
        </div>
      ))}

      {canManage && (
        <div style={{ marginTop: 14 }}>
          <button className="mini-btn accent" disabled={busy} onClick={() => setAddOpen(true)}>
            + Add contact
          </button>
        </div>
      )}

      {error && <p className="pf-error" style={{ padding: '8px 0 0' }}>{error}</p>}

      {canManage && addOpen && (
        <AddContactModal
          cfg={cfg}
          orgId={orgId}
          linkedIds={linked}
          onClose={() => setAddOpen(false)}
          onAdded={() => { setAddOpen(false); void refresh(); }}
        />
      )}
    </>
  );
}

/* ── add contact modal — picker + optional create-new-contact toggle ── */

function AddContactModal({ cfg, orgId, linkedIds, onClose, onAdded }: {
  cfg: OrgConfig;
  orgId: string;
  linkedIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { can } = useAuth();
  const canCreatePerson = can('users', 'add');

  const [people, setPeople] = useState<PersonPick[] | null>(null);
  const [pick, setPick] = useState('');
  const [tier, setTier] = useState<ContactTier>('viewer');
  const [showNew, setShowNew] = useState(false);
  const [ncForm, setNcForm] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  // Person created by a failed earlier attempt (created but not linked):
  // while set, submit must only retry the link — never POST /users again.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void apiFetch('/people').then(async (r) => {
      if (r.ok) setPeople(await r.json());
    });
  }, []);

  const set = (key: keyof typeof ncForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setNcForm({ ...ncForm, [key]: e.target.value });

  const errorFor = async (resp: Response, fallback: string): Promise<string> => {
    try {
      const code = (await resp.json())?.detail?.code;
      return NEW_CONTACT_ERRORS[code] ?? fallback;
    } catch {
      return fallback;
    }
  };

  const canSubmit = createdId !== null || (showNew
    ? !!ncForm.first_name.trim() && !!ncForm.last_name.trim()
    : !!pick);

  const toggleMode = () => {
    setShowNew((v) => !v);
    setError('');
    setPick('');
    setNcForm({ first_name: '', last_name: '', email: '', phone: '' });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');

    const plan = planAddContact({ showNew, pick, createdPersonId: createdId });
    let personId = plan.personId;
    if (plan.needsCreate) {
      const personResp = await apiFetch('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildNewContactPersonPayload(ncForm)),
      });
      if (!personResp.ok) {
        setError(await errorFor(personResp, 'Could not create the contact — check the fields and try again.'));
        setSaving(false);
        return;
      }
      const created = await personResp.json();
      personId = created.person_id;
      setCreatedId(personId);
      // Make the new person visible to the picker so a link retry can
      // show them pre-selected by name.
      setPeople((prev) => [...(prev ?? []), {
        person_id: created.person_id,
        display_name: created.display_name
          ?? `${ncForm.first_name.trim()} ${ncForm.last_name.trim()}`.trim(),
        email: ncForm.email.trim() || null,
        job_title: null,
        has_account: false,
      }]);
    }

    try {
      await addContactLink(cfg.kind, orgId, personId, tier);
    } catch (err) {
      const reason = err instanceof ApiError ? NEW_CONTACT_ERRORS[err.code] : undefined;
      const recovery = afterLinkFailure(
        plan.needsCreate || createdId ? personId : null, reason);
      if (recovery) {
        setShowNew(recovery.showNew);
        setPick(recovery.pick);
        setError(recovery.message);
      } else {
        setError(err instanceof ApiError
          ? (NEW_CONTACT_ERRORS[err.code] ?? 'Could not add the contact — try again.')
          : 'Network error.');
      }
      setSaving(false);
      return;
    }
    setCreatedId(null);
    setSaving(false);
    onAdded();
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Add contact</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            {!showNew ? (
              <div className="pf-form">
                <div className="full"><label>Person *</label>
                  <ComboBox
                    placeholder="Type to search people…"
                    value={pick}
                    onChange={setPick}
                    options={(people ?? [])
                      .filter((p) => !linkedIds.has(p.person_id))
                      .map((p) => ({
                        value: p.person_id,
                        label: p.display_name,
                        sub: p.email ?? p.job_title,
                      }))}
                  /></div>
                <div><label>Tier</label>
                  <TierSelect value={tier} onChange={setTier} /></div>
              </div>
            ) : (
              <>
                <div className="modal-section">New person</div>
                <div className="pf-form">
                  <div><label>First name *</label>
                    <input value={ncForm.first_name} onChange={set('first_name')} required /></div>
                  <div><label>Last name *</label>
                    <input value={ncForm.last_name} onChange={set('last_name')} required /></div>
                  <div><label>Email</label>
                    <input type="email" value={ncForm.email} onChange={set('email')} /></div>
                  <div><label>Phone</label>
                    <input value={ncForm.phone} onChange={set('phone')} /></div>
                  <div><label>Tier</label>
                    <TierSelect value={tier} onChange={setTier} /></div>
                </div>
              </>
            )}
            {canCreatePerson && createdId === null && (
              <button type="button" className="link-plain" style={{ marginTop: 12 }}
                      onClick={toggleMode}>
                {showNew ? '← Pick an existing person instead' : "Can't find them? Create a new contact"}
              </button>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving || !canSubmit}>
              {saving ? 'Saving…' : 'Add contact'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── create / edit modal ────────────────────────────────────────── */
/* ORG_ERRORS now lives in lib/orgs.ts, shared with GodCell's error map. */

function OrgFormModal({ cfg, org, partnerTypes, onClose, onSaved }: {
  cfg: OrgConfig;
  org: OrgItem | null;
  partnerTypes: StatusValue[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [types, setTypes] = useState<Set<string>>(new Set(org?.partner_types ?? []));
  const [form, setForm] = useState({
    name: org?.name ?? '',
    code: org?.code ?? '',
    status: org?.status ?? 'active',
    tier: org?.tier ?? 'standard',
    service_region: org?.service_region ?? '',
    phone: org?.phone ?? '',
    website: org?.website ?? '',
    city: org?.city ?? '',
    region: org?.region ?? '',
    notes: org?.notes ?? '',
    account_manager_id: org?.account_manager?.id ?? '',
  });
  const [people, setPeople] = useState<PersonPick[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void apiFetch('/people').then(async (r) => {
      if (r.ok) setPeople(await r.json());
    });
  }, []);

  const set = (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      status: form.status,
      phone: form.phone.trim() || null,
      website: form.website.trim() || null,
      city: form.city.trim() || null,
      region: form.region.trim() || null,
      notes: form.notes.trim() || null,
      account_manager_id: form.account_manager_id || null,
    };
    // tier is client-only, service_region is partner-only — the API
    // rejects (422) the other kind's field outright, so never send it.
    if (cfg.kind === 'client') payload.tier = form.tier;
    else payload.service_region = form.service_region.trim() || null;
    if (cfg.hasType) payload.partner_types = [...types];
    const resp = await apiFetch(org ? `${cfg.apiBase}/${org.id}` : cfg.apiBase, {
      method: org ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      let code = 'unknown';
      try { code = (await resp.json())?.detail?.code ?? code; } catch { /* noop */ }
      setError(ORG_ERRORS[code] ?? 'Could not save — check the fields.');
      setSaving(false);
      return;
    }
    const saved = await resp.json();
    onSaved(saved.id);
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{org ? `Edit ${org.name}` : cfg.addLabel}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="pf-form">
              <div><label>Name *</label>
                <input value={form.name} onChange={set('name')} required /></div>
              <div><label>Code</label>
                <input value={form.code} onChange={set('code')} placeholder="ACME" /></div>
              {cfg.hasType && (
                <div className="full"><label>Types (a partner can do several)</label>
                  <TagInput
                    value={[...types]}
                    onChange={(tags) => setTypes(new Set(tags))}
                    options={partnerTypes.map((t) => ({ value: t.key, label: t.label }))}
                    placeholder="Type to add a type…"
                  />
                </div>
              )}
              <div><label>Status</label>
                <select className="org-select" value={form.status} onChange={set('status')}>
                  {cfg.kind === 'client' && <option value="prospect">Prospect</option>}
                  <option value="active">Active</option>
                  <option value="inactive">In-Active</option>
                </select></div>
              {cfg.kind === 'client' ? (
                <div><label>Tier</label>
                  <select className="org-select" value={form.tier} onChange={set('tier')}>
                    <option value="standard">Standard</option>
                    <option value="preferred">Preferred</option>
                    <option value="strategic">Strategic</option>
                  </select></div>
              ) : (
                <div><label>Service region</label>
                  <input value={form.service_region} onChange={set('service_region')}
                         placeholder="e.g. Southeast US" /></div>
              )}
              <div><label>Account manager</label>
                <ComboBox
                  placeholder="Type to search people…"
                  value={form.account_manager_id}
                  clearable
                  onChange={(v) => setForm({ ...form, account_manager_id: v })}
                  options={(people ?? []).map((p) => ({
                    value: p.person_id,
                    label: p.display_name,
                    sub: p.email,
                  }))}
                /></div>
              <div><label>Phone</label>
                <input value={form.phone} onChange={set('phone')} /></div>
              <div><label>Website</label>
                <input value={form.website} onChange={set('website')}
                       placeholder="https://…" /></div>
              <div><label>City</label>
                <input value={form.city} onChange={set('city')} /></div>
              <div><label>State / region</label>
                <input value={form.region} onChange={set('region')} /></div>
              <div className="full"><label>Notes</label>
                <input value={form.notes} onChange={set('notes')} /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : org ? 'Save changes' : `Create ${cfg.kind}`}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
