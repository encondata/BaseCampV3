/** Rules tab — status-rule directory list. Deliberately simpler than
 *  Notifications: rules run in the dozens, so this is search + rows
 *  sorted by priority, no column menus, virtualization, or CSV. Trigger
 *  and action labels are resolved from the /status-rules schema so the
 *  list can never drift from the engine's vocabulary. The editor modal
 *  (create/edit) lands in Task 11 — "+ New rule" and row Edit are
 *  no-ops here. */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, createStatusRule, deleteStatusRule, getStatusRuleExecStats,
  getStatusRuleSchema, listStatusRules, toggleStatusRule,
  type StatusRule, type StatusRuleExecStat, type StatusRuleSchema,
} from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { summarizeAction } from '../../lib/statusRules';

// Name | Trigger | Priority | Conditions | Actions | Runs | Enabled | row actions
const GRID = '1.6fr 1.3fr 80px 100px 90px 150px 80px 200px';

function statusOption(schema: StatusRuleSchema, value: string) {
  return schema.trigger_statuses.find((o) => o.value === value);
}

function matchTypeLabel(schema: StatusRuleSchema, value: string): string {
  return schema.match_types.find((o) => o.value === value)?.label ?? value;
}

function ruleSearchText(r: StatusRule, schema: StatusRuleSchema): string {
  return [
    r.name, r.description,
    statusOption(schema, r.trigger_status)?.label ?? r.trigger_status,
    matchTypeLabel(schema, r.trigger_match_type),
  ].join(' ').toLowerCase();
}

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

  const statFor = (id: string) => stats.find((s) => s.rule_id === id);

  const visible = useMemo(() => {
    if (!rules || !schema) return [];
    const q = query.trim().toLowerCase();
    const rows = q ? rules.filter((r) => ruleSearchText(r, schema).includes(q)) : rules;
    return [...rows].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  }, [rules, schema, query]);

  const toggle = async (rule: StatusRule) => {
    try {
      await toggleStatusRule(rule.id, !rule.enabled);
    } finally {
      await load();
    }
  };

  const duplicate = async (rule: StatusRule) => {
    try {
      await createStatusRule({
        name: `${rule.name} (Copy)`, description: rule.description,
        trigger_status: rule.trigger_status, trigger_match_type: rule.trigger_match_type,
        priority: rule.priority, enabled: false,
        conditions: rule.conditions, actions: rule.actions,
      });
    } finally {
      await load();
    }
  };

  const remove = async (rule: StatusRule) => {
    if (!window.confirm(`Delete "${rule.name}"? This cannot be undone.`)) return;
    try {
      await deleteStatusRule(rule.id);
    } finally {
      await load();
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
          {canAdd && (
            <button className="btn-solid" onClick={() => { /* Task 11: open the create modal */ }}>
              + New rule
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load status rules</b>{error}
        </div>
      )}

      {!error && schema && (
        <div className="dir-list">
          <div className="list-head" style={{ gridTemplateColumns: GRID }}>
            <span className="col-head">Name</span>
            <span className="col-head">Trigger</span>
            <span className="col-head">Priority</span>
            <span className="col-head">Conditions</span>
            <span className="col-head">Actions</span>
            <span className="col-head">Runs</span>
            <span className="col-head">Enabled</span>
            <span className="col-head" />
          </div>

          {rules && visible.length === 0 && (
            rules.length === 0 ? (
              <div className="dir-empty">
                <b>No rules yet</b>Create the first one.
              </div>
            ) : (
              <div className="dir-empty">
                <b>No matches</b>Try a different search.
              </div>
            )
          )}

          {visible.map((rule) => {
            const opt = statusOption(schema, rule.trigger_status);
            const stat = statFor(rule.id);
            const actionsTitle = rule.actions
              .map((a) => summarizeAction(a, schema)).join('\n') || 'No actions';
            return (
              <div key={rule.id} className="dir-row">
                <div className="row-main" style={{ gridTemplateColumns: GRID, cursor: 'default' }}>
                  <div className="cell">
                    <span className="cell-top"><b>{rule.name}</b></span>
                    <span className="cell-sub">{rule.description || '—'}</span>
                  </div>
                  <div className="cell">
                    <div className="chips">
                      <span className="chip custom" style={{ '--chip': opt?.color } as CSSProperties}>
                        <span className="dot" />{opt?.label ?? rule.trigger_status}
                      </span>
                      <span className="chip tag">{matchTypeLabel(schema, rule.trigger_match_type)}</span>
                    </div>
                  </div>
                  <div className="cell mono">{rule.priority}</div>
                  <div className="cell">{rule.conditions.length}</div>
                  <div className="cell" title={actionsTitle}>{rule.actions.length}</div>
                  <div className="cell cell-sub">
                    {stat?.run_count ?? 0} · {relativeTime(stat?.last_run_at ?? null)}
                  </div>
                  <div className="cell">
                    <label className="switch">
                      <input type="checkbox" checked={rule.enabled} disabled={!canChange}
                             aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                             onChange={() => void toggle(rule)} />
                      <span className="track" />
                    </label>
                  </div>
                  <div className="cell" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {canChange && (
                      <button className="mini-btn" onClick={() => { /* Task 11: open the edit modal */ }}>
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
            );
          })}
        </div>
      )}
    </>
  );
}
