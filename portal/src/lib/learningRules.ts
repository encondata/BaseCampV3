/**
 * Assignment-rule vocabulary shared by the Rules page, the rule editor and
 * the tests: the fields a condition can test, how their values are
 * normalized (the API stores UUIDs lowercased and countries uppercased, so
 * the portal does the same before it compares or sends them), and the
 * "When <field> is <values>" wording.
 */

import type { RuleCondition } from './learning';

export type RuleField =
  | 'everyone' | 'initiative' | 'client' | 'site' | 'site_country'
  | 'worker_role' | 'partner' | 'person';

export const RULE_FIELDS: { key: RuleField; label: string; noun: string }[] = [
  { key: 'everyone', label: 'Everyone', noun: '' },
  { key: 'initiative', label: 'Initiative', noun: 'initiatives' },
  { key: 'client', label: 'Client', noun: 'clients' },
  { key: 'site', label: 'Site', noun: 'sites' },
  { key: 'site_country', label: 'Site country', noun: 'countries' },
  { key: 'worker_role', label: 'Worker role', noun: 'worker roles' },
  { key: 'partner', label: 'Partner', noun: 'partners' },
  { key: 'person', label: 'Person', noun: 'people' },
];

export const fieldLabel = (field: string): string =>
  RULE_FIELDS.find((f) => f.key === field)?.label ?? field;

/** Fields whose values are ids. */
const UUID_FIELDS = new Set<string>(['initiative', 'client', 'site', 'partner', 'person']);

/** One value as the API will store it: ids lowercase, countries upper case,
 *  anything else trimmed. */
export function normalizeValue(field: string, value: string): string {
  const v = value.trim();
  if (UUID_FIELDS.has(field)) return v.toLowerCase();
  if (field === 'site_country') return v.toUpperCase();
  return v;
}

/** The values of a condition, normalized, without blanks or repeats. */
export function normalizeValues(field: string, values: string[]): string[] {
  const out = values.map((v) => normalizeValue(field, v)).filter((v) => v !== '');
  return Array.from(new Set(out));
}

/** What the editor holds for one condition row. */
export interface ConditionDraft { field: RuleField | ''; values: string[] }

/** The `conditions` body for create/patch: `everyone` takes no values. */
export function buildConditions(rows: ConditionDraft[]): RuleCondition[] {
  return rows.map((r) => ({
    field: r.field,
    values: r.field === 'everyone' ? [] : normalizeValues(r.field, r.values),
  }));
}

/** A rule can be saved when every condition says something. */
export function conditionsComplete(rows: ConditionDraft[]): boolean {
  return rows.length > 0
    && rows.every((r) => r.field !== '')
    && rows.every((r) => r.field === 'everyone' || normalizeValues(r.field, r.values).length > 0);
}

/** Editor rows from a stored rule (unknown fields are kept as they are). */
export function draftsFrom(conditions: RuleCondition[]): ConditionDraft[] {
  return conditions.map((c) => ({ field: c.field as RuleField, values: [...c.values] }));
}

export const RULE_ERRORS: Record<string, string> = {
  bad_rule_field: 'One of the conditions tests something rules can’t test.',
  bad_rule_values: 'Every condition needs at least one value.',
  bad_packet: 'Pick a packet that exists and isn’t archived.',
  bad_order: 'The rules changed meanwhile. Reload and try again.',
};

export const PACKET_ERRORS: Record<string, string> = {
  duplicate_document: 'A document can be in a packet only once.',
  bad_document: 'A document in this packet doesn’t exist or is archived. Remove it and try again.',
  archived: 'This packet is archived, so it can’t be changed.',
  not_found: 'That packet is gone. Reload the list.',
};
