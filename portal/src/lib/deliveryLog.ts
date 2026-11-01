/**
 * Delivery log — the portal side of the notification delivery log
 * (GET /notifications/log, api notifications/delivery_log.py) and of Check
 * delivery (GET /notifications/check): the words for every event, reason and
 * group-verdict code, the outcome chip and one-line detail a log row shows,
 * the time-range choices, and the list's column registry. A code this file
 * does not know (a newer API) shows as itself.
 *
 * Spec: docs/superpowers/specs/2026-10-31-notifications-phase0-design.md
 * (sections 4 and 9).
 */

import type { DeliveryLogEntry, DeliveryLogEvent } from './api';
import type { ColumnDef } from './listTools';

/** The hint under the page title on the Delivery log tab. */
export const DELIVERY_LOG_HINT = 'Every notification and email decision — who, what and why.';

/** Every event, in the order a notification's trail runs (the Outcome filter's order). */
export const DELIVERY_LOG_EVENTS: readonly DeliveryLogEvent[] = [
  'inbox_written', 'inbox_suppressed', 'email_queued', 'email_not_queued',
  'email_sent', 'email_skipped', 'email_retry', 'email_failed',
];

export const EVENT_LABELS: Record<DeliveryLogEvent, string> = {
  inbox_written: 'In inbox',
  inbox_suppressed: 'Not in inbox',
  email_queued: 'Queued',
  email_not_queued: 'Not emailed',
  email_sent: 'Sent',
  email_skipped: 'Dropped',
  email_retry: 'Retrying',
  email_failed: 'Failed',
};

/** The map's own entry for `code` (never an Object.prototype member). */
const own = <V>(map: Record<string, V>, code: string): V | undefined =>
  (Object.hasOwn(map, code) ? map[code] : undefined);

const isEvent = (code: string): code is DeliveryLogEvent => Object.hasOwn(EVENT_LABELS, code);

/** Every reason code the API writes: why an inbox row or an email did not
 *  happen, why a queued email was dropped before sending, and why one waits. */
export const REASON_LABELS: Record<string, string> = {
  // the inbox row was not written (inbox_suppressed)
  category_off: 'Category turned off',
  // the notification was not emailed (email_not_queued)
  email_not_set_up: "Email isn't set up",
  unregistered_kind: 'Not a registered notification type',
  kind_not_emailed: 'This type is never emailed',
  category_inbox_only: 'Category set to inbox only',
  recipient_inactive: 'Person archived or account disabled',
  no_address: 'No email address',
  no_email_group: 'No group emails this category',
  blocked_by_schedule: "Every group's schedule blocks it",
  // dropped just before sending (email_skipped)
  notification_gone: 'Inbox item no longer exists',
  hidden: 'Hidden in the portal',
  read: 'Already read in the portal',
  resolved: 'Already decided',
  category_turned_down: 'Category turned down',
  // why a queued email waits (email_queued detail.reason)
  quiet_hours: 'Quiet hours',
  inactive_day: 'Not an active day',
};

/** A reason code in words, or the code itself when it is new. */
export const reasonLabel = (code: string): string => own(REASON_LABELS, code) ?? code;

/** The log's channels in words (the inbox, and the one live sending channel). */
export const LOG_CHANNEL_LABELS: Record<string, string> = { inbox: 'Inbox', email: 'Email' };
export const channelLabel = (code: string): string => own(LOG_CHANNEL_LABELS, code) ?? code;

/** Where an email's address came from (detail.via, the check's address_source). */
export const ADDRESS_SOURCE_LABELS: Record<string, string> = {
  contact: 'contact email',
  login: 'sign-in email',
};

/** A group's answer right now (Check delivery's groups table), in words and color. */
export const VERDICTS: Record<string, { label: string; chip: string }> = {
  open: { label: 'Open', chip: 'c-green' },
  urgent_bypass: { label: 'Urgent bypass', chip: 'c-green' },
  quiet_hours: { label: 'Quiet hours', chip: 'c-amber' },
  inactive_day: { label: 'Not an active day', chip: 'c-amber' },
  no_email_channel: { label: 'No email', chip: 'c-slate' },
  paused: { label: 'Paused', chip: 'c-slate' },
  not_subscribed: { label: 'Not subscribed', chip: 'c-slate' },
};
export const verdictOf = (code: string): { label: string; chip: string } =>
  own(VERDICTS, code) ?? { label: code, chip: 'c-slate' };

/** The outcome chip of a log row: Held (amber) for a queued email that waits,
 *  Sent green, Failed red, Retrying amber, the inbox and a queued email blue,
 *  the rest slate. An event this file does not know shows its code. */
export function outcomeOf(e: DeliveryLogEntry): { label: string; chip: string } {
  if (!isEvent(e.event)) return { label: e.event, chip: 'c-slate' };
  const label = EVENT_LABELS[e.event];
  switch (e.event) {
    case 'email_queued':
      return e.detail?.deferred === true ? { label: 'Held', chip: 'c-amber' } : { label, chip: 'c-blue' };
    case 'inbox_written': return { label, chip: 'c-blue' };
    case 'email_sent': return { label, chip: 'c-green' };
    case 'email_retry': return { label, chip: 'c-amber' };
    case 'email_failed': return { label, chip: 'c-red' };
    default: return { label, chip: 'c-slate' };
  }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A moment as local weekday and 12-hour clock: "Mon 7:00 AM". Built by hand,
 *  like formatQuietHours, so it reads the same in every browser (Intl puts a
 *  narrow no-break space before AM/PM in some). */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DAY_NAMES[d.getDay()]} ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const names = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && n !== '') : []);

/** "OSError" or "SMTPResponseException, SMTP 452": the failure's class and code. */
function failure(detail: Record<string, unknown>): string | null {
  const error = text(detail.error);
  const code = count(detail.smtp_code);
  const parts = [error, code !== null ? `SMTP ${code}` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** The one-line detail of a log row: when a queued email goes and why it
 *  waits ("Held until Mon 7:00 AM · Quiet hours · Destination Side Ops Team"),
 *  how a send went ("Attempt 2 failed (OSError) — retrying"), or the reason an
 *  inbox row or an email did not happen ("Already read in the portal"). Empty
 *  when there is nothing to add (an inbox row that was written). */
export function describeEntry(e: DeliveryLogEntry): string {
  const d = e.detail ?? {};
  switch (e.event) {
    case 'email_queued': {
      const sendAt = text(d.send_at);
      const why = text(d.reason);
      const parts = d.deferred === true && sendAt
        ? [`Held until ${shortWhen(sendAt)}`, why ? reasonLabel(why) : null]
        : ['Due now'];
      const groups = names(d.groups);
      if (groups.length) parts.push(groups.join(', '));
      return parts.filter(Boolean).join(' · ');
    }
    case 'email_sent': {
      const attempt = count(d.attempt);
      return attempt !== null ? `Sent on attempt ${attempt}` : '';
    }
    case 'email_retry': {
      const attempt = count(d.attempt);
      const err = failure(d);
      return `${attempt !== null ? `Attempt ${attempt}` : 'An attempt'} failed${err ? ` (${err})` : ''} — retrying`;
    }
    case 'email_failed': {
      const attempts = count(d.attempts);
      const err = failure(d);
      const tries = attempts !== null ? ` after ${attempts} attempt${attempts === 1 ? '' : 's'}` : '';
      return `Gave up${tries}${err ? ` (${err})` : ''}`;
    }
    default:
      return e.reason ? reasonLabel(e.reason) : '';
  }
}

/** The time-range choices above the list (default 7 days). */
export type TimeRange = '24h' | '7d' | '30d' | 'all';
export const TIME_RANGES: { key: TimeRange; label: string }[] = [
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All' },
];
const RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000,
};

/** The oldest moment a range shows, as the API's `since` (null: everything). */
export function sinceFor(range: TimeRange, now: number = Date.now()): string | null {
  return range === 'all' ? null : new Date(now - RANGE_MS[range]).toISOString();
}

/* The list's columns. Each track carries a px floor (list-column-floors):
 * When, Channel and Outcome hold short, low-variance values (a relative
 * time, one channel chip, one outcome chip) and Category one chip whose
 * floor holds the longest, "Approvals & requests"; their small fr barely
 * grows, so the slack goes to Notification and Detail, the two columns
 * people read. Detail is clamped to two lines.
 * Fit: default columns + DELIVERY_LOG_TRAILING ≤ LIST_FIT.page
 * (1172px — .portal-page at a 1512px window, nav expanded). */
export const DELIVERY_LOG_COLUMNS: ColumnDef[] = [
  { key: 'when', label: 'When', width: '0.5fr', default: true, min: 90 },
  { key: 'person', label: 'Person', width: '1fr', default: true, min: 120 },
  { key: 'notification', label: 'Notification', width: '2fr', default: true, min: 190 },
  { key: 'category', label: 'Category', width: '0.9fr', default: true, min: 156 },
  { key: 'channel', label: 'Channel', width: '0.4fr', default: true, min: 80 },
  { key: 'outcome', label: 'Outcome', width: '0.6fr', default: true, min: 112 },
  { key: 'detail', label: 'Detail', width: '2fr', default: true, min: 210 },
];

/** The row's chevron track, after the columns. */
export const DELIVERY_LOG_TRAILING = ['30px'];
