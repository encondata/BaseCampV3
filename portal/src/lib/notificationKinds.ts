/**
 * Notification categories and personal delivery choices — the portal side
 * of api/src/serversherpa/notifications/kinds.py. Groups subscribe to
 * categories; each person turns a category down to inbox-only or off on
 * /me › Notifications. Account security is fixed (always emailed).
 */

import type { DeliveryChoice, MyNotificationGroup, NotificationCategory } from './api';

export type { DeliveryChoice, NotificationCategory };

/** Where a category's email permission comes from — CATEGORY_EMAIL_SOURCE in
 *  the API's notifications/kinds.py:
 *  - 'groups': one of the person's groups must subscribe to the category
 *    with Email among its effective channels;
 *  - 'always': the owner's own notices email whatever the groups say
 *    (account security);
 *  - 'direct': email follows the person's /me choice alone (reserved for a
 *    later category; no group is involved). */
export type EmailSource = 'groups' | 'always' | 'direct';

export const NOTIFICATION_CATEGORIES: { key: NotificationCategory; label: string; emailSource: EmailSource }[] = [
  { key: 'approvals', label: 'Approvals & requests', emailSource: 'groups' },
  { key: 'reports', label: 'Reports & labels', emailSource: 'groups' },
  { key: 'wiki', label: 'Wiki', emailSource: 'groups' },
  { key: 'learning', label: 'Learning', emailSource: 'groups' },
  { key: 'security', label: 'Account security', emailSource: 'always' },
];

export const DELIVERY_CHOICES: { key: DeliveryChoice; label: string }[] = [
  { key: 'email', label: 'Inbox + Email' },
  { key: 'inbox', label: 'Inbox only' },
  { key: 'off', label: 'Off' },
];

export function categoryLabel(key: string): string {
  return NOTIFICATION_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

/** Labels for a group's category keys, in registry order; unknown keys drop. */
export function categoryLabels(keys: readonly string[]): string[] {
  const set = new Set(keys);
  return NOTIFICATION_CATEGORIES.filter((c) => set.has(c.key)).map((c) => c.label);
}

/** The groups the person belongs to that can email them this category:
 *  subscribed to it, with email among their effective channels. */
export function emailGroupsFor(
  category: NotificationCategory, groups: MyNotificationGroup[],
): MyNotificationGroup[] {
  return groups.filter((g) =>
    g.is_member && g.categories.includes(category) && g.effective_channels.includes('email'));
}
