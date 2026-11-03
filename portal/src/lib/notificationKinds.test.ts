import { expect, it } from 'vitest';

import {
  DELIVERY_CHOICES, NOTIFICATION_CATEGORIES, categoryLabel, categoryLabels, emailGroupsFor,
} from './notificationKinds';

it('lists the six categories in spec order with their labels', () => {
  expect(NOTIFICATION_CATEGORIES).toEqual([
    { key: 'approvals', label: 'Approvals & requests' },
    { key: 'reports', label: 'Reports & labels' },
    { key: 'wiki', label: 'Wiki' },
    { key: 'learning', label: 'Learning' },
    { key: 'plans', label: 'Project plans', direct: 'Sent to your contact email' },
    { key: 'security', label: 'Account security' },
  ]);
});

it('puts Project plans before Account security (security stays last)', () => {
  const keys = NOTIFICATION_CATEGORIES.map((c) => c.key);
  expect(keys.indexOf('plans')).toBe(keys.indexOf('security') - 1);
  expect(categoryLabel('plans')).toBe('Project plans');
  expect(categoryLabels(['security', 'plans', 'wiki'])).toEqual([
    'Wiki', 'Project plans', 'Account security',
  ]);
});

it('only Project plans is delivered directly, not through a group', () => {
  expect(NOTIFICATION_CATEGORIES.filter((c) => c.direct).map((c) => c.key)).toEqual(['plans']);
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

it('emailGroupsFor is empty for a direct category even when a group carries it', () => {
  const group = {
    id: 'p', name: 'p', categories: ['plans', 'approvals'], is_member: true,
    effective: { channels: ['email'] }, effective_channels: ['email'],
  };
  expect(emailGroupsFor('plans', [group] as never)).toEqual([]);
  expect(emailGroupsFor('approvals', [group] as never).map((x) => x.id)).toEqual(['p']);
});
