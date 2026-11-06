/**
 * Notification categories — the portal side of
 * api/src/serversherpa/notifications/kinds.py. A person's Inbox and Email
 * switches are per category (lib/notificationSwitches.ts); account security
 * has no switches, since it is always on.
 */

import type { NotificationCategory } from './api';

export type { NotificationCategory };

export const NOTIFICATION_CATEGORIES: { key: NotificationCategory; label: string }[] = [
  { key: 'approvals', label: 'Approvals & requests' },
  { key: 'reports', label: 'Reports & labels' },
  { key: 'wiki', label: 'Wiki' },
  { key: 'learning', label: 'Learning' },
  { key: 'initiatives', label: 'Initiatives' },
  { key: 'assets', label: 'Assets' },
  { key: 'plans', label: 'Project plans' },
  { key: 'trucks', label: 'Trucks' },
  { key: 'devices', label: 'Devices' },
  { key: 'status_rules', label: 'Status rules' },
  { key: 'bulk_actions', label: 'Bulk actions' },
  { key: 'security', label: 'Account security' },
];

export function categoryLabel(key: string): string {
  return NOTIFICATION_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}
