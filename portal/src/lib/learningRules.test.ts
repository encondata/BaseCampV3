import { expect, it } from 'vitest';

import {
  buildConditions, conditionsComplete, draftsFrom, normalizeValue, normalizeValues,
} from './learningRules';

it('lowercases ids, upper-cases countries and trims the rest', () => {
  expect(normalizeValue('client', ' 0A1B2C3D-0000-4000-8000-ABCDEFABCDEF ')).toBe('0a1b2c3d-0000-4000-8000-abcdefabcdef');
  expect(normalizeValue('site_country', ' singapore ')).toBe('SINGAPORE');
  expect(normalizeValue('worker_role', ' forklift ')).toBe('forklift');
});

it('drops blanks and repeats after normalizing', () => {
  expect(normalizeValues('site_country', ['sg', 'SG', ' ', 'my'])).toEqual(['SG', 'MY']);
});

it('everyone is sent with no values even if some linger in the draft', () => {
  expect(buildConditions([{ field: 'everyone', values: ['x'] }])).toEqual([{ field: 'everyone', values: [] }]);
});

it('a rule is complete only when every non-everyone condition has a value', () => {
  expect(conditionsComplete([])).toBe(false);
  expect(conditionsComplete([{ field: 'everyone', values: [] }])).toBe(true);
  expect(conditionsComplete([{ field: 'client', values: [] }])).toBe(false);
  expect(conditionsComplete([{ field: 'client', values: [' '] }])).toBe(false);
  expect(conditionsComplete([{ field: 'client', values: ['c1'] }, { field: 'site_country', values: ['sg'] }])).toBe(true);
});

it('drafts copy the stored values', () => {
  const stored = [{ field: 'client', values: ['a'] }];
  const drafts = draftsFrom(stored);
  drafts[0].values.push('b');
  expect(stored[0].values).toEqual(['a']);
});
