import { describe, expect, it } from 'vitest';

import type { NotificationMemberOverrides } from './api';
import * as groups from './notificationGroups';
import { GROUP_ERRORS, hasOverrides } from './notificationGroups';

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

describe('the override editor adapters', () => {
  it('are gone: a member sets nothing per group, so /me hands no group to an editor', () => {
    expect('toGroupDetail' in groups).toBe(false);
    expect('toMember' in groups).toBe(false);
  });
});
