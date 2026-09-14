import { expect, it } from 'vitest';

import { buildTruckIndex, filterTrucks, matchTruck, type TruckRow } from './truckMatch';

const truck = (over: Partial<TruckRow> & { id: string; name: string }): TruckRow => ({
  load_number: null, status: 'in_transit', status_label: 'In Transit',
  driver_name: null, start_site_id: null, start_site_name: null,
  end_site_id: null, end_site_name: null, container_count: 0, ...over,
});

const ONE = truck({
  id: 't-1', name: 'TRUCK-1', load_number: 'L-1042', driver_name: 'Dana Driver',
  start_site_name: 'NAP11', end_site_name: 'ACC4', container_count: 3,
});
const TWO = truck({ id: 't-2', name: 'TRUCK-2', load_number: 'L-1043' });
const SPARE = truck({ id: 't-3', name: 'Spare Trailer' });

const index = buildTruckIndex([ONE, TWO, SPARE]);

it('matches a truck by its exact name, case-insensitively', () => {
  expect(matchTruck(index, 'TRUCK-2')).toEqual({ kind: 'name', truck: TWO });
  expect(matchTruck(index, 'truck-2')).toEqual({ kind: 'name', truck: TWO });
  expect(matchTruck(index, '  Spare Trailer  ')).toEqual({ kind: 'name', truck: SPARE });
});

it('matches a truck by its exact load number', () => {
  expect(matchTruck(index, 'L-1042')).toEqual({ kind: 'load_number', truck: ONE });
  expect(matchTruck(index, 'l-1043')).toEqual({ kind: 'load_number', truck: TWO });
});

it('prefers a name over a load number when a string could be either', () => {
  // Contrived but decidable: the name someone typed is what they meant.
  const odd = buildTruckIndex([
    truck({ id: 't-a', name: 'L-1042' }),
    truck({ id: 't-b', name: 'Other', load_number: 'L-1042' }),
  ]);
  expect(matchTruck(odd, 'L-1042')?.truck.id).toBe('t-a');
});

it('a partial is not a match — that is what the filter is for', () => {
  expect(matchTruck(index, 'TRUCK')).toBeNull();
  expect(matchTruck(index, 'L-10')).toBeNull();
  expect(matchTruck(index, '')).toBeNull();
  expect(matchTruck(index, '   ')).toBeNull();
});

it('a truck with no load number never matches an empty-ish value', () => {
  const bare = buildTruckIndex([SPARE]);
  expect(matchTruck(bare, '—')).toBeNull();
  expect(matchTruck(bare, 'null')).toBeNull();
});

it('the first row wins a duplicate key, so a match never depends on sync order', () => {
  const dupes = buildTruckIndex([
    truck({ id: 't-a', name: 'TRUCK-1' }),
    truck({ id: 't-b', name: 'truck-1' }),
  ]);
  expect(matchTruck(dupes, 'TRUCK-1')?.truck.id).toBe('t-a');
});

it('filterTrucks narrows on a partial name or load number, keeping the sync order', () => {
  expect(filterTrucks(index, 'truck').map((t) => t.id)).toEqual(['t-1', 't-2']);
  expect(filterTrucks(index, '104').map((t) => t.id)).toEqual(['t-1', 't-2']);
  expect(filterTrucks(index, '1043').map((t) => t.id)).toEqual(['t-2']);
  expect(filterTrucks(index, 'trailer').map((t) => t.id)).toEqual(['t-3']);
  expect(filterTrucks(index, 'nothing here')).toEqual([]);
});

it('an empty filter shows every truck', () => {
  expect(filterTrucks(index, '')).toHaveLength(3);
  expect(filterTrucks(index, '   ')).toHaveLength(3);
});
