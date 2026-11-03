/**
 * Delivery log — the portal side of the notification delivery log
 * (GET /notifications/log, api notifications/delivery_log.py) and of Check
 * delivery (GET /notifications/check): the words for every event and reason
 * code, for where a switch comes from and for the schedule's state right now,
 * the outcome chip and one-line detail a log row shows, the time-range
 * choices, and the list's column registry. A code this file does not know (a
 * newer API) shows as itself.
 *
 * Specs: docs/superpowers/specs/2026-10-31-notifications-phase0-design.md
 * (sections 4 and 9), 2026-11-01-notifications-phase1-design.md (section 7)
 * and 2026-11-02-notifications-phase2-design.md (section 8: the routes that
 * brought a notification, and the reasons no_access and not_watching).
 */

import type { DeliveryLogEntry, DeliveryLogEvent } from './api';
import type { ColumnDef } from './listTools';

/** The hint under the page title on the Delivery log tab. */
export const DELIVERY_LOG_HINT = 'Every notification and email decision — who, what and why.';

/** Every event, in the order a notification's trail runs (the Outcome filter's
 *  order): the inbox row, the email's decision (queued, not emailed, or held
 *  for the summary and then in it), then how the sending went. */
export const DELIVERY_LOG_EVENTS: readonly DeliveryLogEvent[] = [
  'inbox_written', 'inbox_suppressed', 'email_queued', 'email_not_queued',
  'email_held', 'email_summarized',
  'email_sent', 'email_skipped', 'email_retry', 'email_failed',
];

export const EVENT_LABELS: Record<DeliveryLogEvent, string> = {
  inbox_written: 'In inbox',
  inbox_suppressed: 'Not in inbox',
  email_queued: 'Queued',
  email_not_queued: 'Not emailed',
  email_held: 'Held for summary',
  email_summarized: 'In summary',
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
 *  happen, why a queued or held email was dropped, and why one is held. The
 *  codes Phase 1 retired stay, so rows logged before it still read well. */
export const REASON_LABELS: Record<string, string> = {
  // the inbox row was not written (inbox_suppressed)
  category_off: 'Category turned off',
  // the person can't open what the event is about: the event sweep keeps the
  // inbox row out (inbox_suppressed) and the send-time re-check drops the email
  // (email_skipped)
  no_access: 'No access',
  // the notification was not emailed (email_not_queued)
  email_not_set_up: "Email isn't set up",
  unregistered_kind: 'Not a registered notification type',
  kind_not_emailed: 'This type is never emailed',
  admin_copy: 'Admin copy — inbox only',
  category_inbox_only: 'Category set to inbox only',
  recipient_inactive: 'Person archived or account disabled',
  no_address: 'No email address',
  // dropped just before sending, or when its summary came (email_skipped)
  notification_gone: 'Inbox item no longer exists',
  hidden: 'Hidden in the portal',
  read: 'Already read in the portal',
  resolved: 'Already decided',
  category_turned_down: 'Category turned down',
  // none of the notification's events reaches the person any more (email_skipped)
  not_watching: 'Not watching any more',
  // why an email is held for the summary (email_held)
  quiet_hours: 'Quiet hours',
  inactive_day: 'Not an active day',
  // retired in Phase 1: groups no longer decide; only rows logged before it carry these
  no_email_group: 'No group emails this category',
  blocked_by_schedule: "Every group's schedule blocks it",
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

/** Where a switch's value comes from (Check delivery's inbox line and its
 *  "Their switches"): the company default they follow, their own choice, or
 *  fixed (account security is always on). */
export const SWITCH_SOURCE_LABELS: Record<string, string> = {
  default: 'Company default',
  own: 'Their choice',
  fixed: 'Always',
};
export const switchSourceLabel = (code: string): string => own(SWITCH_SOURCE_LABELS, code) ?? code;

/** Where a person's schedule stands right now (Check delivery's "Their
 *  schedule"), in words and color. */
export const SCHEDULE_STATES: Record<string, { label: string; chip: string }> = {
  open: { label: 'Open', chip: 'c-green' },
  quiet_hours: { label: 'In quiet hours', chip: 'c-amber' },
  inactive_day: { label: 'Day off', chip: 'c-amber' },
};
export const scheduleStateOf = (code: string): { label: string; chip: string } =>
  own(SCHEDULE_STATES, code) ?? { label: code, chip: 'c-slate' };

/** The outcome chip of a log row: Held for summary (amber) for an email that
 *  waits for the person's summary, and Held (amber) for a queued email from
 *  before Phase 1 that carries `deferred`. Sent is green, Failed red, Retrying
 *  amber; the inbox, a queued email and one in a summary blue; the rest slate.
 *  An event this file does not know shows its code. */
export function outcomeOf(e: DeliveryLogEntry): { label: string; chip: string } {
  if (!isEvent(e.event)) return { label: e.event, chip: 'c-slate' };
  const label = EVENT_LABELS[e.event];
  switch (e.event) {
    case 'email_queued':
      return e.detail?.deferred === true ? { label: 'Held', chip: 'c-amber' } : { label, chip: 'c-blue' };
    case 'email_held': return { label, chip: 'c-amber' };
    case 'inbox_written':
    case 'email_summarized': return { label, chip: 'c-blue' };
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
const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One route that brought a notification to the person, in words: "Watching ·
 *  their own", "Watching · Group A" (a group's watch), "Rule · Rule A" (a
 *  status rule that named them) or "Named" (the code that announced it named
 *  them). A group or rule whose name was not logged reads as "Watching" or
 *  "Rule" alone, and a route this file does not know (a newer API) as itself. */
function routeText(route: string, routeNames: Record<string, unknown>): string {
  if (route === 'watch') return 'Watching · their own';
  if (route === 'direct') return 'Named';
  const name = text(own(routeNames, route));
  if (route.startsWith('group:')) return name ? `Watching · ${name}` : 'Watching';
  if (route.startsWith('rule:')) return name ? `Rule · ${name}` : 'Rule';
  return route;
}

/** The routes of an inbox row, joined with ", " in the order the API logged
 *  them (it sorts them): `detail.via`, a list of "watch", "direct",
 *  "group:<id>" and "rule:<id>", with `detail.names` giving the groups' and
 *  rules' names by route. Empty when none was logged. Only the event sweep's
 *  inbox rows carry this list: on a queued email `via` is a string (where the
 *  address came from), so ask for it of the two inbox events alone. */
function routesText(d: Record<string, unknown>): string {
  const routeNames = isMap(d.names) ? d.names : {};
  return names(d.via).map((route) => routeText(route, routeNames)).join(', ');
}

/** "OSError" or "SMTPResponseException, SMTP 452": the failure's class and code. */
function failure(detail: Record<string, unknown>): string | null {
  const error = text(detail.error);
  const code = count(detail.smtp_code);
  const parts = [error, code !== null ? `SMTP ${code}` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** An email sent now only because that morning's summary has already gone
 *  (the last hour before the person is back online): a queued row's
 *  `after_summary` flag, and Check delivery's `after_summary`. */
export const AFTER_SUMMARY_LABEL = 'after the summary';

/** What a queued email says besides "Due now", from its detail flags: why it
 *  did not wait for a summary. */
const QUEUED_FLAGS: readonly (readonly [string, string])[] = [
  ['critical', 'critical'],
  ['owner_copy', "owner's copy"],
  ['after_summary', AFTER_SUMMARY_LABEL],
];

/** The one-line detail of a log row: when an email is due ("Due now · critical",
 *  "Summary email · 3 notifications"), why it waits for the summary ("Until
 *  Mon 7:00 AM · Quiet hours"), how a send went ("Attempt 2 failed (OSError) —
 *  retrying"), or the reason an inbox row or an email did not happen ("Already
 *  read in the portal"), with whose switch it was when a switch turned it
 *  down ("Category turned off · Their choice"). An inbox row the event sweep
 *  wrote says what brought it ("Watching · their own, Watching · Group A"),
 *  and one it kept out says that after its reason ("Category turned off ·
 *  Their choice · Watching · their own"). A queued email from before
 *  Phase 1 that carries `deferred` keeps its older words ("Held until Mon
 *  7:00 AM · Quiet hours · Destination Side Ops Team"). Empty when there is
 *  nothing to add (an inbox row that logged no routes, an email in a summary). */
export function describeEntry(e: DeliveryLogEntry): string {
  const d = e.detail ?? {};
  switch (e.event) {
    case 'inbox_written':
      return routesText(d) || (e.reason ? reasonLabel(e.reason) : '');
    case 'email_held': {
      const until = text(d.summary_at);
      return [until ? `Until ${shortWhen(until)}` : null, e.reason ? reasonLabel(e.reason) : null]
        .filter(Boolean).join(' · ');
    }
    case 'email_queued': {
      if (d.summary === true) {
        const n = count(d.count);
        return n === null ? 'Summary email' : `Summary email · ${n} notification${n === 1 ? '' : 's'}`;
      }
      const sendAt = text(d.send_at);
      const why = text(d.reason);
      const parts = d.deferred === true && sendAt
        ? [`Held until ${shortWhen(sendAt)}`, why ? reasonLabel(why) : null]
        : ['Due now', ...QUEUED_FLAGS.filter(([key]) => d[key] === true).map(([, label]) => label)];
      const groups = names(d.groups);          // only on rows from before Phase 1
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
    case 'inbox_suppressed':
    case 'email_not_queued': {
      // A switch that turned it down (category_off, category_inbox_only) logs
      // where its value came from: the company default or the person's own.
      const source = text(d.source);
      // An inbox row the event sweep kept out also logs what would have brought it.
      const routes = e.event === 'inbox_suppressed' ? routesText(d) : '';
      return [
        e.reason ? reasonLabel(e.reason) : null, source ? switchSourceLabel(source) : null, routes,
      ].filter(Boolean).join(' · ');
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
 * When and Channel hold short, low-variance values (a relative time, one
 * channel chip); Category and Outcome one chip each, whose floor holds the
 * longest: "Approvals & requests" (156px) and "Held for summary" (125px
 * measured at the default list size; the chip's 20px of padding does not
 * scale, so the smallest size needs the most: 130px covers every size).
 * Their small fr barely grows, so the slack goes to Notification and
 * Detail, the two columns people read. Detail is clamped to two lines.
 * Fit: default columns + DELIVERY_LOG_TRAILING ≤ LIST_FIT.page
 * (1172px — .portal-page at a 1512px window, nav expanded). */
export const DELIVERY_LOG_COLUMNS: ColumnDef[] = [
  { key: 'when', label: 'When', width: '0.5fr', default: true, min: 90 },
  { key: 'person', label: 'Person', width: '1fr', default: true, min: 120 },
  { key: 'notification', label: 'Notification', width: '2fr', default: true, min: 190 },
  { key: 'category', label: 'Category', width: '0.9fr', default: true, min: 156 },
  { key: 'channel', label: 'Channel', width: '0.4fr', default: true, min: 80 },
  { key: 'outcome', label: 'Outcome', width: '0.6fr', default: true, min: 130 },
  { key: 'detail', label: 'Detail', width: '2fr', default: true, min: 210 },
];

/** The row's chevron track, after the columns. */
export const DELIVERY_LOG_TRAILING = ['30px'];
