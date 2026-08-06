/**
 * External — combined directory + full management of client/partner
 * contact people: one list (not tabs), the standard Filters/Columns/
 * Export toolbar, per-org-link metadata (title + function tags), and
 * portal login lifecycle (grant/enable/disable). Gated by the `users`
 * resource — no new registry resource, no matrix migration.
 *
 * Ref: docs/superpowers/specs/2026-07-14-external-people-design.md
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import ComboBox from '../components/ComboBox';
import InlineTextField from '../components/InlineTextField';
import TagInput from '../components/TagInput';
import TierSelect from '../components/TierSelect';
import {
  addContactLink,
  adminAccountStateRequest,
  adminCreateAccountRequest,
  adminUpdateProfileRequest,
  apiFetch,
  ApiError,
  getExternal,
  patchContactLink,
  removeContactLink,
  type ContactTier,
  type ExternalDirectoryOut,
  type ExternalLinkItem,
  type ExternalPersonItem,
  type OrgKind,
} from '../lib/api';
import {
  applyExternalPatch,
  buildLinkMetaPatch,
  buildNewContactPersonPayload,
  canEditExternalPerson,
  distinctFunctions,
  distinctTitles,
  externalCellText,
  externalSearchHay,
  EXTERNAL_GOD_FIELDS,
  LOGIN_META,
  orgKey,
  parseOrgKey,
  typeLabel,
} from '../lib/external';
import { avatarGradient, initials } from '../lib/format';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import {
  ColumnsButton,
  ExportButton,
  exportCsv,
  visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import { naturalCompare } from '../lib/sites';
import { USER_ERRORS } from '../lib/users';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';

interface OrgRef { id: string; name: string; kind: OrgKind }

const PILLS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active login' },
  { key: 'disabled', label: 'Disabled login' },
  { key: 'none', label: 'No login' },
];

const COLUMNS: ColumnDef[] = [
  { key: 'orgs', label: 'Orgs', width: '1.8fr', default: true },
  { key: 'type', label: 'Type', width: '0.9fr', default: true },
  { key: 'title', label: 'Title', width: '1.3fr', default: false },
  { key: 'functions', label: 'Functions', width: '1.6fr', default: true },
  { key: 'email', label: 'Email', width: '1.6fr', default: true },
  { key: 'phone', label: 'Phone', width: '1.1fr', default: false },
  { key: 'login', label: 'Login', width: '1fr', default: true },
];

// Every column the page can offer plus 'primary' (the always-shown
// name+contact cell). No godOnly columns and no archived concept on this
// page. The old orgType/org/tier/function/login facets are gone — they're
// fully covered by ColumnMenu filtering on 'orgs'/'type'/'functions'/
// 'login', so no pseudo-column was needed (unlike Users' must_change).
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'primary']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Sort value per column key — deliberately separate from `externalCellText`:
 *  that accessor's job is display/filter text (the joined "org · tier"
 *  string, the LOGIN_META label), which would sort wrong (a joined-link
 *  string sorts by its first link's text rather than a stable key; the
 *  login label doesn't order active/disabled/none the way the raw status
 *  key does). This stays raw so columns order the way a user expects. */
function sortValueFor(p: ExternalPersonItem, key: string): string {
  switch (key) {
    case 'primary': return p.display_name.toLowerCase();
    case 'orgs': return p.links.map((l) => l.org_name).join(',').toLowerCase();
    case 'type': return typeLabel(p.links);
    case 'title': return distinctTitles(p.links).join(',').toLowerCase();
    case 'functions': return distinctFunctions(p.links).join(',').toLowerCase();
    case 'email': return p.email ?? '';
    case 'phone': return p.phone ?? '';
    case 'login': return p.login_status;
    default: return '';
  }
}

const CSV_COLUMNS: [string, (p: ExternalPersonItem) => string][] = [
  ['Person ID', (p) => p.person_id],
  ['Name', (p) => p.display_name],
  ['Email', (p) => p.email ?? ''],
  ['Phone', (p) => p.phone ?? ''],
  ['Type', (p) => typeLabel(p.links)],
  ['Orgs', (p) => p.links.map((l) => `${l.org_name} · ${l.tier}`).join('; ')],
  ['Titles', (p) => distinctTitles(p.links).join('; ')],
  ['Functions', (p) => distinctFunctions(p.links).join('; ')],
  ['Login status', (p) => p.login_status],
];

const LINK_ERRORS: Record<string, string> = {
  already_a_contact: 'That org is already linked for this person.',
  rank_too_low: "You don't have permission for that tier.",
  invalid_functions: 'Functions must be short, unique tags (max 12).',
  org_not_found: 'That organization could not be found.',
};

const NEW_CONTACT_ERRORS: Record<string, string> = {
  email_in_use: 'That email is already in use.',
  ...LINK_ERRORS,
};

const GRANT_ERRORS: Record<string, string> = {
  account_exists: 'This person already has a login account.',
  email_in_use: 'That login email is already in use.',
  rank_too_low: 'Their rank is at or above yours.',
  person_not_found: 'That person no longer exists.',
};

export default function External() {
  const { can, godMode } = useAuth();
  const god = useGodEdit();
  const location = useLocation();
  const navigate = useNavigate();

  const [dir, setDir] = useState<ExternalDirectoryOut | null>(null);
  const [error, setError] = useState('');
  const [pill, setPill] = useState('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  // Unlike the other converted pages, External has no useRecordFocus/
  // ?open= support — its only arrival path is location.state.openRow from
  // the topbar search/palette (see the effect below), handled with a plain
  // setOpenId. That was harmless while filters were session-only local
  // state, but usePersistentListState's filters now survive across visits,
  // so a persisted filter really can hide a row an arrival just opened.
  // Same ref-guard pattern as Assets.tsx, scoped to this page's one arrival
  // path — not a new deep-link feature, just keeping the existing one safe
  // under persisted filters.
  const deepLinkTarget = useRef<string | null>(null);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
  } = usePersistentListState(
    'external', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 }, ALL_COLUMN_KEYS,
  );
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [allOrgs, setAllOrgs] = useState<OrgRef[] | null>(null);

  const canClients = can('clients', 'change');
  const canPartners = can('partners', 'change');
  const canUsers = can('users', 'change');
  const canCreatePerson = can('users', 'add');
  const editPerms = { canUsers, canClients, canPartners, canCreatePerson };

  const load = async () => {
    try {
      const data = await getExternal();
      setDir(data);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view external people.'
        : 'Failed to load external people.');
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  // global-search / palette handoff
  useEffect(() => {
    const state = location.state as { openRow?: string; openAdd?: boolean } | null;
    if (state?.openRow) {
      deepLinkTarget.current = state.openRow;
      setOpenId(state.openRow);
    }
    if (state?.openAdd) setAddOpen(true);
    if (state?.openRow || state?.openAdd) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  const loadAllOrgs = async () => {
    if (allOrgs) return;
    const [cResp, pResp] = await Promise.all([
      canClients ? apiFetch('/clients') : Promise.resolve(null),
      canPartners ? apiFetch('/partners') : Promise.resolve(null),
    ]);
    const list: OrgRef[] = [];
    if (cResp?.ok) {
      const rows = await cResp.json() as { id: string; name: string; archived_at: string | null }[];
      for (const r of rows) if (!r.archived_at) list.push({ id: r.id, name: r.name, kind: 'client' });
    }
    if (pResp?.ok) {
      const rows = await pResp.json() as { id: string; name: string; archived_at: string | null }[];
      for (const r of rows) if (!r.archived_at) list.push({ id: r.id, name: r.name, kind: 'partner' });
    }
    setAllOrgs(list);
  };

  const people = dir?.people ?? [];
  const functionTags = dir?.function_tags ?? [];

  const godFields = EXTERNAL_GOD_FIELDS();
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const replaceRow = (p: ExternalPersonItem) =>
    setDir((d) => (d ? { ...d, people: d.people.map((x) => (x.person_id === p.person_id ? p : x)) } : d));

  // Same endpoint the Users page uses (PATCH /users/{id}/profile) — see
  // lib/external.ts's EXTERNAL_GOD_FIELDS comment for why only `phone`
  // qualifies here. admin_update_profile returns the full PersonDetail;
  // applyExternalPatch merges the one field god-edit can touch back into
  // the row already in state.
  const patchExternalPerson = async (
    id: string, body: Record<string, unknown>,
  ): Promise<ExternalPersonItem> => {
    const detail = await adminUpdateProfileRequest(id, body);
    const current = people.find((p) => p.person_id === id);
    if (!current) throw new Error('external row not found after save');
    return applyExternalPatch(current, detail);
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: people.length };
    for (const p of PILLS.slice(1)) c[p.key] = 0;
    for (const p of people) c[p.login_status] = (c[p.login_status] ?? 0) + 1;
    return c;
  }, [people]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = people.filter((p) => {
      if (pill !== 'all' && p.login_status !== pill) return false;
      if (!passesColumnFilters(p, filters, externalCellText)) return false;
      if (!q) return true;
      return externalSearchHay(p).includes(q);
    });
    return rows.sort((a, b) => (
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir
    ));
  }, [people, pill, filters, query, sortKey, sortDir]);

  // Auto-close the open row when it drops out of `visible` — EXCEPT the one
  // case where it just arrived via location.state.openRow and the reason
  // it's missing is a persisted column filter: then clear the filters
  // instead. See Assets.tsx for the full rationale.
  useEffect(() => {
    if (!dir || !openId || visible.some((p) => p.person_id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = people.find((p) => p.person_id === openId);
      if (target && !passesColumnFilters(target, filters, externalCellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [dir, people, visible, openId, filters, clearFilters]);

  // Release the deep-link guard once the target row is first confirmed
  // visible — see Assets.tsx for the full rationale.
  useEffect(() => {
    if (deepLinkTarget.current && visible.some((p) => p.person_id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  const editPerson = useMemo(
    () => (editId ? people.find((p) => p.person_id === editId) ?? null : null),
    [people, editId]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);
  const grid = { gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (p: ExternalPersonItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={p} gf={gf} patch={patchExternalPerson} onRowSaved={replaceRow}
                   errorMap={USER_ERRORS} disabled={!canUsers}
                   idOf={(row) => row.person_id} />
        );
      }
    }
    switch (key) {
      case 'orgs':
        return (
          <div className="chips">
            {p.links.length === 0 && <span className="chip tag">—</span>}
            {p.links.map((l) => (
              <span key={orgKey(l.kind, l.org_id)} className={`chip ${l.kind === 'client' ? 'c-blue' : 'c-violet'}`}>
                {l.org_name} · {l.tier}
              </span>
            ))}
          </div>
        );
      case 'type':
        return <span className="cell-top">{typeLabel(p.links)}</span>;
      case 'title':
        return <span className="cell-top">{distinctTitles(p.links).join(', ') || '—'}</span>;
      case 'functions':
        return (
          <div className="chips">
            {distinctFunctions(p.links).length === 0 && <span className="chip tag">—</span>}
            {distinctFunctions(p.links).map((f) => <span key={f} className="chip tag">{f}</span>)}
          </div>
        );
      case 'email':
        return <span className="mono">{p.email ?? '—'}</span>;
      case 'phone':
        return <span className="mono">{p.phone ?? '—'}</span>;
      case 'login': {
        const m = LOGIN_META[p.login_status];
        return <span className={`chip ${m.cls}`}><span className="dot" />{m.label}</span>;
      }
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">People</div>
          <h1 className="page-title">
            External
            <span className="badge-count">{dir?.people.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Client and partner contacts — org links, roles at each org, and portal login state.
          </p>
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
          <span className="result-count">{visible.length} of {people.length} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} godMode={godMode} />
          <ExportButton onExport={() => exportCsv('external-people', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canUsers} />
          {canCreatePerson && (canClients || canPartners) && (
            <button className="btn-solid" onClick={() => setAddOpen(true)}>
              + New external contact
            </button>
          )}
        </div>
      </div>

      <div className="dir-list">
        <div className="list-head" style={grid}>
          <span className="col-head">
            <button className="sortable" onClick={() => toggleSort('primary')}>
              Member {caret('primary')}
            </button>
            <ColumnMenu colKey="primary" label="Member"
                        allRows={people} filters={filters}
                        text={externalCellText}
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
                          allRows={people} filters={filters}
                          text={externalCellText}
                          filter={filters[c.key]} onFilter={setFilter}
                          sortDir={sortKey === c.key ? sortDir : null}
                          onSort={(dir) => setSort(c.key, dir)} />
            </span>
          ))}
          <span />
        </div>

        {error && <div className="dir-empty"><b>Cannot load</b>{error}</div>}
        {!error && dir && visible.length === 0 && (
          <div className="dir-empty">
            <b>No matches</b>Try a different filter — or add a contact.
            <EmptyClearFilters filters={filters} onClear={clearFilters} />
          </div>
        )}

        {visible.map((p) => {
          const open = openId === p.person_id;
          return (
            <div key={p.person_id} className={`dir-row ${open ? 'open' : ''}`}>
              <div className="row-main" style={grid}
                   onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : p.person_id); }}>
                <div className="cell cell-primary">
                  <div className="dir-avatar"
                       style={{ background: p.avatar_url ? 'var(--surface-2)' : avatarGradient(p.display_name) }}>
                    {p.avatar_url ? <img src={p.avatar_url} alt="" /> : initials(p.display_name)}
                  </div>
                  <div className="pn">
                    <b>{p.display_name}</b>
                    <span>{p.email ?? p.phone ?? '—'}</span>
                  </div>
                </div>
                {shownCols.map((c) => (
                  <div className="cell" key={c.key}>{cellFor(p, c.key)}</div>
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
                      <ExternalDetail
                        person={p}
                        canEdit={canEditExternalPerson(editPerms, p)}
                        onEdit={() => setEditId(p.person_id)}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editPerson && (
        <EditPersonModal
          person={editPerson}
          allOrgs={allOrgs}
          loadAllOrgs={() => void loadAllOrgs()}
          functionTags={functionTags}
          canClients={canClients}
          canPartners={canPartners}
          canUsers={canUsers}
          canGrantLogin={canCreatePerson}
          onClose={() => setEditId(null)}
          onChanged={() => void load()}
        />
      )}

      {addOpen && (
        <NewExternalContactModal
          allOrgs={allOrgs}
          loadAllOrgs={() => void loadAllOrgs()}
          functionTags={functionTags}
          onClose={() => setAddOpen(false)}
          onCreated={(id) => {
            setAddOpen(false);
            deepLinkTarget.current = null;
            void load().then(() => setOpenId(id));
          }}
        />
      )}
    </div>
  );
}

/* ── row detail: read-only display — the ONLY interactive element is the
 * Edit button. All mutation (org links, title/functions, login lifecycle,
 * avatar) lives in EditPersonModal. ───────────────────────────────── */

function ExternalDetail({ person, canEdit, onEdit }: {
  person: ExternalPersonItem;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Org links</p>
        {person.links.length === 0 && (
          <p className="set-note" style={{ padding: 0 }}>No org links yet.</p>
        )}
        {person.links.map((l) => (
          <div className="session-item" key={orgKey(l.kind, l.org_id)}
               style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div className="session-main">
              <b>{l.org_name}</b>
              <p>{l.kind === 'client' ? 'Client' : 'Partner'}</p>
            </div>
            <span className="chip tag">{l.tier}</span>
            <div style={{
              flexBasis: '100%', display: 'flex', gap: 8, marginTop: 8,
              alignItems: 'center', flexWrap: 'wrap',
            }}>
              <span className="chip tag">{l.org_title ?? 'no title'}</span>
              <div className="chips">
                {l.functions.length === 0 && <span className="chip tag">no functions</span>}
                {l.functions.map((f) => <span key={f} className="chip c-blue">{f}</span>)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Portal login</p>
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <span className={`chip ${LOGIN_META[person.login_status].cls}`}>
              <span className="dot" />{LOGIN_META[person.login_status].label}
            </span>
          </dd>
        </dl>
      </div>

      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}

/* ── edit modal: everything mutable — avatar, org links editor, login
 * lifecycle. Reuses the same components/API calls the old inline row
 * editor used; only the container changed. ─────────────────────────── */

function EditPersonModal({
  person, allOrgs, loadAllOrgs, functionTags, canClients, canPartners, canUsers,
  canGrantLogin, onClose, onChanged,
}: {
  person: ExternalPersonItem;
  allOrgs: OrgRef[] | null;
  loadAllOrgs: () => void;
  functionTags: string[];
  canClients: boolean;
  canPartners: boolean;
  canUsers: boolean;
  canGrantLogin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [addOrg, setAddOrg] = useState('');
  const [addTier, setAddTier] = useState<ContactTier>('viewer');
  const [grantOpen, setGrantOpen] = useState(false);

  const canManageLink = (kind: OrgKind) => (kind === 'client' ? canClients : canPartners);

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (LINK_ERRORS[err.code] ?? fallback) : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const updateLink = (link: ExternalLinkItem, patch: Parameters<typeof patchContactLink>[3]) =>
    run(() => patchContactLink(link.kind, link.org_id, person.person_id, patch),
      'Could not save — try again.');
  const removeLink = (link: ExternalLinkItem) =>
    run(() => removeContactLink(link.kind, link.org_id, person.person_id),
      'Could not remove the link — try again.');
  const addLink = () => {
    if (!addOrg) return;
    const { kind, orgId } = parseOrgKey(addOrg);
    void run(async () => {
      await addContactLink(kind, orgId, person.person_id, addTier);
      setAddOrg('');
    }, 'Could not add the link — try again.');
  };

  const setAccountState = (action: 'enable' | 'disable') =>
    run(() => adminAccountStateRequest(person.person_id, action),
      'Could not change the account state — try again.');

  const linkedKeys = new Set(person.links.map((l) => orgKey(l.kind, l.org_id)));
  const addableOrgs = (allOrgs ?? [])
    .filter((o) => canManageLink(o.kind))
    .filter((o) => !linkedKeys.has(orgKey(o.kind, o.id)));

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Edit — {person.display_name}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
            <AvatarUpload
              name={person.display_name}
              url={person.avatar_url}
              entityType="person"
              entityId={person.person_id}
              editable={canUsers}
              size={72}
              radius={20}
              onUploaded={() => onChanged()}
            />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-dark)' }}>
                {person.display_name}
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 2 }}>
                {person.email ?? person.phone ?? '—'}
              </div>
            </div>
          </div>

          <div className="detail-block">
            <p className="eyebrow-sm">Org links</p>
            {person.links.length === 0 && (
              <p className="set-note" style={{ padding: 0 }}>No org links yet.</p>
            )}
            {person.links.map((l) => (
              <div className="session-item" key={orgKey(l.kind, l.org_id)}
                   style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div className="session-main">
                  <b>{l.org_name}</b>
                  <p>{l.kind === 'client' ? 'Client' : 'Partner'}</p>
                </div>
                {canManageLink(l.kind) ? (
                  <TierSelect value={l.tier} disabled={busy}
                              onChange={(tier) => void updateLink(l, { tier })} />
                ) : (
                  <span className="chip tag">{l.tier}</span>
                )}
                {canManageLink(l.kind) && (
                  <button className="mini-btn" disabled={busy} title="Remove link"
                          onClick={() => void removeLink(l)}>✕</button>
                )}
                <div style={{
                  flexBasis: '100%', display: 'flex', gap: 8, marginTop: 8,
                  alignItems: 'center', flexWrap: 'wrap',
                }}>
                  {canManageLink(l.kind) ? (
                    <>
                      <InlineTextField value={l.org_title} placeholder="Title at org…" maxWidth={170}
                                        disabled={busy}
                                        onCommit={(v) => void updateLink(l, { org_title: v })} />
                      <TagInput value={l.functions} suggestions={functionTags} disabled={busy}
                                placeholder="Functions — billing, scheduling…"
                                onChange={(fns) => void updateLink(l, { functions: fns })} />
                    </>
                  ) : (
                    <>
                      <span className="chip tag">{l.org_title ?? 'no title'}</span>
                      <div className="chips">
                        {l.functions.length === 0 && <span className="chip tag">no functions</span>}
                        {l.functions.map((f) => <span key={f} className="chip c-blue">{f}</span>)}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}

            {(canClients || canPartners) && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <ComboBox
                  placeholder="Add an org link — type to search…"
                  value={addOrg}
                  onChange={setAddOrg}
                  onOpen={loadAllOrgs}
                  options={addableOrgs.map((o) => ({
                    value: orgKey(o.kind, o.id), label: o.name,
                    sub: o.kind === 'client' ? 'Client' : 'Partner',
                  }))}
                />
                <TierSelect value={addTier} onChange={setAddTier} disabled={busy} />
                <button className="mini-btn accent" disabled={!addOrg || busy}
                        onClick={addLink}>
                  Add link
                </button>
              </div>
            )}
            {error && <p className="pf-error" style={{ padding: '8px 0 0' }}>{error}</p>}
          </div>

          <div className="detail-block">
            <p className="eyebrow-sm">Portal login</p>
            <dl className="kv">
              <dt>Status</dt>
              <dd>
                <span className={`chip ${LOGIN_META[person.login_status].cls}`}>
                  <span className="dot" />{LOGIN_META[person.login_status].label}
                </span>
              </dd>
            </dl>
            {canUsers && person.login_status !== 'none' && (
              <div className="detail-actions">
                {person.login_status === 'disabled' ? (
                  <button className="mini-btn" disabled={busy}
                          onClick={() => void setAccountState('enable')}>
                    Enable account
                  </button>
                ) : (
                  <button className="mini-btn danger" disabled={busy}
                          onClick={() => void setAccountState('disable')}>
                    Disable account
                  </button>
                )}
              </div>
            )}
            {person.login_status === 'none' && (
              canGrantLogin ? (
                <div className="detail-actions">
                  <button className="mini-btn accent" disabled={busy}
                          onClick={() => setGrantOpen(true)}>
                    Grant portal access
                  </button>
                </div>
              ) : (
                <p className="set-note" style={{ padding: '10px 0 0' }}>
                  No login account.
                </p>
              )
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="mini-btn" onClick={onClose}>Done</button>
        </div>
      </div>

      {grantOpen && (
        <GrantAccessModal
          person={person}
          onClose={() => setGrantOpen(false)}
          onDone={() => { setGrantOpen(false); onChanged(); }}
        />
      )}
    </div>
  );
}

/* ── grant portal access (create account for existing person) ────── */

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(14));
  const pick = (byte: number) => chars[byte % chars.length];
  return `${Array.from(bytes, pick).join('')}!`;
}

function GrantAccessModal({ person, onClose, onDone }: {
  person: ExternalPersonItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [loginEmail, setLoginEmail] = useState(person.email ?? '');
  const [tempPassword, setTempPassword] = useState(generatePassword());
  const [mustChange, setMustChange] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await adminCreateAccountRequest(person.person_id, {
        login_email: loginEmail.trim(),
        temp_password: tempPassword,
        must_change_password: mustChange,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError
        ? (GRANT_ERRORS[err.code] ?? 'Could not create the account — check the fields.')
        : 'Network error.');
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Grant portal access — {person.display_name}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="pf-form">
              <div><label>Login email *</label>
                <input type="email" value={loginEmail} required
                       onChange={(e) => setLoginEmail(e.target.value)} /></div>
              <div><label>Temporary password *</label>
                <input value={tempPassword} required minLength={10}
                       onChange={(e) => setTempPassword(e.target.value)} /></div>
              <div className="full">
                <label style={{ margin: 0 }}>
                  <input type="checkbox" checked={mustChange}
                         onChange={(e) => setMustChange(e.target.checked)}
                         style={{ marginRight: 7 }} />
                  Must change password at first sign-in
                </label>
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create account'}
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

/* ── new external contact (one-form flow) ────────────────────────── */

function NewExternalContactModal({ allOrgs, loadAllOrgs, functionTags, onClose, onCreated }: {
  allOrgs: OrgRef[] | null;
  loadAllOrgs: () => void;
  functionTags: string[];
  onClose: () => void;
  onCreated: (personId: string) => void;
}) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', org_title: '' });
  const [org, setOrg] = useState('');
  const [tier, setTier] = useState<ContactTier>('viewer');
  const [functions, setFunctions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  const codeFrom = async (resp: Response): Promise<string> => {
    try { return (await resp.json())?.detail?.code ?? 'unknown'; } catch { return 'unknown'; }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!org) { setError('Pick an organization to link.'); return; }
    setSaving(true);
    setError('');
    const { kind, orgId } = parseOrgKey(org);

    const personResp = await apiFetch('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildNewContactPersonPayload(form)),
    });
    if (!personResp.ok) {
      const code = await codeFrom(personResp);
      setError(NEW_CONTACT_ERRORS[code] ?? 'Could not create the contact — check the fields.');
      setSaving(false);
      return;
    }
    const created = await personResp.json();

    try {
      await addContactLink(kind, orgId, created.person_id, tier);
      const metaPatch = buildLinkMetaPatch(form.org_title, functions);
      if (metaPatch) await patchContactLink(kind, orgId, created.person_id, metaPatch);
    } catch (err) {
      setError(err instanceof ApiError
        ? `Contact was created but could not be fully linked: ${NEW_CONTACT_ERRORS[err.code] ?? err.code}`
        : 'Contact created but linking failed — add the org link from the row.');
      setSaving(false);
      onCreated(created.person_id);
      return;
    }
    setSaving(false);
    onCreated(created.person_id);
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>New external contact</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="modal-section">Identity</div>
            <div className="pf-form">
              <div><label>First name *</label>
                <input value={form.first_name} onChange={set('first_name')} required /></div>
              <div><label>Last name *</label>
                <input value={form.last_name} onChange={set('last_name')} required /></div>
              <div><label>Email</label>
                <input type="email" value={form.email} onChange={set('email')} /></div>
              <div><label>Phone</label>
                <input value={form.phone} onChange={set('phone')} /></div>
            </div>

            <div className="modal-section">Organization link</div>
            <div className="pf-form">
              <div className="full"><label>Organization *</label>
                <ComboBox
                  placeholder="Type to search clients & partners…"
                  value={org}
                  onChange={setOrg}
                  onOpen={loadAllOrgs}
                  options={(allOrgs ?? []).map((o) => ({
                    value: orgKey(o.kind, o.id), label: o.name,
                    sub: o.kind === 'client' ? 'Client' : 'Partner',
                  }))}
                /></div>
              <div><label>Tier</label>
                <TierSelect value={tier} onChange={setTier} /></div>
              <div><label>Title at org</label>
                <input value={form.org_title} onChange={set('org_title')} placeholder="VP Sales…" /></div>
              <div className="full"><label>Functions</label>
                <TagInput value={functions} onChange={setFunctions} suggestions={functionTags}
                          placeholder="billing, scheduling, escalation…" /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create contact'}
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
