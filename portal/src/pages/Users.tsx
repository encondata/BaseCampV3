/**
 * Users directory — fibertrace directory-list pattern, full toolbar:
 * quick-filter pills · advanced Filters (facets) · Columns picker ·
 * CSV Export · Add person (create modal). Search lives in the topbar.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  AccountStateModal,
  AdminEditProfileModal,
  ManageRolesModal,
  ResetPasswordModal,
} from '../components/UserAdminModals';
import { apiFetch, ApiError } from '../lib/api';
import { canTouchRank } from '../lib/access';
import { avatarGradient, initials, longDate, relativeTime } from '../lib/format';
import '../styles/directory.css';
import '../styles/profile.css';   /* .pf-form, .btn-solid */
import '../styles/settings.css';  /* .set-note */

interface UserItem {
  person_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  display_name: string;
  job_title: string | null;
  phone: string | null;
  contact_email: string | null;
  login_email: string | null;
  roles: string[];
  status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  account_created_at: string | null;
  archived_at: string | null;
  avatar_url: string | null;
  max_rank: number;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'c-green' },
  locked: { label: 'Locked', cls: 'c-amber' },
  disabled: { label: 'Disabled', cls: 'c-red' },
};

const ROLE_CLS: Record<string, string> = {
  admin: 'c-amber', staff: 'c-blue', worker: 'c-green',
  client: 'c-violet', vendor: 'c-violet', external: 'c-blue',
};

const ALL_ROLES = ['admin', 'staff', 'worker', 'client', 'vendor', 'external'];
const PILLS = [
  { key: 'all', label: 'Everyone' },
  { key: 'active', label: 'Active' },
  { key: 'locked', label: 'Locked' },
  { key: 'disabled', label: 'Disabled' },
];

/* column registry: name is fixed-first, chevron fixed-last */
const COLUMNS = [
  { key: 'roles', label: 'Roles', width: '1.4fr', default: true },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'job_title', label: 'Job title', width: '1.3fr', default: false },
  { key: 'contact_email', label: 'Contact email', width: '1.6fr', default: false },
  { key: 'phone', label: 'Phone', width: '1.2fr', default: false },
  { key: 'last_login', label: 'Last sign-in', width: '1.1fr', default: true },
  { key: 'created', label: 'Created', width: '1.1fr', default: false },
] as const;

type ColKey = (typeof COLUMNS)[number]['key'];
type SortKey = 'name' | ColKey;

const CSV_COLUMNS: [string, (u: UserItem) => string][] = [
  ['Person ID', (u) => u.person_id],
  ['First name', (u) => u.first_name],
  ['Last name', (u) => u.last_name],
  ['Preferred name', (u) => u.preferred_name ?? ''],
  ['Login email', (u) => u.login_email ?? ''],
  ['Contact email', (u) => u.contact_email ?? ''],
  ['Phone', (u) => u.phone ?? ''],
  ['Job title', (u) => u.job_title ?? ''],
  ['Roles', (u) => u.roles.join('; ')],
  ['Status', (u) => u.status],
  ['Password change required', (u) => String(u.must_change_password)],
  ['Last sign-in', (u) => u.last_login_at ?? ''],
  ['Account created', (u) => u.account_created_at ?? ''],
];

function exportCsv(rows: UserItem[]): void {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    CSV_COLUMNS.map(([h]) => esc(h)).join(','),
    ...rows.map((u) => CSV_COLUMNS.map(([, fn]) => esc(fn(u))).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

interface Facets {
  roles: Set<string>;
  mustChange: boolean;
}

type ManageAction =
  | { kind: 'edit' | 'reset' | 'roles'; user: UserItem }
  | { kind: 'state'; action: 'disable' | 'enable' | 'unlock'; user: UserItem };

export default function Users() {
  const { person: mePerson, can, maxRank } = useAuth();
  const [manage, setManage] = useState<ManageAction | null>(null);
  const [query, setQuery] = useState('');
  const location = useLocation();
  const navigate = useNavigate();

  const [users, setUsers] = useState<UserItem[] | null>(null);
  const [error, setError] = useState('');
  const [pill, setPill] = useState('all');
  const [facets, setFacets] = useState<Facets>({ roles: new Set(), mustChange: false });
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(
    new Set(COLUMNS.filter((c) => c.default).map((c) => c.key)));
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pop, setPop] = useState<'filters' | 'columns' | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = async () => {
    const resp = await apiFetch('/users');
    if (!resp.ok) {
      setError(resp.status === 403
        ? 'You do not have permission to view users.' : 'Failed to load users.');
      return;
    }
    setUsers(await resp.json());
  };

  useEffect(() => { void load(); }, []);

  // command-palette handoffs: open Add modal / jump to a row
  useEffect(() => {
    const state = location.state as { openAdd?: boolean; openRow?: string } | null;
    if (state?.openAdd) setAddOpen(true);
    if (state?.openRow) setOpenId(state.openRow);
    if (state?.openAdd || state?.openRow) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  // close popovers on outside click
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.pop-wrap')) setPop(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [pop]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: users?.length ?? 0 };
    for (const p of PILLS.slice(1)) c[p.key] = 0;
    for (const u of users ?? []) c[u.status] = (c[u.status] ?? 0) + 1;
    return c;
  }, [users]);

  const activeFacetCount = facets.roles.size + (facets.mustChange ? 1 : 0);

  const visible = useMemo(() => {
    if (!users) return [];
    const q = query.trim().toLowerCase();
    const rows = users.filter((u) => {
      if (pill !== 'all' && u.status !== pill) return false;
      if (facets.roles.size > 0 && !u.roles.some((r) => facets.roles.has(r))) return false;
      if (facets.mustChange && !u.must_change_password) return false;
      if (!q) return true;
      const hay = `${u.display_name} ${u.login_email ?? ''} ${u.contact_email ?? ''} ` +
        `${u.job_title ?? ''} ${u.phone ?? ''} ${u.roles.join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
    const val = (u: UserItem): string => {
      switch (sortKey) {
        case 'name': return u.display_name.toLowerCase();
        case 'roles': return u.roles.join(',');
        case 'status': return u.status;
        case 'job_title': return (u.job_title ?? '').toLowerCase();
        case 'contact_email': return u.contact_email ?? '';
        case 'phone': return u.phone ?? '';
        case 'last_login': return u.last_login_at ?? '';
        case 'created': return u.account_created_at ?? '';
      }
    };
    return rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
  }, [users, pill, facets, query, sortKey, sortDir]);

  // hide the open row if filtering hid it (only once data is loaded —
  // otherwise this races the openRow handoff from global search / palette)
  useEffect(() => {
    if (users && openId && !visible.some((u) => u.person_id === openId)) {
      setOpenId(null);
    }
  }, [users, visible, openId]);

  const shownCols = COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = {
    gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px`,
  };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const cellFor = (u: UserItem, key: ColKey) => {
    switch (key) {
      case 'roles':
        return (
          <div className="chips">
            {u.roles.length === 0 && <span className="chip tag">no roles</span>}
            {u.roles.map((r) => (
              <span key={r} className={`chip ${ROLE_CLS[r] ?? 'tag'}`}>{r}</span>
            ))}
          </div>
        );
      case 'status': {
        const meta = STATUS_META[u.status] ?? { label: u.status, cls: 'tag' };
        return <span className={`chip ${meta.cls}`}><span className="dot" />{meta.label}</span>;
      }
      case 'job_title':
        return <span className="cell-top">{u.job_title ?? '—'}</span>;
      case 'contact_email':
        return <span className="mono">{u.contact_email ?? '—'}</span>;
      case 'phone':
        return <span className="mono">{u.phone ?? '—'}</span>;
      case 'last_login':
        return <span className="mono">{relativeTime(u.last_login_at)}</span>;
      case 'created':
        return <span className="mono">{longDate(u.account_created_at)}</span>;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">People</div>
          <h1 className="page-title">
            Users
            <span className="badge-count">{users?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Everyone who can sign in to the portal — accounts, roles, and access state.
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
          <span className="result-count">{visible.length} of {users?.length ?? 0} shown</span>

          <div className="pop-wrap">
            <button className="btn-ghost" onClick={() => setPop(pop === 'filters' ? null : 'filters')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 3H2l8 9.5V19l4 2v-8.5z" />
              </svg>
              Filters
              {activeFacetCount > 0 && <span className="fbadge">{activeFacetCount}</span>}
            </button>
            {pop === 'filters' && (
              <div className="pop-menu">
                <div className="pop-title">Role</div>
                {ALL_ROLES.map((r) => {
                  const on = facets.roles.has(r);
                  return (
                    <button key={r} className={`pop-item ${on ? 'on' : ''}`}
                            onClick={() => setFacets((f) => {
                              const roles = new Set(f.roles);
                              if (on) roles.delete(r); else roles.add(r);
                              return { ...f, roles };
                            })}>
                      <span className="pop-check">
                        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor"
                             strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                      </span>
                      {r}
                    </button>
                  );
                })}
                <div className="pop-sep" />
                <div className="pop-title">Account</div>
                <button className={`pop-item ${facets.mustChange ? 'on' : ''}`}
                        onClick={() => setFacets((f) => ({ ...f, mustChange: !f.mustChange }))}>
                  <span className="pop-check">
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor"
                         strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                  </span>
                  Password change required
                </button>
                {activeFacetCount > 0 && (
                  <>
                    <div className="pop-sep" />
                    <button className="pop-item"
                            onClick={() => setFacets({ roles: new Set(), mustChange: false })}>
                      Clear all filters
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="pop-wrap">
            <button className="btn-ghost" onClick={() => setPop(pop === 'columns' ? null : 'columns')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round"><path d="M9 3v18M15 3v18M3 5.5h18M3 5.5v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-13a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z" /></svg>
              Columns
            </button>
            {pop === 'columns' && (
              <div className="pop-menu">
                <div className="pop-title">Visible columns</div>
                {COLUMNS.map((c) => {
                  const on = visibleCols.has(c.key);
                  return (
                    <button key={c.key} className={`pop-item ${on ? 'on' : ''}`}
                            onClick={() => setVisibleCols((prev) => {
                              const next = new Set(prev);
                              if (on) next.delete(c.key); else next.add(c.key);
                              return next;
                            })}>
                      <span className="pop-check">
                        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor"
                             strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                      </span>
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <button className="btn-ghost" onClick={() => exportCsv(visible)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            Export
          </button>

          <button className="btn-solid" onClick={() => setAddOpen(true)}>
            + Add person
          </button>
        </div>
      </div>

      <div className="dir-list">
        <div className="list-head" style={grid}>
          <button className="sortable" onClick={() => toggleSort('name')}>Name {caret('name')}</button>
          {shownCols.map((c) => (
            <button key={c.key} className="sortable" onClick={() => toggleSort(c.key)}>
              {c.label} {caret(c.key)}
            </button>
          ))}
          <span />
        </div>

        {error && <div className="dir-empty"><b>Cannot load users</b>{error}</div>}
        {!error && users && visible.length === 0 && (
          <div className="dir-empty"><b>No matches</b>Try a different search or filter.</div>
        )}

        {visible.map((u) => {
          const open = openId === u.person_id;
          const status = STATUS_META[u.status] ?? { label: u.status, cls: 'tag' };
          return (
            <div key={u.person_id} className={`dir-row ${open ? 'open' : ''}`}>
              <div className="row-main" style={grid}
                   onClick={() => setOpenId(open ? null : u.person_id)}>
                <div className="cell cell-primary">
                  <div className="dir-avatar"
                       style={{ background: u.avatar_url ? 'var(--surface-2)' : avatarGradient(u.display_name) }}>
                    {u.avatar_url
                      ? <img src={u.avatar_url} alt="" />
                      : initials(u.display_name)}
                  </div>
                  <div className="pn">
                    <b>{u.display_name}</b>
                    <span>{u.login_email ?? u.contact_email ?? '—'}</span>
                  </div>
                </div>
                {shownCols.map((c) => (
                  <div className="cell" key={c.key}>{cellFor(u, c.key)}</div>
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
                        <p className="eyebrow-sm">Profile</p>
                        <dl className="kv">
                          <dt>Person ID</dt><dd className="mono">{u.person_id}</dd>
                          <dt>Job title</dt><dd>{u.job_title ?? '—'}</dd>
                          <dt>Contact email</dt><dd className="mono">{u.contact_email ?? '—'}</dd>
                          <dt>Phone</dt><dd className="mono">{u.phone ?? '—'}</dd>
                        </dl>
                        <p className="eyebrow-sm">Roles</p>
                        <div className="chips">
                          {u.roles.length === 0 && <span className="chip tag">none granted</span>}
                          {u.roles.map((r) => (
                            <span key={r} className={`chip ${ROLE_CLS[r] ?? 'tag'}`}>{r}</span>
                          ))}
                        </div>
                      </div>
                      <div className="detail-block">
                        <p className="eyebrow-sm">Account</p>
                        <dl className="kv">
                          <dt>Login email</dt><dd className="mono">{u.login_email ?? '—'}</dd>
                          <dt>Status</dt>
                          <dd><span className={`chip ${status.cls}`}><span className="dot" />{status.label}</span></dd>
                          <dt>Last sign-in</dt><dd className="mono">{relativeTime(u.last_login_at)}</dd>
                          <dt>Created</dt><dd className="mono">{longDate(u.account_created_at)}</dd>
                          <dt>Password</dt>
                          <dd>{u.must_change_password
                            ? <span className="chip c-amber"><span className="dot" />change required</span>
                            : 'set'}</dd>
                        </dl>
                        {(() => {
                          const isSelf = u.person_id === mePerson?.id;
                          const canTouch = !isSelf && canTouchRank(maxRank, u.max_rank);
                          const canManageUsers = canTouch && can('users', 'change');
                          const canManageRoles = canTouch && can('access', 'change');
                          if (isSelf) {
                            return (
                              <div className="detail-actions">
                                <span className="self-note">
                                  This is you — your details, password, and
                                  sessions live on your profile.
                                </span>
                                <button className="mini-btn accent"
                                        onClick={() => navigate('/me')}>
                                  Go to My profile
                                </button>
                              </div>
                            );
                          }
                          if (!canTouch) {
                            return (
                              <div className="detail-actions">
                                <span className="self-note">
                                  Read-only — {u.display_name}'s rank is at or above yours.
                                </span>
                              </div>
                            );
                          }
                          if (!canManageUsers && !canManageRoles) return null;
                          const guard = (title: string) => title;
                          return (
                            <div className="detail-actions">
                              {canManageUsers && (
                                <button className="mini-btn accent"                                       title={guard('Edit identity fields')}
                                        onClick={() => setManage({ kind: 'edit', user: u })}>
                                  Edit profile
                                </button>
                              )}
                              {canManageUsers && (
                                <button className="mini-btn"                                       title={guard('Set a temporary password')}
                                        onClick={() => setManage({ kind: 'reset', user: u })}>
                                  Reset password
                                </button>
                              )}
                              {canManageRoles && (
                                <button className="mini-btn"                                       title={guard('Grant or revoke roles')}
                                        onClick={() => setManage({ kind: 'roles', user: u })}>
                                  Manage roles
                                </button>
                              )}
                              {canManageUsers && u.status === 'locked' && (
                                <button className="mini-btn"                                         title={guard('Clear the failed-attempt lockout')}
                                        onClick={() => setManage({ kind: 'state', action: 'unlock', user: u })}>
                                  Unlock
                                </button>
                              )}
                              {canManageUsers && (u.status === 'disabled' ? (
                                <button className="mini-btn"                                         title={guard('Restore sign-in')}
                                        onClick={() => setManage({ kind: 'state', action: 'enable', user: u })}>
                                  Enable account
                                </button>
                              ) : (
                                <button className="mini-btn danger"                                         title={guard('Block sign-in and revoke sessions')}
                                        onClick={() => setManage({ kind: 'state', action: 'disable', user: u })}>
                                  Disable account
                                </button>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {manage?.kind === 'edit' && (
        <AdminEditProfileModal user={manage.user}
          onClose={() => setManage(null)}
          onSaved={() => { setManage(null); void load(); }}
          onAvatarChanged={() => void load()} />
      )}
      {manage?.kind === 'reset' && (
        <ResetPasswordModal user={manage.user}
          onClose={() => setManage(null)}
          onDone={() => { setManage(null); void load(); }} />
      )}
      {manage?.kind === 'roles' && (
        <ManageRolesModal user={manage.user}
          onClose={() => setManage(null)}
          onSaved={() => { setManage(null); void load(); }} />
      )}
      {manage?.kind === 'state' && (
        <AccountStateModal user={manage.user} action={manage.action}
          onClose={() => setManage(null)}
          onDone={() => { setManage(null); void load(); }} />
      )}

      {addOpen && (
        <AddPersonModal
          onClose={() => setAddOpen(false)}
          onCreated={(personId) => {
            setAddOpen(false);
            void load().then(() => setOpenId(personId));
          }}
        />
      )}
    </div>
  );
}

/* ── Add person modal ───────────────────────────────────────────── */

const ADD_ERRORS: Record<string, string> = {
  email_in_use: 'That login email is already in use.',
  login_details_required: 'Login email and temporary password are required to create an account.',
  role_requires_org: 'That role needs a client or partner to scope to — grant it from the org contacts instead.',
  rank_too_low: 'You do not have sufficient rank to grant one of the selected roles.',
};

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const pick = () => chars[Math.floor(Math.random() * chars.length)];
  return `${Array.from({ length: 14 }, pick).join('')}!`;
}

function AddPersonModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (personId: string) => void;
}) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', preferred_name: '', contact_email: '',
    phone: '', job_title: '', login_email: '', temp_password: generatePassword(),
  });
  const [roles, setRoles] = useState<Set<string>>(new Set(['staff']));
  const [createAccount, setCreateAccount] = useState(true);
  const [mustChange, setMustChange] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const resp = await apiFetch('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          preferred_name: form.preferred_name.trim() || null,
          contact_email: form.contact_email.trim() || null,
          phone: form.phone.trim() || null,
          job_title: form.job_title.trim() || null,
          roles: [...roles],
          create_account: createAccount,
          login_email: createAccount ? form.login_email.trim() : null,
          temp_password: createAccount ? form.temp_password : null,
          must_change_password: mustChange,
        }),
      });
      if (!resp.ok) {
        let code = 'unknown';
        try { code = (await resp.json())?.detail?.code ?? code; } catch { /* noop */ }
        setError(ADD_ERRORS[code] ?? 'Could not create — check the fields and try again.');
        return;
      }
      const created = await resp.json();
      onCreated(created.person_id);
    } catch (err) {
      setError(err instanceof ApiError ? (ADD_ERRORS[err.code] ?? err.code) : 'Network error.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Add person</h3>
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
              <div><label>Preferred name</label>
                <input value={form.preferred_name} onChange={set('preferred_name')} /></div>
              <div><label>Job title</label>
                <input value={form.job_title} onChange={set('job_title')} /></div>
              <div><label>Contact email</label>
                <input type="email" value={form.contact_email} onChange={set('contact_email')} /></div>
              <div><label>Phone</label>
                <input value={form.phone} onChange={set('phone')} /></div>
            </div>

            <div className="modal-section">Roles</div>
            <div className="role-picks">
              {ALL_ROLES.map((r) => (
                <button key={r} type="button"
                        className={`role-pick ${roles.has(r) ? 'on' : ''}`}
                        disabled={r === 'client'}
                        title={r === 'client' ? 'Needs client scoping — coming with client management' : undefined}
                        onClick={() => setRoles((prev) => {
                          const next = new Set(prev);
                          if (next.has(r)) next.delete(r); else next.add(r);
                          return next;
                        })}>
                  {r}
                </button>
              ))}
            </div>

            <div className="modal-section">Login account</div>
            <div className="pf-form">
              <div className="full" style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
                <label style={{ margin: 0 }}>
                  <input type="checkbox" checked={createAccount}
                         onChange={(e) => setCreateAccount(e.target.checked)}
                         style={{ marginRight: 7 }} />
                  Create a login account now
                </label>
                {createAccount && (
                  <label style={{ margin: 0 }}>
                    <input type="checkbox" checked={mustChange}
                           onChange={(e) => setMustChange(e.target.checked)}
                           style={{ marginRight: 7 }} />
                    Must change password at first sign-in
                  </label>
                )}
              </div>
              {createAccount && (
                <>
                  <div><label>Login email *</label>
                    <input type="email" value={form.login_email}
                           onChange={set('login_email')} required /></div>
                  <div><label>Temporary password *</label>
                    <input value={form.temp_password} onChange={set('temp_password')}
                           required minLength={10} /></div>
                </>
              )}
              {!createAccount && (
                <p className="set-note full" style={{ padding: 0, margin: 0 }}>
                  Without an account this person won't appear in the Users list —
                  they'll show in the People directory when it lands.
                </p>
              )}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create person'}
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
