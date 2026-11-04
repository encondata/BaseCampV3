/**
 * The pure rules of the Inbox / Email switch grid: which categories have
 * switches, what a person's own values plus the company default add up to
 * (Email needs Inbox), and how flipping one switch changes what is stored.
 */
import { describe, expect, it } from 'vitest';

import { NOTIFICATION_CATEGORIES } from './notificationKinds';
import {
  CATEGORY_DESCRIPTIONS, CONFIGURABLE, effective, flip, isChanged,
} from './notificationSwitches';

const ON = { inbox: true, email: true };

describe('CONFIGURABLE', () => {
  it('is the ten categories that have switches, in registry order', () => {
    expect(CONFIGURABLE).toEqual([
      'approvals', 'reports', 'wiki', 'learning', 'initiatives', 'plans', 'trucks', 'devices',
      'status_rules', 'bulk_actions',
    ]);
  });

  it('leaves out only Account security, which is always on', () => {
    const rest = NOTIFICATION_CATEGORIES.map((c) => c.key).filter((k) => !CONFIGURABLE.includes(k));
    expect(rest).toEqual(['security']);
  });
});

describe('CATEGORY_DESCRIPTIONS', () => {
  it('has the eleven row descriptions of the design, word for word', () => {
    expect(CATEGORY_DESCRIPTIONS).toEqual({
      approvals: 'Group membership requests and decisions, routers waiting for approval',
      reports: 'Reports and label runs, ready or failed',
      wiki: 'Page updates, comments, mentions, reviews and exports',
      learning: 'Learning completed or overdue, quizzes locked',
      initiatives: 'Initiative status changes',
      plans: "Plan tasks assigned to you, coming due or overdue, and the owner's overdue digest",
      trucks: 'Truck status changes',
      devices: 'Devices going offline',
      status_rules: 'Notifications from status rules',
      bulk_actions: 'Background bulk actions, finished or failed',
      security: 'Password expiring and two-factor notices about your own account',
    });
  });

  it('names every category the grid can list', () => {
    expect(Object.keys(CATEGORY_DESCRIPTIONS).sort()).toEqual(NOTIFICATION_CATEGORIES.map((c) => c.key).sort());
  });
});

describe('effective', () => {
  it('follows the default when the person has set nothing', () => {
    expect(effective(undefined, ON)).toEqual({ inbox: true, email: true });
    expect(effective({}, { inbox: true, email: false })).toEqual({ inbox: true, email: false });
    expect(effective(undefined, { inbox: false, email: false })).toEqual({ inbox: false, email: false });
  });

  it.each([
    // [own, default, inbox, email]
    [{ inbox: true, email: true }, { inbox: false, email: false }, true, true],
    [{ inbox: true, email: false }, { inbox: true, email: true }, true, false],
    [{ inbox: false, email: true }, { inbox: true, email: true }, false, false],
    [{ inbox: false, email: false }, { inbox: true, email: true }, false, false],
  ])('own %j over default %j gives inbox %s, email %s', (own, def, inbox, email) => {
    expect(effective(own, def)).toEqual({ inbox, email });
  });

  it('takes each value on its own: one set, the other follows the default', () => {
    expect(effective({ email: false }, ON)).toEqual({ inbox: true, email: false });
    expect(effective({ inbox: false }, { inbox: true, email: false })).toEqual({ inbox: false, email: false });
    expect(effective({ email: true }, { inbox: true, email: false })).toEqual({ inbox: true, email: true });
  });

  it('turns Email off while Inbox is off, whoever set which', () => {
    // own inbox off, default email on: Email needs Inbox
    expect(effective({ inbox: false }, ON)).toEqual({ inbox: false, email: false });
    // the default's inbox off, the person's own email on
    expect(effective({ email: true }, { inbox: false, email: false })).toEqual({ inbox: false, email: false });
  });

  it('gets Email back as soon as Inbox is back on', () => {
    expect(effective({ inbox: true }, { inbox: false, email: true })).toEqual({ inbox: true, email: true });
  });
});

describe('isChanged', () => {
  it('is false when the person has no values of their own', () => {
    expect(isChanged(undefined)).toBe(false);
    expect(isChanged({})).toBe(false);
    expect(isChanged({ inbox: undefined, email: undefined })).toBe(false);
  });

  it('is true when either value is set, on or off', () => {
    expect(isChanged({ inbox: false })).toBe(true);
    expect(isChanged({ email: true })).toBe(true);
    expect(isChanged({ inbox: true, email: false })).toBe(true);
  });
});

describe('flip', () => {
  it('stores a value that differs from the default', () => {
    expect(flip(undefined, ON, 'email', false)).toEqual({ email: false });
    expect(flip(undefined, ON, 'inbox', false)).toEqual({ inbox: false });
    expect(flip(undefined, { inbox: true, email: false }, 'email', true)).toEqual({ email: true });
  });

  it('keeps the other value the person already set', () => {
    expect(flip({ email: false }, ON, 'inbox', false)).toEqual({ email: false, inbox: false });
    expect(flip({ inbox: false }, ON, 'email', false)).toEqual({ inbox: false, email: false });
  });

  it('drops a value that equals the default, so the switch follows it again', () => {
    expect(flip({ inbox: false, email: false }, ON, 'inbox', true)).toEqual({ email: false });
    expect(flip({ inbox: false, email: false }, ON, 'email', true)).toEqual({ inbox: false });
  });

  it('returns undefined when both values are cleared', () => {
    expect(flip({ email: false }, ON, 'email', true)).toBeUndefined();
    expect(flip({ inbox: false }, ON, 'inbox', true)).toBeUndefined();
  });

  it('returns undefined when nothing was set and the new value is the default', () => {
    expect(flip(undefined, ON, 'email', true)).toBeUndefined();
    expect(flip({}, { inbox: false, email: false }, 'inbox', false)).toBeUndefined();
  });

  it('never carries an unset key', () => {
    const next = flip({ inbox: undefined, email: false }, ON, 'inbox', false);
    expect(Object.keys(next ?? {}).sort()).toEqual(['email', 'inbox']);
    const cleared = flip({ inbox: undefined, email: false }, ON, 'email', true);
    expect(cleared).toBeUndefined();
  });

  it('does not change the object it was given', () => {
    const own = Object.freeze({ email: false });
    expect(flip(own, ON, 'inbox', false)).toEqual({ email: false, inbox: false });
    expect(own).toEqual({ email: false });
  });
});
