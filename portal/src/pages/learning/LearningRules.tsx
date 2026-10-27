/**
 * /learning/rules — the assignment rules in the order they run: each row
 * reads "When <field> is <values> → <packet>" with an On/Off chip and an
 * actions menu (Edit, Turn on/off, Move up/down, Delete). Drag a row, or use
 * Move up / Move down, to reorder; the full order is posted to /reorder.
 * New rule and Edit open the rule editor. Below the rules, the dry-run panel
 * previews what they would assign for an initiative. Reads need
 * learning:view; every control follows the API's action (add, change,
 * delete).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import DryRunPanel from '../../components/learning/DryRunPanel';
import RuleEditorModal from '../../components/learning/RuleEditorModal';
import { useLearningAccess } from '../../components/learning/useLearningAccess';
import { useRuleLookups, type LookupKind, type RuleLookups } from '../../components/learning/useRuleLookups';
import { RowActionsMenu, type RowAction } from '../../components/hardware/RowActionsMenu';
import { useAuth } from '../../auth/AuthContext';
import {
  deleteLearningRule, listLearningRules, patchLearningRule, reorderLearningRules,
  type LearningRule,
} from '../../lib/learning';
import { apiErrorText } from '../../lib/learningDoc';
import { fieldLabel, RULE_ERRORS } from '../../lib/learningRules';
import {
  ACTIONS_TRACK, ColHead, listGridStyle, listScale, moveKey, useReorderDrag, type ColumnDef,
} from '../../lib/listTools';
import { useToast } from '../../lib/notificationsContext';
import '../../styles/directory.css';
import '../../styles/learning.css';

export const RULE_COLUMNS = {
  order: { key: 'order', label: 'Order', short: '#', width: '64px', default: true, min: 64 },
  name: { key: 'name', label: 'Rule', width: '1.2fr', default: true, min: 150 },
  when: { key: 'when', label: 'Who gets which packet', short: 'Assigns', width: '3fr', default: true, min: 360 },
  status: { key: 'status', label: 'Status', width: '80px', default: true, min: 80 },
};

/** Values shown as tokens before the rest fold into "+N more". */
const SHOWN_VALUES = 3;

function ConditionTokens({ rule, lookups }: { rule: LearningRule; lookups: RuleLookups }) {
  const everyoneOnly = rule.conditions.length === 1 && rule.conditions[0].field === 'everyone';
  return (
    <div className="lrn-cond-text">
      {!everyoneOnly && <span className="cell-sub">When</span>}
      {rule.conditions.map((c, i) => (
        <span className="lrn-cond-part" key={`${c.field}-${i}`}>
          {i > 0 && <span className="cell-sub">and</span>}
          <span className="lrn-tok k">{fieldLabel(c.field)}</span>
          {c.field !== 'everyone' && (
            <>
              <span className="cell-sub">is</span>
              {c.values.slice(0, SHOWN_VALUES).map((v, at) => (
                <span className="lrn-cond-part" key={v}>
                  {at > 0 && <span className="cell-sub">or</span>}
                  <span className="lrn-tok">{lookups.label(c.field as LookupKind, v)}</span>
                </span>
              ))}
              {c.values.length > SHOWN_VALUES && (
                <span className="lrn-tok" title={c.values.map((v) => lookups.label(c.field as LookupKind, v)).join(', ')}>
                  +{c.values.length - SHOWN_VALUES} more
                </span>
              )}
            </>
          )}
        </span>
      ))}
      <span className="lrn-arrow" aria-hidden="true">→</span>
      <span className="lrn-tok">{rule.packet_name}</span>
      {rule.packet_archived && (
        <span className="chip c-amber" title="The packet is archived, so this rule assigns nothing">Packet archived</span>
      )}
    </div>
  );
}

export default function LearningRules() {
  const { preferences } = useAuth();
  const toast = useToast();
  const can = useLearningAccess();
  const canAdd = can('add');
  const canChange = can('change');
  const canDelete = can('delete');
  const lookups = useRuleLookups();

  const [rules, setRules] = useState<LearningRule[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ rule: LearningRule | null } | null>(null);

  // The newest order the user has asked for. Reorders post one at a time and
  // only the last answer repaints, so a quick second move never snaps back.
  const orderRef = useRef<LearningRule[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const outstanding = useRef(0);
  const commit = useCallback((next: LearningRule[]) => { orderRef.current = next; setRules(next); }, []);

  const load = useCallback(() => {
    setFailed(false);
    listLearningRules()
      .then(commit)
      .catch(() => { setFailed(true); setRules((r) => r ?? []); });
  }, [commit]);
  useEffect(() => { load(); }, [load]);

  // the names behind the values the rules already use
  useEffect(() => {
    (rules ?? []).forEach((r) => r.conditions.forEach((c) => {
      if (c.field !== 'everyone') lookups.load(c.field as LookupKind);
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  const reorder = (ids: string[]) => {
    const byId = new Map(orderRef.current.map((r) => [r.id, r]));
    if (ids.join() === orderRef.current.map((r) => r.id).join()) return;
    setError('');
    commit(ids.map((id) => byId.get(id)!));
    outstanding.current += 1;
    queue.current = queue.current.then(async () => {
      try {
        const saved = await reorderLearningRules(ids);
        if (outstanding.current === 1) commit(saved);
      } catch (e) {
        setError(apiErrorText(e, RULE_ERRORS, 'Couldn’t save the new order.'));
        load();
      } finally {
        outstanding.current -= 1;
      }
    });
  };

  const move = (rule: LearningRule, by: -1 | 1) => {
    const ids = orderRef.current.map((r) => r.id);
    const at = ids.indexOf(rule.id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    reorder(ids);
  };

  const drag = useReorderDrag(
    (src, dst, before) => reorder(moveKey(orderRef.current.map((r) => r.id), src, dst, before)),
    'y', { ignoreFrom: 'button, input' });

  const toggle = async (rule: LearningRule) => {
    setBusy(true);
    setError('');
    try {
      const saved = await patchLearningRule(rule.id, { enabled: !rule.enabled });
      commit(orderRef.current.map((r) => (r.id === rule.id ? saved : r)));
    } catch (e) {
      setError(apiErrorText(e, RULE_ERRORS));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rule: LearningRule) => {
    if (!window.confirm(`Delete the rule “${rule.name}”? Assignments it already made stay.`)) return;
    setBusy(true);
    setError('');
    try {
      await deleteLearningRule(rule.id);
      commit(orderRef.current.filter((r) => r.id !== rule.id));
      toast(`Deleted ${rule.name}`);
    } catch (e) {
      setError(apiErrorText(e, RULE_ERRORS));
    } finally {
      setBusy(false);
    }
  };

  const saved = (rule: LearningRule) => {
    const isNew = editing?.rule === null;
    commit(isNew ? [...orderRef.current, rule] : orderRef.current.map((r) => (r.id === rule.id ? rule : r)));
    setEditing(null);
    toast(isNew ? `Created ${rule.name}` : `Saved ${rule.name}`);
  };

  const goToDryRun = () => {
    document.getElementById('lrn-dryrun')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    document.getElementById('lrn-dryrun-initiative')?.focus();
  };

  const anyAction = canChange || canDelete;
  const columns: ColumnDef[] = Object.values(RULE_COLUMNS);
  const grid = listGridStyle(columns, anyAction ? [ACTIONS_TRACK] : [], undefined, listScale(preferences?.list_size));
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
  const list = rules ?? [];
  const loadFailed = failed && list.length === 0;

  const actionsFor = (rule: LearningRule, at: number): RowAction[] => [
    ...(canChange ? [
      { key: 'edit', label: 'Edit', onSelect: () => setEditing({ rule }) },
      { key: 'toggle', label: rule.enabled ? 'Turn off' : 'Turn on', disabled: busy, onSelect: () => void toggle(rule) },
      { key: 'up', label: 'Move up', disabled: at === 0, onSelect: () => move(rule, -1) },
      { key: 'down', label: 'Move down', disabled: at === list.length - 1, onSelect: () => move(rule, 1) },
    ] : []),
    ...(canDelete ? [{
      key: 'delete', label: 'Delete', destructive: true, disabled: busy, onSelect: () => void remove(rule),
    }] : []),
  ];

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Learning</div>
          <h1 className="page-title">
            Assignment rules
            {rules !== null && !loadFailed && <span className="badge-count">{list.length}</span>}
          </h1>
          <p className="page-hint">
            Rules run when someone is added to an initiative, and when you assign by hand.
          </p>
        </div>
        <div className="lrn-head-actions">
          <button type="button" className="btn-ghost" onClick={goToDryRun}>Dry run</button>
          {canAdd && (
            <button type="button" className="btn-solid" onClick={() => setEditing({ rule: null })}>New rule</button>
          )}
        </div>
      </div>

      {error && <p className="pf-error" role="alert">{error}</p>}
      {loadFailed && (
        <div className="dir-empty" role="alert">
          <b>Couldn’t load the rules.</b>
          <div className="audit-more">
            <button type="button" className="mini-btn" onClick={load}>Try again</button>
          </div>
        </div>
      )}
      {rules === null && <p className="page-hint">Loading…</p>}

      {rules !== null && !loadFailed && (
        <>
          {canChange && list.length > 1 && (
            <p className="lrn-hint lrn-order-hint">Drag a rule to reorder, or use Move up and Move down in its menu.</p>
          )}
          <div className="dir-list list-scroll lrn-rule-list" role="group" aria-label="Assignment rules">
            <div className="list-head" style={rowStyle}>
              {columns.map((c) => <ColHead key={c.key} col={c} />)}
              {anyAction && <span className="col-head" aria-hidden="true" />}
            </div>
            {list.length === 0 && (
              <div className="dir-empty">
                <b>No rules yet</b>
                {canAdd ? 'Create the first one.' : 'Rules appear here once a manager adds them.'}
              </div>
            )}
            {list.map((rule, at) => (
              <div key={rule.id}
                   className={`dir-row${canChange ? ` ${drag.dropClass(rule.id)}` : ''}${rule.enabled ? '' : ' lrn-rule-off'}`}
                   style={{ minWidth: rowStyle.minWidth } as CSSProperties}
                   {...(canChange ? drag.dragProps(rule.id) : {})}>
                <div className="row-main" style={rowStyle}>
                  <div className="cell lrn-order-cell">
                    {canChange && <span className="lrn-grip" aria-hidden="true">⋮⋮</span>}
                    <span className="cell-sub">{at + 1}</span>
                  </div>
                  <div className="cell">
                    <span className="lrn-rule-name cell-top cell-line" title={rule.name}>{rule.name}</span>
                  </div>
                  <div className="cell"><ConditionTokens rule={rule} lookups={lookups} /></div>
                  <div className="cell">
                    <span className={`chip ${rule.enabled ? 'c-green' : 'c-slate'}`}>{rule.enabled ? 'On' : 'Off'}</span>
                  </div>
                  {anyAction && (
                    <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <RowActionsMenu actions={actionsFor(rule, at)} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <DryRunPanel />

      {editing && (
        <RuleEditorModal rule={editing.rule} lookups={lookups}
                         onClose={() => setEditing(null)} onSaved={saved} />
      )}
    </div>
  );
}
