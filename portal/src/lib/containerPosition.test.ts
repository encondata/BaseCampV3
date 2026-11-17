/**
 * containerPosition — the per-container position cache (one request per
 * container a minute, failures never cached) and the card's wording for
 * each kind of answer.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContainerPosition } from './api';

const getContainerPosition = vi.fn();
vi.mock('./api', () => ({
  getContainerPosition: (id: string) => getContainerPosition(id),
  onLocalSessionCleared: () => {},
}));

const {
  POSITION_TTL_MS, clearPositionCache, loadContainerPosition, positionLines,
} = await import('./containerPosition');

const TRUCK: ContainerPosition = {
  kind: 'truck', name: 'Truck 1', lat: 33.1, lng: -84.2,
  recorded_at: '2026-11-17T14:32:00Z', approximate_address: 'I-85 N',
};

beforeEach(() => {
  clearPositionCache();
  getContainerPosition.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

it('makes one request per container within a minute', async () => {
  getContainerPosition.mockResolvedValue(TRUCK);
  const now = 1_000_000;
  await expect(loadContainerPosition('c1', now)).resolves.toEqual(TRUCK);
  await expect(loadContainerPosition('c1', now + 10)).resolves.toEqual(TRUCK);
  expect(getContainerPosition).toHaveBeenCalledTimes(1);

  await loadContainerPosition('c1', now + POSITION_TTL_MS + 1);
  expect(getContainerPosition).toHaveBeenCalledTimes(2);
});

it('shares one in-flight request between concurrent callers', async () => {
  getContainerPosition.mockResolvedValue(TRUCK);
  const [a, b] = await Promise.all([
    loadContainerPosition('c1', 0), loadContainerPosition('c1', 0),
  ]);
  expect(a).toEqual(TRUCK);
  expect(b).toEqual(TRUCK);
  expect(getContainerPosition).toHaveBeenCalledTimes(1);
});

it('does not cache a failure', async () => {
  getContainerPosition
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce(TRUCK);
  await expect(loadContainerPosition('c1', 0)).rejects.toThrow('boom');
  await expect(loadContainerPosition('c1', 1)).resolves.toEqual(TRUCK);
  expect(getContainerPosition).toHaveBeenCalledTimes(2);
});

it('words each kind', () => {
  // Built from a local time so HH:MM reads 14:32 in any time zone.
  const recorded = new Date(2026, 10, 17, 14, 32);
  vi.useFakeTimers();
  vi.setSystemTime(recorded.getTime() + 3 * 60 * 60 * 1000);

  expect(positionLines({ ...TRUCK, recorded_at: recorded.toISOString() })).toEqual({
    title: 'Truck 1',
    detail: 'Last report 14:32 · 3h ago · I-85 N',
    note: null,
  });
  // No address: the detail stops after the age.
  expect(positionLines({
    ...TRUCK, recorded_at: recorded.toISOString(), approximate_address: '',
  }).detail).toBe('Last report 14:32 · 3h ago');

  expect(positionLines({
    kind: 'truck', name: 'Truck 1', lat: null, lng: null,
    recorded_at: null, approximate_address: '',
  })).toEqual({
    title: 'Truck 1', detail: '', note: "Truck 1 hasn't reported a position yet",
  });

  expect(positionLines({
    kind: 'site', name: 'Atlanta DC', lat: 33.7, lng: -84.4,
    recorded_at: null, approximate_address: '',
  })).toEqual({
    title: 'Atlanta DC', detail: 'Site location, not a live position', note: null,
  });

  expect(positionLines({
    kind: 'none', name: null, lat: null, lng: null,
    recorded_at: null, approximate_address: '',
  })).toEqual({ title: '', detail: '', note: 'No known position' });
});
