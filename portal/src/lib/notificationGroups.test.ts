import { describe, expect, it } from 'vitest';

import * as groups from './notificationGroups';
import { GROUP_ERRORS } from './notificationGroups';

describe('GROUP_ERRORS', () => {
  it('carries the spec copy for every self-service error code', () => {
    expect(GROUP_ERRORS.already_member).toBe("You're already in that group.");
    expect(GROUP_ERRORS.not_a_member).toBe("You're not in that group.");
    expect(GROUP_ERRORS.request_pending).toBe("There's already a request waiting for this group.");
    expect(GROUP_ERRORS.group_not_found).toBe('That group no longer exists.');
    expect(GROUP_ERRORS.forbidden).toBe("You can't change that.");
  });
});

describe('what a group no longer has', () => {
  it('is only the error copy: a member sets nothing per group, so there is no editor, adapter or override check', () => {
    expect(Object.keys(groups)).toEqual(['GROUP_ERRORS']);
  });
});
