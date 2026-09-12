import { expect, it } from 'vitest';

import type { InitiativeItem } from './api';
import {
  canGenerate, hasHiddenErrors, isRunActive, isValidToken, jsonToRuleRows, progressPct,
  ruleRowsToJson, sortedErrorSummary, validateRuleRows, visibleInitiativesForGenerate,
} from './generateLabels';

const ini = (id: string, status: string, createdAt: string, archived: string | null = null) => ({
  id, name: id, status, archived_at: archived, created_at: createdAt,
} as unknown as InitiativeItem);

it('visibleInitiativesForGenerate hides archived and finished statuses, newest first', () => {
  const items = [
    ini('a', 'in_progress', '2026-01-01T00:00:00Z'),
    ini('b', 'completed', '2026-06-01T00:00:00Z'),
    ini('c', 'cancelled', '2026-06-01T00:00:00Z'),
    ini('d', 'planned', '2026-03-01T00:00:00Z'),
    ini('e', 'in_progress', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'),
  ];
  expect(visibleInitiativesForGenerate(items).map((i) => i.id)).toEqual(['d', 'a']);
});

it('canGenerate requires an initiative and >=1 type, and blocks while a run is active', () => {
  expect(canGenerate({ initiativeId: null, labelTypes: [], activeRunId: null })).toBe(false);
  expect(canGenerate({ initiativeId: 'i1', labelTypes: [], activeRunId: null })).toBe(false);
  expect(canGenerate({ initiativeId: 'i1', labelTypes: ['top'], activeRunId: null })).toBe(true);
  expect(canGenerate({ initiativeId: 'i1', labelTypes: ['top'], activeRunId: 'r1' })).toBe(false);
});

it('isRunActive is true only for queued/running', () => {
  expect(isRunActive(null)).toBe(false);
  expect(isRunActive({ status: 'queued' })).toBe(true);
  expect(isRunActive({ status: 'running' })).toBe(true);
  expect(isRunActive({ status: 'completed' })).toBe(false);
  expect(isRunActive({ status: 'failed' })).toBe(false);
  expect(isRunActive({ status: 'canceled' })).toBe(false);
});

it('progressPct prefers the server progress_pct, falls back to processed/total, and clamps', () => {
  expect(progressPct({ progress_pct: 42, processed: 1, total: 100 })).toBe(42);
  expect(progressPct({ progress_pct: null, processed: 25, total: 100 })).toBe(25);
  expect(progressPct({ processed: 1, total: 3 })).toBe(33);
  expect(progressPct({ processed: 0, total: 0 })).toBe(0);
  expect(progressPct({ progress_pct: 140, processed: 0, total: 0 })).toBe(100);
});

it('sortedErrorSummary sorts by count desc, ties alphabetically', () => {
  expect(sortedErrorSummary({ no_template: 1, unknown_token: 5, bad_data: 5 })).toEqual([
    ['bad_data', 5], ['unknown_token', 5], ['no_template', 1],
  ]);
});

it('hasHiddenErrors compares errors count to the (capped) error_details length', () => {
  expect(hasHiddenErrors({ errors: 3, error_details: [{}, {}, {}] as never })).toBe(false);
  expect(hasHiddenErrors({ errors: 60, error_details: Array(50).fill({}) as never })).toBe(true);
});

it('isValidToken accepts lowercase/digits/underscore only', () => {
  expect(isValidToken('row')).toBe(true);
  expect(isValidToken('row_2')).toBe(true);
  expect(isValidToken('Row')).toBe(false);
  expect(isValidToken('row-2')).toBe(false);
  expect(isValidToken('')).toBe(false);
});

it('jsonToRuleRows / ruleRowsToJson round-trip generation_rules', () => {
  const rules = {
    destination: { '1': 'nap', '2': 'row' },
    source: { '1': 'building' },
    length_limits: { asset_name: 20 },
  };
  const rows = jsonToRuleRows(rules);
  expect(rows.destination).toEqual([{ position: '1', token: 'nap' }, { position: '2', token: 'row' }]);
  expect(rows.source).toEqual([{ position: '1', token: 'building' }]);
  expect(rows.lengthLimits).toEqual([{ token: 'asset_name', limit: '20' }]);
  expect(ruleRowsToJson(rows)).toEqual(rules);
});

it('jsonToRuleRows on empty/undefined rules gives empty rows, and that round-trips to {}', () => {
  const rows = jsonToRuleRows(undefined);
  expect(rows).toEqual({ destination: [], source: [], lengthLimits: [] });
  expect(ruleRowsToJson(rows)).toEqual({});
});

it('ruleRowsToJson drops untouched blank rows', () => {
  const rows = {
    destination: [{ position: '1', token: 'nap' }, { position: '', token: '' }],
    source: [], lengthLimits: [{ token: '', limit: '' }],
  };
  expect(ruleRowsToJson(rows)).toEqual({ destination: { '1': 'nap' } });
});

it('validateRuleRows accepts well-formed rows and ignores blank ones', () => {
  expect(validateRuleRows({
    destination: [{ position: '2', token: 'row' }, { position: '', token: '' }],
    source: [], lengthLimits: [{ token: 'asset_name', limit: '20' }],
  })).toBeNull();
});

it('validateRuleRows rejects a bad token', () => {
  expect(validateRuleRows({
    destination: [{ position: '2', token: 'Row Name' }], source: [], lengthLimits: [],
  })).toMatch(/lowercase/);
});

it('validateRuleRows rejects a non-numeric position and a non-positive length limit', () => {
  expect(validateRuleRows({
    destination: [{ position: 'x', token: 'row' }], source: [], lengthLimits: [],
  })).toMatch(/Position/);
  expect(validateRuleRows({
    destination: [], source: [], lengthLimits: [{ token: 'asset_name', limit: '0' }],
  })).toMatch(/positive whole number/);
});
