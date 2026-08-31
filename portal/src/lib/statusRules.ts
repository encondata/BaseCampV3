/** Display helpers for status rules — pure functions over the /schema
 *  payload so list rows and the editor share one rendering of
 *  conditions and actions. No imports from components. */

import type {
  SchemaOption, StatusRuleAction, StatusRuleCondition, StatusRuleSchema,
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
