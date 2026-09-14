/** Matching a scanned string against the move's containers: RFID with
 *  and without the stored zero padding, the Container Labels tag, an
 *  exact name, and what an ambiguous partial does instead. */
import { expect, it } from 'vitest';

import {
  buildContainerIndex, matchContainer, searchContainers, type ContainerRow,
} from './containerMatch';

const crate = (over: Partial<ContainerRow> & { id: string; name: string }): ContainerRow => ({
  rfid_tag: null, label_tag: null, container_type: 'shipping_container',
  status: 'available', status_label: 'Available', site_id: null, site_name: null,
  asset_count: 0, ...over,
});

const PAL_1 = crate({
  id: 'c-1', name: 'SC-DAL_PAL-001', rfid_tag: '0'.repeat(18) + '100348',
  label_tag: 'priority', asset_count: 3,
});
const PAL_2 = crate({ id: 'c-2', name: 'SC-DAL_PAL-002', label_tag: 'vendor' });
const PAL_3 = crate({ id: 'c-3', name: 'SC-DAL_PAL-003' });
const CASE = crate({
  id: 'c-4', name: 'container01', container_type: 'pelican_case',
  rfid_tag: 'E2004321' + '0'.repeat(16),
});

const index = buildContainerIndex([PAL_1, PAL_2, PAL_3, CASE]);

it('matches an RFID tag scanned with its padding', () => {
  const hit = matchContainer(index, '0'.repeat(18) + '100348');
  expect(hit?.kind).toBe('rfid');
  expect(hit?.container.id).toBe('c-1');
});

it('matches the same tag read without padding, and ignores case', () => {
  expect(matchContainer(index, '100348')?.container.id).toBe('c-1');
  expect(matchContainer(index, 'e2004321' + '0'.repeat(16))?.container.id).toBe('c-4');
  // A handheld that drops the padding on a tag that does not start with
  // zeros reads the same value either way.
  expect(matchContainer(index, 'E2004321' + '0'.repeat(16))?.kind).toBe('rfid');
});

it('matches a Container Labels tag key', () => {
  const hit = matchContainer(index, 'priority');
  expect(hit?.kind).toBe('label_tag');
  expect(hit?.container.id).toBe('c-1');
  expect(matchContainer(index, 'VENDOR')?.container.id).toBe('c-2');
});

it('matches an exact name, case-insensitively', () => {
  const hit = matchContainer(index, 'sc-dal_pal-003');
  expect(hit?.kind).toBe('name');
  expect(hit?.container.id).toBe('c-3');
});

it('does not match a partial name — that is a choice, not a match', () => {
  expect(matchContainer(index, 'SC-DAL_PAL')).toBeNull();
  expect(matchContainer(index, '')).toBeNull();
  expect(matchContainer(index, '   ')).toBeNull();
  expect(matchContainer(index, 'nothing-like-this')).toBeNull();
});

it('searchContainers offers the crates a partial could mean, capped', () => {
  expect(searchContainers(index, 'SC-DAL_PAL', 8).map((c) => c.id))
    .toEqual(['c-1', 'c-2', 'c-3']);
  expect(searchContainers(index, 'pal-00', 2).map((c) => c.id)).toEqual(['c-1', 'c-2']);
  // One hit is not ambiguous: the screen picks it without asking.
  expect(searchContainers(index, 'container0', 8).map((c) => c.id)).toEqual(['c-4']);
  expect(searchContainers(index, 'nope', 8)).toEqual([]);
  expect(searchContainers(index, '  ', 8)).toEqual([]);
});

it('the first row wins on a duplicate label tag — it is not unique', () => {
  const shared = buildContainerIndex([
    crate({ id: 'c-a', name: 'A', label_tag: 'priority' }),
    crate({ id: 'c-b', name: 'B', label_tag: 'priority' }),
  ]);
  expect(matchContainer(shared, 'priority')?.container.id).toBe('c-a');
});

it('a container with no tag never matches an empty or dash-shaped value', () => {
  const bare = buildContainerIndex([crate({ id: 'c-x', name: 'Bare', rfid_tag: '  ' })]);
  expect(matchContainer(bare, '—')).toBeNull();
  expect(matchContainer(bare, '')).toBeNull();
  expect(matchContainer(bare, 'Bare')?.kind).toBe('name');
});
