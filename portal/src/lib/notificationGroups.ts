/**
 * notificationGroups — error copy for notification group membership: the
 * self-service requests on /me/notifications ("My groups" / "Join a group")
 * and the approvals of them (the Notifications page, the inbox). Groups only
 * list their members now: they no longer decide what a person gets, so a
 * member has no per-group settings to check or edit.
 */

/** Copy for the self-service error codes (design spec, verbatim). */
export const GROUP_ERRORS: Record<string, string> = {
  already_member: "You're already in that group.",
  not_a_member: "You're not in that group.",
  request_pending: "There's already a request waiting for this group.",
  group_not_found: 'That group no longer exists.',
  forbidden: "You can't change that.",
};
