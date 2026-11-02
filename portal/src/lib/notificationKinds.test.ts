import { expect, it } from 'vitest';

import * as kinds from './notificationKinds';
import { NOTIFICATION_CATEGORIES, categoryLabel, categoryLabels } from './notificationKinds';

it('lists the five categories in spec order with their labels', () => {
  expect(NOTIFICATION_CATEGORIES.map(({ key, label }) => ({ key, label }))).toEqual([
    { key: 'approvals', label: 'Approvals & requests' },
    { key: 'reports', label: 'Reports & labels' },
    { key: 'wiki', label: 'Wiki' },
    { key: 'learning', label: 'Learning' },
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

it('maps keys to labels and drops unknown keys', () => {
  expect(categoryLabel('wiki')).toBe('Wiki');
  expect(categoryLabel('bogus')).toBe('bogus');
  expect(categoryLabels(['security', 'approvals', 'bogus'])).toEqual([
    'Approvals & requests', 'Account security',
  ]);
});
