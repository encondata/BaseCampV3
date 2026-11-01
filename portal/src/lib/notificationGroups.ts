/**
 * notificationGroups — error copy, the override check, and the adapters for
 * the self-service "My groups" / "Join a group" sections on
 * /me/notifications (pages/me/MeNotifications.tsx). Quiet hours and days on
 * those lists read through lib/notifications.ts's formatQuietHours /
 * formatDays, the same as every other notification list.
 */

import type {
  MyNotificationGroup, NotificationEffectiveSettings, NotificationGroupDetail,
  NotificationMember, NotificationMemberOverrides,
} from './api';

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

const EMPTY_OVERRIDES: NotificationMemberOverrides = {
  channels: null, quiet_mode: null, quiet_start: null, quiet_end: null,
  timezone: null, active_days: null, dnd_behavior: null, urgent_bypass: null,
};

/** Adapts a MyNotificationGroup row into the NotificationGroupDetail shape
 *  OverrideEditorModal expects (it was built for the admin group-detail
 *  page). Only the fields the modal actually reads are populated —
 *  `members` stays empty since the modal is handed the member directly
 *  and never looks at the group's member list in the self-service flow. */
export function toGroupDetail(g: MyNotificationGroup): NotificationGroupDetail {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    channels: g.channels,
    categories: g.categories,
    quiet_start: g.quiet_start,
    quiet_end: g.quiet_end,
    timezone: g.timezone,
    active_days: g.active_days,
    dnd_behavior: g.dnd_behavior,
    urgent_bypass: g.urgent_bypass,
    enabled: true,
    member_count: g.member_count,
    created_at: '',
    members: [],
  };
}

/** Adapts a MyNotificationGroup + the signed-in person into the
 *  NotificationMember shape OverrideEditorModal expects. can_text comes
 *  from the phone on the person's own profile; can_email, can_push and
 *  can_web are always true because reaching /me/notifications requires a
 *  signed-in account (which always has a sign-in email). */
export function toMember(
  g: MyNotificationGroup,
  person: {
    id: string;
    display_name: string;
    email?: string | null;
    phone?: string | null;
    avatar_url?: string | null;
  },
): NotificationMember {
  const effective: NotificationEffectiveSettings = g.effective ?? {
    channels: g.channels,
    quiet_start: g.quiet_start,
    quiet_end: g.quiet_end,
    timezone: g.timezone,
    active_days: g.active_days,
    dnd_behavior: g.dnd_behavior,
    urgent_bypass: g.urgent_bypass,
  };
  return {
    person_id: person.id,
    display_name: person.display_name,
    job_title: null,
    avatar_url: person.avatar_url ?? null,
    email: person.email ?? null,
    phone: person.phone ?? null,
    has_account: true,
    can_email: true, // the sender falls back to the sign-in email, and every account has one
    can_text: !!person.phone,
    can_push: true,
    can_web: true,
    overrides: g.overrides ?? EMPTY_OVERRIDES,
    effective,
    added_at: '',
  };
}
