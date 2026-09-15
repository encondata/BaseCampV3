# User Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-detail page for one login user at `/people/users/:personId`, styled like `/me`, showing profile, account, memberships, roles, access groups (editable in place), overrides, effective permissions, sessions, and audit history.

**Architecture:** One aggregated read endpoint `GET /users/{person_id}` feeds the page; the effective-permission and activity queries are factored out of `access.py` / `me.py` into shared helpers so both callers share one implementation. Two small new mutations (`PUT /users/{id}/access-groups`, `POST /users/{id}/sessions/revoke-all`). The page is a `/me`-shaped shell (hero + segmented tabs) with three tab components and one new modal; every existing admin modal is reused.

**Tech Stack:** FastAPI + SQLAlchemy async + pytest (real Postgres); React 18 + TypeScript + react-router + vitest/jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-15-user-detail-page-design.md`

## Global Constraints

- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail` on branch `user-detail`. Never `cd` to the main checkout.
- Every python command must set `PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src` and `SS_TEST_DB=serversherpa_test_user_detail` (the venv's editable install points at the main checkout). The venv is symlinked at `api/.venv`.
- Run suites in the FOREGROUND in one continuous command with an explicit timeout (600000 ms). Never background a suite and end the turn "waiting".
- Never commit `api/src/serversherpa/_dev_reload.py` (dev churn) — `git checkout -- api/src/serversherpa/_dev_reload.py` if it shows up.
- American English everywhere (color, customize, canceled).
- No migration. No new npm dependencies.
- Ruff line length 100 (`api/pyproject.toml`). Portal: `npx tsc -b --noEmit` must be clean; the list typography guardrail `portal/src/styles/listTypography.test.ts` must stay green (no raw `<table>` outside `DataTable`, no font props outside `directory.css`, no `mini-row` co-class setting display/padding/gap/border/min-height).
- Every new modal carries the report-generate header (`.rgm-head-text` with `.eyebrow`, `h3`, `.page-hint`) and sizes to its content.
- Commit after each task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `api/src/serversherpa/access/effective.py` (new) | `effective_cells()` — resolved cells + sourcing + group list for one person |
| `api/src/serversherpa/services/activity.py` (new) | `person_activity()` — the "acted-in + about-them" audit query |
| `api/src/serversherpa/services/sessions.py` (new) | `live_session_rows()` — live login families for one person |
| `api/src/serversherpa/api/routes/access.py` | `effective` endpoint delegates to `effective_cells` |
| `api/src/serversherpa/api/routes/me.py` | `/activity` and `/sessions` delegate to the helpers |
| `api/src/serversherpa/api/schemas.py` | `UserDetailOut` family, `AccessGroupsUpdateIn`, `AccessGroupsOut` |
| `api/src/serversherpa/api/routes/users.py` | `GET /{id}`, `GET /{id}/activity`, `PUT /{id}/access-groups`, `POST /{id}/sessions/revoke-all` |
| `api/tests/test_users_detail_api.py` (new) | all four endpoints |
| `portal/src/lib/api.ts` | types + `getUserDetail`, `getUserActivity`, `setUserAccessGroups`, `revokeAllUserSessions` |
| `portal/src/lib/users.ts` | `ROLE_CLS` moves here; `toManagedUser()`, `toMemberItem()` adapters |
| `portal/src/components/ActivityHistory.tsx` | `subjectName` prop |
| `portal/src/pages/UserDetail.tsx` (new) | page shell: load, hero, actions, tabs |
| `portal/src/components/users/UserProfileTab.tsx` (new) | Profile / Account / Memberships / Active sessions panels |
| `portal/src/components/users/UserAccessTab.tsx` (new) | Roles / Access groups / Overrides / Effective permissions panels |
| `portal/src/components/users/ManageGroupsModal.tsx` (new) | toggle the person in/out of access groups |
| `portal/src/styles/user-detail.css` (new) | `ud-` layout rules |
| `portal/src/pages/Users.tsx` | Full details button; Add person lands on the page |
| `portal/src/pages/Access.tsx`, `components/access/GroupsTab.tsx` | `?tab=&group=` deep link |
| `portal/src/App.tsx` | three routes |

---

### Task 1: Shared helpers — `effective_cells`, `person_activity`, `live_session_rows`

Pure refactor: behavior of `/access/effective/{id}`, `/auth/me/activity`, `/auth/me/sessions` is unchanged and the existing tests prove it.

**Files:**
- Create: `api/src/serversherpa/access/effective.py`
- Create: `api/src/serversherpa/services/activity.py`
- Create: `api/src/serversherpa/services/sessions.py`
- Modify: `api/src/serversherpa/api/routes/access.py:100-186` (the `effective` endpoint)
- Modify: `api/src/serversherpa/api/routes/me.py:56-97` (`/activity`) and `:129-166` (`/sessions`)
- Test: existing `api/tests/test_access_api.py`, `api/tests/test_me_activity.py`, `api/tests/test_me_api.py`

**Interfaces:**
- Produces: `effective_cells(db, person_id) -> EffectiveAccess` with `.access: AccessInfo`, `.groups: list[tuple[uuid.UUID, str]]`, `.cells: dict[str, dict[str, {"value": bool, "source": str}]]`, `.scope: dict`.
- Produces: `person_activity(db, person_id, login_email, *, limit=50) -> list[dict]` (keys exactly the `MyActivityItem` fields).
- Produces: `live_session_rows(db, person_id) -> list[dict]` (keys `family_id, started_at, last_active_at, expires_at, ip_address, user_agent`; sorted most recently active first).

- [ ] **Step 1: Run the three existing test files to record the green baseline**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_access_api.py tests/test_me_activity.py tests/test_me_api.py
```
Expected: all pass.

- [ ] **Step 2: Create `api/src/serversherpa/access/effective.py`**

```python
"""Resolved effective access for one person, with per-cell sourcing.

Shared by GET /access/effective/{id} (the Access Explorer tab) and
GET /users/{id} (the user detail page) so the sourcing rules — hard gate,
override, gate, floor, role — have exactly one implementation."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import AccessInfo, resolve_access
from serversherpa.access.resources import ACTIONS, REGISTRY
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PermissionOverride, ResourceGroupGate,
    RolePermission,
)


@dataclass
class EffectiveAccess:
    access: AccessInfo
    groups: list[tuple[uuid.UUID, str]] = field(default_factory=list)   # (id, name)
    cells: dict = field(default_factory=dict)

    @property
    def scope(self) -> dict:
        return {
            "global": self.access.is_global,
            "client_ids": [str(c) for c in sorted(self.access.client_ids)],
            "partner_ids": [str(p) for p in sorted(self.access.partner_ids)],
        }


async def effective_cells(db: AsyncSession, person_id: uuid.UUID) -> EffectiveAccess:
    access = await resolve_access(db, person_id)
    overrides = {(o.resource, o.action): o.allow for o in await db.scalars(
        select(PermissionOverride).where(
            PermissionOverride.person_id == person_id))}
    group_rows = (await db.execute(
        select(AccessGroup.id, AccessGroup.name)
        .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
        .where(AccessGroupMember.person_id == person_id)
        .order_by(AccessGroup.name))).all()
    gated = {res for (res,) in (await db.execute(
        select(ResourceGroupGate.resource).distinct())).all()}
    member_res: set[str] = set()
    if group_rows:
        gids = {gid for gid, _ in group_rows}
        member_res = {res for res, gid in (await db.execute(
            select(ResourceGroupGate.resource, ResourceGroupGate.group_id))).all()
            if gid in gids}

    role_set = set(access.role_names)
    granted: dict[str, set[str]] = {}
    if role_set:
        for res, action in (await db.execute(
            select(RolePermission.resource, RolePermission.action)
            .where(RolePermission.role.in_(role_set)))).all():
            granted.setdefault(res, set()).add(action)

    cells: dict = {}
    for res_id, res in REGISTRY.items():
        cells[res_id] = {}
        hard = ((res.developer_only and "developer" not in access.role_names)
                or not (res.visible_to & access.anchors))
        gate_blocks = (res_id in gated and res_id not in member_res
                       and access.max_rank < GATE_BYPASS_RANK)
        for a in ACTIONS:
            value = access.perms[res_id][a]
            if hard:
                source = "hard_gate"
            elif (res_id, a) in overrides:
                # always_viewable floors view=True AFTER overrides (resolver),
                # so a deny override on such a cell is discarded — when the
                # override row disagrees with the final value, the floor is
                # what actually decided it
                source = "override" if overrides[(res_id, a)] == value else "floor"
            elif gate_blocks:
                # gate blocks this action outright, unless always_viewable
                # floors the view cell back on for it
                source = "floor" if (res.always_viewable and a == "view") else "gate"
            elif res.always_viewable and a == "view" and value and (
                    a not in granted.get(res_id, set())):
                # value is true only because always_viewable floored it —
                # no role actually granted view
                source = "floor"
            else:
                source = "role"
            cells[res_id][a] = {"value": value, "source": source}

    return EffectiveAccess(access=access, groups=list(group_rows), cells=cells)
```

- [ ] **Step 3: Make `access.py::effective` delegate**

Replace the body of `effective()` (everything after the `person is None` 404 check, down to and including the `return {...}`) with:

```python
    eff = await effective_cells(db, person_id)
    return {
        "person_id": str(person_id), "display_name": person.display_name,
        "roles": eff.access.role_names, "max_rank": eff.access.max_rank,
        "groups": [{"id": str(gid), "name": name} for gid, name in eff.groups],
        "scope": eff.scope,
        "cells": eff.cells,
    }
```

Add `from serversherpa.access.effective import effective_cells` to the imports. Then run `ruff check` (Step 7) — `resolve_access` and `ACTIONS` become unused in `access.py` only if nothing else in the file uses them; delete exactly the imports ruff reports as unused, nothing more.

- [ ] **Step 4: Create `api/src/serversherpa/services/activity.py`**

```python
"""One person's audit history: rows they acted in, plus rows about their
person / account / sign-ins (admin resets, failed logins against their
email — those carry actor NULL and entity_id = the typed email).

Shared by /auth/me/activity and /users/{id}/activity so the "about this
person" rule has one home. Returns plain dicts shaped like MyActivityItem;
the routes wrap them."""

import uuid

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AuditLog, Person
from serversherpa.services.entity_refs import resolve_entity_refs

ABOUT_ENTITY_TYPES = ("person", "user_account", "auth")


async def person_activity(
    db: AsyncSession, person_id: uuid.UUID, login_email: str | None, *, limit: int = 50,
) -> list[dict]:
    identities = [str(person_id)]
    if login_email:
        identities.append(login_email)
    rows = (await db.execute(
        select(AuditLog, Person)
        .outerjoin(Person, Person.id == AuditLog.actor_person_id)
        .where(or_(
            AuditLog.actor_person_id == person_id,
            and_(AuditLog.entity_type.in_(ABOUT_ENTITY_TYPES),
                 AuditLog.entity_id.in_(identities)),
        ))
        .order_by(AuditLog.at.desc())
        .limit(limit)
    )).all()
    refs = await resolve_entity_refs(db, {
        (log.entity_type, log.entity_id) for log, _ in rows
        if log.entity_id is not None})
    return [{
        "id": log.id, "at": log.at, "action": log.action,
        "entity_type": log.entity_type, "entity_id": log.entity_id,
        "ip": str(log.ip) if log.ip else None,
        "by_me": log.actor_person_id == person_id,
        "actor_name": (actor.display_name
                       if actor is not None and log.actor_person_id != person_id
                       else None),
        "changes": log.changes or {},
        "entity_name": refs.get((log.entity_type, log.entity_id or ""), {}).get("name"),
        "entity_summary": refs.get((log.entity_type, log.entity_id or ""), {})
                              .get("summary", {}),
    } for log, actor in rows]
```

- [ ] **Step 5: Create `api/src/serversherpa/services/sessions.py`**

```python
"""Live login families for one person — shared by /auth/me/sessions (adds
the `current` flag) and GET /users/{id} (admin view, no current flag)."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AuthSession


async def live_session_rows(db: AsyncSession, person_id: uuid.UUID) -> list[dict]:
    now = datetime.now(UTC)
    live = (await db.scalars(
        select(AuthSession).where(
            AuthSession.person_id == person_id,
            AuthSession.revoked_at.is_(None),
            AuthSession.rotated_at.is_(None),
            AuthSession.expires_at > now,
        )
    )).all()
    family_ids = [s.family_id for s in live]
    starts = dict((await db.execute(
        select(AuthSession.family_id, func.min(AuthSession.created_at))
        .where(AuthSession.family_id.in_(family_ids or [uuid.uuid4()]))
        .group_by(AuthSession.family_id)
    )).all())
    rows = [{
        "family_id": s.family_id,
        "started_at": starts.get(s.family_id, s.created_at),
        "last_active_at": s.created_at,
        "expires_at": s.expires_at,
        "ip_address": str(s.ip_address) if s.ip_address is not None else None,
        "user_agent": s.user_agent,
    } for s in live]
    rows.sort(key=lambda r: r["last_active_at"], reverse=True)
    return rows
```

- [ ] **Step 6: Make `me.py` delegate**

Replace the body of `my_activity()` with:

```python
    rows = await person_activity(db, user.person.id, user.account.email, limit=50)
    return [MyActivityItem(**row) for row in rows]
```

Replace the body of `list_sessions()` with:

```python
    rows = await live_session_rows(db, user.person.id)
    items = [SessionItem(**row, current=row["family_id"] == user.session.family_id)
             for row in rows]
    items.sort(key=lambda i: not i.current)   # stable: current first, then most recent
    return items
```

Add imports `from serversherpa.services.activity import ABOUT_ENTITY_TYPES, person_activity` and `from serversherpa.services.sessions import live_session_rows`. Keep the module-level name `ABOUT_ME_ENTITY_TYPES = ABOUT_ENTITY_TYPES` in `me.py` (other code may import it). Remove the now-unused imports ruff reports (`and_`, `or_`, `AuditLog`, possibly `func`/`AuthSession` — only what ruff flags).

- [ ] **Step 7: Lint and re-run the three test files**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && .venv/bin/ruff check src/serversherpa/access/effective.py src/serversherpa/services/activity.py src/serversherpa/services/sessions.py src/serversherpa/api/routes/access.py src/serversherpa/api/routes/me.py
```
Expected: no findings (fix unused imports if any).

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_access_api.py tests/test_me_activity.py tests/test_me_api.py tests/test_access_overrides_api.py tests/test_access_groups_api.py
```
Expected: all pass, same counts as Step 1.

- [ ] **Step 8: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/access/effective.py api/src/serversherpa/services/activity.py api/src/serversherpa/services/sessions.py api/src/serversherpa/api/routes/access.py api/src/serversherpa/api/routes/me.py && git commit -m "refactor(api): share effective-cells, person-activity, and live-session helpers

Pure extraction from /access/effective, /auth/me/activity and /auth/me/sessions
so the user detail endpoint can reuse them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `GET /users/{person_id}` — the aggregated detail payload

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append after `class UserItem`)
- Modify: `api/src/serversherpa/api/routes/users.py` (imports; new endpoint after `list_users`, before `create_user`)
- Create: `api/tests/test_users_detail_api.py`

**Interfaces:**
- Consumes: `effective_cells`, `live_session_rows` (Task 1); `status_labels`, `level_colors`, `level_fields`, `status_fields` from `serversherpa.status.labels`; `effective_settings` from `serversherpa.api.routes.notifications`; `PartnerRef`, `PersonDetail` from schemas.
- Produces: `UserDetailOut` and nested schemas exactly as below — the portal types in Task 5 mirror them field for field.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_users_detail_api.py`:

```python
"""GET /users/{id} (aggregated detail), GET /users/{id}/activity,
PUT /users/{id}/access-groups, POST /users/{id}/sessions/revoke-all."""

from datetime import UTC, datetime

from sqlalchemy import select, text

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, AuditLog, AuthSession, Client, NotificationGroup,
    NotificationGroupMember, Person, PersonRole, WorkerProfile,
)
from tests.test_access_roles_api import login_admin
from tests.test_users_api import _add_user, _token

H = lambda token: {"Authorization": f"Bearer {token}"}  # noqa: E731


async def _login(client, email):
    return H(await _token(client, email=email))


# ── GET /users/{id} ─────────────────────────────────────────────────

async def test_detail_full_payload_for_admin(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)          # alice -> admin (rank 60)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    # a client-anchored grant with an org name + a granter
    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    db.add(PersonRole(person_id=wan.id, role="client_admin", client_id=acme.id,
                      granted_by=seeded_user.id))
    # worker profile
    db.add(WorkerProfile(person_id=wan.id, trade="Cabling", status="active"))
    # notification group membership
    ng = NotificationGroup(name="Ops", description="", channels=["email"],
                           timezone="America/New_York", active_days=["mon"],
                           dnd_behavior="hold", urgent_bypass=False, enabled=True)
    db.add(ng)
    await db.flush()
    db.add(NotificationGroupMember(group_id=ng.id, person_id=wan.id, channels=["web"]))
    await db.commit()
    # access group via the real endpoint (adds added_by)
    gid = (await client.post("/access/groups", headers=hdrs,
                             json={"name": "Finance"})).json()["id"]
    assert (await client.put(f"/access/groups/{gid}/members", headers=hdrs,
                             json={"person_ids": [str(wan.id)]})).status_code == 200
    assert (await client.put("/access/resources/clients/gates", headers=hdrs,
                             json={"group_ids": [gid]})).status_code == 200
    # an override
    assert (await client.put(f"/access/overrides/{wan.id}", headers=hdrs,
                             json={"overrides": {"sites": {"delete": True}}})).status_code == 200
    # wan signs in once so a live session exists
    await _token(client, email="wan@test.example.com")

    resp = await client.get(f"/users/{wan.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["person"]["display_name"] == "Wan Worker"
    assert body["person"]["source"] == "manual"
    assert body["account"]["login_email"] == "wan@test.example.com"
    assert body["account"]["status"] == "active"
    assert body["account"]["last_login_at"] is not None

    roles = {r["role"]: r for r in body["roles"]}
    assert set(roles) == {"staff", "client_admin"}
    assert roles["client_admin"]["org"] == {"kind": "client", "id": str(acme.id), "name": "Acme"}
    assert roles["client_admin"]["granted_by"]["display_name"] == "Alice Anderson"
    assert roles["staff"]["org"] is None
    assert body["max_rank"] == 40

    assert body["worker"]["trade"] == "Cabling"
    assert body["worker"]["status_label"]            # vocabulary label resolved
    assert body["worker"]["partner"] is None

    assert body["notification_groups"] == [
        {"id": str(ng.id), "name": "Ops", "channels": ["web"],
         "added_at": body["notification_groups"][0]["added_at"]}]

    acc = body["access"]
    assert acc is not None
    assert [g["name"] for g in acc["groups"]] == ["Finance"]
    assert acc["groups"][0]["gate_count"] == 1
    assert acc["groups"][0]["gated_pages"] == ["Clients"]
    assert acc["groups"][0]["added_by"]["display_name"] == "Alice Anderson"
    assert acc["overrides"] == [{
        "resource": "sites", "resource_label": "Sites", "action": "delete", "allow": True,
        "set_by": acc["overrides"][0]["set_by"], "set_at": acc["overrides"][0]["set_at"]}]
    assert acc["overrides"][0]["set_by"]["display_name"] == "Alice Anderson"
    assert acc["scope"]["client_ids"] == [str(acme.id)]
    assert acc["scope_orgs"] == [{"kind": "client", "id": str(acme.id), "name": "Acme"}]
    assert acc["cells"]["sites"]["delete"] == {"value": True, "source": "override"}

    assert len(body["sessions"]) == 1
    assert body["sessions"][0]["family_id"]


async def test_detail_access_block_follows_rank_60_rule(client, db, seeded_user):
    # alice stays staff (rank 40): other -> access null, self -> populated
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    hdrs = await _login(client, "alice@test.example.com")
    other = (await client.get(f"/users/{wan.id}", headers=hdrs)).json()
    assert other["access"] is None
    me = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert me["access"] is not None
    assert me["access"]["groups"] == []


async def test_detail_sessions_need_users_change(client, db, seeded_user):
    # staff has users:change and is global -> sessions visible;
    # a staff whose users:change is overridden off -> sessions null
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    hdrs = await _login(client, "alice@test.example.com")
    assert (await client.get(f"/users/{wan.id}", headers=hdrs)).json()["sessions"] == []
    admin = await login_admin(client, db, seeded_user)
    assert (await client.put(f"/access/overrides/{wan.id}", headers=admin,
                             json={"overrides": {"users": {"change": False}}})).status_code == 200
    wan_hdrs = await _login(client, "wan@test.example.com")
    assert (await client.get(f"/users/{seeded_user.id}", headers=wan_hdrs)).json()["sessions"] is None


async def test_detail_404_without_account_and_403_for_worker(client, db, seeded_user):
    hdrs = await _login(client, "alice@test.example.com")
    ghost = Person(first_name="No", last_name="Account")
    db.add(ghost)
    await db.commit()
    resp = await client.get(f"/users/{ghost.id}", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "user_not_found"

    await _add_user(db, first="Wan", last="Worker",
                    email="wan@test.example.com", role="worker")
    wan_hdrs = await _login(client, "wan@test.example.com")
    assert (await client.get(f"/users/{seeded_user.id}", headers=wan_hdrs)).status_code == 403
```

(The activity / access-groups / revoke-all tests are added to this same file in Tasks 3 and 4.)

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_users_detail_api.py
```
Expected: FAIL — `GET /users/{id}` returns 404/405 (route missing). If `NotificationGroup(...)` raises for a missing required column, open `api/src/serversherpa/db/models.py::NotificationGroup` and pass every non-defaulted column; do not change the model.

- [ ] **Step 3: Add the schemas**

Append to `api/src/serversherpa/api/schemas.py` directly after `class UserItem` (keep `PartnerRef` and `PersonDetail`, both already defined earlier in the file — if `PartnerRef` is defined *later* in the file than `UserItem`, place this block after `PartnerRef` instead):

```python
# ── user detail page (GET /users/{id}) ─────────────────────────────

class PersonRef(BaseModel):
    id: uuid.UUID
    display_name: str


class OrgRefOut(BaseModel):
    kind: str            # "client" | "partner"
    id: uuid.UUID
    name: str


class UserDetailPerson(PersonDetail):
    source: str
    source_ref: str | None
    archived_at: datetime | None


class UserDetailAccount(BaseModel):
    login_email: str | None
    status: str                          # active | locked | disabled
    must_change_password: bool
    last_login_at: datetime | None
    created_at: datetime
    password_updated_at: datetime | None


class UserRoleGrant(BaseModel):
    role: str
    label: str
    rank: int
    scope_anchor: str
    org: OrgRefOut | None
    granted_by: PersonRef | None
    granted_at: datetime


class UserWorkerCard(BaseModel):
    trade: str | None
    level: str | None
    level_title: str | None
    level_color: str | None
    partner: PartnerRef | None
    status: str
    status_label: str
    status_color: str


class UserNotificationGroup(BaseModel):
    id: uuid.UUID
    name: str
    channels: list[str]
    added_at: datetime


class UserAccessGroupRow(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    gate_count: int
    gated_pages: list[str]
    added_by: PersonRef | None
    added_at: datetime


class UserOverrideRow(BaseModel):
    resource: str
    resource_label: str
    action: str
    allow: bool
    set_by: PersonRef | None
    set_at: datetime


class UserAccessBlock(BaseModel):
    groups: list[UserAccessGroupRow]
    overrides: list[UserOverrideRow]
    scope: dict
    scope_orgs: list[OrgRefOut]
    cells: dict


class UserSessionRow(BaseModel):
    family_id: uuid.UUID
    started_at: datetime
    last_active_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None


class UserDetailOut(BaseModel):
    person: UserDetailPerson
    account: UserDetailAccount
    roles: list[UserRoleGrant]
    max_rank: int
    worker: UserWorkerCard | None
    notification_groups: list[UserNotificationGroup]
    access: UserAccessBlock | None       # None below rank 60 unless viewing yourself
    sessions: list[UserSessionRow] | None  # None without users:change (global)


class AccessGroupsUpdateIn(BaseModel):
    group_ids: list[uuid.UUID]


class AccessGroupsOut(BaseModel):
    group_ids: list[uuid.UUID]
```

- [ ] **Step 4: Add the endpoint**

In `api/src/serversherpa/api/routes/users.py` extend the imports:

```python
from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.effective import effective_cells
from serversherpa.access.resources import REGISTRY
from serversherpa.api.routes.notifications import effective_settings
from serversherpa.api.schemas import (
    AccessGroupsOut, AccessGroupsUpdateIn, AccountCreateIn, MyActivityItem, OrgRefOut,
    PartnerRef, PersonDetail, PersonRef, ProfileUpdateIn, ResetPasswordIn, RolesUpdateIn,
    UserAccessBlock, UserAccessGroupRow, UserCreateIn, UserDetailAccount, UserDetailOut,
    UserDetailPerson, UserItem, UserNotificationGroup, UserOverrideRow, UserRoleGrant,
    UserSessionRow, UserWorkerCard,
)
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, AuthSession, Client, NotificationGroup,
    NotificationGroupMember, Partner, PermissionOverride, Person, PersonRole,
    ResourceGroupGate, Role, UserAccount, WorkerLevel, WorkerProfile,
)
from serversherpa.services.activity import person_activity
from serversherpa.services.sessions import live_session_rows
from serversherpa.status.labels import level_colors, level_fields, status_fields, status_labels
```

(`MyActivityItem`, `AccessGroupsOut`, `AccessGroupsUpdateIn`, `person_activity` are used by Tasks 3–4; importing them now is fine — ruff does not flag imports used later in the same task series only if they are used; if ruff complains after this task, leave them out and add them in Task 3/4.)

Add after `list_users` and before `create_user`:

```python
async def _person_refs(db: DbSession, ids: set) -> dict:
    """id -> PersonRef for a batch of granter/adder/setter ids (None dropped)."""
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = (await db.execute(
        select(Person.id, Person.display_name).where(Person.id.in_(wanted)))).all()
    return {pid: PersonRef(id=pid, display_name=name) for pid, name in rows}


async def _org_refs(db: DbSession, client_ids: set, partner_ids: set) -> dict:
    """(kind, id) -> OrgRefOut."""
    out: dict = {}
    if client_ids:
        for cid, name in (await db.execute(
                select(Client.id, Client.name).where(Client.id.in_(client_ids)))).all():
            out[("client", cid)] = OrgRefOut(kind="client", id=cid, name=name)
    if partner_ids:
        for pid, name in (await db.execute(
                select(Partner.id, Partner.name).where(Partner.id.in_(partner_ids)))).all():
            out[("partner", pid)] = OrgRefOut(kind="partner", id=pid, name=name)
    return out


@router.get("/{person_id}", response_model=UserDetailOut)
async def get_user_detail(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("users", "view"),
) -> UserDetailOut:
    """Everything the user detail page shows, in one payload. Row visibility
    matches the list (users:view + scope). The access block keeps the
    Explorer's rank-60 rule; sessions need users:change and a global actor."""
    query = (select(Person, UserAccount)
             .join(UserAccount, UserAccount.person_id == Person.id)
             .where(Person.id == person_id))
    cond = scope_conditions("users", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    row = (await db.execute(query)).first()
    if row is None:
        raise _err(404, "user_not_found")
    person, account = row
    now = datetime.now(UTC)

    # ── roles: active grants with rank, org, granter ──
    grant_rows = (await db.execute(
        select(PersonRole, Role)
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.person_id == person_id, PersonRole.revoked_at.is_(None))
        .order_by(Role.rank.desc(), Role.name))).all()
    orgs = await _org_refs(
        db, {g.client_id for g, _ in grant_rows if g.client_id},
        {g.partner_id for g, _ in grant_rows if g.partner_id})

    # ── worker card ──
    worker: UserWorkerCard | None = None
    profile = await db.get(WorkerProfile, person_id)
    if profile is not None:
        partner = await db.get(Partner, profile.partner_id) if profile.partner_id else None
        level_row = await db.get(WorkerLevel, profile.level) if profile.level else None
        worker = UserWorkerCard(
            trade=profile.trade,
            level_title=level_row.title if level_row else None,
            partner=PartnerRef(id=partner.id, name=partner.name) if partner else None,
            **level_fields(profile.level, await level_colors(db)),
            **status_fields(profile.status, await status_labels(db, "worker")),
        )

    # ── notification groups (enabled only; channels = effective) ──
    ng_rows = (await db.execute(
        select(NotificationGroup, NotificationGroupMember)
        .join(NotificationGroupMember,
              NotificationGroupMember.group_id == NotificationGroup.id)
        .where(NotificationGroupMember.person_id == person_id,
               NotificationGroup.enabled.is_(True))
        .order_by(NotificationGroup.name))).all()
    notification_groups = [
        UserNotificationGroup(id=g.id, name=g.name,
                              channels=effective_settings(g, m)["channels"],
                              added_at=m.added_at)
        for g, m in ng_rows]

    # ── access block (rank-60 rule, same as /access/effective) ──
    access_block: UserAccessBlock | None = None
    can_see_access = actor.access.can("access", "view") and (
        actor.access.max_rank >= GATE_BYPASS_RANK or person_id == actor.person.id)
    override_rows: list[PermissionOverride] = []
    group_member_rows: list = []
    if can_see_access:
        eff = await effective_cells(db, person_id)
        group_member_rows = (await db.execute(
            select(AccessGroup, AccessGroupMember)
            .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
            .where(AccessGroupMember.person_id == person_id)
            .order_by(AccessGroup.name))).all()
        gates_by_group: dict = {}
        if group_member_rows:
            gids = [g.id for g, _ in group_member_rows]
            for res, gid in (await db.execute(
                    select(ResourceGroupGate.resource, ResourceGroupGate.group_id)
                    .where(ResourceGroupGate.group_id.in_(gids)))).all():
                gates_by_group.setdefault(gid, []).append(res)
        override_rows = list(await db.scalars(
            select(PermissionOverride)
            .where(PermissionOverride.person_id == person_id)
            .order_by(PermissionOverride.resource, PermissionOverride.action)))
        scope_orgs_map = await _org_refs(db, set(eff.access.client_ids),
                                         set(eff.access.partner_ids))

    # one batched name lookup for every "who did it" column
    refs = await _person_refs(
        db,
        {g.granted_by for g, _ in grant_rows}
        | {m.added_by for _, m in group_member_rows}
        | {o.set_by for o in override_rows})

    if can_see_access:
        access_block = UserAccessBlock(
            groups=[UserAccessGroupRow(
                id=g.id, name=g.name, description=g.description,
                gate_count=len(gates_by_group.get(g.id, [])),
                gated_pages=sorted(REGISTRY[r].label for r in gates_by_group.get(g.id, [])
                                   if r in REGISTRY),
                added_by=refs.get(m.added_by), added_at=m.added_at)
                for g, m in group_member_rows],
            overrides=[UserOverrideRow(
                resource=o.resource,
                resource_label=REGISTRY[o.resource].label if o.resource in REGISTRY
                               else o.resource,
                action=o.action, allow=o.allow, set_by=refs.get(o.set_by), set_at=o.set_at)
                for o in override_rows],
            scope=eff.scope,
            scope_orgs=[scope_orgs_map[k] for k in sorted(scope_orgs_map, key=str)],
            cells=eff.cells,
        )

    # ── sessions (admin view) ──
    sessions: list[UserSessionRow] | None = None
    if actor.access.can("users", "change") and actor.access.is_global:
        sessions = [UserSessionRow(**r) for r in await live_session_rows(db, person_id)]

    person_out = UserDetailPerson.model_validate(person)
    person_out.avatar_url = presign_get(person.avatar_key)
    return UserDetailOut(
        person=person_out,
        account=UserDetailAccount(
            login_email=account.email, status=_status(account, now),
            must_change_password=account.must_change_password,
            last_login_at=account.last_login_at, created_at=account.created_at,
            password_updated_at=account.password_updated_at),
        roles=[UserRoleGrant(
            role=role.name, label=role.label or role.name, rank=role.rank,
            scope_anchor=role.scope_anchor,
            org=(orgs.get(("client", g.client_id)) if g.client_id
                 else orgs.get(("partner", g.partner_id)) if g.partner_id else None),
            granted_by=refs.get(g.granted_by), granted_at=g.granted_at)
            for g, role in grant_rows],
        max_rank=max((role.rank for _, role in grant_rows), default=0),
        worker=worker,
        notification_groups=notification_groups,
        access=access_block,
        sessions=sessions,
    )
```

Route-ordering note: FastAPI matches `/{person_id}` only for GET; the existing POST/PUT/PATCH routes under `/{person_id}/...` are unaffected. `UserDetailPerson.model_validate(person)` works because `PersonDetail` sets `from_attributes=True` and `Person` has `source`, `source_ref`, `archived_at` columns.

- [ ] **Step 5: Run the tests**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_users_detail_api.py tests/test_users_api.py
```
Expected: all pass. If `status_label` for `"active"` is empty because the test DB has no worker vocabulary, the assertion `assert body["worker"]["status_label"]` still passes (`status_fields` falls back to the key). If `REGISTRY["clients"].label` is not exactly `"Clients"`, read `api/src/serversherpa/access/resources.py` and fix the test's expected label, not the code.

- [ ] **Step 6: Lint and commit**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && .venv/bin/ruff check src/serversherpa/api/routes/users.py src/serversherpa/api/schemas.py tests/test_users_detail_api.py`
Expected: clean (remove any import not yet used; Tasks 3–4 re-add theirs).

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/api/routes/users.py api/src/serversherpa/api/schemas.py api/tests/test_users_detail_api.py && git commit -m "feat(api): GET /users/{id} aggregated detail payload

Profile, account, role grants (org + granter), worker card, notification groups,
access block (rank-60 rule as /access/effective), live sessions (users:change).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `GET /users/{person_id}/activity`

**Files:**
- Modify: `api/src/serversherpa/api/routes/users.py` (after `get_user_detail`)
- Test: `api/tests/test_users_detail_api.py` (append)

**Interfaces:**
- Consumes: `person_activity` (Task 1), `MyActivityItem` schema.
- Produces: `GET /users/{id}/activity -> list[MyActivityItem]` (audit:view + global; 404 `user_not_found`).

- [ ] **Step 1: Append the failing tests**

```python
# ── GET /users/{id}/activity ────────────────────────────────────────

async def test_activity_requires_audit_view(client, db, seeded_user):
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    staff = await _login(client, "alice@test.example.com")     # staff has no audit:view
    assert (await client.get(f"/users/{wan.id}/activity", headers=staff)).status_code == 403


async def test_activity_rows_acted_and_about(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    # about-wan row (actor = alice) via the real roles endpoint
    assert (await client.put(f"/users/{wan.id}/roles", headers=admin,
                             json={"roles": ["staff", "worker"]})).status_code == 200
    # acted-by-wan row
    db.add(AuditLog(actor_person_id=wan.id, entity_type="site", entity_id=None,
                    action="site.create", changes={}))
    await db.commit()

    resp = await client.get(f"/users/{wan.id}/activity", headers=admin)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    by_action = {r["action"]: r for r in rows}
    assert by_action["role.set"]["by_me"] is False
    assert by_action["role.set"]["actor_name"] == "Alice Anderson"
    assert by_action["site.create"]["by_me"] is True
    assert by_action["site.create"]["actor_name"] is None

    ghost = Person(first_name="No", last_name="Account")
    db.add(ghost)
    await db.commit()
    assert (await client.get(f"/users/{ghost.id}/activity", headers=admin)).status_code == 404
```

- [ ] **Step 2: Run to verify they fail**

Run the file as in Task 2 Step 5. Expected: the two new tests FAIL (404/405).

- [ ] **Step 3: Add the endpoint** (after `get_user_detail`)

```python
@router.get("/{person_id}/activity", response_model=list[MyActivityItem])
async def user_activity(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("audit", "view"),
) -> list[MyActivityItem]:
    """The History tab: rows this person acted in plus rows about their
    person/account/sign-ins — the same query /auth/me/activity runs, pointed
    at the target. `by_me` means the *target* acted."""
    await _require_global(actor)
    account = await db.get(UserAccount, person_id)
    if account is None:
        raise _err(404, "user_not_found")
    rows = await person_activity(db, person_id, account.email, limit=100)
    return [MyActivityItem(**row) for row in rows]
```

- [ ] **Step 4: Run, lint, commit**

Run the test file + ruff as before. Expected: all pass, ruff clean.

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/api/routes/users.py api/tests/test_users_detail_api.py && git commit -m "feat(api): GET /users/{id}/activity for the user History tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `PUT /users/{id}/access-groups` and `POST /users/{id}/sessions/revoke-all`

**Files:**
- Modify: `api/src/serversherpa/api/routes/users.py` (after `set_roles`)
- Test: `api/tests/test_users_detail_api.py` (append)

**Interfaces:**
- Consumes: `_load_target`, `_revoke_all_sessions`, `audit` (all existing in `users.py`); `AccessGroupsUpdateIn`, `AccessGroupsOut` (Task 2).
- Produces: `PUT /users/{id}/access-groups {group_ids} -> {group_ids}` (access:change; 403 `rank_too_low` / `cannot_target_self`; 404 `group_not_found` / `user_not_found`; audit `person` / `access_groups.set`). `POST /users/{id}/sessions/revoke-all -> 204` (users:change; audit `auth` / `session.revoke_all`).

- [ ] **Step 1: Append the failing tests**

```python
# ── PUT /users/{id}/access-groups ───────────────────────────────────

async def test_set_access_groups_diffs_and_audits(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    g1 = (await client.post("/access/groups", headers=admin, json={"name": "Finance"})).json()["id"]
    g2 = (await client.post("/access/groups", headers=admin, json={"name": "Ops"})).json()["id"]
    assert (await client.put(f"/access/groups/{g1}/members", headers=admin,
                             json={"person_ids": [str(wan.id)]})).status_code == 200

    resp = await client.put(f"/users/{wan.id}/access-groups", headers=admin,
                            json={"group_ids": [g2]})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"group_ids": [g2]}
    members = list(await db.scalars(
        select(AccessGroupMember.group_id).where(AccessGroupMember.person_id == wan.id)))
    assert [str(m) for m in members] == [g2]
    added = await db.scalar(select(AccessGroupMember.added_by)
                            .where(AccessGroupMember.person_id == wan.id))
    assert added == seeded_user.id

    log = await db.scalar(select(AuditLog).where(AuditLog.action == "access_groups.set"))
    assert log.entity_type == "person" and log.entity_id == str(wan.id)
    assert log.changes == {"groups": {"from": ["Finance"], "to": ["Ops"]}}

    # unknown group -> 404, nothing changed
    resp = await client.put(f"/users/{wan.id}/access-groups", headers=admin,
                            json={"group_ids": [g2, "00000000-0000-0000-0000-000000000001"]})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "group_not_found"


async def test_set_access_groups_guards(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    gid = (await client.post("/access/groups", headers=admin, json={"name": "Sec"})).json()["id"]
    # self
    resp = await client.put(f"/users/{seeded_user.id}/access-groups", headers=admin,
                            json={"group_ids": [gid]})
    assert resp.json()["detail"]["code"] == "cannot_target_self"
    # outranked target
    boss = await _add_user(db, first="B", last="Oss",
                           email="boss@test.example.com", role="super_admin")
    resp = await client.put(f"/users/{boss.id}/access-groups", headers=admin,
                            json={"group_ids": [gid]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


# ── POST /users/{id}/sessions/revoke-all ────────────────────────────

async def test_revoke_all_sessions(client, db, seeded_user):
    admin = await login_admin(client, db, seeded_user)
    wan = await _add_user(db, first="Wan", last="Worker",
                          email="wan@test.example.com", role="staff")
    await _token(client, email="wan@test.example.com")
    await _token(client, email="wan@test.example.com")
    live = list(await db.scalars(select(AuthSession).where(
        AuthSession.person_id == wan.id, AuthSession.revoked_at.is_(None))))
    assert len(live) >= 2

    resp = await client.post(f"/users/{wan.id}/sessions/revoke-all", headers=admin)
    assert resp.status_code == 204, resp.text
    db.expire_all()
    still_live = list(await db.scalars(select(AuthSession).where(
        AuthSession.person_id == wan.id, AuthSession.revoked_at.is_(None))))
    assert still_live == []
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "session.revoke_all"))
    assert log.entity_type == "auth" and log.entity_id == str(wan.id)

    body = (await client.get(f"/users/{wan.id}", headers=admin)).json()
    assert body["sessions"] == []
```

- [ ] **Step 2: Run to verify they fail** (same command). Expected: the three new tests FAIL.

- [ ] **Step 3: Add the endpoints** (after `set_roles`, before `admin_update_profile`)

```python
@router.put("/{person_id}/access-groups", response_model=AccessGroupsOut)
async def set_access_groups(
    person_id: uuid.UUID,
    body: AccessGroupsUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> AccessGroupsOut:
    """Person-centered group membership: the full desired set, diffed.
    Same rank rules as PUT /access/groups/{id}/members, one audit row on
    the person instead of one per group."""
    await _load_target(db, actor, person_id)
    desired = set(body.group_ids)
    current_rows = list(await db.scalars(
        select(AccessGroupMember).where(AccessGroupMember.person_id == person_id)))
    current = {m.group_id for m in current_rows}
    names = {g.id: g.name for g in await db.scalars(
        select(AccessGroup).where(AccessGroup.id.in_((desired | current) or {uuid.uuid4()})))}
    if any(gid not in names for gid in desired):
        raise _err(404, "group_not_found")
    if desired != current:
        for gid in current - desired:
            await db.execute(AccessGroupMember.__table__.delete().where(
                AccessGroupMember.group_id == gid,
                AccessGroupMember.person_id == person_id))
        for gid in desired - current:
            db.add(AccessGroupMember(group_id=gid, person_id=person_id,
                                     added_by=actor.person.id))
        audit(db, actor_id=actor.person.id, entity_type="person",
              entity_id=str(person_id), action="access_groups.set",
              changes={"groups": {"from": sorted(names[g] for g in current),
                                  "to": sorted(names[g] for g in desired)}})
        await db.commit()
    return AccessGroupsOut(group_ids=sorted(desired, key=str))


@router.post("/{person_id}/sessions/revoke-all", status_code=204)
async def revoke_all_user_sessions(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> None:
    """Sign the person out everywhere without disabling them."""
    await _load_target(db, actor, person_id)
    await _revoke_all_sessions(db, person_id, reason="admin_revoke")
    audit(db, actor_id=actor.person.id, entity_type="auth",
          entity_id=str(person_id), action="session.revoke_all", changes={})
    await db.commit()
```

- [ ] **Step 4: Run the whole new file plus neighbors, lint, commit**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_users_detail_api.py tests/test_users_api.py tests/test_access_groups_api.py tests/test_me_api.py && .venv/bin/ruff check src/serversherpa/api/routes/users.py tests/test_users_detail_api.py
```
Expected: all pass, ruff clean.

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/api/routes/users.py api/tests/test_users_detail_api.py && git commit -m "feat(api): PUT /users/{id}/access-groups and POST /users/{id}/sessions/revoke-all

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Portal API client, shared user helpers, `ActivityHistory.subjectName`

**Files:**
- Modify: `portal/src/lib/api.ts` (after `adminUpdateProfileRequest`, ~line 495)
- Modify: `portal/src/lib/users.ts` (add `ROLE_CLS`, `toManagedUser`, `toMemberItem`)
- Modify: `portal/src/pages/Users.tsx:43-46` (remove local `ROLE_CLS`, import it)
- Modify: `portal/src/components/ActivityHistory.tsx`
- Test: `portal/src/components/ActivityHistory.test.tsx` (create), `portal/src/lib/users.test.ts` (create or append if present)

**Interfaces:**
- Produces (api.ts): `UserDetailOut` and nested types mirroring Task 2 field for field; `getUserDetail(id)`, `getUserActivity(id): Promise<MyActivityItem[]>`, `setUserAccessGroups(id, groupIds: string[]): Promise<string[]>`, `revokeAllUserSessions(id): Promise<void>`.
- Produces (users.ts): `ROLE_CLS: Record<string,string>`, `toManagedUser(d: UserDetailOut): ManagedUser`, `toMemberItem(d: UserDetailOut): MemberItem`.
- Produces (ActivityHistory): prop `subjectName?: string`.

- [ ] **Step 1: Write the failing tests**

Create `portal/src/components/ActivityHistory.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import ActivityHistory from './ActivityHistory';
import type { MyActivityItem } from '../lib/api';

afterEach(cleanup);

const ROWS: MyActivityItem[] = [
  { id: 'r1', at: '2026-09-15T10:00:00Z', action: 'site.create', entity_type: 'site',
    entity_id: null, ip: null, by_me: true, actor_name: null, changes: {},
    entity_name: null, entity_summary: {} },
  { id: 'r2', at: '2026-09-15T09:00:00Z', action: 'role.set', entity_type: 'person',
    entity_id: 'p1', ip: null, by_me: false, actor_name: 'Alice Anderson', changes: {},
    entity_name: 'Wan Worker', entity_summary: {} },
];

it('labels by_me rows "You" by default', () => {
  render(<MemoryRouter><ActivityHistory rows={ROWS} /></MemoryRouter>);
  expect(screen.getAllByText('You').length).toBeGreaterThan(0);
  expect(screen.getByText('Alice Anderson')).toBeTruthy();
});

it('labels by_me rows with subjectName when given', () => {
  render(<MemoryRouter><ActivityHistory rows={ROWS} subjectName="Wan Worker" /></MemoryRouter>);
  expect(screen.queryByText('You')).toBeNull();
  expect(screen.getAllByText('Wan Worker').length).toBeGreaterThan(0);
});
```

Create `portal/src/lib/users.test.ts` (if a file with that name already exists, append the two `it` blocks and merge imports):

```ts
import { describe, expect, it } from 'vitest';

import { ROLE_CLS, toManagedUser, toMemberItem } from './users';
import type { UserDetailOut } from './api';

const DETAIL: UserDetailOut = {
  person: {
    id: 'p1', first_name: 'Wan', last_name: 'Worker', preferred_name: null,
    display_name: 'Wan Worker', email: 'wan@x.test', phone: null, job_title: 'Tech',
    address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
    country: 'US', badge_uid: 'B1', created_at: '2026-01-01T00:00:00Z', avatar_key: null,
    avatar_url: null, password_updated_at: null, source: 'manual', source_ref: null,
    archived_at: null,
  },
  account: { login_email: 'wan@x.test', status: 'active', must_change_password: false,
    last_login_at: null, created_at: '2026-01-01T00:00:00Z', password_updated_at: null },
  roles: [{ role: 'staff', label: 'Staff', rank: 40, scope_anchor: 'global', org: null,
    granted_by: null, granted_at: '2026-01-01T00:00:00Z' }],
  max_rank: 40, worker: null, notification_groups: [], access: null, sessions: null,
};

describe('user detail adapters', () => {
  it('ROLE_CLS maps the six roles', () => {
    expect(ROLE_CLS.admin).toBe('c-amber');
    expect(ROLE_CLS.worker).toBe('c-green');
  });
  it('toManagedUser flattens person + account + roles', () => {
    const m = toManagedUser(DETAIL);
    expect(m).toEqual({
      person_id: 'p1', display_name: 'Wan Worker', first_name: 'Wan', last_name: 'Worker',
      preferred_name: null, job_title: 'Tech', contact_email: 'wan@x.test', phone: null,
      roles: ['staff'], status: 'active', max_rank: 40, avatar_url: null,
    });
  });
  it('toMemberItem carries login email and roles', () => {
    expect(toMemberItem(DETAIL)).toEqual({
      person_id: 'p1', display_name: 'Wan Worker', job_title: 'Tech',
      login_email: 'wan@x.test', status: 'active', roles: ['staff'], max_rank: 40,
      avatar_url: null,
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/components/ActivityHistory.test.tsx src/lib/users.test.ts`
Expected: FAIL (missing exports / prop ignored).

- [ ] **Step 3: Add the API types and helpers to `portal/src/lib/api.ts`**

Insert directly after `adminUpdateProfileRequest`:

```ts
/* ── user detail page (GET /users/{id}) ────────────────────────── */

export interface PersonRef { id: string; display_name: string }
export interface OrgRefOut { kind: 'client' | 'partner'; id: string; name: string }

export interface UserDetailPerson extends PersonDetail {
  source: string;
  source_ref: string | null;
  archived_at: string | null;
}

export interface UserDetailAccount {
  login_email: string | null;
  status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  password_updated_at: string | null;
}

export interface UserRoleGrant {
  role: string; label: string; rank: number; scope_anchor: string;
  org: OrgRefOut | null; granted_by: PersonRef | null; granted_at: string;
}

export interface UserWorkerCard {
  trade: string | null; level: string | null; level_title: string | null;
  level_color: string | null; partner: { id: string; name: string } | null;
  status: string; status_label: string; status_color: string;
}

export interface UserNotificationGroup {
  id: string; name: string; channels: string[]; added_at: string;
}

export interface UserAccessGroupRow {
  id: string; name: string; description: string; gate_count: number;
  gated_pages: string[]; added_by: PersonRef | null; added_at: string;
}

export interface UserOverrideRow {
  resource: string; resource_label: string; action: string; allow: boolean;
  set_by: PersonRef | null; set_at: string;
}

export interface UserAccessBlock {
  groups: UserAccessGroupRow[];
  overrides: UserOverrideRow[];
  scope: ScopeInfo;
  scope_orgs: OrgRefOut[];
  cells: Record<string, Record<Action, EffectiveCell>>;
}

export interface UserSessionRow {
  family_id: string; started_at: string; last_active_at: string; expires_at: string;
  ip_address: string | null; user_agent: string | null;
}

export interface UserDetailOut {
  person: UserDetailPerson;
  account: UserDetailAccount;
  roles: UserRoleGrant[];
  max_rank: number;
  worker: UserWorkerCard | null;
  notification_groups: UserNotificationGroup[];
  access: UserAccessBlock | null;
  sessions: UserSessionRow[] | null;
}

export async function getUserDetail(personId: string): Promise<UserDetailOut> {
  const resp = await apiFetch(`/users/${personId}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getUserActivity(personId: string): Promise<MyActivityItem[]> {
  const resp = await apiFetch(`/users/${personId}/activity`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function setUserAccessGroups(
  personId: string, groupIds: string[],
): Promise<string[]> {
  const resp = await apiFetch(`/users/${personId}/access-groups`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_ids: groupIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return (await resp.json()).group_ids as string[];
}

export async function revokeAllUserSessions(personId: string): Promise<void> {
  const resp = await apiFetch(`/users/${personId}/sessions/revoke-all`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}
```

`ScopeInfo`, `Action`, `EffectiveCell`, `MyActivityItem`, `PersonDetail` are all already declared in `api.ts`; if any is declared *below* this insertion point, TypeScript hoists interface declarations, so order does not matter.

- [ ] **Step 4: Add `ROLE_CLS` and adapters to `portal/src/lib/users.ts`**

Add near the top (after the imports):

```ts
import type { MemberItem, UserDetailOut } from './api';
import type { ManagedUser } from '../components/UserAdminModals';

/** Role chip palette — shared by the Users list and the user detail page. */
export const ROLE_CLS: Record<string, string> = {
  admin: 'c-amber', staff: 'c-blue', worker: 'c-green',
  client: 'c-violet', vendor: 'c-violet', external: 'c-blue',
};

/** The shape UserAdminModals (edit / reset / roles / state) expect. */
export function toManagedUser(d: UserDetailOut): ManagedUser {
  return {
    person_id: d.person.id,
    display_name: d.person.display_name,
    first_name: d.person.first_name,
    last_name: d.person.last_name,
    preferred_name: d.person.preferred_name,
    job_title: d.person.job_title,
    contact_email: d.person.email,
    phone: d.person.phone,
    roles: d.roles.map((r) => r.role),
    status: d.account.status,
    max_rank: d.max_rank,
    avatar_url: d.person.avatar_url,
  };
}

/** The shape OverrideEditor's `member` prop expects. */
export function toMemberItem(d: UserDetailOut): MemberItem {
  return {
    person_id: d.person.id,
    display_name: d.person.display_name,
    job_title: d.person.job_title,
    login_email: d.account.login_email,
    status: d.account.status,
    roles: d.roles.map((r) => r.role),
    max_rank: d.max_rank,
    avatar_url: d.person.avatar_url,
  };
}
```

`UserAdminModals.tsx` imports nothing from `lib/users.ts`, so the type import above creates no cycle. In `portal/src/pages/Users.tsx` delete the local `const ROLE_CLS = {...}` block (lines 43–46) and add `ROLE_CLS` to the existing `import { ... } from '../lib/users'` list.

- [ ] **Step 5: Add `subjectName` to `ActivityHistory`**

In `portal/src/components/ActivityHistory.tsx`:

```ts
function whoLabel(row: MyActivityItem, subject: string): string {
  return row.by_me ? subject : (row.actor_name ?? 'System');
}
```

Change the signature to `export default function ActivityHistory({ rows, subjectName }: { rows: MyActivityItem[]; subjectName?: string })`, add `const subject = subjectName ?? 'You';` as the first line of the body, and update every `whoLabel(r)` / `whoLabel(row)` call to `whoLabel(r, subject)`. In `facetGroups`, change `{ value: 'you', label: 'You' }` to `{ value: 'you', label: subject }` and add `subject` to that `useMemo`'s dependency list. Nothing else changes (the `activity-dot me` class stays keyed on `by_me`).

- [ ] **Step 6: Run the tests and type-check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/components/ActivityHistory.test.tsx src/lib/users.test.ts src/pages/Profile.test.tsx && npx tsc -b --noEmit`
Expected: all pass, tsc clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/lib/api.ts portal/src/lib/users.ts portal/src/lib/users.test.ts portal/src/pages/Users.tsx portal/src/components/ActivityHistory.tsx portal/src/components/ActivityHistory.test.tsx && git commit -m "feat(portal): user detail API client, shared ROLE_CLS/adapters, ActivityHistory subjectName

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `UserDetail` page shell + Profile tab

**Files:**
- Create: `portal/src/pages/UserDetail.tsx`
- Create: `portal/src/components/users/UserProfileTab.tsx`
- Create: `portal/src/styles/user-detail.css`
- Modify: `portal/src/App.tsx:127` (routes)
- Test: `portal/src/pages/UserDetail.test.tsx` (create)

**Interfaces:**
- Consumes: `getUserDetail`, `revokeAllUserSessions`, `toManagedUser` (Task 5); `AdminEditProfileModal`, `ResetPasswordModal`, `AccountStateModal` from `components/UserAdminModals`; `GodDeleteButton`; `AvatarUpload`; `STATUS_META` from `lib/users`; `RANK_LABELS`, `canTouchRank` from `lib/access`; `describeUserAgent`, `longDate`, `relativeTime` from `lib/format`.
- Produces: `UserDetail` default export; `UserProfileTab` props `{ detail: UserDetailOut; mode: DetailMode; onEdit(): void; onReset(): void; onSignOutAll(): void }`; exported type `DetailMode = 'self' | 'readonly' | 'manage' | 'view'` from `UserDetail.tsx`. Task 7 adds the Access tab through a `tab === 'access'` branch marked below; Task 8 adds History.

- [ ] **Step 1: Write the failing tests**

Create `portal/src/pages/UserDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * /people/users/:personId — hero, tabs, Profile tab panels, action gating.
 * The Access and History tabs get their own `it` blocks in later tasks.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { UserDetailOut } from '../lib/api';

const auth = vi.hoisted(() => ({
  personId: 'me-1',
  maxRank: 100,
  perms: new Set<string>(['users:view', 'users:change', 'access:view', 'access:change', 'audit:view']),
  godMode: false,
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: auth.personId, display_name: 'Me' },
    roles: ['admin'],
    maxRank: auth.maxRank,
    godMode: auth.godMode,
    can: (res: string, action = 'view') => auth.perms.has(`${res}:${action}`),
    preferences: { list_prefs: {} },
    updatePreferences: vi.fn(),
    applyProfile: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getUserDetail: vi.fn(),
  getUserActivity: vi.fn(async () => []),
  getAccessSummary: vi.fn(async () => ({
    stats: { members: 0, roles: 0, groups: 0, gated_resources: 0, overrides: 0 },
    resources: [{ id: 'clients', label: 'Clients', developer_only: false, always_viewable: false, gated_by: ['g1'] }],
    roles: [], groups: [{ id: 'g1', name: 'Finance', description: 'Money people', icon: 'users', member_count: 1, members: [] },
                        { id: 'g2', name: 'Ops', description: '', icon: 'users', member_count: 0, members: [] }],
  })),
  setUserAccessGroups: vi.fn(async (_id: string, ids: string[]) => ids),
  revokeAllUserSessions: vi.fn(async () => {}),
  getOverrides: vi.fn(async () => ({ overrides: {} })),
  putOverrides: vi.fn(async () => {}),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

export const DETAIL: UserDetailOut = {
  person: {
    id: 'p1', first_name: 'Wan', last_name: 'Worker', preferred_name: null,
    display_name: 'Wan Worker', email: 'wan@x.test', phone: '555-0100', job_title: 'Tech',
    address_line1: '1 Main St', address_line2: null, city: 'Dallas', region: 'TX',
    postal_code: '75001', country: 'US', badge_uid: 'BADGE-1',
    created_at: '2026-01-01T00:00:00Z', avatar_key: null, avatar_url: null,
    password_updated_at: null, source: 'v2_import', source_ref: 'v2:people:42', archived_at: null,
  },
  account: { login_email: 'wan@x.test', status: 'active', must_change_password: true,
    last_login_at: '2026-09-14T12:00:00Z', created_at: '2026-01-02T00:00:00Z',
    password_updated_at: '2026-08-01T00:00:00Z' },
  roles: [
    { role: 'staff', label: 'Staff', rank: 40, scope_anchor: 'global', org: null,
      granted_by: { id: 'me-1', display_name: 'Me' }, granted_at: '2026-01-02T00:00:00Z' },
    { role: 'client_admin', label: 'Client admin', rank: 20, scope_anchor: 'client',
      org: { kind: 'client', id: 'c1', name: 'Acme' }, granted_by: null, granted_at: '2026-02-01T00:00:00Z' },
  ],
  max_rank: 40,
  worker: { trade: 'Cabling', level: 'l2', level_title: 'Journeyman', level_color: '#123456',
    partner: { id: 'pa1', name: 'Wire Co' }, status: 'active', status_label: 'Active', status_color: '#178a4c' },
  notification_groups: [{ id: 'ng1', name: 'Ops alerts', channels: ['email', 'web'], added_at: '2026-03-01T00:00:00Z' }],
  access: {
    groups: [{ id: 'g1', name: 'Finance', description: 'Money people', gate_count: 1, gated_pages: ['Clients'],
      added_by: { id: 'me-1', display_name: 'Me' }, added_at: '2026-04-01T00:00:00Z' }],
    overrides: [{ resource: 'sites', resource_label: 'Sites', action: 'delete', allow: true,
      set_by: { id: 'me-1', display_name: 'Me' }, set_at: '2026-05-01T00:00:00Z' }],
    scope: { global: true, client_ids: [], partner_ids: [] },
    scope_orgs: [],
    cells: { clients: { view: { value: true, source: 'role' }, add: { value: false, source: 'role' },
      change: { value: false, source: 'role' }, delete: { value: false, source: 'role' } } },
  },
  sessions: [{ family_id: 'f1', started_at: '2026-09-14T12:00:00Z', last_active_at: '2026-09-14T13:00:00Z',
    expires_at: '2026-09-21T12:00:00Z', ip_address: '10.0.0.5', user_agent: 'Mozilla/5.0 (Macintosh) Chrome/128' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.personId = 'me-1';
  auth.maxRank = 100;
  auth.perms = new Set(['users:view', 'users:change', 'access:view', 'access:change', 'audit:view']);
  api.getUserDetail.mockResolvedValue(DETAIL);
});
afterEach(cleanup);

const { default: UserDetail } = await import('./UserDetail');

export function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/people/users/:personId" element={<UserDetail />} />
        <Route path="/people/users/:personId/access" element={<UserDetail />} />
        <Route path="/people/users/:personId/history" element={<UserDetail />} />
        <Route path="/me" element={<div>ME PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('renders the hero, three tabs, and the Profile panels', async () => {
  renderAt('/people/users/p1');
  expect(await screen.findByRole('heading', { level: 1, name: /Wan Worker/ })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Access' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'History' })).toBeTruthy();
  expect(screen.getByText('BADGE-1')).toBeTruthy();
  expect(screen.getByText('Imported from V2')).toBeTruthy();
  expect(screen.getByText('v2:people:42')).toBeTruthy();
  expect(screen.getByText('change required')).toBeTruthy();
  // memberships
  expect(screen.getByText('Cabling')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open worker page' }).getAttribute('href')).toBe('/people/workers/p1');
  expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe('/stakeholders/clients/c1');
  expect(screen.getByRole('link', { name: 'Ops alerts' }).getAttribute('href')).toBe('/system/notifications/ng1');
  // sessions
  expect(screen.getByText('10.0.0.5', { exact: false })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeTruthy();
});

it('hides the History tab without audit:view and the sessions panel when null', async () => {
  auth.perms.delete('audit:view');
  api.getUserDetail.mockResolvedValue({ ...DETAIL, sessions: null });
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.queryByRole('tab', { name: 'History' })).toBeNull();
  expect(screen.queryByText('Active sessions')).toBeNull();
});

it('self shows only "Go to My profile"', async () => {
  auth.personId = 'p1';
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.getByRole('button', { name: 'Go to My profile' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
});

it('an outranked person is read-only', async () => {
  auth.maxRank = 40;                     // same rank as Wan -> cannot touch
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.getByText(/rank is at or above yours/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Disable account' })).toBeNull();
});

it('Sign out everywhere confirms, posts, and reloads', async () => {
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out all sessions' }));
  await waitFor(() => expect(api.revokeAllUserSessions).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(api.getUserDetail).toHaveBeenCalledTimes(2));
});

it('shows the not-found state on 404', async () => {
  const { ApiError } = await import('../lib/api');
  api.getUserDetail.mockRejectedValue(new ApiError(404, 'user_not_found'));
  renderAt('/people/users/nope');
  expect(await screen.findByText('User not found')).toBeTruthy();
  expect(screen.getByRole('link', { name: '← Users' }).getAttribute('href')).toBe('/people/users');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/UserDetail.test.tsx`
Expected: FAIL — module `./UserDetail` not found.

- [ ] **Step 3: Create `portal/src/styles/user-detail.css`**

```css
/* User detail page (/people/users/:id) — layout only; typography comes
   from directory.css tokens and the /me profile.css panels. */

.ud-hero-chips { display: inline-flex; gap: 6px; align-items: center; margin-left: 10px; vertical-align: middle; }
.ud-panels { display: flex; flex-direction: column; gap: 18px; margin-top: 18px; }
.ud-membership-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 14px 0 6px; }
.ud-membership-head:first-child { margin-top: 0; }
.ud-row { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 12px; align-items: center; }
.ud-row-2 { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.4fr) auto; gap: 12px; align-items: center; }
.ud-note { color: var(--text-mute); padding: 6px 0; }
.ud-source-ref { display: block; margin-top: 2px; }
.ud-rank-note { border: 1px dashed var(--border, #d9dee7); border-radius: 10px; padding: 14px 16px; color: var(--text-mute); }
.ud-confirm-card { width: min(520px, 96vw); }
.ud-groups-card { width: min(760px, 96vw); max-width: 96vw; }
.ud-group-picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.ud-group-pick { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border, #d9dee7); background: var(--surface, #fff); cursor: pointer; }
.ud-group-pick.on { border-color: var(--accent, #d38b1d); box-shadow: inset 0 0 0 1px var(--accent, #d38b1d); }
.ud-group-pick:disabled { opacity: 0.45; cursor: not-allowed; }
.ud-group-pick .ud-group-meta { color: var(--text-mute); }
@media (max-width: 900px) {
  .ud-row, .ud-row-2 { grid-template-columns: 1fr; }
}
```

- [ ] **Step 4: Create `portal/src/components/users/UserProfileTab.tsx`**

```tsx
/**
 * UserProfileTab — the /me-shaped Profile tab for another user: Profile +
 * Account kv panels, then Memberships (worker profile, org affiliations,
 * notification groups) and Active sessions (admin view).
 */
import { Link } from 'react-router-dom';

import type { UserDetailOut } from '../../lib/api';
import { describeUserAgent, longDate, relativeTime } from '../../lib/format';
import { STATUS_META } from '../../lib/users';
import type { DetailMode } from '../../pages/UserDetail';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Added manually',
  v2_import: 'Imported from V2',
};

export default function UserProfileTab({ detail, mode, onEdit, onReset, onSignOutAll }: {
  detail: UserDetailOut;
  mode: DetailMode;
  onEdit: () => void;
  onReset: () => void;
  onSignOutAll: () => void;
}) {
  const { person, account, roles, worker, notification_groups: groups, sessions } = detail;
  const status = STATUS_META[account.status] ?? { label: account.status, cls: 'tag' };
  const canManage = mode === 'manage';
  const address = [person.address_line1, person.address_line2,
    [person.city, person.region, person.postal_code].filter(Boolean).join(', '),
    person.country]
    .filter((part) => part && String(part).length > 0)
    .join(' · ') || '—';
  const orgRoles = roles.filter((r) => r.org !== null);

  return (
    <>
      <div className="profile-grid">
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>Profile</h3>
              {canManage && <button className="mini-btn" onClick={onEdit}>Edit</button>}
            </div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Person ID</dt><dd className="mono">{person.id}</dd>
                <dt>Badge ID</dt><dd className="mono">{person.badge_uid}</dd>
                <dt>Preferred name</dt><dd>{person.preferred_name ?? '—'}</dd>
                <dt>Job title</dt><dd>{person.job_title ?? '—'}</dd>
                <dt>Contact email</dt><dd className="mono">{person.email ?? '—'}</dd>
                <dt>Phone</dt><dd className="mono">{person.phone ?? '—'}</dd>
                <dt>Address</dt><dd>{address}</dd>
                <dt>Source</dt>
                <dd>
                  {SOURCE_LABEL[person.source] ?? person.source}
                  {person.source_ref && <span className="mono ud-source-ref">{person.source_ref}</span>}
                </dd>
                <dt>Member since</dt><dd className="mono">{longDate(person.created_at)}</dd>
              </dl>
            </div>
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>Account</h3>
              {canManage && <button className="mini-btn" onClick={onReset}>Reset password</button>}
            </div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Login email</dt><dd className="mono">{account.login_email ?? '—'}</dd>
                <dt>Status</dt>
                <dd><span className={`chip ${status.cls}`}><span className="dot" />{status.label}</span></dd>
                <dt>Password</dt>
                <dd>{account.must_change_password
                  ? <span className="chip c-amber"><span className="dot" />change required</span>
                  : account.password_updated_at
                    ? `Last reset ${longDate(account.password_updated_at)}`
                    : 'set'}</dd>
                <dt>Last sign-in</dt>
                <dd className="mono" title={account.last_login_at ? new Date(account.last_login_at).toLocaleString() : undefined}>
                  {relativeTime(account.last_login_at)}
                </dd>
                <dt>Account created</dt><dd className="mono">{longDate(account.created_at)}</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <div className="profile-full">
        <div className="panel">
          <div className="panel-head"><h3>Memberships</h3></div>
          <div className="panel-body">
            <div className="ud-membership-head"><p className="eyebrow-sm" style={{ margin: 0 }}>Worker profile</p></div>
            {worker ? (
              <div className="mini-list">
                <div className="mini-row ud-row">
                  <span className="cell-top">{worker.trade ?? 'No trade set'}</span>
                  <span>{worker.level_title ?? 'Unleveled'}</span>
                  <span>{worker.partner?.name ?? 'Direct hire'}</span>
                  <Link className="mini-btn" to={`/people/workers/${person.id}`}>Open worker page</Link>
                </div>
              </div>
            ) : <p className="ud-note">Not a worker</p>}

            <div className="ud-membership-head"><p className="eyebrow-sm" style={{ margin: 0 }}>Org affiliations</p></div>
            {orgRoles.length === 0 ? <p className="ud-note">No client or partner roles</p> : (
              <div className="mini-list">
                {orgRoles.map((r) => (
                  <div key={`${r.role}:${r.org!.id}`} className="mini-row ud-row-2">
                    <Link className="cell-top" to={`/stakeholders/${r.org!.kind}s/${r.org!.id}`}>{r.org!.name}</Link>
                    <span className="chip tag">{r.label}</span>
                    <span className="mono">{longDate(r.granted_at)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="ud-membership-head"><p className="eyebrow-sm" style={{ margin: 0 }}>Notification groups</p></div>
            {groups.length === 0 ? <p className="ud-note">Not in any notification groups</p> : (
              <div className="mini-list">
                {groups.map((g) => (
                  <div key={g.id} className="mini-row ud-row-2">
                    <Link className="cell-top" to={`/system/notifications/${g.id}`}>{g.name}</Link>
                    <span className="chips">
                      {g.channels.length === 0 ? <span className="chip tag">muted</span>
                        : g.channels.map((c) => <span key={c} className="chip tag">{c}</span>)}
                    </span>
                    <span className="mono">{longDate(g.added_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {sessions !== null && (
        <div className="profile-full">
          <div className="panel">
            <div className="panel-head">
              <h3>Active sessions</h3>
              <span className="activity-tools">
                <span className="result-count">{sessions.length} live</span>
                {canManage && sessions.length > 0 && (
                  <button className="mini-btn danger" onClick={onSignOutAll}>Sign out everywhere</button>
                )}
              </span>
            </div>
            <div className="panel-body">
              {sessions.map((s) => (
                <div className="session-item" key={s.family_id}>
                  <div className="session-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                         strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="13" rx="2" />
                      <path d="M8 21h8M12 17v4" />
                    </svg>
                  </div>
                  <div className="session-main cell">
                    <div className="cell-top"><b>{describeUserAgent(s.user_agent)}</b></div>
                    <div className="mono">
                      {s.ip_address ?? 'unknown ip'} · started {relativeTime(s.started_at)} ·
                      expires {relativeTime(s.expires_at)}
                    </div>
                  </div>
                </div>
              ))}
              {sessions.length === 0 && (
                <p className="set-note" style={{ padding: 0 }}>No live sessions found.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Create `portal/src/pages/UserDetail.tsx`**

```tsx
/**
 * UserDetail — full page for one login user (/people/users/:personId),
 * styled like /me: eyebrow + hero, segmented tabs (Profile / Access /
 * History), profile-grid panels. Every admin action reuses the Users
 * directory's modals; the payload is one GET /users/{id}.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import GodDeleteButton from '../components/GodDeleteButton';
import {
  AccountStateModal, AdminEditProfileModal, ResetPasswordModal,
} from '../components/UserAdminModals';
import UserProfileTab from '../components/users/UserProfileTab';
import { canTouchRank, RANK_LABELS } from '../lib/access';
import { ApiError, getUserDetail, revokeAllUserSessions, type UserDetailOut } from '../lib/api';
import { longDate } from '../lib/format';
import { usePendingDeletes } from '../lib/pendingDeletes';
import { ROLE_CLS, STATUS_META, toManagedUser } from '../lib/users';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/access.css';
import '../styles/user-detail.css';

/** self = it's you; readonly = they outrank you; manage = full admin actions;
 *  view = you can see the row but hold no users:change / access:change. */
export type DetailMode = 'self' | 'readonly' | 'manage' | 'view';

type Tab = 'profile' | 'access' | 'history';
type Action =
  | { kind: 'edit' | 'reset' | 'signout' }
  | { kind: 'state'; action: 'disable' | 'enable' | 'unlock' };

export function rankLabel(rank: number): string | null {
  const hit = RANK_LABELS.find(([r]) => r === rank);
  return hit ? hit[1] : rank > 0 ? `Rank ${rank}` : null;
}

export default function UserDetail() {
  const { personId = '' } = useParams<{ personId: string }>();
  const { person: me, can, maxRank, godMode } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pd = usePendingDeletes(godMode);

  const tab: Tab = pathname.endsWith('/access') ? 'access'
    : pathname.endsWith('/history') ? 'history' : 'profile';
  const base = `/people/users/${personId}`;

  const [detail, setDetail] = useState<UserDetailOut | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setDetail(await getUserDetail(personId));
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) setMissing(true);
      else setLoadError('Could not load this user.');
    }
  }, [personId]);

  useEffect(() => { void load(); }, [load]);

  const back = <Link to="/people/users" className="idet-back">← Users</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>User not found</b>This person does not exist or has no login account.
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>{loadError}</b>
          <button className="mini-btn" style={{ marginTop: 8 }} onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }
  if (!detail) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const { person, account, roles } = detail;
  const isSelf = person.id === me?.id;
  const canTouch = !isSelf && canTouchRank(maxRank, detail.max_rank);
  const canManageUsers = canTouch && can('users', 'change');
  const canManageAccess = canTouch && can('access', 'change');
  const mode: DetailMode = isSelf ? 'self' : !canTouch ? 'readonly'
    : (canManageUsers || canManageAccess || godMode) ? 'manage' : 'view';
  const status = STATUS_META[account.status] ?? { label: account.status, cls: 'tag' };
  const rank = rankLabel(detail.max_rank);
  const managed = toManagedUser(detail);
  const showHistory = can('audit', 'view');
  const joined = [person.city, person.region].filter(Boolean).join(', ');

  const signOutAll = async () => {
    setSigningOut(true);
    try {
      await revokeAllUserSessions(person.id);
      setAction(null);
      await load();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="portal-page">
      {back}
      <div className="eyebrow">People › Users</div>

      <div className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-id">
          <AvatarUpload
            name={person.display_name}
            url={person.avatar_url}
            entityType="person"
            entityId={person.id}
            editable={canManageUsers}
            size={104}
            radius={26}
            onUploaded={() => void load()}
          />
          <div className="profile-meta">
            <h1>
              {person.display_name}
              <span className="ud-hero-chips">
                <span className={`chip ${status.cls}`}><span className="dot" />{status.label}</span>
                {rank && <span className="chip tag">{rank}</span>}
              </span>
            </h1>
            <div className="pm-role">
              {person.job_title ?? 'No title set'} · {roles.length
                ? roles.map((r) => (
                  <span key={r.role} className={`chip ${ROLE_CLS[r.role] ?? 'tag'}`}
                        style={{ marginRight: 4 }}>{r.label}</span>))
                : 'no roles'}
            </div>
            <div className="pm-sub">
              {person.email && <span>✉ {person.email}</span>}
              {person.phone && <span>☏ {person.phone}</span>}
              {joined && <span>⌖ {joined}</span>}
              <span>joined {longDate(account.created_at)}</span>
            </div>
          </div>
          <div className="profile-actions">
            {mode === 'self' && (
              <button className="btn-solid" onClick={() => navigate('/me')}>Go to My profile</button>
            )}
            {mode === 'readonly' && (
              <span className="ro-chip">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="9" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                Read-only · their rank is at or above yours
              </span>
            )}
            {mode === 'manage' && canManageUsers && (
              <>
                <button className="btn-solid" onClick={() => setAction({ kind: 'edit' })}>Edit profile</button>
                <button className="mini-btn" onClick={() => setAction({ kind: 'reset' })}>Reset password</button>
                {account.status === 'locked' && (
                  <button className="mini-btn" onClick={() => setAction({ kind: 'state', action: 'unlock' })}>Unlock</button>
                )}
                {account.status === 'disabled' ? (
                  <button className="mini-btn" onClick={() => setAction({ kind: 'state', action: 'enable' })}>Enable account</button>
                ) : (
                  <button className="mini-btn danger" onClick={() => setAction({ kind: 'state', action: 'disable' })}>Disable account</button>
                )}
              </>
            )}
            {mode === 'manage' && (
              <GodDeleteButton visible={godMode} entityType="person"
                               entityId={person.id} label={person.display_name}
                               pending={pd.pendingIds.has(person.id)}
                               onChange={pd.pendingIds.has(person.id)
                                 ? () => pd.unmark(person.id)
                                 : () => pd.mark('person', person.id, person.display_name)} />
            )}
          </div>
        </div>
      </div>

      <div className="segmented me-tabs" role="tablist">
        {([['profile', 'Profile', base], ['access', 'Access', `${base}/access`],
           ['history', 'History', `${base}/history`]] as const)
          .filter(([key]) => key !== 'history' || showHistory)
          .map(([key, label, to]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''}
                    onClick={() => navigate(to)}>
              {label}
            </button>
          ))}
      </div>

      {tab === 'profile' && (
        <UserProfileTab detail={detail} mode={canManageUsers ? 'manage' : mode}
                        onEdit={() => setAction({ kind: 'edit' })}
                        onReset={() => setAction({ kind: 'reset' })}
                        onSignOutAll={() => setAction({ kind: 'signout' })} />
      )}
      {/* Task 7 adds: tab === 'access' && <UserAccessTab … /> */}
      {/* Task 8 adds: tab === 'history' && showHistory && <UserHistoryTab … /> */}

      {action?.kind === 'edit' && (
        <AdminEditProfileModal user={managed}
          onClose={() => setAction(null)}
          onSaved={() => { setAction(null); void load(); }}
          onAvatarChanged={() => void load()} />
      )}
      {action?.kind === 'reset' && (
        <ResetPasswordModal user={managed}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); void load(); }} />
      )}
      {action?.kind === 'state' && (
        <AccountStateModal user={managed} action={action.action}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); void load(); }} />
      )}
      {action?.kind === 'signout' && (
        <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !signingOut) setAction(null); }}>
          <div className="modal-card reports-modal-card rgm-card ud-confirm-card" role="dialog" aria-label="Sign out everywhere">
            <div className="modal-head">
              <div className="rgm-head-text">
                <div className="eyebrow">Sessions</div>
                <h3>Sign out everywhere</h3>
                <p className="page-hint">
                  Every live sign-in for {person.display_name} is revoked immediately. Their account stays enabled and they can sign in again with their password.
                </p>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn-solid" onClick={() => void signOutAll()} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out all sessions'}
              </button>
              <button className="mini-btn" onClick={() => setAction(null)} disabled={signingOut}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

`reports.css` (the `.rgm-*` rules) is imported by the Reports page; add `import '../styles/reports.css';` to the import block so the confirm card is styled when the page is opened cold.

- [ ] **Step 6: Add the routes to `portal/src/App.tsx`**

Add `import UserDetail from './pages/UserDetail';` next to the other page imports, and directly after the `/people/users` route:

```tsx
                <Route path="/people/users/:personId" element={
                  <ProtectedRoute resource="users"><UserDetail /></ProtectedRoute>
                } />
                <Route path="/people/users/:personId/access" element={
                  <ProtectedRoute resource="users"><UserDetail /></ProtectedRoute>
                } />
                <Route path="/people/users/:personId/history" element={
                  <ProtectedRoute resource="users"><UserDetail /></ProtectedRoute>
                } />
```

- [ ] **Step 7: Run the tests, type-check, guardrail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/UserDetail.test.tsx src/styles/listTypography.test.ts && npx tsc -b --noEmit`
Expected: the six Task-6 tests pass; guardrail green; tsc clean. If the guardrail flags `.ud-row` / `.ud-row-2` as `mini-row` co-classes setting `display`/`gap`, rename them so they are applied on a wrapping `<div>` inside the `mini-row` instead of on the `mini-row` element itself, and re-run.

- [ ] **Step 8: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/pages/UserDetail.tsx portal/src/pages/UserDetail.test.tsx portal/src/components/users/UserProfileTab.tsx portal/src/styles/user-detail.css portal/src/App.tsx && git commit -m "feat(portal): user detail page shell and Profile tab (/people/users/:personId)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Access tab + Manage groups modal

**Files:**
- Create: `portal/src/components/users/UserAccessTab.tsx`
- Create: `portal/src/components/users/ManageGroupsModal.tsx`
- Modify: `portal/src/pages/UserDetail.tsx` (the `tab === 'access'` branch)
- Test: `portal/src/pages/UserDetail.test.tsx` (append)

**Interfaces:**
- Consumes: `getAccessSummary`, `setUserAccessGroups` (api.ts); `MatrixTable` (`components/access/MatrixTable`, props `mode="effective" resources cells editable={false}`); `OverrideEditor` (`components/access/OverrideEditor`, props `summary member canEdit maxRank selfId onClose onSaved`); `ManageRolesModal` (`components/UserAdminModals`, props `user onClose onSaved`); `DataTable`; `toMemberItem`, `toManagedUser`, `ROLE_CLS`.
- Produces: `UserAccessTab` props `{ detail: UserDetailOut; canManageAccess: boolean; selfId: string | null; maxRank: number; onChanged(): void }`; `ManageGroupsModal` props `{ user: { person_id: string; display_name: string; max_rank: number }; summary: AccessSummary; currentIds: string[]; onClose(): void; onSaved(): void }`.

- [ ] **Step 1: Append the failing tests to `UserDetail.test.tsx`**

```tsx
it('Access tab renders four panels with real tables', async () => {
  renderAt('/people/users/p1/access');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.getByRole('tab', { name: 'Access' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('table', { name: 'Roles' })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Access groups' })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Overrides' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Effective permissions' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Finance' }).getAttribute('href')).toBe('/access?tab=groups&group=g1');
  expect(screen.getByText('Money people')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Manage roles' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Manage groups' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Edit overrides' })).toBeTruthy();
});

it('Access tab shows the rank note when the access block is null but keeps Manage roles', async () => {
  api.getUserDetail.mockResolvedValue({ ...DETAIL, access: null });
  renderAt('/people/users/p1/access');
  await screen.findByRole('table', { name: 'Roles' });
  expect(screen.getByText(/visible to admins at rank 60 and above/)).toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Access groups' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Manage roles' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Manage groups' })).toBeNull();
});

it('Manage groups toggles and saves the full id list', async () => {
  renderAt('/people/users/p1/access');
  fireEvent.click(await screen.findByRole('button', { name: 'Manage groups' }));
  const ops = await screen.findByRole('button', { name: /^Ops/ });
  fireEvent.click(ops);                                   // add Ops (Finance already on)
  fireEvent.click(screen.getByRole('button', { name: 'Save groups' }));
  await waitFor(() => expect(api.setUserAccessGroups).toHaveBeenCalledWith('p1', ['g1', 'g2']));
  await waitFor(() => expect(api.getUserDetail).toHaveBeenCalledTimes(2));
});

it('Manage groups surfaces rank_too_low', async () => {
  const { ApiError } = await import('../lib/api');
  api.setUserAccessGroups.mockRejectedValueOnce(new ApiError(403, 'rank_too_low'));
  renderAt('/people/users/p1/access');
  fireEvent.click(await screen.findByRole('button', { name: 'Manage groups' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Finance/ }));   // remove Finance
  fireEvent.click(screen.getByRole('button', { name: 'Save groups' }));
  expect(await screen.findByText(/rank is at or above yours/)).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify they fail** (`npx vitest run src/pages/UserDetail.test.tsx`). Expected: the four new tests FAIL.

- [ ] **Step 3: Create `portal/src/components/users/ManageGroupsModal.tsx`**

```tsx
/**
 * ManageGroupsModal — toggle one person in or out of any access group and
 * save the whole set through PUT /users/{id}/access-groups. Mirrors
 * ManageRolesModal's shape with the report-generate modal header.
 */
import { useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { canTouchRank } from '../../lib/access';
import { ApiError, setUserAccessGroups, type AccessSummary } from '../../lib/api';

const ERRORS: Record<string, string> = {
  rank_too_low: "Their rank is at or above yours — you can't change their groups.",
  cannot_target_self: "That's you — groups you belong to are managed on the Access page.",
  group_not_found: 'One of those groups no longer exists — refresh and try again.',
  user_not_found: 'This user no longer exists.',
};

export default function ManageGroupsModal({ user, summary, currentIds, onClose, onSaved }: {
  user: { person_id: string; display_name: string; max_rank: number };
  summary: AccessSummary;
  currentIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { maxRank } = useAuth();
  const [picked, setPicked] = useState<Set<string>>(new Set(currentIds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const actorCanTouch = canTouchRank(maxRank, user.max_rank);
  const gateCount = (gid: string) =>
    summary.resources.filter((r) => r.gated_by.includes(gid)).length;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      // keep the summary's order so the payload is stable
      await setUserAccessGroups(user.person_id,
        summary.groups.filter((g) => picked.has(g.id)).map((g) => g.id));
      onSaved();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(ERRORS[code] ?? 'Could not save — try again.');
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card ud-groups-card" role="dialog" aria-label="Manage access groups">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Access groups</div>
            <h3>Groups — {user.display_name}</h3>
            <p className="page-hint">Members of a group can open the pages gated behind it.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {summary.groups.length === 0 ? (
            <div className="dir-empty"><b>No groups yet</b>Create one on the Access page first.</div>
          ) : (
            <div className="ud-group-picks">
              {summary.groups.map((g) => {
                const on = picked.has(g.id);
                const n = gateCount(g.id);
                return (
                  <button key={g.id} type="button"
                          className={`ud-group-pick ${on ? 'on' : ''}`}
                          aria-pressed={on}
                          disabled={!actorCanTouch}
                          title={actorCanTouch ? undefined : `${user.display_name}'s rank is at or above yours`}
                          onClick={() => setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
                            return next;
                          })}>
                    <span className="cell-top">{g.name}</span>
                    {g.description && <span className="ud-group-meta">{g.description}</span>}
                    <span className="ud-group-meta">gates {n} page{n === 1 ? '' : 's'}</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="set-note" style={{ padding: '12px 0 0' }}>
            Adding someone to a group does not grant a role — it only unlocks gated pages.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn-solid" onClick={() => void save()} disabled={saving || !actorCanTouch}>
            {saving ? 'Saving…' : 'Save groups'}
          </button>
          <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `portal/src/components/users/UserAccessTab.tsx`**

```tsx
/**
 * UserAccessTab — Roles / Access groups / Overrides / Effective permissions
 * for one user, each a real table with its own head button. The access
 * block is null below rank 60 (server rule): then only Roles renders and the
 * other three collapse into one note.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import DataTable from '../DataTable';
import { ManageRolesModal } from '../UserAdminModals';
import MatrixTable from '../access/MatrixTable';
import OverrideEditor from '../access/OverrideEditor';
import ManageGroupsModal from './ManageGroupsModal';
import { getAccessSummary, type AccessSummary, type UserDetailOut } from '../../lib/api';
import { longDate } from '../../lib/format';
import { ROLE_CLS, toManagedUser, toMemberItem } from '../../lib/users';

type Open = 'roles' | 'groups' | 'overrides' | null;

export default function UserAccessTab({ detail, canManageAccess, selfId, maxRank, onChanged }: {
  detail: UserDetailOut;
  canManageAccess: boolean;
  selfId: string | null;
  maxRank: number;
  onChanged: () => void;
}) {
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const { roles, access } = detail;

  useEffect(() => {
    let cancelled = false;
    void getAccessSummary().then((s) => { if (!cancelled) setSummary(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const who = (p: { display_name: string } | null) => p?.display_name ?? '—';
  const scopeLine = access
    ? access.scope.global ? 'Sees: everything'
      : access.scope_orgs.length ? `Sees: ${access.scope_orgs.map((o) => o.name).join(', ')} only`
        : 'Sees: own records only'
    : '';

  return (
    <div className="ud-panels">
      <div className="panel">
        <div className="panel-head">
          <h3>Roles</h3>
          {canManageAccess && <button className="mini-btn" onClick={() => setOpen('roles')}>Manage roles</button>}
        </div>
        <div className="panel-body">
          <DataTable ariaLabel="Roles" emptyText="No roles granted"
            columns={[
              { key: 'role', label: 'Role' }, { key: 'label', label: 'Label' },
              { key: 'rank', label: 'Rank', align: 'right' }, { key: 'scope', label: 'Scope' },
              { key: 'by', label: 'Granted by' }, { key: 'at', label: 'Granted on', mono: true },
            ]}
            rows={roles.map((r) => ({
              key: `${r.role}:${r.org?.id ?? 'global'}`,
              cells: [
                <span className={`chip ${ROLE_CLS[r.role] ?? 'tag'}`}>{r.role}</span>,
                r.label, String(r.rank),
                r.org ? <Link to={`/stakeholders/${r.org.kind}s/${r.org.id}`}>{r.org.name}</Link> : 'Global',
                who(r.granted_by), longDate(r.granted_at),
              ],
            }))} />
        </div>
      </div>

      {access === null ? (
        <div className="ud-rank-note">
          Resolved access (groups, overrides, effective permissions) is visible to admins at rank 60 and above.
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>Access groups</h3>
              {canManageAccess && summary && (
                <button className="mini-btn" onClick={() => setOpen('groups')}>Manage groups</button>
              )}
            </div>
            <div className="panel-body">
              <DataTable ariaLabel="Access groups" emptyText="Not in any access groups"
                columns={[
                  { key: 'group', label: 'Group' }, { key: 'desc', label: 'Description' },
                  { key: 'gates', label: 'Pages gated', align: 'right' },
                  { key: 'by', label: 'Added by' }, { key: 'at', label: 'Added on', mono: true },
                ]}
                rows={access.groups.map((g) => ({
                  key: g.id,
                  cells: [
                    <Link to={`/access?tab=groups&group=${g.id}`}>{g.name}</Link>,
                    g.description || '—',
                    <span title={g.gated_pages.join(', ')}>{String(g.gate_count)}</span>,
                    who(g.added_by), longDate(g.added_at),
                  ],
                }))} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Overrides</h3>
              {canManageAccess && summary && (
                <button className="mini-btn" onClick={() => setOpen('overrides')}>Edit overrides</button>
              )}
            </div>
            <div className="panel-body">
              <DataTable ariaLabel="Overrides" emptyText="No overrides"
                columns={[
                  { key: 'page', label: 'Page' }, { key: 'action', label: 'Action' },
                  { key: 'effect', label: 'Effect' }, { key: 'by', label: 'Set by' },
                  { key: 'at', label: 'Set on', mono: true },
                ]}
                rows={access.overrides.map((o) => ({
                  key: `${o.resource}:${o.action}`,
                  cells: [
                    o.resource_label, o.action,
                    <span className={`chip ${o.allow ? 'c-green' : 'c-red'}`}><span className="dot" />{o.allow ? 'allow' : 'deny'}</span>,
                    who(o.set_by), longDate(o.set_at),
                  ],
                }))} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Effective permissions</h3>
              <span className="exp-scope">{scopeLine}</span>
            </div>
            <div className="panel-body">
              {summary
                ? <MatrixTable mode="effective" resources={summary.resources} cells={access.cells} editable={false} />
                : <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
            </div>
          </div>
        </>
      )}

      {open === 'roles' && (
        <ManageRolesModal user={toManagedUser(detail)}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); onChanged(); }} />
      )}
      {open === 'groups' && summary && access && (
        <ManageGroupsModal user={{ person_id: detail.person.id, display_name: detail.person.display_name, max_rank: detail.max_rank }}
          summary={summary} currentIds={access.groups.map((g) => g.id)}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); onChanged(); }} />
      )}
      {open === 'overrides' && summary && (
        <OverrideEditor summary={summary} member={toMemberItem(detail)}
          canEdit={canManageAccess} maxRank={maxRank} selfId={selfId}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); onChanged(); }} />
      )}
    </div>
  );
}
```

If `MatrixTable`'s `resources` prop type is not `AccessResourceOut[]`, read `portal/src/components/access/MatrixTable.tsx:20-53` and pass exactly what ExplorerTab passes (`summary.resources`) — the call above already mirrors ExplorerTab. If `DataTable` requires `cells` to be `ReactNode[]` with keys, wrap JSX cells in fragments with `key` only if a React key warning appears in the test output.

- [ ] **Step 5: Wire the tab in `UserDetail.tsx`**

Replace the `{/* Task 7 adds … */}` comment with:

```tsx
      {tab === 'access' && (
        <UserAccessTab detail={detail} canManageAccess={canManageAccess}
                       selfId={me?.id ?? null} maxRank={maxRank} onChanged={() => void load()} />
      )}
```

and add `import UserAccessTab from '../components/users/UserAccessTab';`.

- [ ] **Step 6: Run tests, type-check, guardrail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/UserDetail.test.tsx src/styles/listTypography.test.ts && npx tsc -b --noEmit`
Expected: all pass; tsc clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/components/users/UserAccessTab.tsx portal/src/components/users/ManageGroupsModal.tsx portal/src/pages/UserDetail.tsx portal/src/pages/UserDetail.test.tsx && git commit -m "feat(portal): user detail Access tab (roles, groups, overrides, effective) + Manage groups modal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: History tab, Users list wiring, Access deep link

**Files:**
- Modify: `portal/src/pages/UserDetail.tsx` (history branch)
- Modify: `portal/src/pages/Users.tsx` (Full details buttons; Add person redirect)
- Modify: `portal/src/pages/Access.tsx:33` and `portal/src/components/access/GroupsTab.tsx:48-50`
- Test: `portal/src/pages/UserDetail.test.tsx` (append), `portal/src/pages/Access.test.tsx` (create), `portal/src/pages/Users.test.tsx` (create)

**Interfaces:**
- Consumes: `ActivityHistory` with `subjectName` (Task 5), `getUserActivity` (Task 5).
- Produces: `GroupsTab` prop `initialGroupId?: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `UserDetail.test.tsx`:

```tsx
it('History tab loads the person activity lazily and names the subject', async () => {
  api.getUserActivity.mockResolvedValue([
    { id: 'r1', at: '2026-09-15T10:00:00Z', action: 'site.create', entity_type: 'site', entity_id: null,
      ip: null, by_me: true, actor_name: null, changes: {}, entity_name: null, entity_summary: {} },
  ]);
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(api.getUserActivity).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(await screen.findByRole('heading', { name: 'User history' })).toBeTruthy();
  await waitFor(() => expect(api.getUserActivity).toHaveBeenCalledWith('p1'));
  expect(await screen.findAllByText('Wan Worker')).toBeTruthy();
});
```

Create `portal/src/pages/Access.test.tsx`:

```tsx
// @vitest-environment jsdom
/** /access?tab=groups&group=<id> opens the Groups tab with that group selected. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 100, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getAccessSummary: vi.fn(async () => ({
    stats: { members: 2, roles: 1, groups: 2, gated_resources: 0, overrides: 0 },
    resources: [{ id: 'clients', label: 'Clients', developer_only: false, always_viewable: false, gated_by: [] }],
    roles: [],
    groups: [
      { id: 'g1', name: 'Finance', description: '', icon: 'users', member_count: 0, members: [] },
      { id: 'g2', name: 'Ops', description: 'Second group', icon: 'users', member_count: 0, members: [] },
    ],
  })),
  listUsers: vi.fn(async () => []),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

afterEach(cleanup);
const { default: Access } = await import('./Access');

it('opens the Groups tab with the linked group selected', async () => {
  render(<MemoryRouter initialEntries={['/access?tab=groups&group=g2']}><Access /></MemoryRouter>);
  expect((await screen.findByRole('tab', { name: 'Groups' })).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Second group')).toBeTruthy();
});

it('defaults to Roles without params', async () => {
  render(<MemoryRouter initialEntries={['/access']}><Access /></MemoryRouter>);
  expect((await screen.findByRole('tab', { name: 'Roles' })).getAttribute('aria-selected')).toBe('true');
});
```

If `GroupDetail` renders the description in a way that the test cannot find by text (check `GroupsTab.tsx:200-260`), assert on the group name inside the detail panel heading instead (`screen.findByRole('heading', { name: 'Ops' })`).

Create `portal/src/pages/Users.test.tsx`:

```tsx
// @vitest-environment jsdom
/** The Users list expansion offers a Full details link to the detail page. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 100, godMode: false,
    can: () => true,
    preferences: { list_prefs: {}, list_size: 'default' }, updatePreferences: vi.fn(),
  }),
}));

const ROW = {
  person_id: 'p1', first_name: 'Wan', last_name: 'Worker', preferred_name: null, display_name: 'Wan Worker',
  job_title: null, phone: null, contact_email: null, login_email: 'wan@x.test', roles: ['staff'],
  status: 'active', must_change_password: false, last_login_at: null, account_created_at: '2026-01-01T00:00:00Z',
  archived_at: null, avatar_url: null, max_rank: 40,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([ROW]), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const { default: Users } = await import('./Users');

it('the expansion shows a Full details link to /people/users/:id', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('Wan Worker'));
  fireEvent.click(await screen.findByRole('button', { name: 'Full details' }));
  expect(await screen.findByText('DETAIL PAGE')).toBeTruthy();
});
```

`Users.tsx` calls `apiFetch('/users')` which goes through `fetch`; if `apiFetch` needs a stored session token to run (check `portal/src/lib/api.ts::apiFetch`), mock `../lib/api` with `importActual` and override `apiFetch: vi.fn(async () => new Response(JSON.stringify([ROW]), { status: 200 }))` instead of stubbing `fetch`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/UserDetail.test.tsx src/pages/Access.test.tsx src/pages/Users.test.tsx`
Expected: the History test, the deep-link test, and the Full details test FAIL.

- [ ] **Step 3: History tab in `UserDetail.tsx`**

Add imports `import ActivityHistory from '../components/ActivityHistory';` and `getUserActivity`, `type MyActivityItem` from `../lib/api`. Add state and a lazy loader inside the component (after `signingOut`):

```tsx
  const [activity, setActivity] = useState<MyActivityItem[] | null>(null);
  const [activityError, setActivityError] = useState('');
  const loadActivity = useCallback(async () => {
    setActivityError('');
    try {
      setActivity(await getUserActivity(personId));
    } catch {
      setActivity([]);
      setActivityError('Could not load history.');
    }
  }, [personId]);
  useEffect(() => {
    if (tab === 'history' && activity === null && can('audit', 'view')) void loadActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
```

Make every mutation refresh history too: change `load` so that after `setDetail(...)` it runs `if (activity !== null) void loadActivity();` — because `load` is declared before `loadActivity`, move `loadActivity`/`activity` above `load` (hooks order is fine as long as both are unconditional).

Replace the `{/* Task 8 adds … */}` comment with:

```tsx
      {tab === 'history' && showHistory && (
        activityError
          ? (
            <div className="dir-empty" style={{ marginTop: 16 }}>
              <b>{activityError}</b>
              <button className="mini-btn" style={{ marginTop: 8 }} onClick={() => void loadActivity()}>Retry</button>
            </div>
          )
          : <ActivityHistory rows={activity ?? []} subjectName={person.display_name} />
      )}
```

- [ ] **Step 4: Users list — Full details + Add person redirect**

In `portal/src/pages/Users.tsx` inside the expansion's IIFE (`const isSelf = …`), add a shared button and render it in all three branches:

```tsx
                          const fullDetails = (
                            <button className="mini-btn accent"
                                    onClick={() => navigate(`/people/users/${u.person_id}`)}>
                              Full details
                            </button>
                          );
```

- self branch: put `{fullDetails}` before the "Go to My profile" button.
- `!canTouch` branch: put `{fullDetails}` after the read-only `<span className="self-note">`.
- manage branch: replace `if (!canManageUsers && !canManageRoles && !godMode) return null;` with `const manageable = canManageUsers || canManageRoles || godMode;` and render `{fullDetails}` as the first child of `detail-actions`, wrapping the existing buttons in `{manageable && (<>…</>)}` so a view-only actor still gets Full details.

In `AddPersonModal`'s `onCreated` handler (around line 645) replace the body with:

```tsx
          onCreated={(personId) => {
            setAddOpen(false);
            navigate(`/people/users/${personId}`);
          }}
```

- [ ] **Step 5: Access deep link**

`portal/src/pages/Access.tsx`: import `useSearchParams` from `react-router-dom`; replace `const [tab, setTab] = useState<Tab>('roles');` with:

```tsx
  const [params] = useSearchParams();
  const wanted = params.get('tab');
  const [tab, setTab] = useState<Tab>(
    TABS.some((t) => t.key === wanted) ? (wanted as Tab) : 'roles');
  const initialGroupId = params.get('group');
```

and pass `initialGroupId={initialGroupId}` to `<GroupsTab …>`.

`portal/src/components/access/GroupsTab.tsx`: add `initialGroupId?: string | null;` to `Props`, destructure it, and change `useState<string | null>(null)` to `useState<string | null>(initialGroupId ?? null)`. (The existing fallback `?? summary.groups[0]` already handles an id that no longer exists.)

- [ ] **Step 6: Run all portal tests, type-check, build**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run && npx tsc -b --noEmit && npm run build`
Expected: every test passes (1788 + the new ones); tsc clean; build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/pages/UserDetail.tsx portal/src/pages/UserDetail.test.tsx portal/src/pages/Users.tsx portal/src/pages/Users.test.tsx portal/src/pages/Access.tsx portal/src/pages/Access.test.tsx portal/src/components/access/GroupsTab.tsx && git commit -m "feat(portal): user History tab, Full details from the Users list, Access ?tab=&group= deep link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Full suites + live verification on the dev stack

**Files:** none new (fixes only, committed as `fix(...)` commits if anything surfaces).

- [ ] **Step 1: Full API suite**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider 2>&1 | tail -8
```
(timeout 600000 ms, foreground). Expected: all pass except the two known WeasyPrint environment failures if this Mac's dyld links are missing (they are documented as pre-existing; report them by name).

- [ ] **Step 2: Full portal suite + build** — `npx vitest run && npx tsc -b --noEmit && npm run build` (see Task 8 Step 6). Expected: green.

- [ ] **Step 3: Start the worktree's API and portal**

The dev stack normally runs from the MAIN checkout; for this branch start both from the worktree on the standard ports (stop the main checkout's servers first if they hold 8000/5173 — check with `lsof -nP -iTCP:8000 -iTCP:5173 -sTCP:LISTEN`). Run detached so the desktop app does not reap them:

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && mkdir -p .devlogs && (PYTHONPATH=$PWD/api/src nohup api/.venv/bin/python -m uvicorn --reload --factory serversherpa.api.app:create_app --app-dir api/src --host 0.0.0.0 --port 8000 > .devlogs/api.log 2>&1 &) && (nohup npm --prefix portal run dev > .devlogs/portal.log 2>&1 &) && sleep 4 && tail -3 .devlogs/api.log .devlogs/portal.log
```

- [ ] **Step 4: Live checks (Browser pane, `http://localhost:5173`)**

Sign in as `claude-dev@test.example.com` / `wt-verify-2026` (fill the fields with form_input, then `document.querySelector('form').requestSubmit()` — the login page's reveal animation never runs in the pane). Then, taking a screenshot at each step and reading the console for errors:

1. `/people/users` → expand a row → **Full details** button present in the expansion; click it.
2. Detail page **Profile** tab: hero (status + rank chips, role chips), Profile / Account / Memberships / Active sessions panels. Pick a user who is also a worker (the V2-imported workers) so the worker card renders.
3. **Access** tab: four panels with tables; open **Manage groups**, toggle a group, save; confirm the Access groups table updates, then follow the group link to `/access?tab=groups&group=…` and confirm the Groups tab opens on that group with the user in its member list.
4. **History** tab: rows load; the actor column shows the person's name for their own rows.
5. Sign in as a rank-40 user (create one via Add person with the staff role, or use the seeded test account if present) and open the same detail page: the Access tab shows the rank note and only the Roles table.
6. Open your own row → hero shows only "Go to My profile".

Scroll with `document.querySelector('.portal-main').scrollTo(...)`. Fix anything that looks wrong (alignment, wrapping, clipped modals) in the source, re-screenshot, and commit as `fix(portal): …`.

- [ ] **Step 5: Stop the worktree servers and restore the main stack**

`pkill -f "user-detail/api/src"`; `pkill -f "user-detail/portal"`; if you stopped the main checkout's servers in Step 3, restart them the same detached way from `/Users/jrh1812/Developer/BaseCampV3` — but do not `cd` there; use `--prefix /Users/jrh1812/Developer/BaseCampV3/portal` and the absolute `--app-dir`.

- [ ] **Step 6: Final commit state**

`git status` must be clean apart from `.devlogs/` (git-ignored) and `api/src/serversherpa/_dev_reload.py` (restore with `git checkout -- api/src/serversherpa/_dev_reload.py`). Report the final commit hash and the test counts.

---

## Self-review notes

- Spec coverage: page (Tasks 6–8), API (Tasks 2–4), list wiring + deep link (Task 8), error states (Task 6 not-found/retry, Task 8 history error), testing (each task + Task 9 live pass), rank-60 rule (Task 2 `can_see_access`), sessions rule (Task 2), audit rows (Task 4), `ROLE_CLS` move (Task 5), `subjectName` (Task 5), Add-person redirect (Task 8). `scope_orgs` is an addition to the spec's access block so the page needs no client/partner fetch for the scope line.
- Type consistency: `UserDetailOut` fields are identical in Task 2 (pydantic) and Task 5 (TS); `DetailMode` is exported from `UserDetail.tsx` and imported by `UserProfileTab.tsx`; `toManagedUser` / `toMemberItem` defined in Task 5, used in Tasks 6–7; `ManageGroupsModal` props match the Task 7 call site.
