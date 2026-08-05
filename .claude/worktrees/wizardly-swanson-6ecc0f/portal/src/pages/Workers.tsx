/**
 * Workers — people holding the worker role. Directory pattern with
 * trade / level badge / partner rollup / status, and a detail panel:
 * editable worker profile, level expectations card, certifications.
 * Blacklisting kills login access (leaving blacklist restores it).
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import ComboBox from '../components/ComboBox';
import { apiFetch } from '../lib/api';
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

interface PartnerRef { id: string; name: string }

interface WorkerItem {
  person_id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  contact_email: string | null;
  phone: string | null;
  avatar_url: string | null;
  has_account: boolean;
  trade: string | null;
  level: string | null;
  status: string;
  status_note: string | null;
  partner: PartnerRef | null;
  cert_count: number;
  certs_expired: number;
}

interface LevelDef {
  level: string;
  rank: number;
  title: string;
  description: string;
  expected_skills: string[];
}

interface Cert {
  id: string;
  name: string;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
}

const LEVEL_COLORS: Record<string, string> = {
  L1: '#8a93a6', L2: '#4dd0ff', L3: '#35e0c8',
  L4: '#3ddc84', L5: '#a78bfa', L6: '#ffb84d',
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'c-green' },
  standby: { label: 'Standby', cls: 'c-amber' },
  blacklist: { label: 'Blacklist', cls: 'c-red' },
};

const PILLS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'standby', label: 'Standby' },
  { key: 'blacklist', label: 'Blacklist' },
];

type SortKey = 'name' | 'trade' | 'level' | 'partner' | 'status' | 'certs' | 'contact';

const COLUMNS: ColumnDef[] = [
  { key: 'trade', label: 'Trade', width: '1.3fr', default: true },
  { key: 'level', label: 'Level', width: '1.2fr', default: true },
  { key: 'partner', label: 'Partner', width: '1.4fr', default: true },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'certs', label: 'Certs', width: '0.9fr', default: false },
  { key: 'contact', label: 'Contact', width: '1.6fr', default: false },
];

const CSV_COLUMNS: [string, (w: WorkerItem) => string][] = [
  ['Person ID', (w) => w.person_id],
  ['Name', (w) => w.display_name],
  ['Trade', (w) => w.trade ?? ''],
  ['Level', (w) => w.level ?? ''],
  ['Partner', (w) => w.partner?.name ?? 'Direct'],
  ['Status', (w) => w.status],
  ['Status note', (w) => w.status_note ?? ''],
  ['Certifications', (w) => String(w.cert_count)],
  ['Certs expired', (w) => String(w.certs_expired)],
  ['Contact email', (w) => w.contact_email ?? ''],
  ['Phone', (w) => w.phone ?? ''],
  ['Has login', (w) => String(w.has_account)],
];

function LevelBadge({ level, levels }: { level: string | null; levels: LevelDef[] }) {
  if (!level) return <span className="chip tag">unleveled</span>;
  const def = levels.find((l) => l.level === level);
  return (
    <span className="lvl-badge" title={def ? `${def.title} — ${def.description}` : level}>
      <b style={{ background: LEVEL_COLORS[level] ?? '#8a93a6' }}>{level}</b>
      <span>{def?.title ?? ''}</span>
    </span>
  );
}

export default function Workers() {
  const { can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [workers, setWorkers] = useState<WorkerItem[] | null>(null);
  const [levels, setLevels] = useState<LevelDef[]>([]);
  const [error, setError] = useState('');
  const [pill, setPill] = useState('all');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [facets, setFacets] = useState<FacetState>({});
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.default).map((c) => c.key)));

  const facetGroups = useMemo<FacetGroup[]>(() => {
    const partnerNames = new Map<string, string>();
    for (const w of workers ?? []) {
      if (w.partner) partnerNames.set(w.partner.id, w.partner.name);
    }
    return [
      { key: 'level', title: 'Level', options:
        levels.map((l) => ({ value: l.level, label: `${l.level} · ${l.title}` })) },
      { key: 'partner', title: 'Partner', options: [
        { value: '__direct__', label: 'Direct hire' },
        ...[...partnerNames].map(([value, label]) => ({ value, label })),
      ] },
      { key: 'certs', title: 'Compliance', options: [
        { value: 'expired', label: 'Has expired certs' },
      ] },
    ];
  }, [workers, levels]);

  const load = async () => {
    const resp = await apiFetch('/workers');
    if (!resp.ok) {
      setError(resp.status === 403
        ? 'You do not have permission to view workers.' : 'Failed to load workers.');
      return;
    }
    setWorkers(await resp.json());
  };

  useEffect(() => {
    void load();
    void apiFetch('/worker-levels').then(async (r) => {
      if (r.ok) setLevels(await r.json());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const state = location.state as { openRow?: string } | null;
    if (state?.openRow) {
      setOpenId(state.openRow);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: workers?.length ?? 0 };
    for (const p of PILLS.slice(1)) c[p.key] = 0;
    for (const w of workers ?? []) c[w.status] = (c[w.status] ?? 0) + 1;
    return c;
  }, [workers]);

  const visible = useMemo(() => {
    if (!workers) return [];
    const q = query.trim().toLowerCase();
    const rows = workers.filter((w) => {
      if (pill !== 'all' && w.status !== pill) return false;
      if (!passesFacets(facets, (g) =>
        g === 'level' ? (w.level ? [w.level] : [])
          : g === 'partner' ? [w.partner?.id ?? '__direct__']
            : g === 'certs' ? (w.certs_expired > 0 ? ['expired'] : [])
              : [])) return false;
      if (!q) return true;
      const hay = `${w.display_name} ${w.trade ?? ''} ${w.level ?? ''} ` +
        `${w.partner?.name ?? 'direct'} ${w.contact_email ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
    const val = (w: WorkerItem): string | number => {
      switch (sortKey) {
        case 'name': return w.display_name.toLowerCase();
        case 'trade': return (w.trade ?? '').toLowerCase();
        case 'level': return w.level ?? '';
        case 'partner': return w.partner?.name.toLowerCase() ?? '';
        case 'status': return w.status;
        case 'certs': return w.cert_count;
        case 'contact': return (w.contact_email ?? '').toLowerCase();
      }
    };
    return rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
  }, [workers, pill, query, facets, sortKey, sortDir]);

  useEffect(() => {
    if (workers && openId && !visible.some((w) => w.person_id === openId)) {
      setOpenId(null);
    }
  }, [workers, visible, openId]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const canManage = can('workers', 'change');

  const shownCols = COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = {
    gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px`,
  };

  const cellFor = (w: WorkerItem, key: string) => {
    switch (key) {
      case 'trade': return <span className="cell-top">{w.trade ?? '—'}</span>;
      case 'level': return <LevelBadge level={w.level} levels={levels} />;
      case 'partner': return <span className="cell-top">{w.partner?.name ?? 'Direct'}</span>;
      case 'status': {
        // fall back to the raw key, not to STATUS_META.active — a worker on a
        // status this page doesn't know about is not Active, and saying so
        // misreads as dispatch-eligible
        const s = STATUS_META[w.status] ?? { label: w.status, cls: 'tag' };
        return <span className={`chip ${s.cls}`}><span className="dot" />{s.label}</span>;
      }
      case 'certs':
        return w.certs_expired > 0
          ? <span className="chip c-red"><span className="dot" />{w.certs_expired} expired</span>
          : <span className="mono">{w.cert_count}</span>;
      case 'contact':
        return <span className="mono">{w.contact_email ?? w.phone ?? '—'}</span>;
      default: return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">People</div>
          <h1 className="page-title">
            Workers
            <span className="badge-count">{workers?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Field crews — trade, level, supplying partner, and deployment status.
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
          <span className="result-count">{visible.length} of {workers?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
          <ExportButton onExport={() => exportCsv('workers', CSV_COLUMNS, visible)} />
          {canManage && (
            <button className="btn-solid"
                    onClick={() => navigate('/people/users', { state: { openAdd: true } })}>
              + Add worker
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

        {error && <div className="dir-empty"><b>Cannot load workers</b>{error}</div>}
        {!error && workers && visible.length === 0 && (
          <div className="dir-empty">
            <b>No matches</b>Grant someone the worker role via Users → Manage roles.
          </div>
        )}

        {visible.map((w) => {
          const open = openId === w.person_id;
          return (
            <div key={w.person_id} className={`dir-row ${open ? 'open' : ''}`}>
              <div className="row-main" style={grid}
                   onClick={() => setOpenId(open ? null : w.person_id)}>
                <div className="cell cell-primary">
                  <div className="dir-avatar"
                       style={{ background: w.avatar_url ? 'var(--surface-2)' : avatarGradient(w.display_name) }}>
                    {w.avatar_url ? <img src={w.avatar_url} alt="" /> : initials(w.display_name)}
                  </div>
                  <div className="pn">
                    <b>{w.display_name}</b>
                    <span>{w.contact_email ?? w.phone ?? '—'}</span>
                  </div>
                </div>
                {shownCols.map((c) => (
                  <div className="cell" key={c.key}>{cellFor(w, c.key)}</div>
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
                      <WorkerDetail
                        worker={w}
                        levels={levels}
                        canManage={canManage}
                        onChanged={() => void load()}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── detail: profile edit + level card + certifications ─────────── */

function WorkerDetail({ worker, levels, canManage, onChanged }: {
  worker: WorkerItem;
  levels: LevelDef[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const levelDef = levels.find((l) => l.level === worker.level);
  // STATUS_META only knows the three seeded statuses, but the vocabulary is
  // open: a developer can create new worker statuses via Variables, and the
  // API assigns them (routes/workers.py validates against status_values, not
  // a fixed list). An unknown key must render, not crash the page for every
  // staff user. Falls back to the raw key rather than STATUS_META.active —
  // labelling a 'probation' worker "Active" would be worse than unstyled.
  const statusMeta = STATUS_META[worker.status] ?? { label: worker.status, cls: 'tag' };

  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Worker profile</p>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14 }}>
          <AvatarUpload
            name={worker.display_name}
            url={worker.avatar_url}
            entityType="person"
            entityId={worker.person_id}
            editable={canManage}
            size={60}
            radius={16}
            onUploaded={() => onChanged()}
          />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-dark)' }}>
              {worker.display_name}
            </div>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 2 }}>
              {worker.contact_email ?? worker.phone ?? '—'}
            </div>
          </div>
        </div>
        {editing ? (
          <ProfileForm worker={worker} levels={levels}
                       onDone={() => { setEditing(false); onChanged(); }}
                       onCancel={() => setEditing(false)} />
        ) : (
          <>
            <dl className="kv">
              <dt>Trade</dt><dd>{worker.trade ?? '—'}</dd>
              <dt>Level</dt><dd><LevelBadge level={worker.level} levels={levels} /></dd>
              <dt>Partner</dt><dd>{worker.partner?.name ?? 'Direct hire'}</dd>
              <dt>Status</dt>
              <dd>
                <span className={`chip ${statusMeta.cls}`}>
                  <span className="dot" />{statusMeta.label}
                </span>
              </dd>
              {worker.status_note && (
                <><dt>Status note</dt><dd>{worker.status_note}</dd></>
              )}
              <dt>Contact</dt>
              <dd className="mono">{[worker.contact_email, worker.phone]
                .filter(Boolean).join(' · ') || '—'}</dd>
              <dt>Login</dt>
              <dd>{worker.has_account
                ? (worker.status === 'blacklist'
                  ? <span className="chip c-red"><span className="dot" />disabled (blacklist)</span>
                  : <span className="chip c-green"><span className="dot" />portal access</span>)
                : <span className="chip tag">no account</span>}</dd>
            </dl>
            {canManage && (
              <div className="detail-actions">
                <button className="mini-btn accent" onClick={() => setEditing(true)}>
                  Edit profile
                </button>
              </div>
            )}
          </>
        )}

        {levelDef && !editing && (
          <>
            <p className="eyebrow-sm">{levelDef.level} · {levelDef.title} — expected skills</p>
            <p className="set-note" style={{ padding: '0 0 8px' }}>{levelDef.description}</p>
            <div className="chips">
              {levelDef.expected_skills.map((s) => (
                <span key={s} className="chip c-blue">⚡ {s}</span>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Certifications & compliance</p>
        <CertsPanel personId={worker.person_id} onChanged={onChanged} />
      </div>
    </div>
  );
}

function ProfileForm({ worker, levels, onDone, onCancel }: {
  worker: WorkerItem;
  levels: LevelDef[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [trade, setTrade] = useState(worker.trade ?? '');
  const [level, setLevel] = useState(worker.level ?? '');
  const [partnerId, setPartnerId] = useState(worker.partner?.id ?? '');
  const [partners, setPartners] = useState<PartnerRef[] | null>(null);
  const [status, setStatus] = useState(worker.status);
  const [note, setNote] = useState(worker.status_note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadPartners = async () => {
    if (partners) return;
    const resp = await apiFetch('/partners');
    if (resp.ok) {
      const body = await resp.json() as { id: string; name: string; archived_at: string | null }[];
      setPartners(body.filter((p) => !p.archived_at));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === 'blacklist' && !note.trim()) {
      setError('Blacklisting requires a reason.');
      return;
    }
    setSaving(true);
    setError('');
    const resp = await apiFetch(`/workers/${worker.person_id}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trade: trade.trim() || null,
        level: level || null,
        partner_id: partnerId || null,
        status,
        status_note: note.trim() || null,
      }),
    });
    if (!resp.ok) {
      let code = 'unknown';
      try { code = (await resp.json())?.detail?.code ?? code; } catch { /* noop */ }
      setError(code === 'blacklist_requires_note'
        ? 'Blacklisting requires a reason.'
        : code === 'cannot_target_self'
          ? 'You cannot blacklist yourself.'
          : code === 'rank_too_low'
            ? 'Their rank is at or above yours.'
            : 'Could not save — try again.');
      setSaving(false);
      return;
    }
    onDone();
  };

  return (
    <form className="pf-form" onSubmit={submit}>
      <div><label>Trade / specialty</label>
        <input value={trade} onChange={(e) => setTrade(e.target.value)}
               placeholder="Server tech, packer, driver…" /></div>
      <div><label>Level</label>
        <ComboBox
          placeholder="Type to pick a level…"
          value={level}
          clearable
          onChange={setLevel}
          options={levels.map((l) => ({
            value: l.level, label: `${l.level} · ${l.title}`, sub: l.description,
          }))}
        /></div>
      <div><label>Supplying partner (blank = direct hire)</label>
        <ComboBox
          placeholder="Type to search partners…"
          value={partnerId}
          clearable
          onChange={setPartnerId}
          onOpen={() => void loadPartners()}
          options={(partners ?? (worker.partner ? [worker.partner] : []))
            .map((p) => ({ value: p.id, label: p.name }))}
        /></div>
      <div><label>Status</label>
        <select className="org-select" value={status}
                onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active</option>
          <option value="standby">Standby</option>
          <option value="blacklist">Blacklist</option>
        </select></div>
      {status === 'blacklist' && (
        <div className="full">
          <label>Blacklist reason *</label>
          <input value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="Why is this worker blocked?" required />
          <p className="pf-error" style={{ marginTop: 6 }}>
            Saving disables their login and signs them out everywhere.
          </p>
        </div>
      )}
      {status !== 'blacklist' && worker.status === 'blacklist' && (
        <p className="set-note full" style={{ padding: 0, margin: 0 }}>
          Leaving blacklist re-enables their login account.
        </p>
      )}
      <div className="pf-form-actions">
        <button className="btn-solid" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        <button className="mini-btn" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {error && <span className="pf-error">{error}</span>}
      </div>
    </form>
  );
}

/* ── certifications panel ───────────────────────────────────────── */

function certState(c: Cert): { label: string; cls: string } | null {
  if (!c.expires_on) return null;
  const days = (new Date(c.expires_on).getTime() - Date.now()) / 86_400_000;
  if (days < 0) return { label: 'expired', cls: 'c-red' };
  if (days < 30) return { label: 'expiring', cls: 'c-amber' };
  return null;
}

function CertsPanel({ personId, onChanged }: {
  personId: string;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const canAdd = can('workers', 'add');
  const canDelete = can('workers', 'delete');
  const [certs, setCerts] = useState<Cert[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', issuer: '', issued_on: '', expires_on: '' });
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const resp = await apiFetch(`/workers/${personId}/certifications`);
    if (resp.ok) setCerts(await resp.json());
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [personId]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await apiFetch(`/workers/${personId}/certifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.trim(),
        issuer: form.issuer.trim() || null,
        issued_on: form.issued_on || null,
        expires_on: form.expires_on || null,
      }),
    });
    setForm({ name: '', issuer: '', issued_on: '', expires_on: '' });
    setAdding(false);
    await refresh();
    onChanged();
    setBusy(false);
  };

  const remove = async (certId: string) => {
    setBusy(true);
    await apiFetch(`/workers/${personId}/certifications/${certId}`, { method: 'DELETE' });
    await refresh();
    onChanged();
    setBusy(false);
  };

  return (
    <>
      {certs === null && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
      {certs?.length === 0 && !adding && (
        <p className="set-note" style={{ padding: 0 }}>No certifications on file.</p>
      )}
      {certs?.map((c) => {
        const state = certState(c);
        return (
          <div className="session-item" key={c.id}>
            <div className="session-main">
              <b>{c.name}</b>
              <p>
                {[c.issuer,
                  c.issued_on ? `issued ${longDate(c.issued_on)}` : null,
                  c.expires_on ? `expires ${longDate(c.expires_on)}` : 'no expiry',
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
            {state && (
              <span className={`chip ${state.cls}`}><span className="dot" />{state.label}</span>
            )}
            {canDelete && (
              <button className="mini-btn" disabled={busy} title="Remove"
                      onClick={() => void remove(c.id)}>✕</button>
            )}
          </div>
        );
      })}

      {canAdd && !adding && (
        <div className="detail-actions">
          <button className="mini-btn accent" onClick={() => setAdding(true)}>
            + Add certification
          </button>
        </div>
      )}
      {adding && (
        <form className="pf-form" onSubmit={add} style={{ marginTop: 14 }}>
          <div><label>Name *</label>
            <input value={form.name} required autoFocus
                   placeholder="OSHA 30, background check…"
                   onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Issuer</label>
            <input value={form.issuer}
                   onChange={(e) => setForm({ ...form, issuer: e.target.value })} /></div>
          <div><label>Issued</label>
            <input type="date" value={form.issued_on}
                   onChange={(e) => setForm({ ...form, issued_on: e.target.value })} /></div>
          <div><label>Expires</label>
            <input type="date" value={form.expires_on}
                   onChange={(e) => setForm({ ...form, expires_on: e.target.value })} /></div>
          <div className="pf-form-actions">
            <button className="btn-solid" type="submit" disabled={busy || !form.name.trim()}>
              Add
            </button>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
}
