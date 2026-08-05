/**
 * ActivityHistory — the /me "User history" list: standard list toolbar
 * (Filters / Columns / Export), sortable headers, and read-only row
 * expansion showing the audit row's field-level before/after changes.
 */

import { useMemo, useState } from 'react';

import { type MyActivityItem } from '../lib/api';
import { relativeTime } from '../lib/format';
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
import { naturalCompare } from '../lib/sites';

const ACTION_LABELS: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Failed sign-in attempt',
  logout: 'Signed out',
  token_replay_detected: 'Token replay detected — sessions revoked',
  'password.change': 'Changed password',
  'session.revoke': 'Signed out another session',
  bulk_import: 'Ran a bulk import',
  create: 'Created',
  update: 'Updated',
  archive: 'Archived',
  restore: 'Unarchived',
  'clients.set': 'Changed client links',
  'survey.update': 'Updated survey',
  'godmode.enable': 'Enabled god mode',
};

const ENTITY_LABELS: Record<string, string> = {
  auth: 'account',
  person: 'profile',
  user_account: 'account',
  site: 'site',
  site_type: 'site type',
  site_bulk_import: 'sites (bulk)',
  status_value: 'status value',
  worker: 'worker',
  worker_level: 'worker level',
  access_group: 'access group',
  role: 'role',
  resource: 'access matrix',
};

function actionLabel(row: MyActivityItem): string {
  return ACTION_LABELS[row.action] ?? row.action.replace(/[._]/g, ' ');
}

function entityLabel(row: MyActivityItem): string {
  return ENTITY_LABELS[row.entity_type] ?? row.entity_type.replace(/_/g, ' ');
}

/** "site 'Acme DC1'" when the changes carry a recognizable name. */
function targetLabel(row: MyActivityItem): string {
  if (row.entity_type === 'auth') return row.by_me ? '—' : (row.entity_id ?? '—');
  const label = entityLabel(row);
  for (const key of ('name' in row.changes ? ['name'] : ['label', 'title'])) {
    const change = row.changes[key];
    if (change && typeof change === 'object' && 'to' in change) {
      const to = (change as { to?: unknown }).to;
      if (typeof to === 'string' && to) return `${label} '${to}'`;
    }
  }
  return label;
}

function whoLabel(row: MyActivityItem): string {
  return row.by_me ? 'You' : (row.actor_name ?? 'System');
}

/** One rendered before/after pair. Values that aren't {from,to} objects
 * (bulk summaries, client add/remove sets) render as plain JSON. */
function changeRows(changes: Record<string, unknown>):
  { field: string; from: string; to: string }[] {
  const show = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  return Object.entries(changes).map(([field, value]) => {
    if (value && typeof value === 'object' && ('from' in value || 'to' in value)) {
      const pair = value as { from?: unknown; to?: unknown };
      return { field, from: show(pair.from), to: show(pair.to) };
    }
    return { field, from: '—', to: show(value) };
  });
}

const COLUMNS: ColumnDef[] = [
  { key: 'who', label: 'Actor', width: '0.9fr', default: true },
  { key: 'action', label: 'Action', width: '1.5fr', default: true },
  { key: 'target', label: 'Target', width: '1.3fr', default: true },
  { key: 'ip', label: 'IP', width: '120px', default: true },
];

type SortKey = 'at' | 'who' | 'action' | 'target' | 'ip';

export default function ActivityHistory({ rows }: { rows: MyActivityItem[] }) {
  const [facets, setFacets] = useState<FacetState>({});
  const [sortKey, setSortKey] = useState<SortKey>('at');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);   // newest first
  const [openId, setOpenId] = useState<string | null>(null);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    new Set(COLUMNS.filter((c) => c.default).map((c) => c.key)));

  const facetGroups: FacetGroup[] = useMemo(() => {
    const actions = new Map<string, string>();
    const entities = new Map<string, string>();
    for (const r of rows) {
      actions.set(r.action, actionLabel(r));
      entities.set(r.entity_type, entityLabel(r));
    }
    const opts = (m: Map<string, string>) =>
      [...m.entries()].sort((a, b) => naturalCompare(a[1], b[1]))
        .map(([value, label]) => ({ value, label }));
    return [
      { key: 'who', title: 'Actor', options: [
        { value: 'you', label: 'You' },
        { value: 'someone', label: 'Someone else' },
        { value: 'system', label: 'System' },
      ] },
      { key: 'action', title: 'Action', options: opts(actions) },
      { key: 'entity', title: 'Record type', options: opts(entities) },
    ];
  }, [rows]);

  const facetValues = (r: MyActivityItem) => (groupKey: string): string[] => {
    switch (groupKey) {
      case 'who': return [r.by_me ? 'you' : r.actor_name ? 'someone' : 'system'];
      case 'action': return [r.action];
      case 'entity': return [r.entity_type];
      default: return [];
    }
  };

  const sortVal = (r: MyActivityItem): string => {
    switch (sortKey) {
      case 'at': return r.at;
      case 'who': return whoLabel(r);
      case 'action': return actionLabel(r);
      case 'target': return targetLabel(r);
      case 'ip': return r.ip ?? '';
    }
  };

  const visible = useMemo(() => {
    const kept = rows.filter((r) => passesFacets(facets, facetValues(r)));
    return [...kept].sort(
      (a, b) => naturalCompare(sortVal(a), sortVal(b)) * sortDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, facets, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === 'at' ? -1 : 1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns:
    `150px ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (r: MyActivityItem, key: string): string => {
    switch (key) {
      case 'who': return whoLabel(r);
      case 'action': return actionLabel(r);
      case 'target': return targetLabel(r);
      case 'ip': return r.ip ?? '—';
      default: return '—';
    }
  };

  return (
    <div className="panel activity-panel">
      <div className="panel-head">
        <h3>User history</h3>
        <div className="activity-tools">
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
          <ExportButton onExport={() => exportCsv<MyActivityItem>(
            'user-history',
            [
              ['At', (r) => r.at],
              ['Actor', (r) => whoLabel(r)],
              ['Action', (r) => actionLabel(r)],
              ['Record type', (r) => r.entity_type],
              ['Record id', (r) => r.entity_id ?? ''],
              ['IP', (r) => r.ip ?? ''],
              ['Changes', (r) => JSON.stringify(r.changes)],
            ],
            visible)} />
          <span className="result-count">{visible.length} of {rows.length}</span>
        </div>
      </div>

      <div className="dir-list activity-list">
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

        {visible.length === 0 && (
          <div className="dir-empty">
            <b>No matching events</b>Adjust the filters to see more history.
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
                  <div className="cell" key={c.key}>
                    {c.key === 'who' ? (
                      <span className="activity-who">
                        <span className={`activity-dot ${r.by_me ? 'me' : 'other'}`} />
                        {cellFor(r, c.key)}
                      </span>
                    ) : cellFor(r, c.key)}
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
                          <dt>Actor</dt><dd>{whoLabel(r)}</dd>
                          <dt>Action</dt><dd className="mono">{r.action}</dd>
                          <dt>Record</dt>
                          <dd className="mono">
                            {r.entity_type}{r.entity_id ? ` · ${r.entity_id}` : ''}
                          </dd>
                          <dt>IP</dt><dd className="mono">{r.ip ?? '—'}</dd>
                        </dl>
                        {details.length > 0 ? (
                          <table className="activity-changes">
                            <thead>
                              <tr><th>Field</th><th>Before</th><th>After</th></tr>
                            </thead>
                            <tbody>
                              {details.map((d) => (
                                <tr key={d.field}>
                                  <td className="mono">{d.field}</td>
                                  <td>{d.from}</td>
                                  <td>{d.to}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
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
    </div>
  );
}
