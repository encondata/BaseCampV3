/** Rules tab — status-rule directory list, rebuilt on the shared
 *  directory-list pattern (model: pages/Notifications.tsx): search box +
 *  toolbar FilterButton facets + per-column ColumnMenu filters +
 *  persisted visible/sort/order state (usePersistentListState) + CSV
 *  export + virtualized rows. Trigger status and match type render as
 *  two separate columns, each resolved from the /status-rules schema so
 *  the list can never drift from the engine's vocabulary. "+ New rule"
 *  and row Edit open RuleEditorModal, schema-driven off the same
 *  /status-rules/schema payload this tab already loads. The trailing
 *  Edit/Duplicate/Delete cell stays outside the column system, the way
 *  Notifications' chevron column does. */

import {
  useCallback, useEffect, useMemo, useState, type CSSProperties,
} from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, createStatusRule, deleteStatusRule, getStatusRuleExecStats,
  getStatusRuleSchema, listStatusRules, toggleStatusRule,
  type StatusRule, type StatusRuleExecStat, type StatusRuleSchema,
} from '../../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../../lib/columnMenu';
import {
  ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  moveKey, passesFacets, useReorderDrag, useSearchHaystacks, visibleColumnsFor,
  type ColumnDef, type FacetGroup, type FacetState,
} from '../../lib/listTools';
import {
  ruleCellText, ruleSearchText, ruleSortValue, summarizeAction,
  type RuleRowContext,
} from '../../lib/statusRules';
import { VirtualRows } from '../../lib/virtualRows';
import RuleEditorModal from './RuleEditorModal';

// Name | Trigger status | Match type | Priority | Conditions | Actions |
// Runs | Updated (hidden by default) | Enabled — trailing Edit/Duplicate/
// Delete cell stays outside COLUMNS, like Notifications' chevron column.
const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: 'minmax(220px, 1.6fr)', default: true },
  { key: 'trigger_status', label: 'Trigger status', width: 'minmax(140px, 1fr)', default: true },
  { key: 'match_type', label: 'Match type', width: '110px', default: true },
  { key: 'priority', label: 'Priority', width: '90px', default: true },
  { key: 'conditions', label: 'Conditions', width: '100px', default: true },
  { key: 'actions', label: 'Actions', width: '90px', default: true },
  { key: 'runs', label: 'Runs', width: 'minmax(140px, 1fr)', default: true },
  { key: 'updated', label: 'Updated', width: 'minmax(150px, 1fr)', default: false },
  { key: 'enabled', label: 'Enabled', width: '90px', default: true },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

function statusOption(schema: StatusRuleSchema, value: string) {
  return schema.trigger_statuses.find((o) => o.value === value);
}

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : "Couldn't update the rule.";

export default function RulesTab({ onCount }: {
  onCount: (n: number | null) => void;
}) {
  const { can } = useAuth();
  const canAdd = can('status_rules', 'add');
  const canChange = can('status_rules', 'change');
  const canDelete = can('status_rules', 'delete');

  const [rules, setRules] = useState<StatusRule[] | null>(null);
  const [schema, setSchema] = useState<StatusRuleSchema | null>(null);
  const [stats, setStats] = useState<StatusRuleExecStat[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [editing, setEditing] = useState<StatusRule | 'new' | null>(null);

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'status-rules', { visible: DEFAULT_VISIBLE, sortKey: 'priority', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      const [r, s, st] = await Promise.all([
        listStatusRules(), getStatusRuleSchema(), getStatusRuleExecStats(),
      ]);
      setRules(r);
      setSchema(s);
      setStats(st);
      setError('');
      onCount(r.length);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? "You don't have access to status rules."
        : "Couldn't load status rules.");
      onCount(null);
    }
  };

  useEffect(() => { void load(); }, []);

  const statsMap = useMemo(
    () => new Map(stats.map((s) => [s.rule_id, s])), [stats],
  );
  const ctx = useMemo<RuleRowContext>(() => ({ schema, stats: statsMap }), [schema, statsMap]);

  const cellText: CellText<StatusRule> = useCallback(
    (r, key) => ruleCellText(r, key, ctx), [ctx],
  );
  const searchText = useCallback(
    (r: StatusRule) => ruleSearchText(r, ctx).toLowerCase(), [ctx],
  );
  const haystack = useSearchHaystacks(rules, searchText);

  const facetGroups = useMemo<FacetGroup[]>(() => {
    if (!schema) return [];
    return [
      { key: 'trigger_status', title: 'Trigger status', options: schema.trigger_statuses.map((o) => (
        { value: o.value, label: o.label }
      )) },
      { key: 'match_type', title: 'Match type', options: schema.match_types.map((o) => (
        { value: o.value, label: o.label }
      )) },
      { key: 'enabled', title: 'Enabled', options: [
        { value: 'enabled', label: 'Enabled' },
        { value: 'disabled', label: 'Disabled' },
      ] },
    ];
  }, [schema]);

  const facetValues = (r: StatusRule) => (groupKey: string): string[] => {
    if (groupKey === 'trigger_status') return [r.trigger_status];
    if (groupKey === 'match_type') return [r.trigger_match_type];
    if (groupKey === 'enabled') return [r.enabled ? 'enabled' : 'disabled'];
    return [];
  };

  const visible = useMemo(() => {
    if (!rules || !schema) return [];
    const q = query.trim().toLowerCase();
    const rows = rules.filter((r) => {
      if (!passesFacets(facets, facetValues(r))) return false;
      if (!passesColumnFilters(r, filters, cellText)) return false;
      if (!q) return true;
      return haystack(r).includes(q);
    });
    return rows.sort((a, b) => {
      const va = ruleSortValue(a, sortKey, ctx), vb = ruleSortValue(b, sortKey, ctx);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
  }, [rules, schema, facets, filters, query, sortKey, sortDir, haystack, cellText, ctx]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 200px` };

  const CSV_COLUMNS = useMemo<[string, (r: StatusRule) => string][]>(() => [
    ['ID', (r) => r.id],
    ['Name', (r) => r.name],
    ['Description', (r) => r.description],
    ['Trigger status', (r) => cellText(r, 'trigger_status')],
    ['Match type', (r) => cellText(r, 'match_type')],
    ['Priority', (r) => cellText(r, 'priority')],
    ['Conditions', (r) => cellText(r, 'conditions')],
    ['Actions', (r) => cellText(r, 'actions')],
    ['Runs', (r) => cellText(r, 'runs')],
    ['Updated', (r) => cellText(r, 'updated')],
    ['Enabled', (r) => cellText(r, 'enabled')],
  ], [cellText]);

  const toggle = async (rule: StatusRule) => {
    setError('');
    try {
      await toggleStatusRule(rule.id, !rule.enabled);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const duplicate = async (rule: StatusRule) => {
    setError('');
    try {
      await createStatusRule({
        name: `${rule.name} (Copy)`, description: rule.description,
        trigger_status: rule.trigger_status, trigger_match_type: rule.trigger_match_type,
        priority: rule.priority, enabled: false,
        conditions: rule.conditions, actions: rule.actions,
      });
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const remove = async (rule: StatusRule) => {
    if (!window.confirm(`Delete "${rule.name}"? This cannot be undone.`)) return;
    setError('');
    try {
      await deleteStatusRule(rule.id);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const cellFor = (rule: StatusRule, key: string) => {
    switch (key) {
      case 'name':
        return (
          <>
            <span className="cell-top"><b>{rule.name}</b></span>
            <span className="cell-sub">{rule.description || '—'}</span>
          </>
        );
      case 'trigger_status': {
        if (!schema) return null;
        const opt = statusOption(schema, rule.trigger_status);
        return (
          <span className="chip custom" style={{ '--chip': opt?.color } as CSSProperties}>
            <span className="dot" />{cellText(rule, 'trigger_status')}
          </span>
        );
      }
      case 'match_type':
        return <span className="chip tag">{cellText(rule, 'match_type')}</span>;
      case 'priority':
        return <span className="mono">{cellText(rule, 'priority')}</span>;
      case 'conditions':
        return <span>{cellText(rule, 'conditions')}</span>;
      case 'actions': {
        const title = schema
          ? (rule.actions.map((a) => summarizeAction(a, schema)).join('\n') || 'No actions')
          : undefined;
        return <span title={title}>{cellText(rule, 'actions')}</span>;
      }
      case 'runs':
        return <span className="cell-sub">{cellText(rule, 'runs')}</span>;
      case 'updated':
        return <span className="cell-sub">{cellText(rule, 'updated')}</span>;
      case 'enabled':
        return (
          <label className="switch">
            <input type="checkbox" checked={rule.enabled} disabled={!canChange}
                   aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                   onChange={() => void toggle(rule)} />
            <span className="track" />
          </label>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {rules?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('status-rules', CSV_COLUMNS, visible)} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setEditing('new')}>
              + New rule
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{rules ? "Couldn't complete that action" : 'Cannot load status rules'}</b>{error}
        </div>
      )}

      {schema && rules && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={rules ?? []} filters={filters}
                            text={cellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <span />
          </div>

          {visible.length === 0 && (
            rules.length === 0 ? (
              <div className="dir-empty">
                <b>No rules yet</b>Create the first one.
              </div>
            ) : (
              <div className="dir-empty">
                <b>No matches</b>Try a different filter.
                <EmptyClearFilters filters={filters}
                                    onClear={() => { clearFilters(); setFacets({}); }} />
              </div>
            )
          )}

          <VirtualRows rows={visible}
            renderRow={(rule, vp) => (
              <div key={rule.id} className="dir-row" {...vp} style={vp?.style}>
                <div className="row-main" style={grid}>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(rule, c.key)}</div>
                  ))}
                  <div className="cell" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {canChange && (
                      <button className="mini-btn" onClick={() => setEditing(rule)}>
                        Edit
                      </button>
                    )}
                    {canAdd && (
                      <button className="mini-btn" onClick={() => void duplicate(rule)}>
                        Duplicate
                      </button>
                    )}
                    {canDelete && (
                      <button className="mini-btn danger" onClick={() => void remove(rule)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )} />
        </div>
      )}

      {editing && schema && (
        <RuleEditorModal
          schema={schema}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </>
  );
}
