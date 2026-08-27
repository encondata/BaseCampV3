/**
 * Workers — people holding the worker role. Directory pattern with
 * trade / level badge / partner rollup / status, and a detail panel:
 * editable worker profile, level expectations card, certifications.
 * Blacklisting kills login access (leaving blacklist restores it).
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import ComboBox from '../components/ComboBox';
import GodDeleteButton from '../components/GodDeleteButton';
import { apiFetch, listWorkerStatuses, updateWorkerProfile, type StatusValue } from '../lib/api';
import { initialOpenId } from '../lib/auditFormat';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import { usePendingDeletes } from '../lib/pendingDeletes';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import { avatarGradient, initials, longDate } from '../lib/format';
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
import {
  applyWorkerPatch, WORKER_ERRORS, WORKER_GOD_FIELDS, workerCellText, workerSearchText,
  type PartnerRef, type WorkerItem,
} from '../lib/workers';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';

interface LevelDef {
  level: string;
  rank: number;
  title: string;
  description: string;
  expected_skills: string[];
  color: string;
}

interface Cert {
  id: string;
  name: string;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
}

// Worker statuses are editable data (status_values, record_type='worker'), so
// this page must not hold a copy of the vocabulary. Chips read the label/colour
// the server denormalises onto each row; the facet and the edit select read
// listWorkerStatuses().
//
// `blacklist` is the one key that is NOT just-another-status, and cannot become
// one by making the vocabulary dynamic:
//   - worker_profiles has a CHECK hardcoding the literal (status != 'blacklist'
//     OR status_note IS NOT NULL), so the reason field is a DB requirement
//   - workers.py enforces a rank rule and a not-yourself rule on it
//   - it disables the login account, which no other status does
// Data-driving this (a requires_note column) is YAGNI until a second status
// needs it — and the CHECK would still name this literal.
const BLACKLIST = 'blacklist';

const COLUMNS: ColumnDef[] = [
  { key: 'trade', label: 'Trade', width: '1.3fr', default: true },
  { key: 'level', label: 'Level', width: '1.2fr', default: true },
  { key: 'partner', label: 'Partner', width: '1.4fr', default: true },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'certs', label: 'Certs', width: '0.9fr', default: false },
  { key: 'contact', label: 'Contact', width: '1.6fr', default: false },
];

// Every column the page can offer plus the 'primary' pseudo-column (the
// always-shown name+contact cell). No godOnly columns and no archived
// concept on this page.
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'primary']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Sort value per column key — deliberately separate from `workerCellText`:
 *  that accessor's job is display/filter text ("N expired" vs. the bare
 *  count, "unleveled", the level+title combo), which would sort wrong
 *  (certs would sort as text, not by count). This stays raw so numeric
 *  columns order by magnitude and the rest order the way a user expects. */
function sortValueFor(w: WorkerItem, key: string): string | number {
  switch (key) {
    case 'primary': return w.display_name.toLowerCase();
    case 'trade': return (w.trade ?? '').toLowerCase();
    case 'level': return w.level ?? '';
    case 'partner': return w.partner?.name.toLowerCase() ?? '';
    // the column shows the label, so sorting by the key would strand a
    // status whose key and label disagree
    case 'status': return w.status_label.toLowerCase();
    case 'certs': return w.cert_count;
    case 'contact': return (w.contact_email ?? '').toLowerCase();
    default: return '';
  }
}

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
      <b style={{ '--lvl': def?.color ?? '#8a93a6' } as CSSProperties}>{level}</b>
      <span>{def?.title ?? ''}</span>
    </span>
  );
}

export default function Workers() {
  const { can, godMode } = useAuth();
  const navigate = useNavigate();
  const god = useGodEdit();
  const pd = usePendingDeletes(godMode);

  const [workers, setWorkers] = useState<WorkerItem[] | null>(null);
  const [levels, setLevels] = useState<LevelDef[]>([]);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [error, setError] = useState('');
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
  useRecordFocus(workers, (w) => w.person_id, (w) => w.display_name,
                 focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'workers', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const cellText = useMemo(() => (w: WorkerItem, colKey: string) =>
    workerCellText(w, colKey, levels), [levels]);

  const load = async () => {
    const resp = await apiFetch('/workers');
    if (!resp.ok) {
      setError(resp.status === 403
        ? 'You do not have permission to view workers.' : 'Failed to load workers.');
      return;
    }
    setWorkers(await resp.json());
  };

  const godFields = useMemo(() => WORKER_GOD_FIELDS({
    levels: () => levels.map((l) => ({ value: l.level, label: `${l.level} · ${l.title}` })),
    statuses: () => statuses.map((s) => ({ value: s.key, label: s.label })),
  }), [levels, statuses]);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const replaceRow = (u: WorkerItem) =>
    setWorkers((xs) => xs?.map((x) => (x.person_id === u.person_id ? u : x)) ?? xs);

  // PUT .../profile returns 204 (no updated row), so the row is reconstructed
  // client-side from the row already in state + the lookups already loaded —
  // see applyWorkerPatch in lib/workers.ts for why that's safe given god-edit
  // only ever sends one field per commit.
  const patchWorker = async (id: string, body: Record<string, unknown>): Promise<WorkerItem> => {
    await updateWorkerProfile(id, body);
    const current = workers?.find((w) => w.person_id === id);
    if (!current) throw new Error('worker row not found after save');
    return applyWorkerPatch(current, body, statuses);
  };

  useEffect(() => {
    void load();
    void apiFetch('/worker-levels').then(async (r) => {
      if (r.ok) setLevels(await r.json());
    });
    void listWorkerStatuses().then(setStatuses).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // openRow handoff now lives in useRecordFocus (expands AND filters to top)

  const workerText = useCallback(
    (w: WorkerItem) => workerSearchText(w, levels), [levels]);
  const haystack = useSearchHaystacks(workers, workerText);

  const visible = useMemo(() => {
    if (!workers) return [];
    const q = query.trim().toLowerCase();
    const rows = workers.filter((w) => {
      if (!passesColumnFilters(w, filters, cellText)) return false;
      if (!q) return true;
      return haystack(w).includes(q);
    });
    return rows.sort((a, b) => {
      const va = sortValueFor(a, sortKey), vb = sortValueFor(b, sortKey);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
  }, [workers, filters, cellText, levels, query, sortKey, sortDir, haystack]);

  // Auto-close the open row when it drops out of `visible` — EXCEPT the one
  // case where it just arrived via a deep link and the reason it's missing
  // is a persisted column filter: then clear the filters instead. See
  // Assets.tsx for the full rationale.
  useEffect(() => {
    if (!workers || !openId || visible.some((w) => w.person_id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = workers.find((w) => w.person_id === openId);
      if (target && !passesColumnFilters(target, filters, cellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [workers, visible, openId, filters, cellText, clearFilters]);

  // Release the deep-link guard once the target row is first confirmed
  // visible — see Assets.tsx for the full rationale.
  useEffect(() => {
    if (deepLinkTarget.current && visible.some((w) => w.person_id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const canManage = can('workers', 'change');

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = {
    gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px`,
  };

  const cellFor = (w: WorkerItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={w} gf={gf} patch={patchWorker} onRowSaved={replaceRow}
                   errorMap={WORKER_ERRORS} disabled={!canManage}
                   idOf={(row) => row.person_id} />
        );
      }
    }
    switch (key) {
      case 'trade': return <span className="cell-top">{w.trade ?? '—'}</span>;
      case 'level': return <LevelBadge level={w.level} levels={levels} />;
      case 'partner': return <span className="cell-top">{w.partner?.name ?? 'Direct'}</span>;
      case 'status':
        return (
          <div className="chips">
            <span className="chip custom" style={{ '--chip': w.status_color } as CSSProperties}>
              <span className="dot" />{w.status_label}
            </span>
            {pd.pendingIds.has(w.person_id) && <span className="chip tag">Pending delete</span>}
          </div>
        );
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
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {workers?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         godMode={godMode} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('workers', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canManage} />
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
          <span className="col-head">
            <button className="sortable" onClick={() => toggleSort('primary')}>
              Name {caret('primary')}
            </button>
            <ColumnMenu colKey="primary" label="Name"
                        allRows={workers ?? []} filters={filters}
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
                          allRows={workers ?? []} filters={filters}
                          text={cellText}
                          filter={filters[c.key]} onFilter={setFilter}
                          sortDir={sortKey === c.key ? sortDir : null}
                          onSort={(dir) => setSort(c.key, dir)} />
            </span>
          ))}
          <span />
        </div>

        {error && <div className="dir-empty"><b>Cannot load workers</b>{error}</div>}
        {!error && workers && visible.length === 0 && (
          <div className="dir-empty">
            <b>No matches</b>Grant someone the worker role via Users → Manage roles.
            <EmptyClearFilters filters={filters} onClear={clearFilters} />
          </div>
        )}

        <VirtualRows rows={visible}
          renderRow={(w, vp) => {
          const open = openId === w.person_id;
          return (
            <div key={w.person_id} className={`dir-row ${open ? 'open' : ''}`}
                 {...vp} style={vp?.style}>
              <div className="row-main" style={grid}
                   onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : w.person_id); }}>
                {/* Primary cell has no god-edit descriptor: display_name comes from
                    the Person record and is edited via PUT /users/{id}/profile — a
                    different endpoint than the worker-profile PATCH this page's
                    god-edit wiring uses, so it stays read-only even in god mode. */}
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
                        statuses={statuses}
                        canManage={canManage}
                        onChanged={() => void load()}
                        godVisible={godMode}
                        pending={pd.pendingIds.has(w.person_id)}
                        onMark={() => pd.mark('person', w.person_id, w.display_name)}
                        onUnmark={() => pd.unmark(w.person_id)}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        }} />
      </div>
    </div>
  );
}

/* ── detail: profile edit + level card + certifications ─────────── */

function WorkerDetail({
  worker, levels, statuses, canManage, onChanged, godVisible, pending, onMark, onUnmark,
}: {
  worker: WorkerItem;
  levels: LevelDef[];
  statuses: StatusValue[];
  canManage: boolean;
  onChanged: () => void;
  godVisible: boolean;
  pending: boolean;
  onMark: () => Promise<void>;
  onUnmark: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const levelDef = levels.find((l) => l.level === worker.level);

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
          <ProfileForm worker={worker} levels={levels} statuses={statuses}
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
                <span className="chip custom" style={{ '--chip': worker.status_color } as CSSProperties}>
                  <span className="dot" />{worker.status_label}
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
                ? (worker.status === BLACKLIST
                  ? <span className="chip c-red"><span className="dot" />disabled (blacklist)</span>
                  : <span className="chip c-green"><span className="dot" />portal access</span>)
                : <span className="chip tag">no account</span>}</dd>
            </dl>
            {(canManage || godVisible) && (
              <div className="detail-actions">
                {canManage && (
                  <button className="mini-btn accent" onClick={() => setEditing(true)}>
                    Edit profile
                  </button>
                )}
                <GodDeleteButton visible={godVisible} entityType="person"
                                 entityId={worker.person_id} label={worker.display_name}
                                 pending={pending} onChange={pending ? onUnmark : onMark} />
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

function ProfileForm({ worker, levels, statuses, onDone, onCancel }: {
  worker: WorkerItem;
  levels: LevelDef[];
  statuses: StatusValue[];
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

  // listWorkerStatuses() filters to is_active, so a worker sitting on a retired
  // status isn't in it — the select would render blank and read as "no status
  // set". The row already carries its label, so seed the option back from there.
  // Appended last: the server sorts by sort_order, and this is the exception.
  const options = useMemo<{ key: string; label: string }[]>(() => (
    statuses.some((s) => s.key === worker.status)
      ? statuses
      : [...statuses, { key: worker.status, label: worker.status_label }]
  ), [statuses, worker.status, worker.status_label]);

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
    if (status === BLACKLIST && !note.trim()) {
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
          {options.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select></div>
      {status === BLACKLIST && (
        <div className="full">
          <label>Blacklist reason *</label>
          <input value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="Why is this worker blocked?" required />
          <p className="pf-error" style={{ marginTop: 6 }}>
            Saving disables their login and signs them out everywhere.
          </p>
        </div>
      )}
      {status !== BLACKLIST && worker.status === BLACKLIST && (
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
