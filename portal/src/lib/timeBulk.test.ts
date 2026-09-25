import { expect, it } from 'vitest';

import {
  approveAllQuestion, bulkFilter, bulkResultText, dayEndIso, dayStartIso, entriesText, hasFilter,
  listQuery, NO_FILTER, timeSourceLabel,
} from './timeBulk';

it('labels every time source, Import included', () => {
  expect(timeSourceLabel('import')).toBe('Import');
  expect(timeSourceLabel('kiosk')).toBe('Kiosk');
  expect(timeSourceLabel('manual')).toBe('Manual');
  expect(timeSourceLabel('punch')).toBe('Punch');
  expect(timeSourceLabel('api')).toBe('Api');
});

it('turns the filters into the list query and the bulk filter', () => {
  const f = { ...NO_FILTER, person_id: 'p1', from: '2026-09-01', to: '2026-09-15' };
  expect(hasFilter(NO_FILTER)).toBe(false);
  expect(hasFilter(f)).toBe(true);
  expect(dayStartIso('2026-09-01')).toBe(new Date(2026, 8, 1).toISOString());
  expect(dayEndIso('2026-09-15')).toBe(new Date(2026, 8, 15, 23, 59, 59, 999).toISOString());
  expect(dayStartIso('')).toBeUndefined();
  expect(bulkFilter(f)).toEqual({
    person_id: 'p1', from: dayStartIso('2026-09-01'), to: dayEndIso('2026-09-15'),
  });
  expect(bulkFilter(NO_FILTER)).toEqual({});
  expect(listQuery('pending', f)).toEqual({
    status: 'pending', person_id: 'p1', since: dayStartIso('2026-09-01'),
    until: dayEndIso('2026-09-15'),
  });
  expect(listQuery('all', NO_FILTER)).toEqual({});
});

it('writes the result and question sentences', () => {
  const skip = (reason: string) => ({ entry_id: 'x', person: null, date: null, reason });
  expect(entriesText(1)).toBe('1 entry');
  expect(entriesText(5000)).toBe('5,000 entries');
  expect(bulkResultText('Approved', 212, [skip('your own entry'), skip('no longer pending')]))
    .toBe('Approved 212 entries. Skipped 2: your own entry (1), no longer pending (1).');
  expect(bulkResultText('Rejected', 1, [])).toBe('Rejected 1 entry.');
  expect(bulkResultText('Approved', 3,
    [skip('not found'), skip('no longer pending'), skip('no longer pending')]))
    .toBe('Approved 3 entries. Skipped 3: no longer pending (2), not found (1).');
  expect(approveAllQuestion(214)).toBe('Approve 214 pending entries that match these filters?');
  expect(approveAllQuestion(1)).toBe('Approve 1 pending entry that matches these filters?');
  expect(approveAllQuestion(5000)).toBe('Approve 5,000 pending entries that match these filters?');
});
