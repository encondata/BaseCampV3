/**
 * Notification switches — the pure rules behind the Inbox / Email grid on
 * /me › Notifications and System › Notifications › Defaults
 * (components/notifications/SwitchGrid.tsx).
 *
 * A person has three switches per category, Inbox, Email and Push. One they have not
 * changed follows the company default, including later changes to it; one
 * they have is kept as their own value, and only those are ever saved.
 * Email and Push need Inbox: with Inbox off they read off, and turning Inbox
 * back on gives back whatever they were. Account security has no switches —
 * it is always on, and never pushes.
 */

import type { NotificationCategory, SwitchPair } from './api';

/** A person's own values for one category: only what they changed. */
export type SwitchValues = { inbox?: boolean; email?: boolean; push?: boolean };

export type SwitchChannel = 'inbox' | 'email' | 'push';

/** The categories that have switches, in registry order. Account security is
 *  always on and has none. */
export const CONFIGURABLE: NotificationCategory[] = [
  'approvals', 'reports', 'wiki', 'learning', 'initiatives', 'assets', 'plans', 'trucks',
  'devices', 'status_rules', 'bulk_actions',
];

/** What each category carries — only the kinds that exist today (the design,
 *  §1 "The grid"). */
export const CATEGORY_DESCRIPTIONS: Record<NotificationCategory, string> = {
  approvals: 'Group membership requests and decisions, routers waiting for approval',
  reports: 'Reports and label runs, ready or failed',
  wiki: 'Page updates, comments, mentions, reviews and exports',
  learning: 'Learning completed or overdue, quizzes locked',
  initiatives: 'Initiative status changes',
  assets: 'Notifications from your asset watches',
  plans: "Plan tasks assigned to you, coming due or overdue, and the owner's overdue digest",
  trucks: 'Truck status changes',
  devices: 'Devices going offline',
  status_rules: 'Notifications from status rules',
  bulk_actions: 'Background bulk actions, finished or failed',
  security: 'Password expiring and two-factor notices about your own account',
};

/** What a person gets for a category: each value of their own, else the
 *  default's — and Email and Push only while Inbox is on. A default with no
 *  push value reads as push off. */
export function effective(own: SwitchValues | undefined, def: SwitchPair): Required<SwitchPair> {
  const inbox = own?.inbox ?? def.inbox;
  const email = own?.email ?? def.email;
  const push = own?.push ?? def.push ?? false;
  return { inbox, email: inbox && email, push: inbox && push };
}

/** Whether the person has a value of their own for any switch. */
export function isChanged(own: SwitchValues | undefined): boolean {
  return own?.inbox !== undefined || own?.email !== undefined || own?.push !== undefined;
}

/** The person's own values after they set `channel` to `next`. A value equal
 *  to the default is dropped, so the switch follows the default again; with
 *  nothing left, `undefined`. The object it is given is not changed. */
export function flip(
  own: SwitchValues | undefined, def: SwitchPair, channel: SwitchChannel, next: boolean,
): SwitchValues | undefined {
  const values: SwitchValues = {};
  if (own?.inbox !== undefined) values.inbox = own.inbox;
  if (own?.email !== undefined) values.email = own.email;
  if (own?.push !== undefined) values.push = own.push;
  if (next === (def[channel] ?? false)) delete values[channel];
  else values[channel] = next;
  return isChanged(values) ? values : undefined;
}
