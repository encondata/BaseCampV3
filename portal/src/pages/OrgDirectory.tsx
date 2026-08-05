/**
 * OrgDirectory — the stakeholders list pattern (fibertrace directory),
 * parameterized for Clients and Partners: status pills, filter, sortable
 * columns, expandable detail with logo upload, org editing, archive, and
 * a contacts panel backed by scoped role grants.
 */

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import ComboBox from '../components/ComboBox';
import TierSelect, { TIER_LABEL } from '../components/TierSelect';
import {
  addContactLink, apiFetch, ApiError, type ContactTier,
} from '../lib/api';
import {
  afterLinkFailure, buildNewContactPersonPayload, planAddContact,
} from '../lib/external';
import { initialOpenId } from '../lib/auditFormat';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import { avatarGradient, initials, longDate } from '../lib/format';
import {
  ColumnsButton,
  ExportButton,
  FilterButton,
  exportCsv,
  passesFacets,
  type ColumnDef,
  type FacetGroup,
  type FacetState,
} from '../lib/listTools';
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

interface ManagerRef { id: string; display_name: string }

interface OrgItem {
  id: string;
  name: string;
  code: string | null;
  partner_types: string[];
  status: string;
  tier: string;
  phone: string | null;
  website: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  notes: string | null;
  account_manager: ManagerRef | null;
  contact_count: number;
  logo_url: string | null;
  archived_at: string | null;
  created_at: string;
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

const STATUS_META: Record<string, { label: string; cls: string }> = {
  prospect: { label: 'Prospect', cls: 'c-blue' },
  active: { label: 'Active', cls: 'c-green' },
  dormant: { label: 'Dormant', cls: 'c-amber' },
  archived: { label: 'Archived', cls: 'c-red' },
};

const TIER_META: Record<string, string> = {
  standard: 'tag', preferred: 'c-blue', strategic: 'c-amber',
};

const TYPE_LABEL: Record<string, string> = {
  staffing: 'Staffing', logistics: 'Logistics', subcontractor: 'Subcontractor',
  consultant: 'Consultant', other: 'Other',
};

const PILLS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'prospect', label: 'Prospect' },
  { key: 'dormant', label: 'Dormant' },
  { key: 'archived', label: 'Archived' },
];

type SortKey = 'name' | 'type' | 'tier' | 'status' | 'manager' | 'contacts'
  | 'created' | 'website' | 'phone' | 'location';

function effectiveStatus(o: OrgItem): string {
  return o.archived_at ? 'archived' : o.status;
}

/* column registry (Name is fixed-first, chevron fixed-last). `type` is
   partner-only and filtered out for clients at render time. */
const ALL_COLUMNS: (ColumnDef & { partnerOnly?: boolean })[] = [
  { key: 'type', label: 'Type', width: '1.1fr', default: true, partnerOnly: true },
  { key: 'tier', label: 'Tier', width: '1fr', default: true },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'manager', label: 'Account manager', width: '1.4fr', default: true },
  { key: 'contacts', label: 'Contacts', width: '0.8fr', default: true },
  { key: 'website', label: 'Website', width: '1.5fr', default: false },
  { key: 'phone', label: 'Phone', width: '1.1fr', default: false },
  { key: 'location', label: 'Location', width: '1.3fr', default: false },
  { key: 'created', label: 'Created', width: '1.1fr', default: false },
];

function csvColumns(hasType: boolean): [string, (o: OrgItem) => string][] {
  const cols: [string, (o: OrgItem) => string][] = [
    ['ID', (o) => o.id],
    ['Name', (o) => o.name],
    ['Code', (o) => o.code ?? ''],
  ];
  if (hasType) cols.push(['Types', (o) => o.partner_types.join('; ')]);
  cols.push(
    ['Tier', (o) => o.tier],
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
  const { can } = useAuth();
  const navigate = useNavigate();

  const [orgs, setOrgs] = useState<OrgItem[] | null>(null);
  const [error, setError] = useState('');
  const [pill, setPill] = useState('all');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  useRecordFocus(orgs, (o) => o.id, (o) => o.name, setOpenId, setQuery);
  const [contacts, setContacts] = useState<Record<string, ContactItem[]>>({});
  const [editing, setEditing] = useState<OrgItem | 'new' | null>(null);
  const [facets, setFacets] = useState<FacetState>({});

  const columns = useMemo(
    () => ALL_COLUMNS.filter((c) => cfg.hasType || !c.partnerOnly),
    [cfg.hasType]);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(ALL_COLUMNS.filter((c) => c.default).map((c) => c.key)));

  const facetGroups = useMemo<FacetGroup[]>(() => {
    const groups: FacetGroup[] = [
      { key: 'tier', title: 'Tier', options: [
        { value: 'standard', label: 'Standard' },
        { value: 'preferred', label: 'Preferred' },
        { value: 'strategic', label: 'Strategic' },
      ] },
    ];
    if (cfg.hasType) {
      groups.push({ key: 'type', title: 'Type', options:
        Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label })) });
    }
    return groups;
  }, [cfg.hasType]);

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

  const visible = useMemo(() => {
    if (!orgs) return [];
    const q = query.trim().toLowerCase();
    const rows = orgs.filter((o) => {
      if (pill !== 'all' && effectiveStatus(o) !== pill) return false;
      if (!passesFacets(facets, (g) =>
        g === 'tier' ? [o.tier] : g === 'type' ? o.partner_types : [])) return false;
      if (!q) return true;
      const hay = `${o.name} ${o.code ?? ''} ${o.city ?? ''} ${o.region ?? ''} ` +
        `${o.partner_types.join(' ')} ${o.account_manager?.display_name ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
    const val = (o: OrgItem): string | number => {
      switch (sortKey) {
        case 'name': return o.name.toLowerCase();
        case 'type': return o.partner_types.join(',');
        case 'tier': return o.tier;
        case 'status': return effectiveStatus(o);
        case 'manager': return o.account_manager?.display_name.toLowerCase() ?? '';
        case 'contacts': return o.contact_count;
        case 'created': return o.created_at;
        case 'website': return o.website ?? '';
        case 'phone': return o.phone ?? '';
        case 'location': return `${o.city ?? ''} ${o.region ?? ''}`.toLowerCase();
      }
    };
    return rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
  }, [orgs, pill, query, facets, sortKey, sortDir]);

  useEffect(() => {
    if (orgs && openId && !visible.some((o) => o.id === openId)) setOpenId(null);
  }, [orgs, visible, openId]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const setArchived = async (org: OrgItem, archive: boolean) => {
    await apiFetch(`${cfg.apiBase}/${org.id}/${archive ? 'archive' : 'unarchive'}`,
      { method: 'POST' });
    void load();
  };

  const shownCols = columns.filter((c) => visibleCols.has(c.key));
  const grid = {
    gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px`,
  };

  const canManage = can(cfg.kind === 'client' ? 'clients' : 'partners', 'change');
  const canViewUsers = can('users', 'view');

  const cellFor = (o: OrgItem, key: string) => {
    switch (key) {
      case 'type':
        return (
          <div className="chips">
            {o.partner_types.length === 0 && <span className="chip tag">—</span>}
            {o.partner_types.map((t) => (
              <span key={t} className="chip tag">{TYPE_LABEL[t] ?? t}</span>
            ))}
          </div>
        );
      case 'tier':
        return <span className={`chip ${TIER_META[o.tier] ?? 'tag'}`}>{o.tier}</span>;
      case 'status': {
        const s = STATUS_META[effectiveStatus(o)];
        return <span className={`chip ${s.cls}`}><span className="dot" />{s.label}</span>;
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
          {PILLS.map((p) => (
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
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <ColumnsButton columns={columns} visible={visibleCols} onChange={setVisibleCols} />
          <ExportButton onExport={() =>
            exportCsv(cfg.title.toLowerCase(), csvColumns(cfg.hasType), visible)} />
          {canManage && (
            <button className="btn-solid" onClick={() => setEditing('new')}>
              + {cfg.addLabel}
            </button>
          )}
        </div>
      </div>

      <div className="dir-list">
        <div className="list-head" style={grid}>
          <button className="sortable" onClick={() => toggleSort('name')}>Name {caret('name')}</button>
          {shownCols.map((c) => (
            <button key={c.key} className="sortable"
                    onClick={() => toggleSort(c.key as SortKey)}>
              {c.label} {caret(c.key as SortKey)}
            </button>
          ))}
          <span />
        </div>

        {error && <div className="dir-empty"><b>Cannot load</b>{error}</div>}
        {!error && orgs && visible.length === 0 && (
          <div className="dir-empty"><b>No matches</b>Try a different filter — or add one.</div>
        )}

        {visible.map((o) => {
          const open = openId === o.id;
          return (
            <div key={o.id} className={`dir-row ${open ? 'open' : ''}`}>
              <div className="row-main" style={grid}
                   onClick={() => setOpenId(open ? null : o.id)}>
                <div className="cell cell-primary">
                  <div className="dir-avatar"
                       style={{ background: o.logo_url ? 'var(--surface-2)' : avatarGradient(o.name) }}>
                    {o.logo_url ? <img src={o.logo_url} alt="" /> : initials(o.name)}
                  </div>
                  <div className="pn">
                    <b>{o.name}</b>
                    <span>{[o.code, [o.city, o.region].filter(Boolean).join(', ')]
                      .filter(Boolean).join(' · ') || '—'}</span>
                  </div>
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
                            <dd className="mono">{o.website
                              ? <a href={o.website} target="_blank" rel="noreferrer">{o.website}</a>
                              : '—'}</dd>
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
                        {canManage && (
                          <div className="detail-actions">
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
                          </div>
                        )}
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
        })}
      </div>

      {editing && (
        <OrgFormModal
          cfg={cfg}
          org={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
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
              <div className="dir-avatar" style={{
                width: 32, height: 32, borderRadius: 9, fontSize: 11,
                background: w.avatar_url ? 'var(--surface-2)' : avatarGradient(w.display_name),
              }}>
                {w.avatar_url ? <img src={w.avatar_url} alt="" /> : initials(w.display_name)}
              </div>
              <div className="session-main">
                <b>{w.display_name}</b>
                <p>{[w.trade, w.level].filter(Boolean).join(' · ') || 'no profile'}</p>
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
          <div className="dir-avatar" style={{
            width: 30, height: 30, borderRadius: 9, fontSize: 11,
            background: c.avatar_url ? 'var(--surface-2)' : avatarGradient(c.display_name),
          }}>
            {c.avatar_url ? <img src={c.avatar_url} alt="" /> : initials(c.display_name)}
          </div>
          <div className="session-main">
            <b>{c.display_name}</b>
            <p>{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</p>
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

const ORG_ERRORS: Record<string, string> = {
  name_or_code_in_use: 'That name or code is already in use.',
  manager_not_found: 'Pick a valid account manager.',
};

function OrgFormModal({ cfg, org, onClose, onSaved }: {
  cfg: OrgConfig;
  org: OrgItem | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [types, setTypes] = useState<Set<string>>(new Set(org?.partner_types ?? []));
  const [form, setForm] = useState({
    name: org?.name ?? '',
    code: org?.code ?? '',
    status: org?.status ?? 'active',
    tier: org?.tier ?? 'standard',
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
      tier: form.tier,
      phone: form.phone.trim() || null,
      website: form.website.trim() || null,
      city: form.city.trim() || null,
      region: form.region.trim() || null,
      notes: form.notes.trim() || null,
      account_manager_id: form.account_manager_id || null,
    };
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
                  <div className="role-picks">
                    {Object.entries(TYPE_LABEL).map(([v, l]) => (
                      <button key={v} type="button"
                              className={`role-pick ${types.has(v) ? 'on' : ''}`}
                              onClick={() => setTypes((prev) => {
                                const next = new Set(prev);
                                if (next.has(v)) next.delete(v); else next.add(v);
                                return next;
                              })}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div><label>Status</label>
                <select className="org-select" value={form.status} onChange={set('status')}>
                  <option value="prospect">Prospect</option>
                  <option value="active">Active</option>
                  <option value="dormant">Dormant</option>
                </select></div>
              <div><label>Tier</label>
                <select className="org-select" value={form.tier} onChange={set('tier')}>
                  <option value="standard">Standard</option>
                  <option value="preferred">Preferred</option>
                  <option value="strategic">Strategic</option>
                </select></div>
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
