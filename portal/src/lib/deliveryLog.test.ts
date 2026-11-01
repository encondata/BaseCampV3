/**
 * The Delivery log's words: a label for every event and every reason code the
 * API writes (spec 2026-10-31-notifications-phase0, sections 4 and 9), the
 * outcome chip a row shows, and the one-line detail. A code this file does not
 * know (a newer API) shows as itself.
 */
import { describe, expect, it } from 'vitest';

import type { DeliveryLogEntry } from './api';
import {
  DELIVERY_LOG_EVENTS, EVENT_LABELS, REASON_LABELS, describeEntry, outcomeOf, reasonLabel,
  shortWhen, sinceFor,
} from './deliveryLog';

const entry = (over: Partial<DeliveryLogEntry> = {}): DeliveryLogEntry => ({
  id: 1, at: '2026-11-01T12:00:00Z', event: 'inbox_written', channel: 'inbox', reason: null,
  kind: 'report_ready', kind_label: 'Report ready', category: 'reports', detail: {},
  process: 'api', person_id: 'p1', person_name: 'Ada Lovelace', notification_id: 'n1',
  notification_title: 'NAP11 move report is ready', notification_link: '/reports',
  outbox_id: null, to_address: null, outbox_status: null, ...over,
});

/** Local Monday 2 November 2026, 7:00 AM — the fixtures read in local time. */
const MONDAY_7AM = new Date(2026, 10, 2, 7, 0, 0).toISOString();

describe('labels', () => {
  it('names every event the log writes', () => {
    expect(EVENT_LABELS).toEqual({
      inbox_written: 'In inbox',
      inbox_suppressed: 'Not in inbox',
      email_queued: 'Queued',
      email_not_queued: 'Not emailed',
      email_sent: 'Sent',
      email_skipped: 'Dropped',
      email_retry: 'Retrying',
      email_failed: 'Failed',
    });
    expect([...DELIVERY_LOG_EVENTS].sort()).toEqual(Object.keys(EVENT_LABELS).sort());
  });

  it('names every reason code in the spec, in words', () => {
    const codes = [
      // section 4: dropped before sending, plus SMTP off
      'notification_gone', 'hidden', 'read', 'resolved', 'recipient_inactive',
      'category_turned_down', 'no_email_group', 'email_not_set_up',
      // section 9: the inbox row not written
      'category_off',
      // section 9: a notification not emailed
      'unregistered_kind', 'kind_not_emailed', 'category_inbox_only', 'no_address',
      'blocked_by_schedule',
      // section 9: why a queued email waits
      'quiet_hours', 'inactive_day',
    ];
    for (const code of codes) {
      expect(REASON_LABELS[code], code).toBeTruthy();
      expect(REASON_LABELS[code], code).not.toBe(code);
    }
  });

  it('uses the agreed words for the codes people ask about most', () => {
    expect(REASON_LABELS.read).toBe('Already read in the portal');
    expect(REASON_LABELS.resolved).toBe('Already decided');
    expect(REASON_LABELS.no_email_group).toBe('No group emails this category');
    expect(REASON_LABELS.quiet_hours).toBe('Quiet hours');
    expect(REASON_LABELS.inactive_day).toBe('Not an active day');
    expect(REASON_LABELS.email_not_set_up).toBe("Email isn't set up");
  });

  it('shows a reason code it does not know as the code itself', () => {
    expect(reasonLabel('read')).toBe('Already read in the portal');
    expect(reasonLabel('some_new_reason')).toBe('some_new_reason');
    expect(reasonLabel('constructor')).toBe('constructor');      // never an Object.prototype member
    expect(outcomeOf(entry({ event: 'toString' }))).toEqual({ label: 'toString', chip: 'c-slate' });
  });
});

describe('outcomeOf', () => {
  it('reads a deferred queued email as Held, in amber', () => {
    expect(outcomeOf(entry({
      event: 'email_queued', channel: 'email',
      detail: { template: 'notification', send_at: MONDAY_7AM, deferred: true, reason: 'quiet_hours' },
    }))).toEqual({ label: 'Held', chip: 'c-amber' });
  });

  it('reads an email queued for now as Queued', () => {
    expect(outcomeOf(entry({
      event: 'email_queued', channel: 'email',
      detail: { template: 'notification', send_at: MONDAY_7AM, deferred: false },
    }))).toEqual({ label: 'Queued', chip: 'c-blue' });
  });

  it('colors the delivery outcomes: sent green, failed red, retrying amber', () => {
    expect(outcomeOf(entry({ event: 'email_sent', channel: 'email' })))
      .toEqual({ label: 'Sent', chip: 'c-green' });
    expect(outcomeOf(entry({ event: 'email_failed', channel: 'email' })))
      .toEqual({ label: 'Failed', chip: 'c-red' });
    expect(outcomeOf(entry({ event: 'email_retry', channel: 'email' })))
      .toEqual({ label: 'Retrying', chip: 'c-amber' });
  });

  it('keeps the quiet outcomes blue or slate', () => {
    expect(outcomeOf(entry({ event: 'inbox_written' }))).toEqual({ label: 'In inbox', chip: 'c-blue' });
    expect(outcomeOf(entry({ event: 'inbox_suppressed', reason: 'category_off' })))
      .toEqual({ label: 'Not in inbox', chip: 'c-slate' });
    expect(outcomeOf(entry({ event: 'email_not_queued', channel: 'email' })))
      .toEqual({ label: 'Not emailed', chip: 'c-slate' });
    expect(outcomeOf(entry({ event: 'email_skipped', channel: 'email', reason: 'read' })))
      .toEqual({ label: 'Dropped', chip: 'c-slate' });
  });

  it('shows an event it does not know as the code itself', () => {
    expect(outcomeOf(entry({ event: 'push_sent' }))).toEqual({ label: 'push_sent', chip: 'c-slate' });
  });
});

describe('describeEntry', () => {
  it('a deferred email says until when, why, and which group lets it go', () => {
    expect(describeEntry(entry({
      event: 'email_queued', channel: 'email', outbox_id: 'o1',
      detail: {
        template: 'notification', send_at: MONDAY_7AM, deferred: true, reason: 'quiet_hours',
        groups: ['Destination Side Ops Team'], via: 'contact',
      },
    }))).toBe('Held until Mon 7:00 AM · Quiet hours · Destination Side Ops Team');
  });

  it('an email queued for now says so, with the groups that let it go', () => {
    expect(describeEntry(entry({
      event: 'email_queued', channel: 'email',
      detail: {
        template: 'notification', send_at: MONDAY_7AM, deferred: false,
        groups: ['Ops Alerts', 'Night Desk'], via: 'contact',
      },
    }))).toBe('Due now · Ops Alerts, Night Desk');
    // template mail (a password reset) names no group
    expect(describeEntry(entry({
      event: 'email_queued', channel: 'email', kind: 'password_reset', kind_label: 'password_reset',
      category: null, notification_id: null,
      detail: { template: 'password_reset', send_at: MONDAY_7AM, deferred: false },
    }))).toBe('Due now');
  });

  it('a deferred email whose reason is new shows the code', () => {
    expect(describeEntry(entry({
      event: 'email_queued', channel: 'email',
      detail: { template: 'notification', send_at: MONDAY_7AM, deferred: true, reason: 'holiday' },
    }))).toBe('Held until Mon 7:00 AM · holiday');
  });

  it('a retry names the attempt and the error class', () => {
    expect(describeEntry(entry({
      event: 'email_retry', channel: 'email',
      detail: { attempt: 2, error: 'OSError', smtp_code: null, next_attempt_at: MONDAY_7AM },
    }))).toBe('Attempt 2 failed (OSError) — retrying');
    expect(describeEntry(entry({
      event: 'email_retry', channel: 'email',
      detail: { attempt: 3, error: 'SMTPResponseException', smtp_code: 452, next_attempt_at: MONDAY_7AM },
    }))).toBe('Attempt 3 failed (SMTPResponseException, SMTP 452) — retrying');
  });

  it('a failure says how many attempts it took', () => {
    expect(describeEntry(entry({
      event: 'email_failed', channel: 'email',
      detail: { attempts: 5, error: 'SMTPRecipientsRefused', smtp_code: 550 },
    }))).toBe('Gave up after 5 attempts (SMTPRecipientsRefused, SMTP 550)');
  });

  it('a sent email names its attempt', () => {
    expect(describeEntry(entry({ event: 'email_sent', channel: 'email', detail: { attempt: 1 } })))
      .toBe('Sent on attempt 1');
  });

  it('a drop, a not-emailed and a suppressed inbox row read as their reason', () => {
    expect(describeEntry(entry({ event: 'email_skipped', channel: 'email', reason: 'read' })))
      .toBe('Already read in the portal');
    expect(describeEntry(entry({ event: 'email_not_queued', channel: 'email', reason: 'no_email_group' })))
      .toBe('No group emails this category');
    expect(describeEntry(entry({ event: 'inbox_suppressed', reason: 'category_off', notification_id: null })))
      .toBe('Category turned off');
  });

  it('an unknown reason code returns the code', () => {
    expect(describeEntry(entry({ event: 'email_skipped', channel: 'email', reason: 'mystery_code' })))
      .toBe('mystery_code');
  });

  it('an inbox row that was written has nothing more to say', () => {
    expect(describeEntry(entry({ event: 'inbox_written' }))).toBe('');
  });
});

describe('times', () => {
  it('shortWhen reads a local time as weekday and 12-hour clock', () => {
    expect(shortWhen(MONDAY_7AM)).toBe('Mon 7:00 AM');
    expect(shortWhen(new Date(2026, 10, 3, 21, 5).toISOString())).toBe('Tue 9:05 PM');
    expect(shortWhen(new Date(2026, 10, 4, 0, 0).toISOString())).toBe('Wed 12:00 AM');
    expect(shortWhen(new Date(2026, 10, 4, 12, 30).toISOString())).toBe('Wed 12:30 PM');
  });

  it('sinceFor turns a time range into the oldest moment to show, or null for all', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(sinceFor('24h', now)).toBe('2026-10-31T12:00:00.000Z');
    expect(sinceFor('7d', now)).toBe('2026-10-25T12:00:00.000Z');
    expect(sinceFor('30d', now)).toBe('2026-10-02T12:00:00.000Z');
    expect(sinceFor('all', now)).toBeNull();
  });
});
