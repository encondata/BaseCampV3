import { expect, it } from 'vitest';

import {
  DELIVERY_CHOICES, NOTIFICATION_CATEGORIES, categoryLabel, categoryLabels, emailGroupsFor,
} from './notificationKinds';

it('lists the five categories in spec order with their labels', () => {
  expect(NOTIFICATION_CATEGORIES.map(({ key, label }) => ({ key, label }))).toEqual([
    { key: 'approvals', label: 'Approvals & requests' },
    { key: 'reports', label: 'Reports & labels' },
    { key: 'wiki', label: 'Wiki' },
    { key: 'learning', label: 'Learning' },
    { key: 'security', label: 'Account security' },
  ]);
});

it('every category says where its email permission comes from; only account security is "always"', () => {
  // Mirrors CATEGORY_EMAIL_SOURCE in api/src/serversherpa/notifications/kinds.py.
  for (const c of NOTIFICATION_CATEGORIES) {
    expect(['groups', 'always', 'direct']).toContain(c.emailSource);
  }
  expect(NOTIFICATION_CATEGORIES.filter((c) => c.emailSource === 'always').map((c) => c.key))
    .toEqual(['security']);
  expect(NOTIFICATION_CATEGORIES.filter((c) => c.emailSource === 'groups').map((c) => c.key))
    .toEqual(['approvals', 'reports', 'wiki', 'learning']);
});

it('offers the three personal choices with the exact labels', () => {
  expect(DELIVERY_CHOICES).toEqual([
    { key: 'email', label: 'Inbox + Email' },
    { key: 'inbox', label: 'Inbox only' },
    { key: 'off', label: 'Off' },
  ]);
});

it('maps keys to labels and drops unknown keys', () => {
  expect(categoryLabel('wiki')).toBe('Wiki');
  expect(categoryLabels(['security', 'approvals', 'bogus'])).toEqual([
    'Approvals & requests', 'Account security',
  ]);
});

it('emailGroupsFor keeps member groups that carry the category and email', () => {
  const g = (id: string, categories: string[], effective: string[] | null, is_member = true) => ({
    id, name: id, categories, is_member,
    effective: effective && { channels: effective },
    effective_channels: effective ?? [],
  });
  const groups = [
    g('a', ['approvals'], ['email', 'web']),
    g('b', ['approvals'], ['web']),
    g('c', ['reports'], ['email']),
    g('d', ['approvals'], ['email'], false),
  ];
  expect(emailGroupsFor('approvals', groups as never).map((x) => x.id)).toEqual(['a']);
  expect(emailGroupsFor('wiki', groups as never)).toEqual([]);
});
