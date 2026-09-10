/**
 * notificationGroups — pure display helpers, error copy, and adapters for
 * the self-service "My groups" / "Join a group" sections on
 * /me/notifications (pages/me/MeNotifications.tsx). Kept separate from
 * lib/notifications.ts, whose formatQuietHours/formatDays are tuned for
 * the admin group-detail page's 12-hour/abbreviated-timezone display —
 * these read the raw "HH:MM:SS" strings straight, per the self-service
 * spec's copy.
 */

import type {
  MyNotificationGroup, NotificationEffectiveSettings, NotificationGroupDetail,
  NotificationMember, NotificationMemberOverrides,
} from './api';

const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DAY_LABELS: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/** "22:00:00" -> "22:00". */
function hm(hms: string): string {
  return hms.slice(0, 5);
}

/** "22:00:00", "07:00:00", "America/New_York" -> "22:00–07:00
 *  (America/New_York)". Either quiet time null (both should be — quiet
 *  hours are both-or-neither) -> "None". */
export function quietHoursText(g: {
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
}): string {
  if (g.quiet_start === null || g.quiet_end === null) return 'None';
  return `${hm(g.quiet_start)}–${hm(g.quiet_end)} (${g.timezone})`;
}

/** All 7 days -> "Every day"; exactly Mon-Fri -> "Mon–Fri"; else a
 *  comma-separated list in week order, e.g. "Mon, Wed, Fri". Empty ->
 *  "None". */
export function daysText(days: string[]): string {
  if (days.length === 0) return 'None';
  const set = new Set(days);
  if (WEEK_ORDER.every((d) => set.has(d))) return 'Every day';
  if (set.size === WEEKDAYS.length && WEEKDAYS.every((d) => set.has(d))) return 'Mon–Fri';
  return WEEK_ORDER.filter((d) => set.has(d)).map((d) => DAY_LABELS[d]).join(', ');
}

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
 *  NotificationMember shape OverrideEditorModal expects. Capability flags
 *  come straight from what's on the person's own profile — can_push/
 *  can_web are always true because reaching /me/notifications requires a
 *  signed-in account. */
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
    can_email: !!person.email,
    can_text: !!person.phone,
    can_push: true,
    can_web: true,
    overrides: g.overrides ?? EMPTY_OVERRIDES,
    effective,
    added_at: '',
  };
}
