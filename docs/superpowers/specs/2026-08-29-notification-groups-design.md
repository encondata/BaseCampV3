# Notification Groups — Design

Date: 2026-08-29
Status: Approved (Jimmy, 2026-08-29)
Scope: DB schema + admin web UI only. The sending backend (worker, providers, queue) is a later feature.

## Goal

Replace the `/system/notifications` placeholder with a real admin surface for managing
notification groups: who gets notified, over which channels, and when. Groups carry
delivery defaults; individual members can override any of them. Full CRUD for admins.

## Non-goals

- No sending, no dispatch worker, no queue, no provider integrations (SMTP/Twilio/web-push).
- No per-event-type subscriptions (which events route to which groups comes with the sender).
- No changes to the existing per-user `ui_prefs.notif` toggles in Settings — they stay as-is
  until the sender lands and the two systems are reconciled.

## Data model — migration `0033_notification_groups.py`

Schema of record is the migration; `db/models.py` mirrors it. Downgrade must be clean.

### `notification_groups`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `name` | CITEXT | unique, required |
| `description` | text | not null, default `''` |
| `channels` | text[] | not null, default `{email,web}`; CHECK subset of `{email,text,push,web}` |
| `quiet_start` | time | nullable |
| `quiet_end` | time | nullable; CHECK both-or-neither with `quiet_start` (NULL pair = no quiet hours) |
| `timezone` | text | not null, default `America/Chicago`; IANA name validated in code via `zoneinfo` |
| `active_days` | text[] | not null, default `{mon,tue,wed,thu,fri,sat,sun}`; CHECK subset; code enforces non-empty |
| `dnd_behavior` | text | not null, default `defer`; CHECK `defer\|skip` — what happens when quiet hours block a send |
| `urgent_bypass` | boolean | not null, default true — urgent notifications ignore quiet hours |
| `enabled` | boolean | not null, default true — pause a group without deleting it |
| `created_by` | uuid FK people | `ON DELETE SET NULL` |
| `created_at` / `updated_at` | timestamptz | not null, `now()` |

### `notification_group_members`

Composite PK `(group_id, person_id)`. `group_id` FK `notification_groups ON DELETE CASCADE`,
`person_id` FK `people ON DELETE CASCADE`. `added_by` uuid FK people SET NULL, `added_at` timestamptz.

Every group setting reappears **nullable — NULL means inherit the group default**:

| Column | Override semantics |
|---|---|
| `channels` text[] | NULL = inherit; **empty array = explicitly muted**; CHECK subset of the four channels |
| `quiet_mode` text | NULL = inherit; `'none'` = no quiet hours for this member; `'custom'` = use member times. CHECK `none\|custom`; CHECK `custom` ⇒ `quiet_start`/`quiet_end` both set |
| `quiet_start` / `quiet_end` time | only meaningful when `quiet_mode = 'custom'` |
| `timezone` text | NULL = inherit |
| `active_days` text[] | NULL = inherit; code enforces non-empty when set |
| `dnd_behavior` text | NULL = inherit; CHECK `defer\|skip` |
| `urgent_bypass` boolean | NULL = inherit |

The tri-state `quiet_mode` exists because a plain NULL cannot distinguish "inherit the
group's quiet hours" from "clear them for me".

**Effective settings** = member value if set, else group value — computed server-side and
returned on every member payload so the UI never re-implements the merge.

## Channel eligibility

Capability is a property of the person, computed server-side:

- `can_email` — `people.email` is not null
- `can_text` — `people.phone` is not null
- `can_push` / `can_web` — the person has a `UserAccount` row

Rules:

- The add-member picker shows each candidate's reachable channels.
- The per-member override editor only offers channels the person can receive; the API
  rejects an override containing an unavailable channel (`channel_unavailable`).
- Group-level channels are aspirational: a group may default to `email` even if a member
  lacks an address. That member's row shows an "unreachable" warning chip; membership is
  never blocked. The future sender skips unavailable channels per person.

## Permissions

New code-side resource in `access/resources.py`:
`Resource("notifications", "Notifications", routes=("/system/notifications",))`.

Default grants (`access/defaults.py` + seeding in migration 0033): full
view/add/change/delete for ranks ≥ 60 (Admin, Super admin, Top). No grants below Admin —
this is an admin-only surface. Mirror the route→resource mapping in
`portal/src/lib/access.ts` (`ROUTE_RESOURCE`) and switch the `App.tsx` route gate from
`settings` to `notifications` (nav item in `navSections.tsx` likewise).

## API — `api/src/serversherpa/api/routes/notifications.py`

Prefix `/notifications`, registered in `app.py`. Guards via `require_permission("notifications", …)`.
Every mutation writes an audit row (`services/audit.py`, entity_type `notification_group`).
Stable error codes; portal maps them to copy.

| Endpoint | Guard | Notes |
|---|---|---|
| `GET /notifications/groups` | view | all groups + member counts |
| `POST /notifications/groups` | add | name/description (+ optional settings); 409 `group_exists` |
| `GET /notifications/groups/{id}` | view | group + members with per-member: person summary, capability flags, raw overrides, effective settings; 404 `group_not_found` |
| `PATCH /notifications/groups/{id}` | change | any group field incl. `enabled`; 409 `group_exists` on rename collision |
| `DELETE /notifications/groups/{id}` | delete | hard delete (members cascade) |
| `POST /notifications/groups/{id}/members` | change | `{person_id}`; 409 `member_exists`, 404 `person_not_found` |
| `PATCH /notifications/groups/{id}/members/{person_id}` | change | override fields; 404 `member_not_found`; 422/`channel_unavailable` for unreachable channels; `invalid_timezone`, `invalid_quiet_hours` as needed |
| `DELETE /notifications/groups/{id}/members/{person_id}` | change | 404 `member_not_found` |
| `GET /notifications/recipients` | change | person picker: all non-archived people with `person_id, display_name, job_title, avatar_url, email, phone, has_account` + the four capability flags. Gated on `notifications:change` so notification admins don't need `users:view` |

## UI

### `/system/notifications` — `pages/Notifications.tsx`

Standard directory pattern (model: `AssetModels.tsx`): `.dir-head` with badge count,
toolbar with client-side search, facet filters, per-column menus, CSV export,
`usePersistentListState('notification_groups', …)`, `VirtualRows`.

Columns: Name, Description, Members (count), Channels (chips), Quiet hours
(formatted e.g. "9:00 PM – 7:00 AM CT", "—" when none), Days (e.g. "Mon–Fri", "Daily"),
Status (Enabled / Paused chip), Created.

Row click navigates to the detail page (no inline expansion — this surface has a full page).
`+ New group` opens the standard modal (name + description only), then navigates to the new
group's detail page to configure the rest. Empty state follows house `.dir-empty` shape.

### `/system/notifications/:groupId` — `pages/NotificationGroupDetail.tsx`

Full detail page in the house-benchmark style:

- **Hero**: name, description, Enabled/Paused state with toggle, summary chips (channels,
  member count), edit-group modal trigger, two-click inline delete (navigates back to list).
- **Delivery defaults panel**: read view of the group's settings (channels, quiet hours,
  timezone, days, DND behavior, urgent bypass) with an Edit button opening a modal. The
  modal form is a 2-column label-above-control grid per the binding form rules: channel
  toggles rendered as an aligned labeled-switch group (never floating checkboxes), quiet
  hours (start / end / timezone selects), active-days selector, DND behavior select
  (Defer / Skip), urgent-bypass switch. Section headings visually distinct from field labels.
- **Members panel**: real aligned table — Person (avatar, name, job title), Contact
  (email / phone, with "unreachable" warning chips for channels the group uses but the
  person lacks), Effective channels (chips + an override marker when personalized),
  Effective quiet hours / days, Actions (Edit overrides, Remove with two-click confirm).
  Add-member `ComboBox` fed by `GET /notifications/recipients`, each option showing the
  candidate's reachable channels.
- **Override editor modal** (per member): every setting rendered as an explicit
  "Group default (shown value)" vs "Custom" choice so inheritance is legible. Channel
  choices limited to that person's capabilities. Muting = custom channels with none selected,
  surfaced clearly ("This member will receive nothing from this group").

### Plumbing

`App.tsx` routes (list + detail) gated on `notifications`; Topbar `CRUMBS` + `PAGES`;
`lib/api.ts` typed client functions + TS mirrors of the schemas; error-code→copy maps
per page. Nav entry already exists — only its `resource` changes.

## Testing

- API — `api/tests/test_notification_groups_api.py` (model: `test_access_groups_api.py`):
  group CRUD, unique-name 409, 403 for sub-admin ranks, member add/remove, override
  validation (custom quiet mode requires both times, channels ⊆ capability, timezone,
  empty-channels mute allowed), effective-settings coalesce correctness, recipients
  capability flags, audit rows written.
- Portal — co-located Vitest: list page renders/filters/navigates; detail page renders
  panels, override editor offers only reachable channels, override markers shown.
- UI verified visually in the browser (screenshots) before completion — passing tests are
  not the UI bar.

## Error handling

House pattern throughout: API raises `HTTPException(status, detail={"code": …})`; portal
`ERRORS` maps + `msgFor`; inline `.pf-error` spans; busy state via `disabled` + label swap;
destructive actions use two-click inline confirm.
