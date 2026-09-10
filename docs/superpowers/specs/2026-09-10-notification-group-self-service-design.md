# Notification groups — self-service on /me/notifications with admin approval

**Date:** 2026-09-10 · **Status:** approved in conversation (scope answer:
join/leave need approval, overrides apply immediately) · **Branch:** `notif-groups`

## Purpose

Notification groups (channels, quiet hours, active days, DND behaviour) are
managed only by admins on `/system/notifications`. People have no view of
which groups notify them and no way to tune or change that. Jimmy wants
`/me/notifications` to show a person's groups, let them edit their own
per-group overrides, leave a group, and search-and-join groups — where
joining or leaving is a **request** an admin (anyone with
`notifications:change`) approves or rejects from the inbox popover.

## Data (migration 0051)

`notification_membership_requests`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| group_id | uuid → notification_groups ON DELETE CASCADE, NOT NULL | |
| person_id | uuid → people, NOT NULL | the requester |
| action | text NOT NULL | `join` \| `leave` |
| status | text NOT NULL default `pending` | `pending` \| `approved` \| `rejected` \| `cancelled` |
| note | text NOT NULL default `''` | requester's reason |
| decided_by | uuid → people, nullable | |
| decided_at | timestamptz, nullable | |
| decision_note | text NOT NULL default `''` | |
| created_at | timestamptz default now() | |

Partial unique index `ux_membership_request_pending (group_id, person_id)
WHERE status = 'pending'` — one open request per person and group. Index on
`(status, created_at)`. Model `NotificationMembershipRequest` after
`NotificationGroupMember`. No change to groups or members.

## API

### Self-service — `/auth/me/notification-groups` (any signed-in user)

- `GET /auth/me/notification-groups?q=` → `MyNotificationGroupOut[]`: every
  `enabled` group (name asc; `q` filters name/description, case-insensitive
  substring) with `id, name, description, channels, quiet_start, quiet_end,
  timezone, active_days, dnd_behavior, urgent_bypass, member_count,
  is_member, overrides (NotificationMemberOverrides | null), effective
  (NotificationEffectiveSettings | null), pending_request
  ({id, action, note, created_at} | null)`. Effective/overrides computed with
  the existing `effective_settings` / `_member_out` helpers.
- `PATCH /auth/me/notification-groups/{group_id}/overrides` body
  `NotificationMemberOverrides` → `MyNotificationGroupOut`. 404
  `not_a_member` when the caller isn't a member. Same validation as the
  admin `patch_member` (extract that validation into a shared function
  `apply_member_overrides(member, body)` in `routes/notifications.py` and
  call it from both). Audit `entity_type="notification_group"`, action
  `member.self_override`.
- `POST /auth/me/notification-groups/{group_id}/requests` body
  `{action: "join"|"leave", note?: str}` → 201 `MembershipRequestOut`.
  Rules: group must be enabled (404 `group_not_found`); `join` requires not
  a member (409 `already_member`); `leave` requires membership (409
  `not_a_member`); an existing pending request → 409 `request_pending`.
  On create: `notify()` every **approver** with kind `membership_request`,
  title `"{Display Name} asks to {join|leave} {Group}"`, body = note,
  link `/system/notifications`, payload `{request_id, group_id, group_name,
  person_id, person_name, action, state: "pending"}`. Approvers = distinct
  people with a non-revoked `PersonRole` whose role has
  `RolePermission(resource='notifications', action='change')`, excluding
  the requester, who have a `UserAccount`.
- `DELETE /auth/me/notification-groups/requests/{request_id}` → 204;
  cancels the caller's own pending request (404 otherwise). Approvers'
  copies of the `membership_request` notification get
  `payload.state = "cancelled"` (see "resolving copies").

### Approval — `/notifications/requests` (gated `notifications:change`)

- `GET /notifications/requests?status=pending` → `MembershipRequestOut[]`
  (`id, group_id, group_name, person_id, person_name, action, status, note,
  decided_by_name, decided_at, decision_note, created_at`), newest first.
- `POST /notifications/requests/{id}/approve` and `/reject` body
  `{note?: str}` → `MembershipRequestOut`. 404 unknown; 409 `already_decided`
  when status ≠ pending. Approve: `join` inserts the membership (no-op if
  already a member since — still approved), `leave` deletes it. Both:
  set status/decided_by/decided_at/decision_note; audit `request.approve` /
  `request.reject` on `entity_type="notification_group"`; notify the
  requester kind `membership_decided`, title
  `"Your request to {join|leave} {Group} was {approved|rejected}"`, body =
  decision note, link `/me/notifications`, payload `{request_id, group_id,
  action, status}`; resolve approvers' copies.
- **Resolving copies**: `UPDATE notifications SET payload = payload ||
  '{"state": "<approved|rejected|cancelled>", "decided_by": "<name>"}'
  WHERE kind='membership_request' AND payload->>'request_id' = :id`. The
  popover renders buttons only while `payload.state == "pending"`.

Errors follow the `{code}` convention; `MembershipRequestOut` is shared by
both routers (schemas.py).

## Portal

- `lib/api.ts`: `MyNotificationGroup`, `MembershipRequest`,
  `listMyNotificationGroups(q?)`, `updateMyGroupOverrides(groupId, body)`,
  `requestGroupMembership(groupId, action, note?)`,
  `cancelMembershipRequest(id)`, `listMembershipRequests(status)`,
  `approveMembershipRequest(id, note?)`, `rejectMembershipRequest(id, note?)`.
- `pages/me/MeNotifications.tsx` gains, below the preferences section:
  - **My groups** (`set-section`): a `mini-list` (head Group / Channels /
    Quiet hours / Days) of groups where `is_member`; each row: name +
    description (`.pn b` / `cell-sub`), channel chips, quiet hours "22:00–07:00
    (America/New_York)" or "None", days summary ("Mon–Fri" / "Every day" /
    list), a `chip tag` "Customised" when any override is non-null, and
    actions **Edit overrides** (opens `OverrideEditorModal` — it takes
    `group: NotificationGroupDetail, member: NotificationMember`; add a
    thin adapter that builds those from `MyNotificationGroup` + the
    signed-in person, and an `onSave` hook prop so the modal calls the
    self-service endpoint instead of the admin one) and **Leave** → opens a
    small `.pf-form` modal with an optional note → `requestGroupMembership(…,
    'leave')`; while a leave request is pending the row shows a `chip`
    "Leave requested" + Cancel. Empty: "You're not in any notification
    groups yet."
  - **Join a group** (`set-section`): `.dir-search` box filtering the
    non-member enabled groups client-side; each row shows name/description,
    channels, member count, and **Join** (note modal → request) or "Join
    requested" + Cancel when pending. Empty: "No other groups to join."
  - Refetch after every action; errors mapped via `GROUP_ERRORS`
    (`already_member` "You're already in that group.", `not_a_member`
    "You're not in that group.", `request_pending` "There's already a
    request waiting for this group.", `group_not_found` "That group no
    longer exists.", `forbidden` "You can't change that.").
- `components/NotificationsPanel.tsx`: rows with `kind ===
  'membership_request'` render, under the body, an inline action strip:
  when `payload.state === 'pending'` → **Approve** / **Reject** `mini-btn`s
  (Reject opens a one-line note prompt via the existing modal idiom; both
  call the API then `refresh()`); otherwise a muted line "Approved by
  {decided_by}" / "Rejected by …" / "Cancelled". Clicking the row still
  navigates to the link. `KindIcon` gets `membership_request` and
  `membership_decided` icons.
- `pages/Notifications.tsx` (admin): a **Pending requests** panel above the
  groups list (hidden when empty): DataTable columns Person / Wants to /
  Group / Note / Requested / Actions (Approve, Reject) — same API calls.
- `lib/notificationGroups.ts`: `quietHoursText`, `daysText`, `hasOverrides`,
  `GROUP_ERRORS`, `toGroupDetail(g, me)` / `toMember(g, me)` adapters.

## Testing

- API `tests/test_notification_self_service.py`: list shape (member vs
  non-member, q filter, disabled group hidden); overrides PATCH applies +
  validates + 404 for non-member; join/leave requests: rules (already
  member, not a member, pending duplicate), approver fan-out (an admin with
  an account gets the notification with the payload; the requester and a
  worker do not), cancel resolves copies; approve join adds membership +
  notifies requester + resolves copies; reject leave keeps membership;
  second decision → 409; worker calling `/notifications/requests` → 403.
- Portal: `MeNotifications.test.tsx` (groups render with chips/quiet text,
  Leave → request posted + "Leave requested", Join search + request,
  Cancel); `NotificationsPanel.test.tsx` (pending request row shows
  Approve/Reject, approve calls API and refreshes, decided row shows
  outcome); `Notifications.test.tsx` (pending panel renders and approves);
  `lib/notificationGroups.test.ts` (text helpers). Typography guardrail
  green, no new allowlist entries.
- Live: request as the dev user, approve from the popover as the same
  admin user (self-approval is allowed for admins — noted), see membership
  appear on `/me/notifications`; leave flow; sound plays on the approver.

## Out of scope

Request expiry, admin-initiated invites, per-group self-join flags, email
delivery of requests, bulk approval.
