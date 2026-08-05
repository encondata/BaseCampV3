/**
 * Variables — the admin surface for controlled vocabularies: status values
 * (per record type), site types, and worker levels. Three tabs, page-local
 * state; each tab owns its own facets/columns so switching tabs never
 * leaks a filter into another tab. Same directory-list pattern as
 * pages/Sites.tsx, applied three times — row expansion is read-only, every
 * mutation lives behind an Edit button in a modal.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import SiteTypeEditModal from '../components/variables/SiteTypeEditModal';
import StatusEditModal, { ColorSwatch } from '../components/variables/StatusEditModal';
import WorkerLevelEditModal from '../components/variables/WorkerLevelEditModal';
import {
  ApiError,
  listSiteTypes,
  listStatusValues,
  listWorkerLevels,
  type SiteLookup,
  type StatusValue,
  type WorkerLevel,
} from '../lib/api';
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
import { recordTypeOptions, statusSearchText } from '../lib/variables';
import '../styles/access.css';   /* .subs-tabs / .access-tab-panel — page-local tab strip */
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/sites.css';    /* .pf-form textarea */

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
  );
}

type Tab = 'statuses' | 'site-types' | 'worker-levels';

const TABS: { id: Tab; label: string }[] = [
  { id: 'statuses', label: 'Statuses' },
  { id: 'site-types', label: 'Site types' },
  { id: 'worker-levels', label: 'Worker levels' },
];

export default function Variables() {
  const [tab, setTab] = useState<Tab>('statuses');

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">System</div>
          <h1 className="page-title">Variables</h1>
          <p className="page-hint">
            Controlled vocabularies shared across the portal — statuses, site types, and worker
            levels.
          </p>
        </div>
      </div>

      <div className="subs-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
                  className={tab === t.id ? 'on' : ''}
                  onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="access-tab-panel">
        {tab === 'statuses' && <StatusesTab />}
        {tab === 'site-types' && <SiteTypesTab />}
        {tab === 'worker-levels' && <WorkerLevelsTab />}
      </div>
    </div>
  );
}

/* ══════════════════════════════ Statuses ═══════════════════════════════ */

const STATUS_COLUMNS: ColumnDef[] = [
  { key: 'record_type', label: 'Type', width: '0.8fr', default: true },
  { key: 'key', label: 'Key', width: '1fr', default: true },
  { key: 'label', label: 'Label', width: '1.2fr', default: true },
  { key: 'description', label: 'Description', width: '2fr', default: true },
  { key: 'color', label: 'Colour', width: '0.8fr', default: true },
  { key: 'sort_order', label: 'Order', width: '0.6fr', default: true },
  { key: 'is_active', label: 'Active', width: '0.6fr', default: true },
  { key: 'usage_count', label: 'In use', width: '0.7fr', default: true },
];

const STATUS_CSV_COLUMNS: [string, (v: StatusValue) => string][] = [
  ['Record type', (v) => v.record_type],
  ['Key', (v) => v.key],
  ['Label', (v) => v.label],
  ['Description', (v) => v.description],
  ['Colour', (v) => v.color],
  ['Sort order', (v) => String(v.sort_order)],
  ['Active', (v) => String(v.is_active)],
  ['In use', (v) => String(v.usage_count ?? 0)],
];

const statusRowKey = (v: StatusValue) => `${v.record_type}:${v.key}`;

function StatusesTab() {
  const { can } = useAuth();
  const canAdd = can('devtools', 'add');
  const canChange = can('devtools', 'change');

  const [values, setValues] = useState<StatusValue[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [facets, setFacets] = useState<FacetState>({});
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(STATUS_COLUMNS.filter((c) => c.default).map((c) => c.key)));
  const [editingRow, setEditingRow] = useState<StatusValue | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      setValues(await listStatusValues());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view status values.'
        : 'Failed to load status values.');
    }
  };

  useEffect(() => { void load(); }, []);

  const facetGroups = useMemo<FacetGroup[]>(() => [
    { key: 'record_type', title: 'Type', options: recordTypeOptions(values ?? []) },
    { key: 'active', title: 'Active', options: [
      { value: 'yes', label: 'Active' },
      { value: 'no', label: 'Inactive' },
    ] },
  ], [values]);

  const facetValues = (v: StatusValue) => (groupKey: string): string[] => {
    if (groupKey === 'record_type') return [v.record_type];
    if (groupKey === 'active') return [v.is_active ? 'yes' : 'no'];
    return [];
  };

  const visible = useMemo(() => {
    if (!values) return [];
    const q = query.trim().toLowerCase();
    const rows = values.filter((v) => {
      if (!passesFacets(facets, facetValues(v))) return false;
      if (!q) return true;
      return statusSearchText(v).includes(q);
    });
    return rows.sort((a, b) => {
      if (a.record_type !== b.record_type) return a.record_type < b.record_type ? -1 : 1;
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.label.localeCompare(b.label);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, facets, query]);

  useEffect(() => {
    if (values && openKey && !visible.some((v) => statusRowKey(v) === openKey)) setOpenKey(null);
  }, [values, visible, openKey]);

  const shownCols = STATUS_COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (v: StatusValue, key: string) => {
    switch (key) {
      case 'record_type':
        return <span className="chip tag">{v.record_type}</span>;
      case 'key':
        return <span className="mono">{v.key}</span>;
      case 'label':
        return <span className="cell-top">{v.label}</span>;
      case 'description':
        return <span className="cell-sub">{v.description || '—'}</span>;
      case 'color':
        return <ColorSwatch token={v.color} />;
      case 'sort_order':
        return <span className="mono">{v.sort_order}</span>;
      case 'is_active':
        return (
          <span className={`chip ${v.is_active ? 'c-green' : 'tag'}`}>
            {v.is_active ? 'Active' : 'Inactive'}
          </span>
        );
      case 'usage_count':
        return <span className="mono">{v.usage_count ?? 0}</span>;
      default:
        return null;
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="dir-search">
          <SearchIcon />
          <input placeholder="Filter this list…" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="result-count">{visible.length} of {values?.length ?? 0} shown</span>
        <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
        <ColumnsButton columns={STATUS_COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
        <ExportButton onExport={() => exportCsv('status-values', STATUS_CSV_COLUMNS, visible)} />
        {canAdd && (
          <button className="btn-solid" onClick={() => setCreating(true)}>+ New status</button>
        )}
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load statuses</b>{error}
        </div>
      )}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            {shownCols.map((c) => <span key={c.key}>{c.label}</span>)}
            <span />
          </div>

          {values && visible.length === 0 && (
            <div className="dir-empty"><b>No matches</b>Try a different filter.</div>
          )}

          {visible.map((v) => {
            const k = statusRowKey(v);
            const open = openKey === k;
            return (
              <div key={k} className={`dir-row ${open ? 'open' : ''}`}>
                <div className="row-main" style={grid} onClick={() => setOpenKey(open ? null : k)}>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(v, c.key)}</div>
                  ))}
                  <div className="cell chevron-cell"><ChevronIcon /></div>
                </div>
                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <StatusRowDetail value={v} canEdit={canChange}
                                          onEdit={() => setEditingRow(v)} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingRow && (
        <StatusEditModal value={editingRow} canChange={canChange}
                          onClose={() => setEditingRow(null)} onSaved={() => load()} />
      )}
      {creating && (
        <StatusEditModal value={null} canChange={canChange}
                          onClose={() => setCreating(false)} onSaved={() => load()} />
      )}
    </>
  );
}

function StatusRowDetail({ value, canEdit, onEdit }: {
  value: StatusValue;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Description</p>
        <p className="set-note" style={{ padding: 0 }}>{value.description || 'No description.'}</p>

        <p className="eyebrow-sm">Colour</p>
        <dl className="kv">
          <dt>Token</dt>
          <dd className="mono">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <ColorSwatch token={value.color} />{value.color}
            </span>
          </dd>
        </dl>
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Usage</p>
        <dl className="kv">
          <dt>In use</dt>
          <dd>{value.usage_count ?? 0} record{(value.usage_count ?? 0) === 1 ? '' : 's'}</dd>
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

/* ═══════════════════════════════ Site types ═════════════════════════════ */

const SITE_TYPE_COLUMNS: ColumnDef[] = [
  { key: 'key', label: 'Key', width: '1fr', default: true },
  { key: 'label', label: 'Label', width: '1.2fr', default: true },
  { key: 'description', label: 'Description', width: '2.4fr', default: true },
  { key: 'sort_order', label: 'Order', width: '0.6fr', default: true },
  { key: 'icon', label: 'Icon', width: '0.8fr', default: true },
];

const SITE_TYPE_CSV_COLUMNS: [string, (t: SiteLookup) => string][] = [
  ['Key', (t) => t.key],
  ['Label', (t) => t.label],
  ['Description', (t) => t.description],
  ['Sort order', (t) => String(t.sort_order)],
  ['Icon', (t) => t.icon ?? ''],
];

function SiteTypesTab() {
  const { can } = useAuth();
  const canChange = can('devtools', 'change');

  const [types, setTypes] = useState<SiteLookup[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(SITE_TYPE_COLUMNS.filter((c) => c.default).map((c) => c.key)));
  const [editingRow, setEditingRow] = useState<SiteLookup | null>(null);

  const load = async () => {
    try {
      setTypes(await listSiteTypes());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view site types.' : 'Failed to load site types.');
    }
  };

  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    if (!types) return [];
    const q = query.trim().toLowerCase();
    const rows = types.filter((t) => {
      if (!q) return true;
      return [t.key, t.label, t.description].join(' ').toLowerCase().includes(q);
    });
    return rows.sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
  }, [types, query]);

  useEffect(() => {
    if (types && openKey && !visible.some((t) => t.key === openKey)) setOpenKey(null);
  }, [types, visible, openKey]);

  const shownCols = SITE_TYPE_COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (t: SiteLookup, key: string) => {
    switch (key) {
      case 'key':
        return <span className="mono">{t.key}</span>;
      case 'label':
        return <span className="cell-top">{t.label}</span>;
      case 'description':
        return <span className="cell-sub">{t.description || '—'}</span>;
      case 'sort_order':
        return <span className="mono">{t.sort_order}</span>;
      case 'icon':
        return <span className="mono">{t.icon || '—'}</span>;
      default:
        return null;
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="dir-search">
          <SearchIcon />
          <input placeholder="Filter this list…" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="result-count">{visible.length} of {types?.length ?? 0} shown</span>
        <ColumnsButton columns={SITE_TYPE_COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
        <ExportButton onExport={() => exportCsv('site-types', SITE_TYPE_CSV_COLUMNS, visible)} />
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load site types</b>{error}
        </div>
      )}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            {shownCols.map((c) => <span key={c.key}>{c.label}</span>)}
            <span />
          </div>

          {types && visible.length === 0 && (
            <div className="dir-empty"><b>No matches</b>Try a different filter.</div>
          )}

          {visible.map((t) => {
            const open = openKey === t.key;
            return (
              <div key={t.key} className={`dir-row ${open ? 'open' : ''}`}>
                <div className="row-main" style={grid}
                     onClick={() => setOpenKey(open ? null : t.key)}>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(t, c.key)}</div>
                  ))}
                  <div className="cell chevron-cell"><ChevronIcon /></div>
                </div>
                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <SiteTypeRowDetail value={t} canEdit={canChange}
                                            onEdit={() => setEditingRow(t)} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingRow && (
        <SiteTypeEditModal value={editingRow} canChange={canChange}
                            onClose={() => setEditingRow(null)} onSaved={() => load()} />
      )}
    </>
  );
}

function SiteTypeRowDetail({ value, canEdit, onEdit }: {
  value: SiteLookup;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Description</p>
        <p className="set-note" style={{ padding: 0 }}>{value.description || 'No description.'}</p>
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Ordering &amp; icon</p>
        <dl className="kv">
          <dt>Sort order</dt>
          <dd className="mono">{value.sort_order}</dd>
          <dt>Icon</dt>
          <dd className="mono">{value.icon || '—'}</dd>
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

/* ══════════════════════════════ Worker levels ═══════════════════════════ */

const WORKER_LEVEL_COLUMNS: ColumnDef[] = [
  { key: 'level', label: 'Level', width: '0.8fr', default: true },
  { key: 'rank', label: 'Rank', width: '0.6fr', default: true },
  { key: 'title', label: 'Title', width: '1.2fr', default: true },
  { key: 'description', label: 'Description', width: '2fr', default: true },
  { key: 'expected_skills', label: 'Expected skills', width: '2fr', default: true },
];

const WORKER_LEVEL_CSV_COLUMNS: [string, (w: WorkerLevel) => string][] = [
  ['Level', (w) => w.level],
  ['Rank', (w) => String(w.rank)],
  ['Title', (w) => w.title],
  ['Description', (w) => w.description],
  ['Expected skills', (w) => w.expected_skills.join('; ')],
];

function WorkerLevelsTab() {
  const { can } = useAuth();
  const canChange = can('devtools', 'change');

  const [levels, setLevels] = useState<WorkerLevel[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(WORKER_LEVEL_COLUMNS.filter((c) => c.default).map((c) => c.key)));
  const [editingRow, setEditingRow] = useState<WorkerLevel | null>(null);

  const load = async () => {
    try {
      setLevels(await listWorkerLevels());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view worker levels.' : 'Failed to load worker levels.');
    }
  };

  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    if (!levels) return [];
    const q = query.trim().toLowerCase();
    const rows = levels.filter((w) => {
      if (!q) return true;
      return [w.level, w.title, w.description, ...w.expected_skills]
        .join(' ').toLowerCase().includes(q);
    });
    return rows.sort((a, b) => a.rank - b.rank);
  }, [levels, query]);

  useEffect(() => {
    if (levels && openKey && !visible.some((w) => w.level === openKey)) setOpenKey(null);
  }, [levels, visible, openKey]);

  const shownCols = WORKER_LEVEL_COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (w: WorkerLevel, key: string) => {
    switch (key) {
      case 'level':
        return <span className="chip tag">{w.level}</span>;
      case 'rank':
        return <span className="mono">{w.rank}</span>;
      case 'title':
        return <span className="cell-top">{w.title}</span>;
      case 'description':
        return <span className="cell-sub">{w.description || '—'}</span>;
      case 'expected_skills':
        return (
          <div className="chips">
            {w.expected_skills.length === 0 && <span className="chip tag">—</span>}
            {w.expected_skills.slice(0, 3).map((s) => <span key={s} className="chip c-blue">{s}</span>)}
            {w.expected_skills.length > 3 && (
              <span className="chip tag">+{w.expected_skills.length - 3}</span>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="dir-search">
          <SearchIcon />
          <input placeholder="Filter this list…" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="result-count">{visible.length} of {levels?.length ?? 0} shown</span>
        <ColumnsButton columns={WORKER_LEVEL_COLUMNS} visible={visibleCols}
                       onChange={setVisibleCols} />
        <ExportButton onExport={() => exportCsv('worker-levels', WORKER_LEVEL_CSV_COLUMNS, visible)} />
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load worker levels</b>{error}
        </div>
      )}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            {shownCols.map((c) => <span key={c.key}>{c.label}</span>)}
            <span />
          </div>

          {levels && visible.length === 0 && (
            <div className="dir-empty"><b>No matches</b>Try a different filter.</div>
          )}

          {visible.map((w) => {
            const open = openKey === w.level;
            return (
              <div key={w.level} className={`dir-row ${open ? 'open' : ''}`}>
                <div className="row-main" style={grid}
                     onClick={() => setOpenKey(open ? null : w.level)}>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(w, c.key)}</div>
                  ))}
                  <div className="cell chevron-cell"><ChevronIcon /></div>
                </div>
                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <WorkerLevelRowDetail value={w} canEdit={canChange}
                                               onEdit={() => setEditingRow(w)} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingRow && (
        <WorkerLevelEditModal value={editingRow} canChange={canChange}
                               onClose={() => setEditingRow(null)} onSaved={() => load()} />
      )}
    </>
  );
}

function WorkerLevelRowDetail({ value, canEdit, onEdit }: {
  value: WorkerLevel;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Description</p>
        <p className="set-note" style={{ padding: 0 }}>{value.description || 'No description.'}</p>
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Expected skills</p>
        <div className="chips">
          {value.expected_skills.length === 0 && <span className="chip tag">No skills listed</span>}
          {value.expected_skills.map((s) => <span key={s} className="chip c-blue">{s}</span>)}
        </div>

        <p className="eyebrow-sm">Rank</p>
        <dl className="kv">
          <dt>Ordering</dt>
          <dd className="mono">{value.rank}</dd>
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
