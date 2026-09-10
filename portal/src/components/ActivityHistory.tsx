/**
 * ActivityHistory — the /me "User history" list: standard list toolbar
 * (Filters / Columns / Export), sortable headers, and read-only row
 * expansion showing the audit row's field-level before/after changes.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import DataTable from './DataTable';
import { type MyActivityItem } from '../lib/api';
import {
  actionLabel, changeRows, entityHref, entityLabel, recordTooltip,
  targetLabel as sharedTargetLabel,
} from '../lib/auditFormat';
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

function targetLabel(row: MyActivityItem): string {
  // your own auth rows are just you — no target worth showing
  return sharedTargetLabel(row, { hideAuthTarget: row.by_me });
}

function whoLabel(row: MyActivityItem): string {
  return row.by_me ? 'You' : (row.actor_name ?? 'System');
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

  const cellFor = (r: MyActivityItem, key: string): ReactElement => {
    switch (key) {
      case 'who': return <span className="cell-top">{whoLabel(r)}</span>;
      case 'action': return <span className="cell-top">{actionLabel(r)}</span>;
      case 'target': return <span className="cell-top">{targetLabel(r)}</span>;
      case 'ip': return <span className="mono">{r.ip ?? '—'}</span>;
      default: return <span className="cell-top">—</span>;
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
                  <span className="mono">{relativeTime(r.at)}</span>
                </div>
                {shownCols.map((c) => (
                  <div className="cell" key={c.key}
                       title={c.key === 'target' ? recordTooltip(r) : undefined}>
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
    </div>
  );
}
