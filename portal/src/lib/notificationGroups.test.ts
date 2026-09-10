import { describe, expect, it } from 'vitest';

import type {
  MyNotificationGroup, NotificationMemberOverrides,
} from './api';
import {
  GROUP_ERRORS, daysText, hasOverrides, quietHoursText, toGroupDetail, toMember,
} from './notificationGroups';

describe('quietHoursText', () => {
  it('formats a raw HH:MM:SS pair with the timezone name in parens', () => {
    expect(quietHoursText({ quiet_start: '22:00:00', quiet_end: '07:00:00', timezone: 'America/New_York' }))
      .toBe('22:00–07:00 (America/New_York)');
  });

  it('returns None when either quiet time is null', () => {
    expect(quietHoursText({ quiet_start: null, quiet_end: null, timezone: 'America/New_York' })).toBe('None');
  });
});

describe('daysText', () => {
  it('collapses all 7 days to Every day', () => {
    expect(daysText(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe('Every day');
  });

  it('collapses exactly the weekday set to Mon–Fri', () => {
    expect(daysText(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Mon–Fri');
  });

  it('collapses out-of-order weekdays to Mon–Fri too', () => {
    expect(daysText(['fri', 'tue', 'thu', 'mon', 'wed'])).toBe('Mon–Fri');
  });

  it('falls back to a comma list in week order for anything else', () => {
    expect(daysText(['fri', 'mon', 'wed'])).toBe('Mon, Wed, Fri');
  });

  it('returns None for an empty list', () => {
    expect(daysText([])).toBe('None');
  });
});

const NO_OVERRIDES: NotificationMemberOverrides = {
  channels: null, quiet_mode: null, quiet_start: null, quiet_end: null,
  timezone: null, active_days: null, dnd_behavior: null, urgent_bypass: null,
};

describe('hasOverrides', () => {
  it('is false for null overrides', () => {
    expect(hasOverrides(null)).toBe(false);
  });

  it('is false when every field is null', () => {
    expect(hasOverrides(NO_OVERRIDES)).toBe(false);
  });

  it('is true when any single field is non-null', () => {
    expect(hasOverrides({ ...NO_OVERRIDES, urgent_bypass: true })).toBe(true);
    expect(hasOverrides({ ...NO_OVERRIDES, channels: ['email'] })).toBe(true);
  });
});

describe('GROUP_ERRORS', () => {
  it('carries the spec copy for every self-service error code', () => {
    expect(GROUP_ERRORS.already_member).toBe("You're already in that group.");
    expect(GROUP_ERRORS.not_a_member).toBe("You're not in that group.");
    expect(GROUP_ERRORS.request_pending).toBe("There's already a request waiting for this group.");
    expect(GROUP_ERRORS.group_not_found).toBe('That group no longer exists.');
    expect(GROUP_ERRORS.forbidden).toBe("You can't change that.");
  });
});

const GROUP: MyNotificationGroup = {
  id: 'g1', name: 'Ops', description: 'Operations alerts', channels: ['email', 'push'],
  quiet_start: '22:00:00', quiet_end: '07:00:00', timezone: 'America/New_York',
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri'], dnd_behavior: 'defer', urgent_bypass: false,
  member_count: 3, is_member: true,
  overrides: { ...NO_OVERRIDES, urgent_bypass: true },
  effective: {
    channels: ['email', 'push'], quiet_start: '22:00:00', quiet_end: '07:00:00',
    timezone: 'America/New_York', active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    dnd_behavior: 'defer', urgent_bypass: true,
  },
  pending_request: null,
};

describe('toGroupDetail', () => {
  it('carries the group settings through and starts members empty', () => {
    const detail = toGroupDetail(GROUP);
    expect(detail.id).toBe('g1');
    expect(detail.name).toBe('Ops');
    expect(detail.channels).toEqual(['email', 'push']);
    expect(detail.timezone).toBe('America/New_York');
    expect(detail.enabled).toBe(true);
    expect(detail.members).toEqual([]);
  });
});

describe('toMember', () => {
  it('derives capability flags from the person\'s email/phone, and always allows push/web', () => {
    const member = toMember(GROUP, {
      id: 'p1', display_name: 'Ada Lovelace', email: 'ada@test.example.com', phone: null,
    });
    expect(member.person_id).toBe('p1');
    expect(member.display_name).toBe('Ada Lovelace');
    expect(member.can_email).toBe(true);
    expect(member.can_text).toBe(false);
    expect(member.can_push).toBe(true);
    expect(member.can_web).toBe(true);
    expect(member.has_account).toBe(true);
  });

  it('passes the group\'s overrides/effective through unchanged when present', () => {
    const member = toMember(GROUP, { id: 'p1', display_name: 'Ada Lovelace' });
    expect(member.overrides).toEqual(GROUP.overrides);
    expect(member.effective).toEqual(GROUP.effective);
  });

  it('falls back to inherit-everything overrides and group defaults when null', () => {
    const bare = { ...GROUP, overrides: null, effective: null };
    const member = toMember(bare, { id: 'p1', display_name: 'Ada Lovelace' });
    expect(member.overrides).toEqual(NO_OVERRIDES);
    expect(member.effective.channels).toEqual(GROUP.channels);
    expect(member.effective.timezone).toBe(GROUP.timezone);
  });
});
