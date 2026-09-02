import { expect, it } from 'vitest';

import type { AssetItem, InitiativeItem, StatusValue } from './api';
import { assetDistribution, sortClientInitiatives } from './clientDashboard';

const I = (over: Partial<InitiativeItem>): InitiativeItem =>
  ({ id: 'i', name: 'n', real_end_at: null, scheduled_start: null,
     archived_at: null, ...over } as InitiativeItem);

it('sorts active first, scheduled_start desc, drops archived', () => {
  const rows = [
    I({ id: 'done', real_end_at: '2026-08-01T00:00:00Z',
        scheduled_start: '2026-07-01' }),
    I({ id: 'old', scheduled_start: '2026-01-01' }),
    I({ id: 'new', scheduled_start: '2026-09-01' }),
    I({ id: 'arch', archived_at: '2026-08-01T00:00:00Z' }),
    I({ id: 'nostart' }),
  ];
  expect(sortClientInitiatives(rows).map((r) => r.id))
    .toEqual(['new', 'old', 'nostart', 'done']);
});

it('assetDistribution counts by status with vocab labels', () => {
  const assets = [
    { id: '1', status: 'in_transit', archived_at: null },
    { id: '2', status: 'in_transit', archived_at: null },
    { id: '3', status: 'labeled', archived_at: null },
    { id: '4', status: 'labeled', archived_at: '2026-01-01' },
    { id: '5', status: 'mystery', archived_at: null },
  ] as AssetItem[];
  const vocab = [
    { record_type: 'asset', key: 'in_transit', label: 'In Transit',
      color: '#1668a7' },
    { record_type: 'asset', key: 'labeled', label: 'Labeled',
      color: '#178a4c' },
  ] as StatusValue[];
  const dist = assetDistribution(assets, vocab);
  expect(dist).toEqual([
    { key: 'in_transit', label: 'In Transit', color: '#1668a7', count: 2 },
    { key: 'labeled', label: 'Labeled', color: '#178a4c', count: 1 },
    { key: 'mystery', label: 'mystery', color: '#51606f', count: 1 },
  ]);
});
