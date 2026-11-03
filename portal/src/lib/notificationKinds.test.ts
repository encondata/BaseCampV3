import { expect, it } from 'vitest';

import * as kinds from './notificationKinds';
import { NOTIFICATION_CATEGORIES, categoryLabel } from './notificationKinds';

it('lists the nine categories in spec order with their labels', () => {
  expect(NOTIFICATION_CATEGORIES.map(({ key, label }) => ({ key, label }))).toEqual([
    { key: 'approvals', label: 'Approvals & requests' },
    { key: 'reports', label: 'Reports & labels' },
    { key: 'wiki', label: 'Wiki' },
    { key: 'learning', label: 'Learning' },
    { key: 'initiatives', label: 'Initiatives' },
    { key: 'trucks', label: 'Trucks' },
    { key: 'devices', label: 'Devices' },
    { key: 'bulk_actions', label: 'Bulk actions' },
    { key: 'security', label: 'Account security' },
  ]);
});

it('a category is a key and a label only: no group decides its email any more', () => {
  for (const category of NOTIFICATION_CATEGORIES) {
    expect(Object.keys(category).sort()).toEqual(['key', 'label']);
  }
});

it('keeps no per-person delivery choices and no lookup of the groups that email a category', () => {
  // A person's choices are switches now (lib/notificationSwitches.ts).
  expect('DELIVERY_CHOICES' in kinds).toBe(false);
  expect('emailGroupsFor' in kinds).toBe(false);
});

it('maps a key to its label, and an unknown key to itself', () => {
  expect(categoryLabel('wiki')).toBe('Wiki');
  expect(categoryLabel('initiatives')).toBe('Initiatives');
  expect(categoryLabel('trucks')).toBe('Trucks');
  expect(categoryLabel('devices')).toBe('Devices');
  expect(categoryLabel('bulk_actions')).toBe('Bulk actions');
  expect(categoryLabel('bogus')).toBe('bogus');
});
