/** Display helpers for status rules — pure functions over the /schema
 *  payload so list rows and the editor share one rendering of
 *  conditions and actions. No imports from components. */

import type {
  SchemaOption, StatusRule, StatusRuleAction, StatusRuleCondition,
  StatusRuleExecStat, StatusRuleSchema,
} from './api';

export function optionLabel(
  options: (string | SchemaOption)[] | undefined, value: string,
): string {
  for (const o of options ?? []) {
    if (typeof o === 'string') { if (o === value) return o; }
    else if (o.value === value) return o.label;
  }
  return value;
}

export function summarizeCondition(
  c: StatusRuleCondition, schema: StatusRuleSchema,
): string {
  const field = schema.condition_fields.find((f) => f.key === c.field);
  const op = schema.operators.find((o) => o.key === c.operator);
  const parts = [field?.label ?? c.field, op?.label ?? c.operator];
  if (op?.needs_value !== false && c.value != null) {
    const fieldOpts = field?.options;
    parts.push(fieldOpts ? optionLabel(fieldOpts, c.value) : c.value);
  }
  return parts.join(' ');
}

/** The key of the Send a notification action. A rule has at most one. */
export const NOTIFY_ACTION = 'notify';

/** The names behind the ids a Send a notification action holds, as far as the caller has loaded
 *  them (the editor's People and Groups options). An id with no name here reads as itself. */
export interface ActionNames {
  people?: Pick<SchemaOption, 'value' | 'label'>[];
  groups?: Pick<SchemaOption, 'value' | 'label'>[];
}

/** "A", "A and B", "A, B and C". */
function joinWords(parts: string[]): string {
  return parts.length < 2
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Notify Person A, Group A and watchers": the people, then the groups, by name, then the
 *  watchers. An action that notifies nobody (the API refuses to save one) reads as its label. */
function summarizeNotify(
  a: StatusRuleAction, label: string, names: ActionNames,
): string {
  const named = (raw: unknown, options: ActionNames['people']): string[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => optionLabel(options, id));
  const parts = [
    ...named(a.params.people, names.people),
    ...named(a.params.groups, names.groups),
  ];
  if (a.params.watchers === true) parts.push('watchers');
  return parts.length ? `Notify ${joinWords(parts)}` : label;
}

export function summarizeAction(
  a: StatusRuleAction, schema: StatusRuleSchema, names: ActionNames = {},
): string {
  const def = schema.actions.find((d) => d.key === a.action_type);
  if (!def) return a.action_type;
  if (a.action_type === NOTIFY_ACTION) return summarizeNotify(a, def.label, names);
  const values = def.params.map((p) => {
    const raw = a.params[p.name];
    return optionLabel(p.options, String(raw));
  });
  return values.length ? `${def.label} → ${values.join(', ')}` : def.label;
}

/* ── list-row accessors ─────────────────────────────────────────────
 * Pure accessors shared by RulesTab's cell rendering, search, sort, and
 * CSV export — the single source of truth for a rule row's display text
 * so those four surfaces can never drift from each other. No component
 * imports (kept pure per the module's own rule above). */

export interface RuleRowContext {
  schema: StatusRuleSchema | null;
  stats: Map<string, StatusRuleExecStat>;
}

export function lastRunLabel(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

/** Must mirror the rendered cell text exactly (search/CSV contract). */
export function ruleCellText(
  rule: StatusRule, key: string, ctx: RuleRowContext,
): string {
  const stat = ctx.stats.get(rule.id);
  switch (key) {
    case 'name': return rule.name;
    case 'trigger_status':
      return optionLabel(ctx.schema?.trigger_statuses, rule.trigger_status);
    case 'match_type':
      return optionLabel(ctx.schema?.match_types, rule.trigger_match_type);
    case 'priority': return String(rule.priority);
    case 'conditions': return String(rule.conditions.length);
    case 'actions': return String(rule.actions.length);
    case 'runs':
      return `${stat?.run_count ?? 0} · ${lastRunLabel(stat?.last_run_at)}`;
    case 'updated': return new Date(rule.updated_at).toLocaleString();
    case 'enabled': return rule.enabled ? 'Enabled' : 'Disabled';
    default: return '';
  }
}

export function ruleSearchText(rule: StatusRule, ctx: RuleRowContext): string {
  return [
    rule.name, rule.description,
    ruleCellText(rule, 'trigger_status', ctx),
    ruleCellText(rule, 'match_type', ctx),
  ].join(' ');
}

export function ruleSortValue(
  rule: StatusRule, key: string, ctx: RuleRowContext,
): string | number {
  const stat = ctx.stats.get(rule.id);
  switch (key) {
    case 'priority': return rule.priority;
    case 'conditions': return rule.conditions.length;
    case 'actions': return rule.actions.length;
    case 'runs': return stat?.run_count ?? 0;
    case 'updated': return Date.parse(rule.updated_at);
    case 'enabled': return rule.enabled ? 1 : 0;
    default: return ruleCellText(rule, key, ctx).toLowerCase();
  }
}
