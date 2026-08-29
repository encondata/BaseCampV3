# Notification Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Replace the `/system/notifications` placeholder with a real admin surface: notification groups carrying delivery defaults (channels, quiet hours, days, timezone, DND behavior, urgent bypass), members from People with per-member overrides, full CRUD gated on a new `notifications` permission resource. DB + web only — no sending.

**Architecture:** Two new tables (migration 0033) mirroring the `access_groups` pattern; membership rows repeat every group setting as nullable columns where NULL = inherit. New `/notifications` router with groups CRUD, member management, and an admin person-picker endpoint that computes channel capability (email needs `people.email`, text needs `people.phone`, push/web need a `UserAccount`). Effective settings (member-coalesced-with-group) are computed server-side and returned on every member payload. Portal: standard directory list page + a full group-detail page (house-benchmark style).

**Tech Stack:** existing only — FastAPI/SQLAlchemy/Alembic, React/Vite/TS. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-notification-groups-design.md` (approved). Read it before implementing — it is the authority on semantics.

## Global Constraints

- Channels are exactly `("email", "text", "push", "web")`; days are exactly `("mon","tue","wed","thu","fri","sat","sun")`. Both enforced by DB CHECK (array containment) AND Pydantic validation.
- NULL on a member column = inherit the group value. Member `channels = []` (empty array) is VALID and means explicitly muted. Member quiet hours use tri-state `quiet_mode`: NULL = inherit, `'none'` = no quiet hours, `'custom'` = use the member's `quiet_start`/`quiet_end` (both required then).
- Group quiet hours: `quiet_start`/`quiet_end` both-or-neither (CHECK). `quiet_start == quiet_end` is rejected in code → 422 `invalid_quiet_hours`. Overnight windows (start > end) are allowed.
- Timezone: IANA name validated with `zoneinfo.ZoneInfo` → 422 `invalid_timezone`. `active_days` must be non-empty when set → 422 `invalid_days`.
- Member channel overrides may only contain channels the person can receive → 422 `channel_unavailable`. Group-level channels are NOT capability-checked (aspirational; per-member warnings in UI).
- Error responses always `HTTPException(status, detail={"code": "<snake_code>"})`. Every mutation calls `audit(db, actor_id=..., entity_type="notification_group", entity_id=str(group_id), action=..., changes=...)` BEFORE `await db.commit()` (`services/audit.py:48` — audit never commits itself).
- New permission resource `notifications`: FULL (view/add/change/delete) for developer, founder, super_admin, admin. Nothing below admin. No rank checks on membership — notification groups grant no access.
- Tests FOREGROUND, one continuous run, explicit timeout 600000ms — NEVER background a suite. API: `cd api && .venv/bin/pytest` (~5 min, real Postgres via docker compose). Portal: `cd portal && npm test` then `npx tsc -b` (or `--noEmit`) and `npm run build` when the task says so.
- Before any commit: `git checkout -- api/src/serversherpa/_dev_reload.py` if dirty (dev-server churn file — never commit it).
- Commit messages end with blank line + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- UI: binding form rules — every control label-above-control in a consistent 2-column grid (textareas full-width), NEVER a raw floating checkbox (booleans = aligned labeled switch rows), section headings visually distinct from field labels. Tabular data = real aligned tables with `—` for empty cells, never joined strings.

---

### Task 1: API — migration 0033, models, permission resource, groups CRUD

**Files:**
- Create: `api/migrations/versions/0033_notification_groups.py` (down_revision `"0032"`)
- Modify: `api/src/serversherpa/db/models.py` (append `NotificationGroup`, `NotificationGroupMember` near `AccessGroup` ~line 280)
- Modify: `api/src/serversherpa/access/resources.py` (add to `_RESOURCES`: `Resource("notifications", "Notifications", routes=("/system/notifications",))` — default `visible_to` global-only is correct)
- Modify: `api/src/serversherpa/access/defaults.py` (append `"notifications"` to `_ALL`; add `"notifications": FULL` to the `admin` dict; staff and below get nothing)
- Create: `api/src/serversherpa/api/routes/notifications.py`
- Modify: `api/src/serversherpa/api/app.py` (`include_router` alongside the others)
- Modify: `api/src/serversherpa/api/schemas.py` (schemas below)
- Test: `api/tests/test_notification_groups_api.py`

**Interfaces (produces):**
- Table `notification_groups`: `id uuid pk default gen_random_uuid()`, `name citext NOT NULL UNIQUE`, `description text NOT NULL default ''`, `channels text[] NOT NULL default '{email,web}'`, `quiet_start time NULL`, `quiet_end time NULL`, `timezone text NOT NULL default 'America/Chicago'`, `active_days text[] NOT NULL default '{mon,tue,wed,thu,fri,sat,sun}'`, `dnd_behavior text NOT NULL default 'defer'`, `urgent_bypass boolean NOT NULL default true`, `enabled boolean NOT NULL default true`, `created_by uuid NULL FK people ON DELETE SET NULL`, `created_at`/`updated_at timestamptz NOT NULL default now()`. CHECKs: `channels <@ ARRAY['email','text','push','web']::text[]`, `active_days <@ ARRAY[...7 days...]::text[]`, `dnd_behavior IN ('defer','skip')`, `(quiet_start IS NULL) = (quiet_end IS NULL)`.
- Table `notification_group_members`: composite pk `(group_id, person_id)`; `group_id uuid FK notification_groups ON DELETE CASCADE`, `person_id uuid FK people ON DELETE CASCADE`, `added_by uuid NULL FK people ON DELETE SET NULL`, `added_at timestamptz NOT NULL default now()`, then nullable overrides: `channels text[] NULL`, `quiet_mode text NULL CHECK IN ('none','custom')`, `quiet_start time NULL`, `quiet_end time NULL`, `timezone text NULL`, `active_days text[] NULL`, `dnd_behavior text NULL CHECK IN ('defer','skip')`, `urgent_bypass boolean NULL`. CHECKs: channel/day containment (allow NULL), `quiet_mode = 'custom'` ⇒ both times NOT NULL (`CHECK (quiet_mode IS DISTINCT FROM 'custom' OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL))`).
- Migration also seeds `role_permissions`: `INSERT ... ON CONFLICT DO NOTHING` for the four admin+ roles × four actions on `notifications` (mirror the style migration 0009 uses / `defaults.py::seed_default_grants`). Downgrade: `DELETE FROM role_permissions WHERE resource='notifications'`, drop both tables.
- Module constants in `routes/notifications.py`: `CHANNELS: tuple = ("email","text","push","web")`, `DAYS: tuple = ("mon","tue","wed","thu","fri","sat","sun")` (the future sender imports from here).
- Schemas (`schemas.py`):
  ```python
  class NotificationGroupSettings(BaseModel):   # shared shape, all optional for PATCH reuse
      channels: list[str] | None = None
      quiet_start: time | None = None
      quiet_end: time | None = None
      timezone: str | None = None
      active_days: list[str] | None = None
      dnd_behavior: str | None = None           # 'defer' | 'skip'
      urgent_bypass: bool | None = None
  class NotificationGroupCreateIn(BaseModel):   # name required; settings optional
      name: str; description: str = ""          # + the settings fields, all optional
  class NotificationGroupPatchIn(BaseModel):    # everything optional incl. name/description/enabled
  class NotificationGroupOut(BaseModel):        # list item
      id: UUID; name: str; description: str; channels: list[str]
      quiet_start: time | None; quiet_end: time | None; timezone: str
      active_days: list[str]; dnd_behavior: str; urgent_bypass: bool
      enabled: bool; member_count: int; created_at: datetime
  ```
- Endpoints (router `APIRouter(prefix="/notifications", tags=["notifications"])`; copy guard/audit/error style from `routes/access.py:316-383`):
  | Method + path | Gate | Behavior |
  |---|---|---|
  | `GET /notifications/groups` | notifications:view | `list[NotificationGroupOut]` ordered by name; `member_count` via `func.count` outerjoin-group_by (single query, no N+1) |
  | `POST /notifications/groups` | notifications:add | 201; 409 `group_exists` on duplicate name; validate settings; audit `group.create` |
  | `PATCH /notifications/groups/{id}` | notifications:change | partial update incl. `enabled`; 404 `group_not_found`; 409 `group_exists` on rename collision; `updated_at=func.now()`; audit `group.update` with `diff` of changed fields (`services/audit.py::snapshot`/`diff`) |
  | `DELETE /notifications/groups/{id}` | notifications:delete | 204; members cascade; audit `group.delete` |
- Shared validator used by create/patch (and Task 2 member patch): `def validate_settings(body) -> None` raising the 422 codes in Global Constraints (channels subset, days subset+non-empty, `ZoneInfo` timezone, quiet both-or-neither + not-equal).

**Steps:**
- [ ] Write failing tests first (model on `tests/test_access_groups_api.py`, auth via `from tests.test_access_roles_api import login_admin`): create → 201 + defaults echoed; duplicate name → 409 `group_exists`; list shows `member_count` 0; patch settings (quiet hours, days, dnd_behavior, enabled=False) round-trips; patch bad channel → 422 `invalid` code; bad timezone → 422 `invalid_timezone`; `quiet_start` without `quiet_end` → 422 `invalid_quiet_hours`; equal times → 422; delete → 204 then get-list omits it; staff login (do NOT upgrade to admin — copy the pattern but leave role `staff`) → 403 on POST; audit rows exist (`select(AuditLog).where(entity_type="notification_group")`).
- [ ] Run the new test file foreground: `cd api && .venv/bin/pytest tests/test_notification_groups_api.py -v` — expect failures (tables/routes missing).
- [ ] Implement: migration (copy column style from `0029_db_backups.py`, group-tables style from 0009), models, resources/defaults, schemas, router, app registration. `cd api && .venv/bin/alembic upgrade head` against the dev DB.
- [ ] Focused tests pass → FULL api suite foreground (timeout 600000ms) → commit `feat(api): notification groups — schema, permission resource, groups CRUD`.

---

### Task 2: API — members, overrides, recipients, effective settings

**Files:**
- Modify: `api/src/serversherpa/api/routes/notifications.py`
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_notification_groups_api.py` (extend)

**Interfaces (produces):**
- Capability rule (one helper, reused by recipients + member payloads + override validation):
  ```python
  def capabilities(person: Person, has_account: bool) -> dict[str, bool]:
      return {"can_email": person.email is not None,
              "can_text": person.phone is not None,
              "can_push": has_account, "can_web": has_account}
  ```
- Effective merge (server is the single implementation of inheritance):
  ```python
  def effective_settings(group, member) -> dict:
      # channels/timezone/active_days/dnd_behavior/urgent_bypass: member value if not None else group's
      # quiet hours: member.quiet_mode None -> group's quiet_start/end;
      #              'none' -> (None, None); 'custom' -> member's times
      # returns the same keys as NotificationGroupSettings, all resolved
  ```
- Schemas:
  ```python
  class NotificationMemberOut(BaseModel):
      person_id: UUID; display_name: str; job_title: str | None
      avatar_url: str | None; email: str | None; phone: str | None
      has_account: bool
      can_email: bool; can_text: bool; can_push: bool; can_web: bool
      overrides: NotificationMemberOverrides    # raw member columns, nulls preserved
      effective: NotificationEffectiveSettings  # resolved; quiet_start/end nullable
      added_at: datetime
  class NotificationMemberOverrides(BaseModel):
      channels: list[str] | None; quiet_mode: str | None
      quiet_start: time | None; quiet_end: time | None
      timezone: str | None; active_days: list[str] | None
      dnd_behavior: str | None; urgent_bypass: bool | None
  class NotificationEffectiveSettings(BaseModel):  # fully resolved, no Nones except quiet times
      channels: list[str]; quiet_start: time | None; quiet_end: time | None
      timezone: str; active_days: list[str]; dnd_behavior: str; urgent_bypass: bool
  class NotificationGroupDetailOut(NotificationGroupOut):
      members: list[NotificationMemberOut]
  class NotificationRecipientOut(BaseModel):
      person_id: UUID; display_name: str; job_title: str | None
      avatar_url: str | None; email: str | None; phone: str | None
      has_account: bool; can_email: bool; can_text: bool; can_push: bool; can_web: bool
  ```
- Endpoints:
  | Method + path | Gate | Behavior |
  |---|---|---|
  | `GET /notifications/groups/{id}` | notifications:view | `NotificationGroupDetailOut`, members ordered by last/first name; 404 `group_not_found`. Avatar via `presign_get(person.avatar_key)` (see `stakeholders.py:610-635` for the outerjoin-UserAccount pattern) |
  | `POST /notifications/groups/{id}/members` | notifications:change | body `{person_id: UUID}`; 404 `group_not_found` / `person_not_found` (missing OR archived person); 409 `member_exists`; audit `member.add` changes `{"person_id": ...}`; returns the new `NotificationMemberOut` |
  | `PATCH /notifications/groups/{id}/members/{person_id}` | notifications:change | body = `NotificationMemberOverrides`, ALL fields optional; a field present-and-null clears the override back to inherit (use Pydantic `model_fields_set` to distinguish absent from null); 404 `member_not_found`; validate via `validate_settings` semantics + `quiet_mode='custom'` requires both times (`invalid_quiet_hours`) + channels ⊆ person capabilities → 422 `channel_unavailable` (empty list allowed = muted); audit `member.update` with diff; returns updated `NotificationMemberOut` |
  | `DELETE /notifications/groups/{id}/members/{person_id}` | notifications:change | 204; 404 `member_not_found`; audit `member.remove` |
  | `GET /notifications/recipients` | notifications:change | all non-archived people, ordered last/first, `list[NotificationRecipientOut]` — copy the `list_people` query shape (`stakeholders.py:611-635`) but NO scope conditions (this gate is admin-only) and include `phone` |

**Steps:**
- [ ] Failing tests first: add member (person with email only) → 201, `can_email` true / `can_text`,`can_push` false, `effective` equals group settings; duplicate add → 409; archived person → 404 `person_not_found`; override channels `["text"]` for phoneless person → 422 `channel_unavailable`; override `channels: []` → 200, effective channels `[]`; `quiet_mode:"custom"` without times → 422; `quiet_mode:"none"` → effective quiet times null while group has them; explicit `{"channels": null}` clears a previously-set override (effective returns to group's); remove member → 204 then detail omits them; recipients endpoint returns capability flags and includes account-less people; group detail 404.
- [ ] Run focused file foreground — new tests fail.
- [ ] Implement the four endpoints + helpers.
- [ ] Focused pass → FULL api suite foreground (timeout 600000ms) → commit `feat(api): notification group members — overrides, capability flags, effective settings, recipients picker`.

---

### Task 3: Portal — API client, formatters, groups list page, plumbing

**Files:**
- Modify: `portal/src/lib/api.ts` (types mirroring Task 1/2 `*Out` schemas — `NotificationGroup`, `NotificationGroupDetail`, `NotificationMember`, `NotificationMemberOverrides`, `NotificationEffectiveSettings`, `NotificationRecipient` — plus `listNotificationGroups()`, `createNotificationGroup(body)`, `getNotificationGroup(id)`, `updateNotificationGroup(id, body)`, `deleteNotificationGroup(id)`, `addNotificationMember(groupId, personId)`, `updateNotificationMember(groupId, personId, overrides)`, `removeNotificationMember(groupId, personId)`, `listNotificationRecipients()`; copy the `apiFetch`/`errorFrom` style of `createAccessGroup` at `api.ts:551-575`)
- Create: `portal/src/lib/notifications.ts` — pure helpers + constants:
  ```ts
  export const CHANNELS = ['email', 'text', 'push', 'web'] as const;
  export type Channel = typeof CHANNELS[number];
  export const CHANNEL_LABELS: Record<Channel, string> =
    { email: 'Email', text: 'Text (SMS)', push: 'Push', web: 'Web' };
  export const DAYS = ['mon','tue','wed','thu','fri','sat','sun'] as const;
  export function formatQuietHours(start: string | null, end: string | null, tz: string): string
    // '21:00:00','07:00:00','America/Chicago' -> '9:00 PM – 7:00 AM CT'; null -> '—'
    // tz abbreviation via Intl.DateTimeFormat(..., {timeZone: tz, timeZoneName: 'short'})
  export function formatDays(days: string[]): string
    // all 7 -> 'Daily'; mon..fri -> 'Mon–Fri'; sat+sun -> 'Weekends';
    // other contiguous runs -> 'Wed–Sat'; else 'Mon, Wed, Fri'
  export function canForChannel(m: {can_email:boolean;can_text:boolean;can_push:boolean;can_web:boolean}, c: Channel): boolean
  ```
- Test: `portal/src/lib/notifications.test.ts` (co-located, Vitest)
- Create: `portal/src/pages/Notifications.tsx`
- Test: `portal/src/pages/Notifications.test.tsx`
- Modify: `portal/src/App.tsx` (replace the `<Placeholder>` element at the `/system/notifications` route with `<Notifications />` and change its gate to `resource="notifications"`; add `/system/notifications/:groupId` → `<NotificationGroupDetail />` stub-imported in Task 4 — for THIS task route only the list page and leave the detail route for Task 4)
- Modify: `portal/src/layout/navSections.tsx` (the existing Notifications item's `resource: 'settings'` → `'notifications'`)
- Modify: `portal/src/lib/access.ts` (`ROUTE_RESOURCE['/system/notifications'] = 'notifications'`)
- Modify: `portal/src/components/Topbar.tsx` (CRUMBS entry exists; verify PAGES entry exists — it does — no change unless detail crumb logic requires one; check how `/stakeholders/clients/:id` resolves its crumb and mirror for the detail path in Task 4)

**Interfaces (produces):** the `lib/api.ts` functions and `lib/notifications.ts` helpers above, consumed by Tasks 4–5.

**List page spec (model: `pages/AssetModels.tsx` — the canonical directory page):**
- `.portal-page` → `.dir-head` (eyebrow "System", title "Notifications" + `.badge-count` of groups, hint "Notification groups — who gets notified, how, and when.") → `.dir-toolbar` (search, `FilterButton` facets: Status enabled/paused, Channels; `ColumnsButton`; `ExportButton`) → `.dir-list` with `VirtualRows`.
- Columns (all with `ColumnMenu`): Name · Description · Members (count, right-aligned) · Channels (one chip per channel, `CHANNEL_LABELS`) · Quiet hours (`formatQuietHours`) · Days (`formatDays`) · Status (`Enabled` chip `.c-green` / `Paused` chip neutral) · Created (date). `usePersistentListState('notification_groups', …)`.
- Row click → `navigate(`/system/notifications/${g.id}`)` (no inline expansion). CSV export (`exportCsv('notification-groups', …)`).
- `+ New group` (`.btn-solid`, shown when `can('notifications','add')`): standard `.modal-scrim`/`.modal-card` modal (model `components/access/GroupsTab.tsx:319-353`) with Name* + Description; on success navigate to the new group's detail page. Error map: `{ group_exists: 'A group with that name already exists.' }` + `msgFor` fallback pattern.
- Empty state `.dir-empty`: `<b>No notification groups yet</b>Create a group to define who gets notified and how.` (+ `EmptyClearFilters` when filters hide everything).

**Steps:**
- [ ] Failing tests first: `notifications.test.ts` (formatQuietHours normal/overnight/null, formatDays Daily/Mon–Fri/Weekends/list, canForChannel), `Notifications.test.tsx` (mock api module: renders rows from two fake groups, search filters, Paused chip shown, New-group button hidden without `add` permission — see how existing page tests mock `useAuth`/api).
- [ ] Implement lib + page + plumbing. Run FULL portal suite + `npx tsc -b` foreground (timeout 600000ms).
- [ ] Commit `feat(portal): notification groups list page + client, notifications permission gate`.

---

### Task 4: Portal — group detail page (hero + delivery defaults)

**Files:**
- Create: `portal/src/pages/NotificationGroupDetail.tsx`
- Create: `portal/src/styles/notifications.css` (page-specific; import in the page. Model panel/hero classes on the stakeholder detail stylesheet — find it via `grep -l stakeholder portal/src/styles/`)
- Modify: `portal/src/App.tsx` (add `/system/notifications/:groupId` route, `resource="notifications"`)
- Modify: `portal/src/components/Topbar.tsx` (detail breadcrumb: mirror whatever mechanism `/stakeholders/clients/:id` uses)
- Test: `portal/src/pages/NotificationGroupDetail.test.tsx`

**Interfaces:**
- Consumes: `getNotificationGroup`, `updateNotificationGroup`, `deleteNotificationGroup` (Task 3).
- Produces: the page shell + a `reload()` pattern Task 5's members panel plugs into (keep the page one file unless it passes ~500 lines; if it does, split members panel into `portal/src/components/notifications/MembersPanel.tsx`).

**Page spec (benchmark: `pages/StakeholderDetail.tsx` hero + panels):**
- Load by `useParams().groupId`; not-found → `.dir-empty` "Group not found" with a back link to `/system/notifications`.
- **Hero**: eyebrow "System · Notifications" back-link, group name as `.page-title`, description as hint, status chip (Enabled `.c-green` / Paused), summary chips (member count, channel chips). Actions (gated `can('notifications','change')` / `'delete'`): `Pause`/`Resume` toggle (PATCH `enabled`), `Edit` (opens modal below), two-click inline `Delete` → on 204 navigate to the list.
- **Edit group modal**: Name* + Description (same modal as create but pre-filled; 409 `group_exists` mapped).
- **Delivery defaults panel** (`.init-panel`-style card, heading "Delivery defaults" visually distinct per form rules): read view as a real aligned two-column definition layout — Channels (chips), Quiet hours (`formatQuietHours`), Timezone, Active days (`formatDays`), When blocked (`Defer until window opens` / `Skip entirely`), Urgent bypass (`Urgent notifications ignore quiet hours` / `Urgent notifications respect quiet hours`) — plus an `Edit settings` `.mini-btn`.
- **Edit settings modal** (2-col label-above-control grid, `.pf-form`):
  - Channels: four aligned labeled switch rows (label left, switch right — reuse the `<Switch>` used in `pages/Settings.tsx:33-62`), one per channel with `CHANNEL_LABELS`.
  - Quiet hours: "Quiet hours" select (`Off` / `Custom`) + when Custom two `<input type="time">` (Start / End) + Timezone `<select>` of common IANA zones (`America/New_York`, `America/Chicago`, `America/Denver`, `America/Phoenix`, `America/Los_Angeles`, `America/Anchorage`, `Pacific/Honolulu`, `UTC`).
  - Active days: seven toggle-pill buttons Mon–Sun (`.mini-btn` toggling an active class), at least one required (client-side guard + server 422 `invalid_days` mapped).
  - When blocked: select Defer / Skip. Urgent bypass: labeled switch row.
  - Error map: `invalid_quiet_hours: 'Quiet hours need both a start and an end (and they can't be equal).'`, `invalid_timezone`, `invalid_days: 'Pick at least one active day.'`.
- On any successful save: refetch the group (`reload()`).

**Steps:**
- [ ] Failing tests first: renders hero + defaults from a mocked detail payload (quiet hours formatted, Paused chip when `enabled:false`); settings modal opens and submitting PATCHes changed fields only; delete requires second click.
- [ ] Implement page + css + route + crumb. FULL portal suite + tsc foreground (timeout 600000ms).
- [ ] Commit `feat(portal): notification group detail — hero, delivery defaults, settings editor`.

---

### Task 5: Portal — members panel + per-member override editor

**Files:**
- Modify: `portal/src/pages/NotificationGroupDetail.tsx` (or the split-out `components/notifications/MembersPanel.tsx` per Task 4's note)
- Modify: `portal/src/styles/notifications.css`
- Test: extend `portal/src/pages/NotificationGroupDetail.test.tsx`

**Interfaces (consumes):** `addNotificationMember`, `updateNotificationMember`, `removeNotificationMember`, `listNotificationRecipients`, `canForChannel`, member payload's `overrides` / `effective` / capability flags (Task 2 shapes via Task 3 types).

**Members panel spec:**
- Card heading "Members" + count badge + add-member `ComboBox` (`components/ComboBox.tsx`, options from `listNotificationRecipients()` minus current members; option `label` = display_name, `sub` = job title + reachable channels summary e.g. "Technician · Email, Web"). Selecting calls `addNotificationMember` then reloads.
- Real aligned table (house table pattern — one column per field, `—` per empty cell):
  - **Person**: avatar (initials fallback) + display name + job title.
  - **Contact**: email and phone stacked; `—` when absent.
  - **Channels**: chips of `effective.channels`; each chip the person can't receive gets a warning style + title "No email address on profile" / "No phone number" / "No user account"; muted members (`effective.channels` empty) show a `Muted` chip; an `Override` marker chip when `overrides.channels != null`.
  - **Quiet hours**: `formatQuietHours(effective…)` + override marker when `overrides.quiet_mode != null`.
  - **Days**: `formatDays(effective.active_days)` + override marker.
  - **Actions** (gated `can('notifications','change')`): `Edit` (`mini-btn sm`) → override modal; `Remove` (`mini-btn sm danger`, two-click inline confirm).
- Empty state inside the card: `<b>No members yet</b>Add people above — they'll receive this group's notifications.`
- **Override editor modal** (per member, title "Overrides — {name}"): every setting rendered as an explicit inherit-vs-custom choice so inheritance is legible:
  - Channels: select `Group default (Email, Web)` / `Custom` → when Custom, switch rows ONLY for channels where `canForChannel` is true; zero selected is allowed and surfaces an inline note "This member will receive nothing from this group."
  - Quiet hours: select `Group default (9:00 PM – 7:00 AM CT)` / `None` / `Custom` (+ time inputs when Custom) — maps to `quiet_mode` null/'none'/'custom'.
  - Timezone, Active days, When blocked, Urgent bypass: same `Group default (…)` / `Custom` pattern (defaults always show the group's current value in the label).
  - Submit sends ONLY the fields whose mode changed, with explicit `null` for anything reset to inherit (Task 2's PATCH distinguishes absent vs null). Error map incl. `channel_unavailable: 'That channel isn't available for this person.'`.
- Group-uses-but-member-lacks warning already covered by the chip warnings above — no extra banner.

**Steps:**
- [ ] Failing tests first: members table renders effective chips + warning on unreachable channel + Override marker; recipients already in the group are excluded from the ComboBox; override modal shows only reachable channels under Custom; reset-to-inherit sends `{channels: null}`; remove needs two clicks.
- [ ] Implement. FULL portal suite + `npx tsc -b` + `npm run build` foreground (timeout 600000ms).
- [ ] Commit `feat(portal): notification group members — add/remove, per-member override editor, capability warnings`.

---

### Task 6: Verification + UI/UX polish passes (orchestrator, NOT a subagent)

- [ ] Dev stack: portal is usually already running on 5173 (open as URL tab — don't start a second server); API on 8000 (restart after migrations). Login `claude-dev@test.example.com` / `wt-verify-2026` — login page quirk: fill via `form_input` then `document.querySelector('form').requestSubmit()`; scroll via `document.querySelector('.portal-main').scrollTo(...)`. If claude-dev lacks the new `notifications` grants (sub-admin rank), grant admin role via SQL or use jhenderson's flows to verify, then note it.
- [ ] Functional pass in the browser: create a group; configure quiet hours 21:00–07:00 CT, weekdays, Defer, bypass on; add three members — one email-only person, one phone-less, one with an account; verify warning chips; set an override (custom channels + quiet 'none'); mute a member; pause the group; rename to a colliding name (409 copy); delete a member and a group. Screenshot each surface.
- [ ] **UI/UX polish pass 1**: LOOK at the screenshots against the binding form rules and the house benchmark (initiative/stakeholder detail pages): alignment of the 2-col grids, switch rows (no floating checkboxes), heading hierarchy, chip rhythm, table column alignment, empty states, dark theme (`resize_window` colorScheme dark), narrow width. Fix everything that reads as unfinished.
- [ ] **UI/UX polish pass 2**: fresh screenshots after fixes; second critical pass for interactivity/professionalism — hover states, focus states, modal sizing, spacing consistency with sibling pages. Fix and re-verify.
- [ ] FULL suites one final time (api + portal + build, foreground, timeout 600000ms). `git checkout -- api/src/serversherpa/_dev_reload.py` if dirty. Commit any polish diffs `polish(portal): notification groups UI passes`.
- [ ] Update ledger `.superpowers/sdd/progress.md`.
