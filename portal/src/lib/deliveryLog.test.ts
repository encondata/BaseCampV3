/**
 * The Delivery log's words: a label for every event and every reason code the
 * API writes (specs 2026-10-31-notifications-phase0, sections 4 and 9, and
 * 2026-11-01-notifications-phase1, section 7), the outcome chip a row shows,
 * the one-line detail, and Check delivery's words for a switch's source and the
 * schedule's state. A code this file does not know (a newer API) shows as itself.
 */
import { describe, expect, it } from 'vitest';

import type { DeliveryLogEntry } from './api';
import {
  DELIVERY_LOG_EVENTS, EVENT_LABELS, REASON_LABELS, SCHEDULE_STATES, SWITCH_SOURCE_LABELS,
  describeEntry, outcomeOf, reasonLabel, scheduleStateOf, shortWhen, sinceFor, switchSourceLabel,
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
      email_held: 'Held for summary',
      email_summarized: 'In summary',
      email_sent: 'Sent',
      email_skipped: 'Dropped',
      email_retry: 'Retrying',
      email_failed: 'Failed',
    });
    expect([...DELIVERY_LOG_EVENTS].sort()).toEqual(Object.keys(EVENT_LABELS).sort());
  });

  it('names every reason code the API writes, in words', () => {
    const codes = [
      // dropped before sending (or at summary time), plus SMTP off; not_watching is new in Phase 2
      'notification_gone', 'hidden', 'read', 'resolved', 'recipient_inactive',
      'category_turned_down', 'email_not_set_up', 'not_watching',
      // a Device offline email dropped because every device in it is seen again (new in Phase 2)
      'back_online',
      // the inbox row not written (no_access is new in Phase 2, and the re-check drops an email for it too)
      'category_off', 'no_access',
      // a notification not emailed (admin_copy is new in Phase 1)
      'unregistered_kind', 'kind_not_emailed', 'category_inbox_only', 'no_address', 'admin_copy',
      // why an email is held for the summary
      'quiet_hours', 'inactive_day',
    ];
    for (const code of codes) {
      expect(REASON_LABELS[code], code).toBeTruthy();
      expect(REASON_LABELS[code], code).not.toBe(code);
    }
  });

  it('keeps the words for the retired codes, so rows from before Phase 1 still read well', () => {
    expect(REASON_LABELS.no_email_group).toBe('No group emails this category');
    expect(REASON_LABELS.blocked_by_schedule).toBe("Every group's schedule blocks it");
  });

  it('uses the agreed words for the codes people ask about most', () => {
    expect(REASON_LABELS.read).toBe('Already read in the portal');
    expect(REASON_LABELS.resolved).toBe('Already decided');
    expect(REASON_LABELS.quiet_hours).toBe('Quiet hours');
    expect(REASON_LABELS.inactive_day).toBe('Not an active day');
    expect(REASON_LABELS.email_not_set_up).toBe("Email isn't set up");
    expect(REASON_LABELS.admin_copy).toBe('Admin copy — inbox only');
    expect(REASON_LABELS.no_access).toBe('No access');
    expect(REASON_LABELS.not_watching).toBe('Not watching any more');
    expect(REASON_LABELS.back_online).toBe('Device back online');
  });

  it('names where a switch comes from and how the schedule stands right now', () => {
    expect(SWITCH_SOURCE_LABELS).toEqual({ default: 'Company default', own: 'Their choice', fixed: 'Always' });
    expect(switchSourceLabel('own')).toBe('Their choice');
    expect(switchSourceLabel('newer_source')).toBe('newer_source');
    expect(switchSourceLabel('constructor')).toBe('constructor');   // never an Object.prototype member

    expect(SCHEDULE_STATES).toEqual({
      open: { label: 'Open', chip: 'c-green' },
      quiet_hours: { label: 'In quiet hours', chip: 'c-amber' },
      inactive_day: { label: 'Day off', chip: 'c-amber' },
    });
    expect(scheduleStateOf('quiet_hours').label).toBe('In quiet hours');
    expect(scheduleStateOf('holiday')).toEqual({ label: 'holiday', chip: 'c-slate' });
  });


  it('shows a reason code it does not know as the code itself', () => {
    expect(reasonLabel('read')).toBe('Already read in the portal');
    expect(reasonLabel('some_new_reason')).toBe('some_new_reason');
    expect(reasonLabel('constructor')).toBe('constructor');      // never an Object.prototype member
    expect(outcomeOf(entry({ event: 'toString' }))).toEqual({ label: 'toString', chip: 'c-slate' });
  });
});

describe('outcomeOf', () => {
  it('reads an email held for the summary as Held for summary, in amber', () => {
    expect(outcomeOf(entry({
      event: 'email_held', channel: 'email', reason: 'quiet_hours', detail: { summary_at: MONDAY_7AM },
    }))).toEqual({ label: 'Held for summary', chip: 'c-amber' });
  });

  it('reads an email that went out in a summary as In summary, in blue', () => {
    expect(outcomeOf(entry({ event: 'email_summarized', channel: 'email', outbox_id: 'o9' })))
      .toEqual({ label: 'In summary', chip: 'c-blue' });
  });

  it('reads a queued email from before Phase 1 that carries deferred as Held, in amber', () => {
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
  it('an email held for the summary says until when, and why', () => {
    expect(describeEntry(entry({
      event: 'email_held', channel: 'email', reason: 'quiet_hours', detail: { summary_at: MONDAY_7AM },
    }))).toBe('Until Mon 7:00 AM · Quiet hours');
    expect(describeEntry(entry({
      event: 'email_held', channel: 'email', reason: 'inactive_day', detail: { summary_at: MONDAY_7AM },
    }))).toBe('Until Mon 7:00 AM · Not an active day');
  });

  it('a held email whose reason is new shows the code, and one with no time says only why', () => {
    expect(describeEntry(entry({
      event: 'email_held', channel: 'email', reason: 'holiday', detail: { summary_at: MONDAY_7AM },
    }))).toBe('Until Mon 7:00 AM · holiday');
    expect(describeEntry(entry({ event: 'email_held', channel: 'email', reason: 'quiet_hours' })))
      .toBe('Quiet hours');
  });

  it('an email in a summary has nothing more to say; the label says it', () => {
    expect(describeEntry(entry({ event: 'email_summarized', channel: 'email', outbox_id: 'o9' }))).toBe('');
  });

  it('an email queued for now says so', () => {
    expect(describeEntry(entry({
      event: 'email_queued', channel: 'email',
      detail: { template: 'notification', send_at: MONDAY_7AM, deferred: false, via: 'contact' },
    }))).toBe('Due now');
    // template mail (a password reset) is the same
    expect(describeEntry(entry({
      event: 'email_queued', channel: 'email', kind: 'password_reset', kind_label: 'password_reset',
      category: null, notification_id: null,
      detail: { template: 'password_reset', send_at: MONDAY_7AM, deferred: false },
    }))).toBe('Due now');
  });

  it('a queued email adds why it did not wait: critical, the owner\'s copy, or after the summary', () => {
    const queued = (extra: Record<string, unknown>) => describeEntry(entry({
      event: 'email_queued', channel: 'email',
      detail: { template: 'notification', send_at: MONDAY_7AM, deferred: false, via: 'contact', ...extra },
    }));
    expect(queued({ critical: true })).toBe('Due now · critical');
    expect(queued({ owner_copy: true, via: 'login' })).toBe("Due now · owner's copy");
    expect(queued({ after_summary: true })).toBe('Due now · after the summary');
    // a flag that is false adds nothing
    expect(queued({ critical: false, owner_copy: false, after_summary: false })).toBe('Due now');
  });

  it('the summary email names how many notifications it holds', () => {
    const summary = (count: unknown) => describeEntry(entry({
      event: 'email_queued', channel: 'email', kind: 'notification_summary',
      kind_label: 'notification_summary', category: null, notification_id: null, outbox_id: 'o9',
      detail: { template: 'notification_summary', send_at: MONDAY_7AM, deferred: false, summary: true, count },
    }));
    expect(summary(3)).toBe('Summary email · 3 notifications');
    expect(summary(1)).toBe('Summary email · 1 notification');
    expect(summary(undefined)).toBe('Summary email');
  });

  it('a queued email from before Phase 1 that waited says until when, why, and which group let it go', () => {
    expect(describeEntry(entry({
      event: 'email_queued', channel: 'email', outbox_id: 'o1',
      detail: {
        template: 'notification', send_at: MONDAY_7AM, deferred: true, reason: 'quiet_hours',
        groups: ['Destination Side Ops Team'], via: 'contact',
      },
    }))).toBe('Held until Mon 7:00 AM · Quiet hours · Destination Side Ops Team');
  });

  it('a queued email from before Phase 1 that went at once names the groups that let it go', () => {
    expect(describeEntry(entry({
      event: 'email_queued', channel: 'email',
      detail: {
        template: 'notification', send_at: MONDAY_7AM, deferred: false,
        groups: ['Ops Alerts', 'Night Desk'], via: 'contact',
      },
    }))).toBe('Due now · Ops Alerts, Night Desk');
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
    expect(describeEntry(entry({ event: 'email_not_queued', channel: 'email', reason: 'admin_copy' })))
      .toBe('Admin copy — inbox only');
    expect(describeEntry(entry({ event: 'inbox_suppressed', reason: 'category_off', notification_id: null })))
      .toBe('Category turned off');
  });

  it('a switch that turned it down says whose it was: Company default or Their choice', () => {
    const suppressed = (source: string) => describeEntry(entry({
      event: 'inbox_suppressed', reason: 'category_off', notification_id: null, detail: { source },
    }));
    expect(suppressed('default')).toBe('Category turned off · Company default');
    expect(suppressed('own')).toBe('Category turned off · Their choice');

    const notEmailed = (reason: string, source: string) => describeEntry(entry({
      event: 'email_not_queued', channel: 'email', reason, detail: { source },
    }));
    expect(notEmailed('category_off', 'own')).toBe('Category turned off · Their choice');
    expect(notEmailed('category_inbox_only', 'default')).toBe('Category set to inbox only · Company default');
    expect(notEmailed('category_inbox_only', 'own')).toBe('Category set to inbox only · Their choice');
  });

  it('a row without a source reads as its reason alone, as before', () => {
    expect(describeEntry(entry({ event: 'inbox_suppressed', reason: 'category_off', notification_id: null })))
      .toBe('Category turned off');
    expect(describeEntry(entry({ event: 'email_not_queued', channel: 'email', reason: 'category_inbox_only' })))
      .toBe('Category set to inbox only');
    expect(describeEntry(entry({ event: 'email_not_queued', channel: 'email', reason: 'no_address' })))
      .toBe('No email address');
  });

  it('a held email dropped when its summary came reads as the reason it was dropped', () => {
    expect(describeEntry(entry({ event: 'email_skipped', channel: 'email', reason: 'category_turned_down' })))
      .toBe('Category turned down');
    expect(describeEntry(entry({ event: 'email_skipped', channel: 'email', reason: 'notification_gone' })))
      .toBe('Inbox item no longer exists');
  });

  it('a row from before Phase 1 still reads as the retired reason', () => {
    expect(describeEntry(entry({ event: 'email_not_queued', channel: 'email', reason: 'no_email_group' })))
      .toBe('No group emails this category');
    expect(describeEntry(entry({ event: 'email_not_queued', channel: 'email', reason: 'blocked_by_schedule' })))
      .toBe("Every group's schedule blocks it");
  });

  it('an unknown reason code returns the code', () => {
    expect(describeEntry(entry({ event: 'email_skipped', channel: 'email', reason: 'mystery_code' })))
      .toBe('mystery_code');
  });

  it('an inbox row that was written has nothing more to say', () => {
    expect(describeEntry(entry({ event: 'inbox_written' }))).toBe('');
  });

  // The event sweep logs the routes that brought a notification (detail.via, a list, sorted by the
  // API), the event ids and the groups' names by route. detail.via on a QUEUED email is a string
  // (where the address came from), so the routes belong to the two inbox events alone.
  describe('the routes of an inbox row', () => {
    const written = (via: unknown, names: unknown = {}) => describeEntry(entry({
      event: 'inbox_written', detail: { via, events: [7], names },
    }));

    it('says what brought it: their own watch, a group\'s watch, a rule, or being named', () => {
      expect(written(['watch', 'group:g1'], { 'group:g1': 'Group A' }))
        .toBe('Watching · their own, Watching · Group A');
      expect(written(['watch'])).toBe('Watching · their own');
      expect(written(['group:g1'], { 'group:g1': 'Group A' })).toBe('Watching · Group A');
      expect(written(['rule:r1'], { 'rule:r1': 'Rule A' })).toBe('Rule · Rule A');
      expect(written(['direct'])).toBe('Named');
    });

    it('lists every route, joined with commas: their own watch, then groups\', then rules\', then being named', () => {
      // the API logs them sorted by code, so "direct" comes first and "watch" last
      expect(written(
        ['direct', 'group:g1', 'group:g2', 'rule:r1', 'watch'],
        { 'group:g1': 'Group A', 'group:g2': 'Group B', 'rule:r1': 'Rule A' },
      )).toBe('Watching · their own, Watching · Group A, Watching · Group B, Rule · Rule A, Named');
    });

    it('keeps the API\'s order among routes of one kind, not an order of the names', () => {
      expect(written(
        ['group:g1', 'group:g2', 'rule:r1', 'rule:r2'],
        { 'group:g1': 'Group B', 'group:g2': 'Group A', 'rule:r1': 'Rule B', 'rule:r2': 'Rule A' },
      )).toBe('Watching · Group B, Watching · Group A, Rule · Rule B, Rule · Rule A');
      // routes out of their usual order are put in it by kind alone
      expect(written(['rule:r1', 'group:g1', 'direct', 'watch'], { 'group:g1': 'Group A', 'rule:r1': 'Rule A' }))
        .toBe('Watching · their own, Watching · Group A, Rule · Rule A, Named');
    });

    it('does not change the list it is given', () => {
      const via = ['direct', 'watch'];
      written(via);
      expect(via).toEqual(['direct', 'watch']);
    });

    it('a group or rule whose name was not logged reads as "Watching" or "Rule" alone', () => {
      expect(written(['group:g1'])).toBe('Watching');
      expect(written(['rule:r1'])).toBe('Rule');
      // the name of another route is not borrowed, and an empty or odd name counts as none
      expect(written(['group:g1'], { 'group:g2': 'Group B' })).toBe('Watching');
      expect(written(['group:g1'], { 'group:g1': '' })).toBe('Watching');
      expect(written(['rule:r1'], { 'rule:r1': 7 })).toBe('Rule');
    });

    it('shows a route it does not know as the route itself, after the ones it does', () => {
      expect(written(['device:d1'])).toBe('device:d1');
      expect(written(['watch', 'device:d1'])).toBe('Watching · their own, device:d1');
      expect(written(['device:d1', 'direct', 'watch'])).toBe('Watching · their own, Named, device:d1');
      expect(written(['constructor'])).toBe('constructor');   // never an Object.prototype member
    });

    it('says nothing when no routes were logged, whatever else the detail holds', () => {
      expect(written([])).toBe('');
      expect(written(undefined)).toBe('');
      expect(written('watch')).toBe('');                // a string is an address source, not a list of routes
      expect(written([7, null, ''])).toBe('');          // only text entries are routes
      expect(describeEntry(entry({ event: 'inbox_written', detail: { events: [7] } }))).toBe('');
      expect(written(['watch'], 'oops')).toBe('Watching · their own');   // names that are not a map are none
      expect(written(['group:g1'], ['Group A'])).toBe('Watching');
    });

    it('is added to why a category switch kept the row out of the inbox, after whose switch it was', () => {
      const suppressed = (detail: Record<string, unknown>) => describeEntry(entry({
        event: 'inbox_suppressed', reason: 'category_off', notification_id: null, detail,
      }));
      expect(suppressed({ source: 'own', via: ['watch'], events: [7], names: {} }))
        .toBe('Category turned off · Their choice · Watching · their own');
      expect(suppressed({ source: 'default', via: ['group:g1', 'rule:r1'], events: [7],
        names: { 'group:g1': 'Group A', 'rule:r1': 'Rule A' } }))
        .toBe('Category turned off · Company default · Watching · Group A, Rule · Rule A');
      // a row logged without routes reads as before
      expect(suppressed({ source: 'own' })).toBe('Category turned off · Their choice');
    });

    it('a candidate dropped for access reads as No access; it has no routes, only its events', () => {
      expect(describeEntry(entry({
        event: 'inbox_suppressed', reason: 'no_access', notification_id: null, detail: { events: [7] },
      }))).toBe('No access');
    });

    it('is read from an inbox row only: on any other event, via keeps the meaning it had', () => {
      // a queued email: via is where the address came from
      expect(describeEntry(entry({
        event: 'email_queued', channel: 'email',
        detail: { template: 'notification', send_at: MONDAY_7AM, deferred: false, via: 'login' },
      }))).toBe('Due now');
      // a list under any other event is not read as routes
      expect(describeEntry(entry({
        event: 'email_queued', channel: 'email',
        detail: { template: 'notification', send_at: MONDAY_7AM, deferred: false, via: ['watch'] },
      }))).toBe('Due now');
      expect(describeEntry(entry({
        event: 'email_not_queued', channel: 'email', reason: 'no_address', detail: { via: ['watch'] },
      }))).toBe('No email address');
      expect(describeEntry(entry({
        event: 'email_sent', channel: 'email', detail: { attempt: 1, via: ['watch'] },
      }))).toBe('Sent on attempt 1');
    });
  });

  it('an email the send-time re-check dropped reads as the reason: no access, or not watching', () => {
    expect(describeEntry(entry({ event: 'email_skipped', channel: 'email', reason: 'no_access' })))
      .toBe('No access');
    expect(describeEntry(entry({ event: 'email_skipped', channel: 'email', reason: 'not_watching' })))
      .toBe('Not watching any more');
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
