/**
 * Admin → Audit log — the app-wide audit_log viewer. Filters are
 * SERVER-side (the log is paginated; client-only facets would silently
 * filter just the loaded window), sorting is client-side over what's
 * loaded, and rows expand to the shared Before/After changes table.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import ComboBox from '../components/ComboBox';
import DataTable from '../components/DataTable';
import {
  getAuditFacets,
  listAuditLog,
  listUsers,
  type AuditLogItem,
  type UserSummary,
} from '../lib/api';
import {
  actionLabel, changeRows, entityHref, entityLabel, recordTooltip, targetLabel,
} from '../lib/auditFormat';
import { relativeTime } from '../lib/format';
import {
  ColumnsButton, ExportButton, exportCsv, type ColumnDef,
} from '../lib/listTools';
import { naturalCompare } from '../lib/sites';
import '../styles/directory.css';
import '../styles/profile.css';

const PAGE = 100;

const COLUMNS: ColumnDef[] = [
  { key: 'actor', label: 'Actor', width: '1fr', default: true },
  { key: 'action', label: 'Action', width: '1.4fr', default: true },
  { key: 'target', label: 'Target', width: '1.3fr', default: true },
  { key: 'entity_id', label: 'Record id', width: '1fr', default: false },
  { key: 'ip', label: 'IP', width: '120px', default: true },
];

type SortKey = 'at' | 'actor' | 'action' | 'target' | 'entity_id' | 'ip';

interface Filters {
  entity_type: string;
  action: string;
  actor_id: string;
  since: string;   // yyyy-mm-dd from <input type=date>
  until: string;
}

const NO_FILTERS: Filters = {
  entity_type: '', action: '', actor_id: '', since: '', until: '',
};

export default function Audit() {
  const [rows, setRows] = useState<AuditLogItem[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [facets, setFacets] = useState<{ entity_types: string[]; actions: string[] }>(
    { entity_types: [], actions: [] });
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('at');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    new Set(COLUMNS.filter((c) => c.default).map((c) => c.key)));

  const queryFrom = (f: Filters, offset: number) => ({
    entity_type: f.entity_type || undefined,
    action: f.action || undefined,
    actor_id: f.actor_id || undefined,
    // date inputs are day-granular: until means "through the end of that day"
    since: f.since ? new Date(`${f.since}T00:00:00`).toISOString() : undefined,
    until: f.until ? new Date(`${f.until}T23:59:59.999`).toISOString() : undefined,
    limit: PAGE,
    offset,
  });

  const load = useCallback(async (f: Filters, append: boolean, offset: number) => {
    setLoading(true);
    setError('');
    try {
      const page = await listAuditLog(queryFrom(f, offset));
      setRows((prev) => (append ? [...prev, ...page] : page));
      setExhausted(page.length < PAGE);
    } catch {
      setError('Could not load the audit log.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(NO_FILTERS, false, 0);
    void getAuditFacets().then(setFacets).catch(() => {});
    void listUsers().then(setPeople).catch(() => {});
  }, [load]);

  const applyFilters = (next: Filters) => {
    setFilters(next);
    setOpenId(null);
    void load(next, false, 0);
  };

  const sortVal = (r: AuditLogItem): string => {
    switch (sortKey) {
      case 'at': return r.at;
      case 'actor': return r.actor_name ?? 'System';
      case 'action': return actionLabel(r);
      case 'target': return targetLabel(r);
      case 'entity_id': return r.entity_id ?? '';
      case 'ip': return r.ip ?? '';
    }
  };

  const visible = useMemo(
    () => [...rows].sort((a, b) => naturalCompare(sortVal(a), sortVal(b)) * sortDir),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === 'at' ? -1 : 1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns:
    `150px ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (r: AuditLogItem, key: string): string => {
    switch (key) {
      case 'actor': return r.actor_name ?? 'System';
      case 'action': return actionLabel(r);
      case 'target': return targetLabel(r);
      case 'entity_id': return r.entity_id ?? '—';
      case 'ip': return r.ip ?? '—';
      default: return '—';
    }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Admin</div>
      <div className="dir-head">
        <h1>Audit log</h1>
        <p>Every recorded change and account event, newest first.</p>
      </div>

      <div className="dir-toolbar audit-toolbar">
        <select value={filters.entity_type} aria-label="Record type"
                onChange={(e) => applyFilters({ ...filters, entity_type: e.target.value })}>
          <option value="">All record types</option>
          {facets.entity_types.map((t) => (
            <option key={t} value={t}>
              {entityLabel({ entity_type: t, action: '', entity_id: null, changes: {} })}
            </option>
          ))}
        </select>
        <select value={filters.action} aria-label="Action"
                onChange={(e) => applyFilters({ ...filters, action: e.target.value })}>
          <option value="">All actions</option>
          {facets.actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel({ action: a, entity_type: '', entity_id: null, changes: {} })}
            </option>
          ))}
        </select>
        <div className="audit-actor">
          <ComboBox
            options={people.map((p) => ({ value: p.person_id, label: p.display_name }))}
            value={filters.actor_id}
            clearable
            placeholder="Any actor…"
            onChange={(v) => applyFilters({ ...filters, actor_id: v })}
          />
        </div>
        <input type="date" value={filters.since} aria-label="From date"
               onChange={(e) => applyFilters({ ...filters, since: e.target.value })} />
        <input type="date" value={filters.until} aria-label="To date"
               onChange={(e) => applyFilters({ ...filters, until: e.target.value })} />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
          <ExportButton onExport={() => exportCsv<AuditLogItem>(
            'audit-log',
            [
              ['At', (r) => r.at],
              ['Actor', (r) => r.actor_name ?? 'System'],
              ['Action', (r) => actionLabel(r)],
              ['Record type', (r) => r.entity_type],
              ['Record id', (r) => r.entity_id ?? ''],
              ['IP', (r) => r.ip ?? ''],
              ['Changes', (r) => JSON.stringify(r.changes)],
            ],
            visible)} />
          <span className="result-count">{rows.length} loaded</span>
        </span>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>{error}</b></div>}

      <div className="dir-list">
        <div className="list-head" style={grid}>
          <button className="sortable" onClick={() => toggleSort('at')}>
            When {caret('at')}
          </button>
          {shownCols.map((c) => (
            <button key={c.key} className="sortable"
                    onClick={() => toggleSort(c.key as SortKey)}>
              {c.label} {caret(c.key as SortKey)}
            </button>
          ))}
          <span />
        </div>

        {!loading && visible.length === 0 && !error && (
          <div className="dir-empty">
            <b>No events match</b>Loosen the filters to see more.
          </div>
        )}

        {visible.map((r) => {
          const open = openId === r.id;
          const details = changeRows(r.changes);
          return (
            <div key={r.id} className={`dir-row ${open ? 'open' : ''}`}>
              <div className="row-main" style={grid}
                   onClick={() => setOpenId(open ? null : r.id)}>
                <div className="cell" title={new Date(r.at).toLocaleString()}>
                  {relativeTime(r.at)}
                </div>
                {shownCols.map((c) => (
                  <div className="cell" key={c.key}
                       title={c.key === 'target' ? recordTooltip(r) : undefined}>
                    {cellFor(r, c.key)}
                  </div>
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
                      <div className="activity-detail">
                        <dl className="kv">
                          <dt>Exact time</dt>
                          <dd className="mono">{new Date(r.at).toLocaleString()}</dd>
                          <dt>Actor</dt><dd>{r.actor_name ?? 'System'}</dd>
                          <dt>Action</dt><dd className="mono">{r.action}</dd>
                          <dt>Record</dt>
                          <dd className="mono" title={recordTooltip(r)}>
                            {entityHref(r) ? (
                              <Link className="record-link" to={entityHref(r) as string}>
                                {r.entity_type} · {r.entity_name ?? r.entity_id} ↗
                              </Link>
                            ) : (
                              <>{r.entity_type}
                                {(r.entity_name ?? r.entity_id)
                                  ? ` · ${r.entity_name ?? r.entity_id}` : ''}</>
                            )}
                          </dd>
                          <dt>IP</dt><dd className="mono">{r.ip ?? '—'}</dd>
                        </dl>
                        {details.length > 0 ? (
                          <DataTable
                            ariaLabel="Field changes"
                            columns={[
                              { key: 'field', label: 'Field', mono: true },
                              { key: 'from', label: 'Before' },
                              { key: 'to', label: 'After' },
                            ]}
                            rows={details.map((d) => (
                              { key: d.field, cells: [d.field, d.from, d.to] }))} />
                        ) : (
                          <p className="set-note" style={{ padding: 0 }}>
                            No field changes recorded for this event.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {!exhausted && (
        <div className="audit-more">
          <button className="mini-btn" disabled={loading}
                  onClick={() => void load(filters, true, rows.length)}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
