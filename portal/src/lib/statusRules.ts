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

export function summarizeAction(
  a: StatusRuleAction, schema: StatusRuleSchema,
): string {
  const def = schema.actions.find((d) => d.key === a.action_type);
  if (!def) return a.action_type;
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
    case 'updated': return rule.updated_at;
    case 'enabled': return rule.enabled ? 1 : 0;
    default: return ruleCellText(rule, key, ctx).toLowerCase();
  }
}
