import { expect, it } from 'vitest';

import {
  activeRawFilters, rangeBounds, rangeFilter, scannedRange, serverColumnFilters,
} from './rawScanQuery';

it('stores a day range as tokens and reads it back', () => {
  expect(rangeFilter({ from: '2026-10-01', to: '' })).toEqual({ values: ['from:2026-10-01'] });
  expect(rangeFilter({ from: '', to: '' })).toBeNull();
  expect(rangeFilter({ from: 'nope', to: '2026-10-05' })).toEqual({ values: ['to:2026-10-05'] });
  expect(scannedRange({ scanned: { values: ['to:2026-10-05', 'from:2026-10-01'] } }))
    .toEqual({ from: '2026-10-01', to: '2026-10-05' });
  expect(scannedRange({})).toEqual({ from: '', to: '' });
});

it('drops old scanned / ingested filters but keeps a real range', () => {
  const saved = {
    site: { values: ['HQ'] },
    scanned: { text: '10/20' },
    ingested: { values: ['x'] },
  };
  expect(activeRawFilters(saved)).toEqual({ site: { values: ['HQ'] } });
  expect(activeRawFilters({ scanned: { values: ['x', 'from:2026-10-01'] } }))
    .toEqual({ scanned: { values: ['from:2026-10-01'] } });
  expect(serverColumnFilters({ site: { text: 'a' }, scanned: { values: ['from:2026-10-01'] } }))
    .toEqual({ site: { text: 'a' } });
});

it('turns a day range into local-day instants', () => {
  expect(rangeBounds({ from: '', to: '' })).toEqual({});
  expect(rangeBounds({ from: '2026-10-01', to: '2026-10-05' })).toEqual({
    since: new Date('2026-10-01T00:00:00').toISOString(),
    until: new Date('2026-10-05T23:59:59.999').toISOString(),
  });
});
