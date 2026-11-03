import { describe, expect, it } from 'vitest';

import type { StatusRule, StatusRuleExecStat, StatusRuleSchema } from './api';
import {
  lastRunLabel, optionLabel, ruleCellText, ruleSearchText, ruleSortValue,
  summarizeAction, summarizeCondition,
} from './statusRules';

const SCHEMA: StatusRuleSchema = {
  trigger_statuses: [{ value: 'rfid_4_into_cage', label: 'Into cage' }],
  match_types: [{ value: 'asset', label: 'Asset' }],
  operators: [
    { key: 'equals', label: 'equals', needs_value: true },
    { key: 'is_null', label: 'is null', needs_value: false },
  ],
  condition_fields: [
    { key: 'scan.device_id', label: 'Scan device', type: 'text' },
  ],
  actions: [
    {
      key: 'set_asset_status', label: 'Set asset status',
      params: [{ name: 'status', type: 'status', options: [
        { value: 'rfid_4_into_cage', label: 'Into cage' }] }],
    },
    { key: 'touch_container_audit', label: 'Record container audit touch', params: [] },
    {
      key: 'notify', label: 'Send a notification',
      params: [
        { name: 'people', type: 'people' },
        { name: 'groups', type: 'groups' },
        { name: 'watchers', type: 'bool' },
      ],
    },
  ],
  sites: [],
};

/** What the editor's People and Groups pickers loaded: the names behind the ids. */
const NAMES = {
  people: [{ value: 'p1', label: 'Person A' }, { value: 'p2', label: 'Person B' }],
  groups: [{ value: 'g1', label: 'Group A' }],
};
const notify = (params: Record<string, unknown>) => ({ action_type: 'notify', params });

describe('summarizeCondition', () => {
  it('joins field label, operator, value', () => {
    expect(summarizeCondition(
      { field: 'scan.device_id', operator: 'equals', value: 'dock-1' },
      SCHEMA)).toBe('Scan device equals dock-1');
  });
  it('omits value for no-value operators', () => {
    expect(summarizeCondition(
      { field: 'scan.device_id', operator: 'is_null', value: null },
      SCHEMA)).toBe('Scan device is null');
  });
});

describe('summarizeAction', () => {
  it('resolves status params to labels', () => {
    expect(summarizeAction(
      { action_type: 'set_asset_status', params: { status: 'rfid_4_into_cage' } },
      SCHEMA)).toBe('Set asset status → Into cage');
  });
  it('renders paramless actions as the bare label', () => {
    expect(summarizeAction(
      { action_type: 'touch_container_audit', params: {} },
      SCHEMA)).toBe('Record container audit touch');
  });

  describe('Send a notification', () => {
    it('reads "Notify" and the people, the groups and the watchers, by name', () => {
      expect(summarizeAction(
        notify({ people: ['p1'], groups: ['g1'], watchers: true }), SCHEMA, NAMES,
      )).toBe('Notify Person A, Group A and watchers');
    });

    it('joins two parts with "and", and three or more with commas and a last "and"', () => {
      expect(summarizeAction(
        notify({ people: ['p1', 'p2'], groups: [], watchers: false }), SCHEMA, NAMES,
      )).toBe('Notify Person A and Person B');
      expect(summarizeAction(
        notify({ people: ['p1', 'p2'], groups: ['g1'], watchers: false }), SCHEMA, NAMES,
      )).toBe('Notify Person A, Person B and Group A');
    });

    it('names a single part on its own', () => {
      expect(summarizeAction(
        notify({ people: [], groups: ['g1'], watchers: false }), SCHEMA, NAMES,
      )).toBe('Notify Group A');
      expect(summarizeAction(
        notify({ people: [], groups: [], watchers: true }), SCHEMA, NAMES,
      )).toBe('Notify watchers');
    });

    it('falls back to the id for a person or group that is not in the loaded options', () => {
      expect(summarizeAction(
        notify({ people: ['p1', 'gone'], groups: ['g9'], watchers: true }), SCHEMA, NAMES,
      )).toBe('Notify Person A, gone, g9 and watchers');
    });

    it('reads the ids when no names are loaded at all', () => {
      expect(summarizeAction(
        notify({ people: ['p1'], groups: ['g1'], watchers: true }), SCHEMA,
      )).toBe('Notify p1, g1 and watchers');
      expect(summarizeAction(
        notify({ people: ['p1'], groups: ['g1'], watchers: false }), SCHEMA, {},
      )).toBe('Notify p1 and g1');
    });

    it('leaves a list that is not a list of ids out, and reads a notice to nobody as the bare label', () => {
      expect(summarizeAction(
        notify({ people: 'p1', groups: [3, null], watchers: 'yes' }), SCHEMA, NAMES,
      )).toBe('Send a notification');
      expect(summarizeAction(notify({}), SCHEMA, NAMES)).toBe('Send a notification');
    });

    it('does not turn a list into one comma-joined string of ids', () => {
      const text = summarizeAction(
        notify({ people: ['p1', 'p2'], groups: [], watchers: false }), SCHEMA);
      expect(text).not.toContain('p1,p2');
    });
  });
});

describe('optionLabel', () => {
  it('falls back to the raw value', () => {
    expect(optionLabel([{ value: 'a', label: 'A' }], 'missing')).toBe('missing');
  });
});

const RULE: StatusRule = {
  id: 'r1', name: 'Cage exit', description: 'Clears location',
  trigger_status: 'rfid_4_into_cage', trigger_match_type: 'asset',
  priority: 9, enabled: true,
  conditions: [{ field: 'scan.device_id', operator: 'equals', value: 'dock-1' }],
  actions: [{ action_type: 'set_asset_status', params: { status: 'rfid_4_into_cage' } }],
  created_at: '2026-08-30T12:00:00Z', updated_at: '2026-08-31T09:00:00Z',
};
const STATS = new Map<string, StatusRuleExecStat>([['r1', {
  rule_id: 'r1', run_count: 4, met_count: 3,
  last_run_at: '2026-08-31T10:00:00Z', avg_duration_ms: 5,
}]]);
const CTX = { schema: SCHEMA, stats: STATS };

describe('rule list accessors', () => {
  it('resolves trigger/match labels from the schema', () => {
    expect(ruleCellText(RULE, 'trigger_status', CTX)).toBe('Into cage');
    expect(ruleCellText(RULE, 'match_type', CTX)).toBe('Asset');
  });
  it('renders counts, runs, and enabled text', () => {
    expect(ruleCellText(RULE, 'conditions', CTX)).toBe('1');
    expect(ruleCellText(RULE, 'actions', CTX)).toBe('1');
    expect(ruleCellText(RULE, 'runs', CTX)).toMatch(/^4 · /);
    expect(ruleCellText(RULE, 'enabled', CTX)).toBe('Enabled');
    expect(ruleCellText({ ...RULE, enabled: false }, 'enabled', CTX)).toBe('Disabled');
  });
  it('runs shows never without stats', () => {
    expect(ruleCellText(RULE, 'runs', { schema: SCHEMA, stats: new Map() }))
      .toBe('0 · never');
  });
  it('searchText covers name, description, and resolved labels', () => {
    const hay = ruleSearchText(RULE, CTX).toLowerCase();
    for (const bit of ['cage exit', 'clears location', 'into cage', 'asset']) {
      expect(hay).toContain(bit);
    }
  });
  it('sortValue is numeric for priority/counts/runs', () => {
    expect(ruleSortValue(RULE, 'priority', CTX)).toBe(9);
    expect(ruleSortValue(RULE, 'runs', CTX)).toBe(4);
    expect(ruleSortValue(RULE, 'conditions', CTX)).toBe(1);
  });
  it('lastRunLabel', () => {
    expect(lastRunLabel(null)).toBe('never');
    expect(lastRunLabel('2026-08-31T10:00:00Z')).not.toBe('never');
  });
});
