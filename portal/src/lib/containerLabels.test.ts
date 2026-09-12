import { describe, expect, it, vi } from 'vitest';

import type { ContainerItem, InitiativeItem } from './api';
import {
  applyBulkTag, buildRunOptions, changedTagIds, containerDisplayName, filterContainers,
  initiativeDisplayName, labeledContainers, persistTagChanges, selectAllFiltered, tagsFromContainers,
  tagsInUse, toggleSelection, toPdfInput,
} from './containerLabels';

function container(over: Partial<ContainerItem> = {}): ContainerItem {
  return {
    id: 'c1', name: 'Rack Cart 1', rfid_tag: null,
    container_type: 'cart', type_label: 'Cart', type_color: '#1890ff',
    status: 'available', status_label: 'Available', status_color: '#22aa55',
    site_id: null, site_name: null, location_detail: '', asset_count: 3,
    last_audit_at: null, last_validated_at: null,
    archived_at: null, created_at: '2026-09-01T00:00:00Z',
    initiative_id: null, initiative_name: null,
    ...over,
  };
}

function initiative(over: Partial<InitiativeItem> = {}): InitiativeItem {
  return {
    id: 'i1', name: 'NAP11 Hall Migration', description: null,
    initiative_type: 'move', type_label: 'Move', type_color: '#1890ff',
    sub_type: null, sub_type_label: null, sub_type_color: null,
    status: 'in_progress', status_label: 'In Progress', status_color: '#22aa55',
    client_id: null, client_name: 'Acme',
    site_id: null, site_name: null, location: null,
    scheduled_start: '2026-10-01T00:00:00Z', scheduled_end: null,
    sky_command_project_id: null,
    origin_site_id: null, origin_site_name: 'NAP11',
    destination_site_id: null, destination_site_name: 'NAP22',
    real_start_at: null, real_end_at: null,
    priority_devices: null, shipping_types: [],
    shipping_partner_id: null, shipping_partner_name: null,
    origin_tech_partner_id: null, origin_cable_partner_id: null,
    origin_logistics_partner_id: null,
    destination_tech_partner_id: null, destination_cable_partner_id: null,
    destination_logistics_partner_id: null,
    origin_vendor_involved: null, destination_vendor_involved: null,
    people_count: 0, links_count: 0,
    ...over,
  } as unknown as InitiativeItem;
}

describe('filterContainers', () => {
  const list = [
    container({ id: 'c1', name: 'Rack Cart 1', type_label: 'Cart' }),
    container({ id: 'c2', name: 'Server Bin', type_label: 'Bin' }),
    container({ id: 'c3', name: 'Cable Tote', type_label: 'Tote' }),
  ];

  it('returns everything for a blank term', () => {
    expect(filterContainers(list, '  ')).toEqual(list);
  });

  it('matches on name, case-insensitively', () => {
    expect(filterContainers(list, 'rack').map((c) => c.id)).toEqual(['c1']);
  });

  it('matches on type label', () => {
    expect(filterContainers(list, 'tote').map((c) => c.id)).toEqual(['c3']);
  });

  it('matches nothing when no row qualifies', () => {
    expect(filterContainers(list, 'zzz')).toEqual([]);
  });
});

describe('toggleSelection', () => {
  it('adds an absent id', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
  });
  it('removes a present id', () => {
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('selectAllFiltered', () => {
  it('checking REPLACES the selection with exactly the filtered ids (V2 parity) — a selection made outside the filter does not survive', () => {
    expect(selectAllFiltered(['a', 'b'], true)).toEqual(['a', 'b']);
  });
  it('unchecking CLEARS the selection to [] entirely, not just the filtered ids', () => {
    expect(selectAllFiltered(['a', 'b'], false)).toEqual([]);
  });
});

describe('applyBulkTag', () => {
  it('sets a tag on every given id', () => {
    expect(applyBulkTag({}, ['a', 'b'], 'priority')).toEqual({ a: 'priority', b: 'priority' });
  });
  it('clears the tag (deletes the entry) when key is null', () => {
    expect(applyBulkTag({ a: 'priority', b: 'vendor', c: 'ewaste' }, ['a', 'b'], null))
      .toEqual({ c: 'ewaste' });
  });
  it('leaves ids not in the list untouched', () => {
    expect(applyBulkTag({ a: 'priority', z: 'vendor' }, ['a'], 'warehouse'))
      .toEqual({ a: 'warehouse', z: 'vendor' });
  });
});

describe('buildRunOptions', () => {
  it('carries selection order and narrows tags to selected+tagged ids only', () => {
    const out = buildRunOptions(['a', 'b', 'c'], { a: 'priority', c: 'ewaste', z: 'vendor' });
    expect(out).toEqual({ container_ids: ['a', 'b', 'c'], tags: { a: 'priority', c: 'ewaste' } });
  });
  it('empty selection yields no tags', () => {
    expect(buildRunOptions([], { a: 'priority' })).toEqual({ container_ids: [], tags: {} });
  });
});

describe('tagsInUse', () => {
  it('returns each distinct tag among the selected ids, once', () => {
    const out = tagsInUse(['a', 'b', 'c'], { a: 'priority', b: 'priority', c: 'vendor' });
    expect(out.sort()).toEqual(['priority', 'vendor']);
  });
  it('ignores tags on ids that are not selected', () => {
    expect(tagsInUse(['a'], { a: 'priority', b: 'vendor' })).toEqual(['priority']);
  });
  it('empty when nothing selected or nothing tagged', () => {
    expect(tagsInUse([], {})).toEqual([]);
    expect(tagsInUse(['a'], {})).toEqual([]);
  });
});

describe('name fallbacks', () => {
  it('containerDisplayName falls back to "Container <id>"', () => {
    expect(containerDisplayName({ id: 'c9', name: '' })).toBe('Container c9');
    expect(containerDisplayName({ id: 'c9', name: 'Named' })).toBe('Named');
  });
  it('initiativeDisplayName falls back to "Move #<id>"', () => {
    expect(initiativeDisplayName({ id: 'i9', name: '' })).toBe('Move #i9');
    expect(initiativeDisplayName({ id: 'i9', name: 'NAP11' })).toBe('NAP11');
  });
});

describe('toPdfInput', () => {
  it('maps the initiative and containers, applying every V2 fallback', () => {
    const ini = initiative({ name: '', origin_site_name: null, destination_site_name: null, scheduled_start: null });
    const containers = [
      container({ id: 'c1', name: '', asset_count: 1 }),
      container({ id: 'c2', name: 'Server Bin' }),
    ];
    const out = toPdfInput(ini, containers, { c2: 'vendor' });
    expect(out).toEqual({
      move: { id: 'i1', name: 'Move #i1', sourceSite: 'N/A', destSite: 'N/A', scheduledStart: null },
      containers: [
        { id: 'c1', name: 'Container c1', tag: null },
        { id: 'c2', name: 'Server Bin', tag: 'vendor' },
      ],
      tagImages: {},
    });
  });

  it('uses real names and sites when present, and preserves ISO scheduled_start', () => {
    const ini = initiative();
    const out = toPdfInput(ini, [container({ id: 'c1', name: 'Rack Cart 1' })], {});
    expect(out.move).toEqual({
      id: 'i1', name: 'NAP11 Hall Migration', sourceSite: 'NAP11', destSite: 'NAP22',
      scheduledStart: '2026-10-01T00:00:00Z',
    });
  });

  it('only carries tags for containers that actually have one', () => {
    const out = toPdfInput(initiative(), [container({ id: 'c1' })], {});
    expect(out.containers[0].tag).toBeNull();
  });
});

describe('tagsFromContainers', () => {
  it('reads each container\'s own label_tag, omitting untagged ones', () => {
    expect(tagsFromContainers([
      { id: 'c1', label_tag: 'priority' },
      { id: 'c2', label_tag: null },
      { id: 'c3' },
    ])).toEqual({ c1: 'priority' });
  });
  it('empty for an empty list', () => {
    expect(tagsFromContainers([])).toEqual({});
  });
});

describe('changedTagIds', () => {
  it('detects a single changed row', () => {
    expect(changedTagIds({ c1: 'priority' }, { c1: 'vendor' })).toEqual(['c1']);
  });
  it('detects a clear (present -> absent) and a set (absent -> present)', () => {
    const ids = changedTagIds({ c1: 'priority' }, { c2: 'vendor' });
    expect(ids.sort()).toEqual(['c1', 'c2']);
  });
  it('treats absence and undefined as equal — no change reported', () => {
    expect(changedTagIds({}, {})).toEqual([]);
    expect(changedTagIds({ c1: 'priority' }, { c1: 'priority' })).toEqual([]);
  });
  it('a bulk change over several ids reports every one that actually differs', () => {
    const ids = changedTagIds(
      { c1: 'priority', c3: 'ewaste' },
      { c1: 'vendor', c2: 'vendor', c3: 'ewaste' },
    );
    expect(ids.sort()).toEqual(['c1', 'c2']);
  });
});

describe('persistTagChanges', () => {
  it('no-ops (no PATCH calls) when nothing changed', async () => {
    const updateFn = vi.fn();
    const out = await persistTagChanges({ c1: 'priority' }, { c1: 'priority' }, updateFn);
    expect(updateFn).not.toHaveBeenCalled();
    expect(out).toEqual({ tags: { c1: 'priority' }, failed: false });
  });

  it('PATCHes every changed id with its new tag (or null when cleared)', async () => {
    const updateFn = vi.fn().mockResolvedValue({});
    const out = await persistTagChanges({}, { c1: 'priority', c2: 'vendor' }, updateFn);
    expect(updateFn).toHaveBeenCalledWith('c1', 'priority');
    expect(updateFn).toHaveBeenCalledWith('c2', 'vendor');
    expect(updateFn).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ tags: { c1: 'priority', c2: 'vendor' }, failed: false });
  });

  it('sends null for a cleared tag', async () => {
    const updateFn = vi.fn().mockResolvedValue({});
    await persistTagChanges({ c1: 'priority' }, {}, updateFn);
    expect(updateFn).toHaveBeenCalledWith('c1', null);
  });

  it('reverts only the failed id\'s tag and reports failed: true, leaving other successful changes in place', async () => {
    const updateFn = vi.fn()
      .mockImplementation((id: string) => (id === 'c1' ? Promise.reject(new Error('boom')) : Promise.resolve({})));
    const out = await persistTagChanges(
      { c1: 'priority', c2: 'ewaste' }, { c1: 'vendor', c2: 'warehouse' }, updateFn,
    );
    expect(out.failed).toBe(true);
    expect(out.tags).toEqual({ c1: 'priority', c2: 'warehouse' });
  });

  it('a failed PATCH for a newly-set tag (no prior value) reverts to absent, not null-ish leftovers', async () => {
    const updateFn = vi.fn().mockRejectedValue(new Error('boom'));
    const out = await persistTagChanges({}, { c1: 'priority' }, updateFn);
    expect(out.failed).toBe(true);
    expect(out.tags).toEqual({});
  });
});

describe('labeledContainers', () => {
  const list = [
    container({ id: 'c1', name: 'Rack Cart 1' }),
    container({ id: 'c2', name: 'Server Bin' }),
    container({ id: 'c3', name: 'Cable Tote' }),
  ];

  it('V2 parity: excludes a selected id that is currently hidden by the search filter', () => {
    // c1 is selected but not in the current filtered view (e.g. hidden by
    // a search term) — V2's own `containersToLabel` excludes it too.
    expect(labeledContainers(list, ['c1', 'c2'], ['c2', 'c3']).map((c) => c.id)).toEqual(['c2']);
  });

  it('returns rows in the list\'s own display order, not selection order', () => {
    expect(labeledContainers(list, ['c3', 'c1'], ['c1', 'c2', 'c3']).map((c) => c.id))
      .toEqual(['c1', 'c3']);
  });

  it('empty when nothing is both selected and filtered-in', () => {
    expect(labeledContainers(list, ['c1'], ['c2', 'c3'])).toEqual([]);
    expect(labeledContainers(list, [], ['c1', 'c2', 'c3'])).toEqual([]);
  });
});
