/**
 * notificationGroups — error copy and the override check for the
 * self-service "My groups" / "Join a group" sections on /me/notifications
 * (pages/me/MeNotifications.tsx). Groups only list their members now: they
 * no longer decide what a person gets, so /me has nothing per group to edit.
 */

import type { NotificationMemberOverrides } from './api';

/** True when any override field is non-null — the member has customized
 *  at least one setting away from the group default. */
export function hasOverrides(ov: NotificationMemberOverrides | null): boolean {
  if (!ov) return false;
  return Object.values(ov).some((v) => v !== null);
}

/** Copy for the self-service error codes (design spec, verbatim). */
export const GROUP_ERRORS: Record<string, string> = {
  already_member: "You're already in that group.",
  not_a_member: "You're not in that group.",
  request_pending: "There's already a request waiting for this group.",
  group_not_found: 'That group no longer exists.',
  forbidden: "You can't change that.",
};
