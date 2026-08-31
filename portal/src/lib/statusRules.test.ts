import { describe, expect, it } from 'vitest';

import type { StatusRuleSchema } from './api';
import { optionLabel, summarizeAction, summarizeCondition } from './statusRules';

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
  ],
  sites: [],
};

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
});

describe('optionLabel', () => {
  it('falls back to the raw value', () => {
    expect(optionLabel([{ value: 'a', label: 'A' }], 'missing')).toBe('missing');
  });
});
