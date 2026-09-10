# Notification Group Self-Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People see and tune their notification groups on `/me/notifications`, and join/leave through requests that admins approve or reject from the inbox popover (and the admin page).

**Architecture:** One new table (`notification_membership_requests`, migration 0051). Self-service endpoints under the ungated `/auth/me` router; approval endpoints under the `notifications:change`-gated router; both share `MembershipRequestOut` and a small `notifications/requests.py` service (create request + approver fan-out, decide, cancel, resolve copies). Portal reuses `OverrideEditorModal` through an adapter, adds two sections to `MeNotifications`, inline Approve/Reject in `NotificationsPanel`, and a pending panel on the admin page.

**Tech Stack:** FastAPI/SQLAlchemy async/Alembic; React 18 + TS + Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-10-notification-group-self-service-design.md` — every code/copy value is defined there.
- Migration `0051`, `down_revision = "0050"`, single head. Table/index/column names exactly as the spec.
- Error codes exactly: `group_not_found`, `not_a_member`, `already_member`, `request_pending`, `request_not_found`, `already_decided`, `invalid_quiet_hours` (existing), `forbidden`.
- Notification kinds: `membership_request` (to approvers) and `membership_decided` (to requester); payload keys exactly as the spec; approvers' copies resolved by updating `payload.state`.
- Portal idioms: `mini-list`/`mini-row`, `DataTable`, `.dir-search`, chips, `RowActionsMenu`/`mini-btn`, `.pf-form` modals; typography guardrail (`portal/src/styles/listTypography.test.ts`) green with no new `listTypography.allow.json` entries; no raw native `<select>`.
- Tests FOREGROUND, one call, timeout 600000ms: API `PYTHONPATH=src SS_TEST_DB=serversherpa_test_ng /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>` from the worktree's api/; portal `npx vitest run <files> && npx tsc --noEmit -p .` from portal/.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` by explicit path; `git checkout -- api/src/serversherpa/_dev_reload.py` if modified.

---

### Task 1: Data + request service

**Files:** Create `api/migrations/versions/0051_notification_membership_requests.py`, `api/src/serversherpa/notifications/requests.py`; Modify `api/src/serversherpa/db/models.py` (`NotificationMembershipRequest` after `NotificationGroupMember`); Test `api/tests/test_notification_requests_service.py`.

**Produces (exact):**
```python
# notifications/requests.py
class RequestError(Exception):            # .code in the spec's error-code list
    def __init__(self, code: str, status: int = 409): ...
async def approver_ids(db, *, exclude: uuid.UUID) -> list[uuid.UUID]
    # distinct person ids with non-revoked PersonRole whose role has RolePermission('notifications','change') AND a UserAccount row, minus `exclude`
async def create_request(db, *, person: Person, group: NotificationGroup, action: str, note: str) -> NotificationMembershipRequest
    # rules: group.enabled else RequestError('group_not_found',404); join+member → 'already_member'; leave+non-member → 'not_a_member'; pending exists → 'request_pending'
    # then notify() each approver (kind 'membership_request', title/body/link/payload per spec)
async def cancel_request(db, *, request_id, person_id) -> None      # 404 'request_not_found' unless pending & own; status='cancelled'; resolve_copies(..., 'cancelled', decided_by_name=None)
async def decide_request(db, *, request_id, actor: Person, approve: bool, note: str) -> NotificationMembershipRequest
    # 404 unknown; 'already_decided' if not pending; approve → apply membership (join: insert NotificationGroupMember(added_by=actor.id) if absent; leave: delete); set fields; notify requester ('membership_decided'); resolve_copies(status, actor display name)
async def resolve_copies(db, request_id, state: str, decided_by: str | None) -> None
    # UPDATE notifications SET payload = payload || jsonb WHERE kind='membership_request' AND payload->>'request_id' = str(request_id)
async def is_member(db, group_id, person_id) -> bool
```
Audit via `services.audit.audit(...)` with `entity_type="notification_group"`, entity_id=group id, actions `request.create`, `request.cancel`, `request.approve`, `request.reject`, changes `{request_id, person_id, action, note}`.

- [ ] Tests first (use `tests/test_notification_groups_api.py`'s `_person` helper style; create people, roles via `PersonRole`, `UserAccount` rows — copy how `test_access_*`/conftest seed an admin with an account; `RolePermission` rows for admin already exist from defaults): `approver_ids` returns the admin with an account, not the requester, not a worker, not a person without an account; `create_request` join → row pending + one notification per approver with the exact payload; duplicate pending → `request_pending`; leave when not a member → `not_a_member`; `cancel_request` → status cancelled + copies' `payload.state == 'cancelled'`; `decide_request(approve=True)` on join → member row exists, request approved with decided_by, requester notified (`membership_decided`, payload.status 'approved'), copies resolved with `decided_by` name; reject on leave keeps membership; second decide → `already_decided`.
- [ ] Migration (mirror 0050's style; partial unique index via `op.create_index(..., unique=True, postgresql_where=sa.text("status = 'pending'"))`), model, service. Run `tests/test_notification_requests_service.py tests/test_notification_groups_api.py`. Commit `feat(notifications): membership request table + service (create, cancel, decide, approver fan-out)`.

---

### Task 2: API routes — self-service + approval

**Files:** Modify `api/src/serversherpa/api/routes/me.py` (new endpoints), `api/src/serversherpa/api/routes/notifications.py` (extract `apply_member_overrides(member, body)` from `patch_member` and reuse; add `/requests` endpoints), `api/src/serversherpa/api/schemas.py` (`MembershipRequestOut`, `MembershipRequestCreateIn {action: Literal['join','leave']; note: str = ''}`, `MembershipDecisionIn {note: str = ''}`, `MyNotificationGroupOut`); Test `api/tests/test_notification_self_service.py`.

**Consumes:** Task 1 service. **Produces:** the endpoints exactly as the spec (paths, methods, status codes, error codes, sort orders).

- [ ] Tests first per the spec's Testing list (list shape incl. `q` and disabled-hidden; overrides PATCH + 404 non-member + `invalid_quiet_hours`; request rules; approver fan-out via HTTP; cancel; approve/reject via HTTP incl. 409 second decision; worker → 403 on `/notifications/requests`; worker CAN call `/auth/me/notification-groups`).
- [ ] Implement; `MyNotificationGroupOut` built with `effective_settings`/overrides from the existing helpers (import them from routes/notifications — or move `effective_settings`, `capabilities`, `_member_out` into `notifications/members.py` if importing across routers is awkward; keep behaviour identical). Run `tests/test_notification_self_service.py tests/test_notification_groups_api.py tests/test_notifications_inbox.py tests/test_me_api.py`. Commit `feat(notifications): self-service groups API under /auth/me + membership request approval endpoints`.

---

### Task 3: Portal lib + MeNotifications groups sections

**Files:** Modify `portal/src/lib/api.ts` (types/functions per spec), `portal/src/pages/me/MeNotifications.tsx` (+ `.test.tsx`), `portal/src/components/notifications/OverrideEditorModal.tsx` (add optional `onSave?: (body: NotificationMemberOverrides) => Promise<unknown>` prop — when given, call it instead of the admin `patchNotificationMember`; default behaviour unchanged); Create `portal/src/lib/notificationGroups.ts` (+ `.test.ts`), `portal/src/components/notifications/MembershipRequestModal.tsx` (note prompt for Join/Leave: title "Ask to join {Group}" / "Ask to leave {Group}", textarea note, Send request).

**Consumes:** Task 2 endpoints. **Produces:** `quietHoursText(g)`, `daysText(days)`, `hasOverrides(ov)`, `GROUP_ERRORS`, `toGroupDetail(g)`, `toMember(g, person)`.

- [ ] Build the **My groups** and **Join a group** sections exactly as the spec (mini-list with head Group / Channels / Quiet hours / Days; chips; Customised tag; Edit overrides → `OverrideEditorModal` via adapters + `onSave` → `updateMyGroupOverrides`; Leave/Join → `MembershipRequestModal` → `requestGroupMembership`; pending states with Cancel → `cancelMembershipRequest`; `.dir-search` client-side filter; empties; refetch after every action; `GROUP_ERRORS` mapping).
- [ ] Tests: lib helpers; MeNotifications (mock the new api functions): renders member groups with chips/quiet text and Customised tag; Leave → modal → request posted with `{action:'leave', note}` and row shows "Leave requested" + Cancel; Join search filters and Join posts; Cancel calls the API and refetches; Edit overrides opens the modal and saving calls `updateMyGroupOverrides` (mock the modal or drive it minimally).
- [ ] Run `npx vitest run src/pages/me src/lib/notificationGroups.test.ts src/components/notifications src/styles/listTypography.test.ts && npx tsc --noEmit -p .`. Commit `feat(portal): my notification groups — overrides, leave/join requests on /me/notifications`.

---

### Task 4: Inbox popover actions + admin pending panel

**Files:** Modify `portal/src/components/NotificationsPanel.tsx` (+ `.test.tsx`), `portal/src/pages/Notifications.tsx` (+ `.test.tsx`), `portal/src/styles/notifications.css` or wherever `.notif-row` styles live (layout-only additions: `.notif-strip { display:flex; gap:8px; margin-top:6px }`).

**Consumes:** Task 3's api functions (`approveMembershipRequest`, `rejectMembershipRequest`, `listMembershipRequests`).

- [ ] Panel: for `kind === 'membership_request'`, render the strip per spec (Approve / Reject when `payload.state === 'pending'`; Reject opens the existing small-modal idiom for a note, or a `window.prompt`-free inline textarea toggle — use a tiny `.pf-form` inline block); outcome line otherwise; `stopPropagation` so the row click doesn't navigate; after a decision call `refresh()`. `KindIcon` cases for `membership_request` (person+plus) and `membership_decided` (check). Tests: pending row shows both buttons, Approve calls `approveMembershipRequest(id)` then `refresh`; decided row shows "Approved by …"; other kinds unchanged.
- [ ] Admin page: `Pending requests` panel (DataTable) above the group list, hidden when empty, with Approve/Reject; refetch after decision. Test: renders rows from mocked `listMembershipRequests('pending')`; Approve calls the API and the row disappears.
- [ ] Run `npx vitest run src/components/NotificationsPanel.test.tsx src/pages/Notifications.test.tsx src/styles/listTypography.test.ts && npx tsc --noEmit -p .`. Commit `feat(portal): approve/reject membership requests from the inbox popover and the admin page`.

---

### Task 5: Verification (controller-led)

- [ ] Full API + portal suites, tsc, build; dev DB `alembic upgrade head`.
- [ ] Live on worktree servers: as the dev admin, request to join a group from `/me/notifications`, see the popover item with Approve/Reject (sound), approve, see membership + the requester's decided notification; edit overrides; leave flow; admin pending panel.
- [ ] Fast-forward `main`/`reports`, push.
