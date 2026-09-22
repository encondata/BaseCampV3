# Copy Access and Role-Change Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the portal's `/access` page, let an admin copy one person's access (global roles, access groups, overrides) to one or many people with Replace or Add-only semantics, and show a review of who a role-matrix change affects before it is saved.

**Architecture:** No schema change. The resolver gains an optional "pretend this role grants X" parameter so a preview can re-run effective access per member. The three existing per-person write endpoints (roles, groups, overrides) have their diff logic extracted into `access/apply.py`, which the new `POST /access/copy` reuses. Two new portal modals (CopyAccessModal, RoleReviewModal) plus a reusable PersonChipPicker plug into the existing Members and Roles tabs.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, pytest (asyncio auto). React 18, TypeScript, Vite, Vitest with jsdom.

Spec: `docs/superpowers/specs/2026-09-21-access-copy-and-role-preview-design.md`.

## Global Constraints

- Work in the git worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/access-copy`, branch `access-copy-preview`. Run every command from that directory. Never `cd` to the primary checkout.
- `api/.venv`, `portal/node_modules` and `.env` in the worktree are symlinks to the primary checkout. Never `npm install` or `pip install` in the worktree. Never commit `api/src/serversherpa/_dev_reload.py` or the `.env` symlink.
- API tests: always `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest <files> -q`. Run one pytest process at a time. Targeted files per task; the full API suite runs once, in Task 7.
- Portal tests: always the whole suite plus the type check, from the worktree root: `npm --prefix portal run test` and `(cd portal && node_modules/.bin/tsc --noEmit)`. To run one portal test file: `(cd portal && node_modules/.bin/vitest run <path>)`.
- Copy modes: `replace` (default) and `add`. Parts: `roles`, `groups`, `overrides`. Only **global-anchored** roles are ever copied or revoked; client/partner-anchored grants are untouched. Skip reasons, in evaluation order: `cannot_target_self`, `no_account`, `rank_too_low`, `role_rank_too_low`. Audit action for a real run: `access.copy`, one row per target that changed.
- Preview endpoint shares every guard of `PUT /access/roles/{name}/matrix` and writes nothing. Masked cell `by` values: `override`, `gate`, `hard_gate`, `floor`, `role`.
- Every new modal uses the report-generate header (`modal-card reports-modal-card rgm-card`, `modal-head` with `eyebrow` / `h3` / `page-hint`, `modal-close`, `modal-body`, `modal-foot` with `btn-solid` + `mini-btn` + inline `pf-error`) and sizes to its content. Dropdowns over records use `ComboBox`; the mode switch uses the house `segmented` group.
- American English in all copy, comments and docs. Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ledger: append one line per task to `.superpowers/sdd/progress.md` in the worktree.

---

### Task 1: Resolver "pretend this role grants X" parameter

**Files:**
- Modify: `api/src/serversherpa/access/resolver.py:56-65` (`resolve_access` signature and the `granted` build)
- Modify: `api/src/serversherpa/access/effective.py:37-61` (`effective_cells` signature and its `granted` build)
- Test: `api/tests/test_access_resolver.py`

**Interfaces:**
- Produces: `resolve_access(db, person_id, *, role_grants_override: dict[str, set[tuple[str, str]]] | None = None) -> AccessInfo` and `effective_cells(db, person_id, *, role_grants_override=None) -> EffectiveAccess`. When the override names a role the person holds, that role contributes exactly the override's `(resource, action)` pairs instead of its `role_permissions` rows. Other roles read the table as before. Override entries for roles the person does not hold are ignored.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_access_resolver.py`:

```python
async def test_role_grants_override_replaces_one_role(db):
    p = await make_person(db, "staff")
    a = await resolve_access(db, p.id, role_grants_override={
        "staff": {("workers", "view"), ("access", "view")}})
    assert a.perms["workers"] == {"view": True, "add": False,
                                  "change": False, "delete": False}
    # a role the person does not hold is ignored
    b = await resolve_access(db, p.id, role_grants_override={
        "admin": {("settings", "change")}})
    assert b.perms["settings"]["change"] is False
    # no override -> unchanged behavior
    c = await resolve_access(db, p.id)
    assert c.perms["workers"]["delete"] is True


async def test_effective_cells_override_keeps_sourcing(db):
    from serversherpa.access.effective import effective_cells
    p = await make_person(db, "staff")
    db.add(PermissionOverride(person_id=p.id, resource="workers",
                              action="view", allow=True))
    await db.commit()
    eff = await effective_cells(db, p.id, role_grants_override={
        "staff": {("access", "view")}})
    assert eff.cells["workers"]["view"] == {"value": True, "source": "override"}
    assert eff.cells["workers"]["add"] == {"value": False, "source": "role"}
```

- [ ] **Step 2: Run to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_access_resolver.py -q -k override`
Expected: FAIL with `TypeError: ... unexpected keyword argument 'role_grants_override'`. (The first run creates and migrates the branch test database; that takes a minute.)

- [ ] **Step 3: Add a shared grant loader and thread the parameter**

In `api/src/serversherpa/access/resolver.py`, add above `resolve_access`:

```python
RoleGrants = dict[str, set[tuple[str, str]]]


async def role_grants(db: AsyncSession, role_names: set[str],
                      override: RoleGrants | None = None) -> dict[str, set[str]]:
    """resource -> granted actions for the union of `role_names`. A role
    named in `override` contributes exactly those (resource, action) pairs
    instead of its role_permissions rows — the matrix-preview hook."""
    granted: dict[str, set[str]] = {}
    override = override or {}
    from_table = {r for r in role_names if r not in override}
    if from_table:
        for res, action in (await db.execute(
            select(RolePermission.resource, RolePermission.action)
            .where(RolePermission.role.in_(from_table)))).all():
            granted.setdefault(res, set()).add(action)
    for name in role_names & set(override):
        for res, action in override[name]:
            granted.setdefault(res, set()).add(action)
    return granted
```

Change the signature to `async def resolve_access(db: AsyncSession, person_id: uuid.UUID, *, role_grants_override: RoleGrants | None = None) -> AccessInfo:` and replace its `granted` block (the `granted: dict[str, set[str]] = {}` through the `for res, action in ...: granted.setdefault(...)` loop) with:

```python
    granted = await role_grants(db, role_set, role_grants_override)
```

In `api/src/serversherpa/access/effective.py`, import `role_grants` from `serversherpa.access.resolver`, change the signature to `async def effective_cells(db: AsyncSession, person_id: uuid.UUID, *, role_grants_override=None) -> EffectiveAccess:`, pass it through: `access = await resolve_access(db, person_id, role_grants_override=role_grants_override)`, and replace its own `granted` block with `granted = await role_grants(db, role_set, role_grants_override)`.

- [ ] **Step 4: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_access_resolver.py api/tests/test_access_api.py api/tests/test_access_deps.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/access/resolver.py api/src/serversherpa/access/effective.py api/tests/test_access_resolver.py
git commit -m "feat(access): resolver accepts a per-role grant override for matrix previews"
```

---

### Task 2: Shared apply helpers, existing endpoints refactored onto them

**Files:**
- Create: `api/src/serversherpa/access/apply.py`
- Modify: `api/src/serversherpa/api/routes/users.py:589-673` (`set_roles`, `set_access_groups`)
- Modify: `api/src/serversherpa/api/routes/access.py:390-441` (`put_overrides`)
- Test: existing `api/tests/test_access_roles_api.py`, `test_access_overrides_api.py`, `test_users_detail_api.py`, `test_users_api.py`, `test_access_groups_api.py` (no new tests; behavior must not change)

**Interfaces:**
- Produces, in `access/apply.py`:
  - `async def apply_global_roles(db, *, actor_id, person_id, desired: set[str], role_rows: dict[str, Role]) -> dict | None` — soft-revokes `revocable_current - desired` (only roles whose `scope_anchor` is not client/partner), adds `desired - current`; returns `{"from": sorted(current), "to": sorted(desired)}` or `None` if `desired == current`. No validation, no audit, no commit.
  - `async def apply_groups(db, *, actor_id, person_id, desired: set[uuid.UUID]) -> dict | None` — returns `{"from": [names], "to": [names]}` or `None`. Raises `KeyError(gid)` for an unknown group id.
  - `async def apply_overrides(db, *, actor_id, person_id, desired: dict[tuple[str, str], bool]) -> dict` — returns the `"res:action" -> {"from", "to"}` change map (empty when unchanged).
  - `async def current_global_roles(db, person_id) -> set[str]`, `async def current_groups(db, person_id) -> set[uuid.UUID]`, `async def current_overrides(db, person_id) -> dict[tuple[str, str], bool]` — plain readers.

- [ ] **Step 1: Create the module**

```python
"""Per-person access writes shared by the users/access routes and the
copy-access endpoint: the diff-and-apply for global roles, access group
membership and per-cell overrides. Callers validate, audit and commit."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PermissionOverride, PersonRole, Role,
)

ORG_ANCHORS = ("client", "partner")


async def current_roles(db: AsyncSession, person_id: uuid.UUID) -> set[str]:
    return set(await db.scalars(
        select(PersonRole.role).where(PersonRole.person_id == person_id,
                                      PersonRole.revoked_at.is_(None))))


async def current_global_roles(db: AsyncSession, person_id: uuid.UUID) -> set[str]:
    return set(await db.scalars(
        select(PersonRole.role)
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None),
               Role.scope_anchor.not_in(ORG_ANCHORS))))


async def current_groups(db: AsyncSession, person_id: uuid.UUID) -> set[uuid.UUID]:
    return set(await db.scalars(
        select(AccessGroupMember.group_id)
        .where(AccessGroupMember.person_id == person_id)))


async def current_overrides(db: AsyncSession,
                            person_id: uuid.UUID) -> dict[tuple[str, str], bool]:
    return {(o.resource, o.action): o.allow for o in await db.scalars(
        select(PermissionOverride).where(PermissionOverride.person_id == person_id))}


async def apply_global_roles(
    db: AsyncSession, *, actor_id: uuid.UUID, person_id: uuid.UUID,
    desired: set[str], role_rows: dict[str, Role],
) -> dict | None:
    """Make the person's revocable (non org-anchored) roles equal `desired`.
    Org-anchored grants are managed by the contact flows and never revoked
    here. `role_rows` must cover every current and desired role name."""
    current = await current_roles(db, person_id)
    revocable_current = {
        name for name in current
        if role_rows.get(name) is None or role_rows[name].scope_anchor not in ORG_ANCHORS
    }
    if revocable_current == desired:
        return None
    now = datetime.now(UTC)
    for role in revocable_current - desired:
        await db.execute(
            update(PersonRole)
            .where(PersonRole.person_id == person_id, PersonRole.role == role,
                   PersonRole.revoked_at.is_(None))
            .values(revoked_at=now, revoked_by=actor_id, updated_at=now))
    for role in desired - current:
        db.add(PersonRole(person_id=person_id, role=role, granted_by=actor_id))
    return {"from": sorted(current), "to": sorted(desired)}


async def apply_groups(
    db: AsyncSession, *, actor_id: uuid.UUID, person_id: uuid.UUID,
    desired: set[uuid.UUID],
) -> dict | None:
    current = await current_groups(db, person_id)
    names = {g.id: g.name for g in await db.scalars(
        select(AccessGroup).where(AccessGroup.id.in_((desired | current) or {uuid.uuid4()})))}
    for gid in desired:
        if gid not in names:
            raise KeyError(gid)
    if desired == current:
        return None
    for gid in current - desired:
        await db.execute(AccessGroupMember.__table__.delete().where(
            AccessGroupMember.group_id == gid,
            AccessGroupMember.person_id == person_id))
    for gid in desired - current:
        db.add(AccessGroupMember(group_id=gid, person_id=person_id, added_by=actor_id))
    return {"from": sorted(names[g] for g in current),
            "to": sorted(names[g] for g in desired)}


async def apply_overrides(
    db: AsyncSession, *, actor_id: uuid.UUID, person_id: uuid.UUID,
    desired: dict[tuple[str, str], bool],
) -> dict:
    current = {(o.resource, o.action): o for o in await db.scalars(
        select(PermissionOverride).where(PermissionOverride.person_id == person_id))}
    changes: dict = {}
    for key, row in current.items():
        if key not in desired:
            changes[f"{key[0]}:{key[1]}"] = {"from": row.allow, "to": None}
            await db.delete(row)
        elif row.allow != desired[key]:
            changes[f"{key[0]}:{key[1]}"] = {"from": row.allow, "to": desired[key]}
            row.allow = desired[key]
            row.set_by = actor_id
            row.set_at = datetime.now(UTC)
    for key, value in desired.items():
        if key not in current:
            changes[f"{key[0]}:{key[1]}"] = {"from": None, "to": value}
            db.add(PermissionOverride(person_id=person_id, resource=key[0],
                                      action=key[1], allow=value, set_by=actor_id))
    return changes
```

- [ ] **Step 2: Refactor `set_roles`** in `api/src/serversherpa/api/routes/users.py`

Keep the validation loop (`unknown_role`, `role_requires_org`, `rank_too_low`) exactly as is. Replace everything from `now = datetime.now(UTC)` through the `for role in desired - current: db.add(...)` loop with:

```python
    await apply_global_roles(db, actor_id=actor.person.id, person_id=person_id,
                             desired=desired, role_rows=role_rows)
```

Keep the audit call and `return sorted(desired)` unchanged (the audit's `from`/`to` still use `current`/`desired`). Add `from serversherpa.access.apply import apply_global_roles, apply_groups` to the imports. If `update` from sqlalchemy is now unused in users.py, remove it from the import.

- [ ] **Step 3: Refactor `set_access_groups`** in the same file

Replace the body after `await _load_target(db, actor, person_id)` with:

```python
    desired = set(body.group_ids)
    try:
        diff = await apply_groups(db, actor_id=actor.person.id,
                                  person_id=person_id, desired=desired)
    except KeyError:
        raise _err(404, "group_not_found")
    if diff is not None:
        audit(db, actor_id=actor.person.id, entity_type="person",
              entity_id=str(person_id), action="access_groups.set",
              changes={"groups": diff})
        await db.commit()
    return AccessGroupsOut(group_ids=sorted(desired, key=str))
```

- [ ] **Step 4: Refactor `put_overrides`** in `api/src/serversherpa/api/routes/access.py`

Keep its guards and validation loop. Replace everything from `current = {(o.resource, o.action): o ...` through the `db.add(PermissionOverride(...))` loop with:

```python
    desired = {(res, a): v for res, actions in body.overrides.items()
               for a, v in actions.items() if v is not None}
    changes = await apply_overrides(db, actor_id=actor.person.id,
                                    person_id=person_id, desired=desired)
```

Keep the audit call, commit and return. Add `from serversherpa.access.apply import apply_overrides` to the imports.

- [ ] **Step 5: Run the covering suites**

Run: `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_access_roles_api.py api/tests/test_access_overrides_api.py api/tests/test_access_groups_api.py api/tests/test_users_detail_api.py api/tests/test_users_api.py api/tests/test_access_api.py -q`
Expected: all PASS, same counts as before the refactor.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/access/apply.py api/src/serversherpa/api/routes/users.py api/src/serversherpa/api/routes/access.py
git commit -m "refactor(access): shared apply helpers for per-person roles, groups and overrides"
```

---

### Task 3: `POST /access/copy`

**Files:**
- Create: `api/src/serversherpa/access/copy.py`
- Modify: `api/src/serversherpa/api/routes/access.py` (new route + Pydantic model, after the overrides routes)
- Test: create `api/tests/test_access_copy_api.py`

**Interfaces:**
- Consumes: Task 2 helpers.
- Produces: `POST /access/copy` per the spec. `access/copy.py::plan_copy(db, actor, source_id, target_ids, parts, mode) -> list[PlanRow]` and `apply_copy(db, actor, plan, parts, mode, source)`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_access_copy_api.py`:

```python
"""POST /access/copy — replace/add semantics per part, skips, dry run, audit."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, AuditLog, Client, PermissionOverride,
    PersonRole, UserAccount,
)
from tests.test_access_roles_api import login_admin
from tests.test_users_api import _add_user


async def _grant(db, person, role, **kw):
    db.add(PersonRole(person_id=person.id, role=role, **kw))
    await db.commit()


async def _group(client, hdrs, name):
    return (await client.post("/access/groups", headers=hdrs,
                              json={"name": name})).json()["id"]


async def _setup(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    src = await _add_user(db, first="Sue", last="Source",
                          email="sue@test.example.com", role="staff")
    tgt = await _add_user(db, first="Tom", last="Target",
                          email="tom@test.example.com", role="worker")
    g_fin = await _group(client, hdrs, "Finance")
    g_ops = await _group(client, hdrs, "Ops")
    await client.put(f"/users/{src.id}/access-groups", headers=hdrs,
                     json={"group_ids": [g_fin]})
    await client.put(f"/users/{tgt.id}/access-groups", headers=hdrs,
                     json={"group_ids": [g_ops]})
    await client.put(f"/access/overrides/{src.id}", headers=hdrs,
                     json={"overrides": {"settings": {"change": True},
                                         "workers": {"delete": False}}})
    await client.put(f"/access/overrides/{tgt.id}", headers=hdrs,
                     json={"overrides": {"workers": {"delete": True},
                                         "sites": {"add": True}}})
    return hdrs, src, tgt, g_fin, g_ops


async def _roles(db, person_id):
    return set(await db.scalars(select(PersonRole.role).where(
        PersonRole.person_id == person_id, PersonRole.revoked_at.is_(None))))


async def _overrides(db, person_id):
    return {(o.resource, o.action): o.allow for o in await db.scalars(
        select(PermissionOverride).where(PermissionOverride.person_id == person_id))}


async def test_dry_run_plans_without_writing(client, db, seeded_user):
    hdrs, src, tgt, g_fin, g_ops = await _setup(client, db, seeded_user)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles", "groups", "overrides"], "mode": "replace",
        "dry_run": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["applied"] is False
    row = body["targets"][0]
    assert row["status"] == "ok"
    assert row["roles"] == {"from": ["worker"], "to": ["staff"]}
    assert row["groups"] == {"from": ["Ops"], "to": ["Finance"]}
    assert row["overrides"] == {"added": 1, "removed": 1, "changed": 1}
    assert await _roles(db, tgt.id) == {"worker"}
    assert await db.scalar(select(AuditLog).where(AuditLog.action == "access.copy")) is None


async def test_replace_applies_every_part_and_audits(client, db, seeded_user):
    hdrs, src, tgt, g_fin, g_ops = await _setup(client, db, seeded_user)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles", "groups", "overrides"], "mode": "replace",
        "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"] is True
    assert await _roles(db, tgt.id) == {"staff"}
    groups = set(await db.scalars(select(AccessGroupMember.group_id).where(
        AccessGroupMember.person_id == tgt.id)))
    assert groups == {uuid.UUID(g_fin)}
    assert await _overrides(db, tgt.id) == {("settings", "change"): True,
                                            ("workers", "delete"): False}
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "access.copy"))
    assert log.entity_type == "person" and log.entity_id == str(tgt.id)
    assert log.changes["source_id"] == str(src.id)
    assert log.changes["mode"] == "replace"
    assert log.changes["roles"] == {"from": ["worker"], "to": ["staff"]}
    assert log.changes["groups"] == {"from": ["Ops"], "to": ["Finance"]}
    assert set(log.changes["overrides"]) == {"settings:change", "workers:delete", "sites:add"}


async def test_add_mode_unions_and_source_wins_conflicts(client, db, seeded_user):
    hdrs, src, tgt, g_fin, g_ops = await _setup(client, db, seeded_user)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles", "groups", "overrides"], "mode": "add",
        "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert await _roles(db, tgt.id) == {"worker", "staff"}
    groups = set(await db.scalars(select(AccessGroupMember.group_id).where(
        AccessGroupMember.person_id == tgt.id)))
    assert groups == {uuid.UUID(g_fin), uuid.UUID(g_ops)}
    assert await _overrides(db, tgt.id) == {("settings", "change"): True,
                                            ("workers", "delete"): False,
                                            ("sites", "add"): True}


async def test_parts_limit_what_changes(client, db, seeded_user):
    hdrs, src, tgt, g_fin, g_ops = await _setup(client, db, seeded_user)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["groups"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    row = resp.json()["targets"][0]
    assert row["roles"] is None and row["overrides"] is None
    assert await _roles(db, tgt.id) == {"worker"}
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "access.copy"))
    assert set(log.changes) == {"source_id", "source_name", "mode", "parts", "groups"}


async def test_org_anchored_roles_are_never_copied_or_revoked(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    await _grant(db, src, "client_viewer", client_id=c.id)
    await _grant(db, tgt, "client_admin", client_id=c.id)
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["targets"][0]["roles"] == {"from": ["client_admin", "worker"],
                                                  "to": ["client_admin", "staff"]}
    assert await _roles(db, tgt.id) == {"staff", "client_admin"}


async def test_skip_reasons(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    boss = await _add_user(db, first="Big", last="Boss",
                           email="boss@test.example.com", role="super_admin")
    no_account = await _add_user(db, first="No", last="Login",
                                 email="nolog@test.example.com", role="worker")
    await db.execute(UserAccount.__table__.delete().where(
        UserAccount.person_id == no_account.id))
    await db.commit()
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id),
        "target_ids": [str(seeded_user.id), str(no_account.id), str(boss.id), str(tgt.id)],
        "parts": ["roles"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    by_id = {r["person_id"]: r for r in resp.json()["targets"]}
    assert by_id[str(seeded_user.id)]["reason"] == "cannot_target_self"
    assert by_id[str(no_account.id)]["reason"] == "no_account"
    assert by_id[str(boss.id)]["reason"] == "rank_too_low"
    assert by_id[str(tgt.id)]["status"] == "ok"
    assert await _roles(db, tgt.id) == {"staff"}
    assert await _roles(db, boss.id) == {"super_admin"}


async def test_role_rank_too_low_skips_target(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    # source holds a role the admin actor cannot grant
    await db.execute(PersonRole.__table__.update().where(
        PersonRole.person_id == src.id).values(role="super_admin"))
    await db.commit()
    resp = await client.post("/access/copy", headers=hdrs, json={
        "source_id": str(src.id), "target_ids": [str(tgt.id)],
        "parts": ["roles"], "mode": "replace", "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["targets"][0]["reason"] == "role_rank_too_low"
    assert await _roles(db, tgt.id) == {"worker"}


async def test_validation_and_source_guards(client, db, seeded_user):
    hdrs, src, tgt, *_ = await _setup(client, db, seeded_user)
    base = {"source_id": str(src.id), "target_ids": [str(tgt.id)],
            "parts": ["roles"], "mode": "replace", "dry_run": True}
    r = await client.post("/access/copy", headers=hdrs, json={**base, "target_ids": []})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "no_targets"
    r = await client.post("/access/copy", headers=hdrs, json={**base, "parts": []})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "no_parts"
    r = await client.post("/access/copy", headers=hdrs, json={**base, "parts": ["hats"]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_part"
    r = await client.post("/access/copy", headers=hdrs, json={**base, "mode": "merge"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_mode"
    r = await client.post("/access/copy", headers=hdrs,
                          json={**base, "source_id": str(uuid.uuid4())})
    assert r.status_code == 404 and r.json()["detail"]["code"] == "person_not_found"
    # copying FROM yourself is allowed
    r = await client.post("/access/copy", headers=hdrs,
                          json={**base, "source_id": str(seeded_user.id)})
    assert r.status_code == 200, r.text
```

- [ ] **Step 2: Run to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_access_copy_api.py -q`
Expected: every test FAILS with status 404/405 (route missing).

- [ ] **Step 3: Create `api/src/serversherpa/access/copy.py`**

```python
"""Copy one person's access to others — plan (dry run) and apply.

Parts: global roles, access groups, per-cell overrides. Replace makes the
target's part equal the source's; Add unions them (the source wins an
override conflict). Org-anchored roles are never copied or revoked."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.apply import (
    ORG_ANCHORS, apply_global_roles, apply_groups, apply_overrides,
    current_global_roles, current_groups, current_overrides, current_roles,
)
from serversherpa.access.resolver import can_touch_rank
from serversherpa.db.models import AccessGroup, Person, Role, UserAccount
from serversherpa.services.storage import presign_get

PARTS = ("roles", "groups", "overrides")
MODES = ("replace", "add")


@dataclass
class Snapshot:
    roles: set[str] = field(default_factory=set)          # global-anchored only
    groups: set[uuid.UUID] = field(default_factory=set)
    overrides: dict[tuple[str, str], bool] = field(default_factory=dict)


@dataclass
class PlanRow:
    person: Person
    max_rank: int
    status: str = "ok"
    reason: str | None = None
    roles: dict | None = None        # {"from": [...], "to": [...]} (all held roles)
    groups: dict | None = None       # {"from": [names], "to": [names]}
    overrides: dict | None = None    # {"added", "removed", "changed"}
    desired: Snapshot = field(default_factory=Snapshot)

    def out(self) -> dict:
        return {"person_id": str(self.person.id),
                "display_name": self.person.display_name,
                "avatar_url": presign_get(self.person.avatar_key),
                "status": self.status, "reason": self.reason,
                "roles": self.roles, "groups": self.groups,
                "overrides": self.overrides}


async def snapshot(db: AsyncSession, person_id: uuid.UUID) -> Snapshot:
    return Snapshot(roles=await current_global_roles(db, person_id),
                    groups=await current_groups(db, person_id),
                    overrides=await current_overrides(db, person_id))


def _merge(mode: str, src: Snapshot, tgt: Snapshot, parts: set[str]) -> Snapshot:
    out = Snapshot(roles=set(tgt.roles), groups=set(tgt.groups),
                   overrides=dict(tgt.overrides))
    if "roles" in parts:
        out.roles = set(src.roles) if mode == "replace" else tgt.roles | src.roles
    if "groups" in parts:
        out.groups = set(src.groups) if mode == "replace" else tgt.groups | src.groups
    if "overrides" in parts:
        out.overrides = (dict(src.overrides) if mode == "replace"
                         else {**tgt.overrides, **src.overrides})
    return out


def _override_counts(cur: dict, new: dict) -> dict:
    added = sum(1 for k in new if k not in cur)
    removed = sum(1 for k in cur if k not in new)
    changed = sum(1 for k in new if k in cur and cur[k] != new[k])
    return {"added": added, "removed": removed, "changed": changed}


async def plan_copy(
    db: AsyncSession, *, actor_id: uuid.UUID, actor_rank: int,
    source_id: uuid.UUID, target_ids: list[uuid.UUID], parts: set[str], mode: str,
) -> tuple[Snapshot, list[PlanRow], dict[str, Role]]:
    src = await snapshot(db, source_id)
    role_rows = {r.name: r for r in await db.scalars(select(Role))}
    group_names = {g.id: g.name for g in await db.scalars(select(AccessGroup))}
    accounts = set(await db.scalars(select(UserAccount.person_id).where(
        UserAccount.person_id.in_(target_ids))))
    rows: list[PlanRow] = []
    for tid in target_ids:
        person = await db.get(Person, tid)
        if person is None:
            continue
        held = await current_roles(db, tid)
        max_rank = max((role_rows[r].rank for r in held if r in role_rows), default=0)
        row = PlanRow(person=person, max_rank=max_rank)
        rows.append(row)
        if tid == actor_id:
            row.status, row.reason = "skipped", "cannot_target_self"
            continue
        if tid not in accounts:
            row.status, row.reason = "skipped", "no_account"
            continue
        if not can_touch_rank(actor_rank, max_rank):
            row.status, row.reason = "skipped", "rank_too_low"
            continue
        tgt = await snapshot(db, tid)
        row.desired = _merge(mode, src, tgt, parts)
        if "roles" in parts:
            new_roles = row.desired.roles - tgt.roles
            if any(not can_touch_rank(actor_rank, role_rows[r].rank) for r in new_roles):
                row.status, row.reason = "skipped", "role_rank_too_low"
                continue
            org_roles = {r for r in held if role_rows.get(r) and role_rows[r].scope_anchor in ORG_ANCHORS}
            if row.desired.roles != tgt.roles:
                row.roles = {"from": sorted(held),
                             "to": sorted(row.desired.roles | org_roles)}
        if "groups" in parts and row.desired.groups != tgt.groups:
            row.groups = {"from": sorted(group_names[g] for g in tgt.groups),
                          "to": sorted(group_names[g] for g in row.desired.groups)}
        if "overrides" in parts and row.desired.overrides != tgt.overrides:
            row.overrides = _override_counts(tgt.overrides, row.desired.overrides)
    return src, rows, role_rows


async def apply_copy(
    db: AsyncSession, *, actor_id: uuid.UUID, rows: list[PlanRow], parts: set[str],
    role_rows: dict[str, Role],
) -> dict[uuid.UUID, dict]:
    """Apply every `ok` row. Returns per-target change dicts (only parts that
    changed) for the caller to audit. No commit."""
    changes: dict[uuid.UUID, dict] = {}
    for row in rows:
        if row.status != "ok":
            continue
        out: dict = {}
        if "roles" in parts and row.roles is not None:
            diff = await apply_global_roles(db, actor_id=actor_id, person_id=row.person.id,
                                            desired=row.desired.roles, role_rows=role_rows)
            if diff is not None:
                out["roles"] = diff
        if "groups" in parts and row.groups is not None:
            diff = await apply_groups(db, actor_id=actor_id, person_id=row.person.id,
                                      desired=row.desired.groups)
            if diff is not None:
                out["groups"] = diff
        if "overrides" in parts and row.overrides is not None:
            diff = await apply_overrides(db, actor_id=actor_id, person_id=row.person.id,
                                         desired=row.desired.overrides)
            if diff:
                out["overrides"] = diff
        if out:
            changes[row.person.id] = out
    return changes
```

Note on `apply_global_roles`: its `desired` is the set of revocable roles the person should end with, and it computes `revocable_current` itself, so passing `row.desired.roles` (global only) leaves org-anchored grants alone. The plan row's `roles.to` includes the org roles so the UI shows the full resulting set.

- [ ] **Step 4: Add the route** to `api/src/serversherpa/api/routes/access.py`, after `put_overrides`

```python
class CopyIn(BaseModel):
    source_id: uuid.UUID
    target_ids: list[uuid.UUID]
    parts: list[str]
    mode: str = "replace"
    dry_run: bool = False


@router.post("/copy")
async def copy_access(
    body: CopyIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    """Copy one person's global roles / groups / overrides to others.
    Skips (self, no account, rank) are reported per target, never fatal."""
    if not actor.access.is_global:
        raise _err(403, "global_only")
    targets = list(dict.fromkeys(body.target_ids))
    if not targets:
        raise _err(422, "no_targets")
    parts = set(body.parts)
    if not parts:
        raise _err(422, "no_parts")
    if parts - set(PARTS):
        raise _err(422, "unknown_part")
    if body.mode not in MODES:
        raise _err(422, "unknown_mode")
    source = await db.get(Person, body.source_id)
    if source is None:
        raise _err(404, "person_not_found")

    _, rows, role_rows = await plan_copy(
        db, actor_id=actor.person.id, actor_rank=actor.access.max_rank,
        source_id=body.source_id, target_ids=targets, parts=parts, mode=body.mode)
    if not body.dry_run:
        changed = await apply_copy(db, actor_id=actor.person.id, rows=rows,
                                   parts=parts, role_rows=role_rows)
        for pid, diff in changed.items():
            audit(db, actor_id=actor.person.id, entity_type="person",
                  entity_id=str(pid), action="access.copy",
                  changes={"source_id": str(source.id),
                           "source_name": source.display_name,
                           "mode": body.mode, "parts": sorted(parts), **diff})
        await db.commit()
    return {"mode": body.mode, "parts": sorted(parts),
            "targets": [r.out() for r in rows], "applied": not body.dry_run}
```

Add `from serversherpa.access.copy import MODES, PARTS, apply_copy, plan_copy` to the imports. Check `AccessInfo.is_global` is what `_require_global` in users.py tests; if that helper checks something else, mirror it exactly.

- [ ] **Step 5: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_access_copy_api.py api/tests/test_access_overrides_api.py api/tests/test_users_detail_api.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/access/copy.py api/src/serversherpa/api/routes/access.py api/tests/test_access_copy_api.py
git commit -m "feat(access): POST /access/copy copies roles, groups and overrides to one or many people"
```

---

### Task 4: `POST /access/roles/{name}/matrix/preview`

**Files:**
- Modify: `api/src/serversherpa/api/routes/access.py` (extract matrix validation from `put_matrix`, add the preview route)
- Test: create `api/tests/test_access_matrix_preview_api.py`

**Interfaces:**
- Consumes: Task 1's `effective_cells(..., role_grants_override=...)`.
- Produces: the preview response per the spec.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_access_matrix_preview_api.py`:

```python
"""POST /access/roles/{name}/matrix/preview — who a matrix change affects."""
from sqlalchemy import select, text

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PermissionOverride, Person, PersonRole,
    ResourceGroupGate, RolePermission,
)
from tests.test_access_roles_api import full_matrix, login_admin


async def _staffer(db, first):
    p = Person(first_name=first, last_name="Staff")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="staff"))
    await db.commit()
    return p


async def test_preview_lists_flips_and_masks(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    plain = await _staffer(db, "Plain")
    overridden = await _staffer(db, "Over")
    db.add(PermissionOverride(person_id=overridden.id, resource="workers",
                              action="delete", allow=True))
    await db.commit()

    matrix = full_matrix(workers_delete=False)
    matrix["settings"]["change"] = True
    resp = await client.post("/access/roles/staff/matrix/preview", headers=hdrs,
                             json={"matrix": matrix})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == "staff"
    assert body["granted"] == ["settings:change"]
    assert body["revoked"] == ["workers:delete"]
    assert body["member_count"] == 2
    assert body["affected_count"] == 2
    by_name = {m["display_name"]: m for m in body["members"]}
    p = by_name["Plain Staff"]
    assert {(f["resource"], f["action"], f["to"]) for f in p["flips"]} == {
        ("workers", "delete", False), ("settings", "change", True)}
    assert p["masked"] == []
    o = by_name["Over Staff"]
    assert [(f["resource"], f["action"]) for f in o["flips"]] == [("settings", "change")]
    assert o["masked"] == [{"resource": "workers", "action": "delete", "by": "override"}]
    # nothing was written
    n = (await db.execute(text(
        "SELECT count(*) FROM role_permissions WHERE role='staff' "
        "AND resource='workers' AND action='delete'"))).scalar_one()
    assert n == 1


async def test_preview_masks_gate_and_other_role(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    gated = await _staffer(db, "Gated")
    g = AccessGroup(name="Finance")
    db.add(g)
    await db.flush()
    db.add(ResourceGroupGate(resource="settings", group_id=g.id))
    two = await _staffer(db, "Two")
    db.add(PersonRole(person_id=two.id, role="worker"))
    await db.commit()

    matrix = full_matrix()
    matrix["settings"]["change"] = True          # gated for Gated (not a member)
    matrix["workers"]["view"] = False            # worker still grants workers:view for Two
    resp = await client.post("/access/roles/staff/matrix/preview", headers=hdrs,
                             json={"matrix": matrix})
    assert resp.status_code == 200, resp.text
    by_name = {m["display_name"]: m for m in resp.json()["members"]}
    assert {"resource": "settings", "action": "change", "by": "gate"} in by_name["Gated Staff"]["masked"]
    assert {"resource": "workers", "action": "view", "by": "role"} in by_name["Two Staff"]["masked"]


async def test_preview_empty_role_and_guards(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/access/roles/staff/matrix/preview", headers=hdrs,
                             json={"matrix": full_matrix()})
    assert resp.status_code == 200, resp.text
    assert resp.json()["member_count"] == 0 and resp.json()["members"] == []
    assert resp.json()["granted"] == [] and resp.json()["revoked"] == []
    # same guards as the PUT
    resp = await client.post("/access/roles/admin/matrix/preview", headers=hdrs,
                             json={"matrix": full_matrix()})
    assert resp.status_code == 403
    m = full_matrix()
    m["access"]["view"] = False
    resp = await client.post("/access/roles/staff/matrix/preview", headers=hdrs,
                             json={"matrix": m})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "access_view_locked"
```

`DEFAULT_GRANTS` gives both staff and worker `workers:view`, so removing it from staff is masked by the worker role for Two.

- [ ] **Step 2: Run to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_access_matrix_preview_api.py -q`
Expected: FAIL (404/405).

- [ ] **Step 3: Extract the matrix validation and add the route**

In `api/src/serversherpa/api/routes/access.py`, above `put_matrix` add:

```python
async def _validated_matrix_edit(
    db: DbSession, actor: AuthContext, name: str, body: MatrixIn,
) -> tuple[Role, set[tuple[str, str]], set[tuple[str, str]]]:
    """Guards shared by the matrix PUT and its preview: role editable at the
    actor's rank, not a role the actor holds, known cells, developer-only
    and access:view locks. Returns (role, before, desired)."""
    role = await _load_role_for_edit(db, actor, name)
    if role.name in actor.roles:
        raise _err(403, "cannot_edit_own_role")
    for res, actions in body.matrix.items():
        if res not in REGISTRY:
            raise _err(422, "unknown_resource")
        for a, on in actions.items():
            if a not in ACTIONS:
                raise _err(422, "unknown_action")
            if on and REGISTRY[res].developer_only and name != "developer":
                raise _err(422, "developer_only_resource")
    if not body.matrix.get("access", {}).get("view", False):
        raise _err(422, "access_view_locked")
    before = {(rp.resource, rp.action) for rp in await db.scalars(
        select(RolePermission).where(RolePermission.role == name))}
    desired = {(res, a) for res, actions in body.matrix.items()
               for a, on in actions.items() if on}
    return role, before, desired
```

Rewrite `put_matrix` to start with `role, before, desired = await _validated_matrix_edit(db, actor, name, body)` and keep its delete/add/audit/commit/return exactly as they are (keep the existing comment about `cannot_edit_own_role` on the helper). Then add, right after `put_matrix`:

```python
@router.post("/roles/{name}/matrix/preview")
async def preview_matrix(
    name: str,
    body: MatrixIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    """Who a matrix change would affect: every member's effective cells are
    re-resolved with this role's grants swapped for the draft. Writes nothing."""
    _, before, desired = await _validated_matrix_edit(db, actor, name, body)
    changed = (desired - before) | (before - desired)
    members = (await db.execute(
        select(Person)
        .join(PersonRole, PersonRole.person_id == Person.id)
        .where(PersonRole.role == name, PersonRole.revoked_at.is_(None))
        .distinct().order_by(Person.last_name, Person.first_name))).scalars().all()
    out = []
    affected = 0
    for person in members:
        current = await effective_cells(db, person.id)
        draft = await effective_cells(db, person.id,
                                      role_grants_override={name: desired})
        flips, masked = [], []
        for res, action in sorted(changed):
            was = current.cells[res][action]["value"]
            now = draft.cells[res][action]
            if was != now["value"]:
                flips.append({"resource": res, "action": action,
                              "from": was, "to": now["value"]})
            else:
                masked.append({"resource": res, "action": action, "by": now["source"]})
        if flips:
            affected += 1
        out.append({"person_id": str(person.id), "display_name": person.display_name,
                    "avatar_url": presign_get(person.avatar_key),
                    "max_rank": current.access.max_rank,
                    "flips": flips, "masked": masked})
    out.sort(key=lambda m: (-len(m["flips"]), m["display_name"]))
    return {"role": name,
            "granted": sorted(f"{r}:{a}" for r, a in desired - before),
            "revoked": sorted(f"{r}:{a}" for r, a in before - desired),
            "member_count": len(members), "affected_count": affected,
            "members": out}
```

- [ ] **Step 4: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_access_matrix_preview_api.py api/tests/test_access_roles_api.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/access.py api/tests/test_access_matrix_preview_api.py
git commit -m "feat(access): matrix preview lists which members flip and which cells are masked"
```

---

### Task 5: Portal — copy access modal on the Members tab

**Files:**
- Modify: `portal/src/lib/api.ts` (types + `copyAccess`, after `getEffective`)
- Create: `portal/src/components/access/PersonChipPicker.tsx`
- Create: `portal/src/components/access/CopyAccessModal.tsx`
- Modify: `portal/src/components/access/MembersTab.tsx` (toolbar button, per-row Copy button, modal mount, toast)
- Modify: `portal/src/styles/access.css` (chip list + plan rows)
- Test: create `portal/src/components/access/PersonChipPicker.test.tsx`, `portal/src/components/access/CopyAccessModal.test.tsx`

**Interfaces:**
- Consumes: Task 3 endpoint.
- Produces: `copyAccess(body: CopyAccessIn): Promise<CopyAccessOut>`; `PersonChipPicker` props `{ options: ComboOption[]; selected: string[]; onChange(ids: string[]): void; disabled?: boolean; placeholder?: string }`; `CopyAccessModal` props `{ members: MemberItem[]; sourceId?: string | null; onClose(): void; onApplied(result: CopyAccessOut): void }`.

- [ ] **Step 1: API types and function** in `portal/src/lib/api.ts`, after `getEffective`:

```ts
export type CopyPart = 'roles' | 'groups' | 'overrides';
export type CopyMode = 'replace' | 'add';
export interface CopyAccessIn {
  source_id: string; target_ids: string[]; parts: CopyPart[]; mode: CopyMode; dry_run: boolean;
}
export interface CopyPlanRow {
  person_id: string; display_name: string; avatar_url: string | null;
  status: 'ok' | 'skipped';
  reason: 'cannot_target_self' | 'rank_too_low' | 'no_account' | 'role_rank_too_low' | null;
  roles: { from: string[]; to: string[] } | null;
  groups: { from: string[]; to: string[] } | null;
  overrides: { added: number; removed: number; changed: number } | null;
}
export interface CopyAccessOut { mode: CopyMode; parts: CopyPart[]; targets: CopyPlanRow[]; applied: boolean }

export async function copyAccess(body: CopyAccessIn): Promise<CopyAccessOut> {
  const resp = await apiFetch('/access/copy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

Match the header/body idiom used by `putRoleMatrix` in the same file.

- [ ] **Step 2: Write the failing tests**

`portal/src/components/access/PersonChipPicker.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import PersonChipPicker from './PersonChipPicker';

afterEach(cleanup);
const options = [
  { value: 'p1', label: 'Ann One', sub: 'staff' },
  { value: 'p2', label: 'Bob Two', sub: 'worker' },
];

it('adds a chip per pick, hides picked people from the menu, removes on ×', () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <PersonChipPicker options={options} selected={[]} onChange={onChange} placeholder="Add person…" />);
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Ann One'));   // ComboBox selects on mousedown
  expect(onChange).toHaveBeenLastCalledWith(['p1']);
  rerender(<PersonChipPicker options={options} selected={['p1']} onChange={onChange} placeholder="Add person…" />);
  expect(screen.getByText('Ann One').closest('.chip')).toBeTruthy();
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  expect(screen.queryAllByText('Ann One')).toHaveLength(1);   // chip only, not in the menu
  fireEvent.click(screen.getByLabelText('Remove Ann One'));
  expect(onChange).toHaveBeenLastCalledWith([]);
});
```

`portal/src/components/access/CopyAccessModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ copyAccess: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: CopyAccessModal } = await import('./CopyAccessModal');

const members = [
  { person_id: 'p1', display_name: 'Ann One', job_title: null, login_email: 'a@x', status: 'active',
    roles: ['staff'], max_rank: 40, avatar_url: null },
  { person_id: 'p2', display_name: 'Bob Two', job_title: null, login_email: 'b@x', status: 'active',
    roles: ['worker'], max_rank: 10, avatar_url: null },
] as never[];

const plan = {
  mode: 'replace', parts: ['roles', 'groups', 'overrides'], applied: false,
  targets: [{ person_id: 'p2', display_name: 'Bob Two', avatar_url: null, status: 'ok', reason: null,
              roles: { from: ['worker'], to: ['staff'] }, groups: null,
              overrides: { added: 2, removed: 0, changed: 0 } }],
};

beforeEach(() => { api.copyAccess.mockReset(); });
afterEach(cleanup);

it('previews with dry_run, renders the plan, then applies the same request', async () => {
  api.copyAccess.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, applied: true });
  const onApplied = vi.fn();
  render(<CopyAccessModal members={members} sourceId="p1" onClose={() => {}} onApplied={onApplied} />);
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Bob Two'));
  fireEvent.click(screen.getByRole('button', { name: 'Add only' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(api.copyAccess).toHaveBeenCalledWith({
    source_id: 'p1', target_ids: ['p2'], parts: ['roles', 'groups', 'overrides'],
    mode: 'add', dry_run: true }));
  expect(await screen.findByText('Role: worker → staff')).toBeTruthy();
  expect(screen.getByText('Overrides: 2 added')).toBeTruthy();
  expect(screen.getByText('Groups: no change')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(api.copyAccess).toHaveBeenLastCalledWith(expect.objectContaining({ dry_run: false })));
  await waitFor(() => expect(onApplied).toHaveBeenCalled());
});

it('shows skipped targets with a reason and keeps Apply disabled until a preview exists', async () => {
  api.copyAccess.mockResolvedValueOnce({ ...plan, targets: [{ ...plan.targets[0], status: 'skipped',
    reason: 'rank_too_low', roles: null, overrides: null }] });
  render(<CopyAccessModal members={members} sourceId="p1" onClose={() => {}} onApplied={() => {}} />);
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Bob Two'));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('Skipped — their rank is at or above yours')).toBeTruthy();
  expect(screen.getByText('0 will change, 1 skipped')).toBeTruthy();
});
```

Run: `(cd portal && node_modules/.bin/vitest run src/components/access/PersonChipPicker.test.tsx src/components/access/CopyAccessModal.test.tsx)`
Expected: FAIL (modules not found).

- [ ] **Step 3: `PersonChipPicker.tsx`**

```tsx
/**
 * PersonChipPicker — pick many people one at a time: the house ComboBox
 * adds a removable chip per pick and drops picked people from its menu.
 * No native multi-select anywhere in the portal; this is the reusable shape.
 */
import ComboBox, { type ComboOption } from '../ComboBox';

interface Props {
  options: ComboOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export default function PersonChipPicker({ options, selected, onChange, disabled, placeholder }: Props) {
  const byId = new Map(options.map((o) => [o.value, o]));
  const remaining = options.filter((o) => !selected.includes(o.value));
  return (
    <div className="chip-picker">
      {selected.length > 0 && (
        <div className="chip-picker-list">
          {selected.map((id) => (
            <span key={id} className="chip">
              {byId.get(id)?.label ?? id}
              <button type="button" className="chip-x" disabled={disabled}
                      aria-label={`Remove ${byId.get(id)?.label ?? id}`}
                      onClick={() => onChange(selected.filter((s) => s !== id))}>×</button>
            </span>
          ))}
        </div>
      )}
      <ComboBox options={remaining} value="" disabled={disabled}
                placeholder={placeholder ?? 'Add person…'}
                onChange={(v) => { if (v) onChange([...selected, v]); }} />
    </div>
  );
}
```

`ComboBox` opens its list on input focus/click and selects an option on `mouseDown` (not click); the tests above follow that.

- [ ] **Step 4: `CopyAccessModal.tsx`**

```tsx
/**
 * CopyAccessModal — copy one member's global roles, access groups and
 * overrides to one or many members. Preview (dry run) first, then Apply
 * sends the identical request for real. Replace is V2's behavior; Add
 * only unions.
 */
import { useState } from 'react';

import {
  ApiError, copyAccess,
  type CopyAccessOut, type CopyMode, type CopyPart, type CopyPlanRow, type MemberItem,
} from '../../lib/api';
import ComboBox from '../ComboBox';
import PersonChipPicker from './PersonChipPicker';

const PART_LABELS: Record<CopyPart, string> = {
  roles: 'Role', groups: 'Access groups', overrides: 'Overrides',
};
const MODE_HINT: Record<CopyMode, string> = {
  replace: 'Targets end up with exactly what the source has. Anything they had that the source lacks is removed.',
  add: 'Targets keep what they have and gain what the source has. Nothing is removed.',
};
const SKIP_REASONS: Record<NonNullable<CopyPlanRow['reason']>, string> = {
  cannot_target_self: "that's you",
  rank_too_low: 'their rank is at or above yours',
  no_account: 'they have no login account',
  role_rank_too_low: "the source holds a role you can't grant",
};
const ERRORS: Record<string, string> = {
  person_not_found: 'The source person no longer exists — refresh and try again.',
  global_only: 'Only staff with global access can copy access.',
  no_targets: 'Add at least one person to copy to.',
  no_parts: 'Pick at least one thing to copy.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was changed.';

const setList = (from: string[], to: string[]): string => {
  const added = to.filter((x) => !from.includes(x)).map((x) => `+${x}`);
  const removed = from.filter((x) => !to.includes(x)).map((x) => `−${x}`);
  return [...added, ...removed].join(', ');
};

export function planLine(row: CopyPlanRow, part: CopyPart): string {
  if (part === 'roles') {
    return row.roles ? `Role: ${row.roles.from.join(', ') || 'none'} → ${row.roles.to.join(', ') || 'none'}` : 'Role: no change';
  }
  if (part === 'groups') {
    return row.groups ? `Groups: ${setList(row.groups.from, row.groups.to)}` : 'Groups: no change';
  }
  if (!row.overrides) return 'Overrides: no change';
  const bits = [];
  if (row.overrides.added) bits.push(`${row.overrides.added} added`);
  if (row.overrides.removed) bits.push(`${row.overrides.removed} removed`);
  if (row.overrides.changed) bits.push(`${row.overrides.changed} changed`);
  return `Overrides: ${bits.join(', ')}`;
}

export default function CopyAccessModal({ members, sourceId, onClose, onApplied }: {
  members: MemberItem[];
  sourceId?: string | null;
  onClose: () => void;
  onApplied: (result: CopyAccessOut) => void;
}) {
  const [source, setSource] = useState(sourceId ?? '');
  const [targets, setTargets] = useState<string[]>([]);
  const [parts, setParts] = useState<Set<CopyPart>>(new Set(['roles', 'groups', 'overrides']));
  const [mode, setMode] = useState<CopyMode>('replace');
  const [plan, setPlan] = useState<CopyAccessOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const options = members.map((m) => ({
    value: m.person_id, label: m.display_name, sub: m.roles.join(', ') || 'no roles',
  }));
  const partList = (['roles', 'groups', 'overrides'] as CopyPart[]).filter((p) => parts.has(p));
  const ready = !!source && targets.length > 0 && partList.length > 0 && !busy;

  const reset = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPlan(null); setError(''); };

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError('');
    try {
      const result = await copyAccess({
        source_id: source, target_ids: targets, parts: partList, mode, dry_run: dryRun,
      });
      if (dryRun) setPlan(result);
      else onApplied(result);
    } catch (e) {
      setError(msgFor(e));
    } finally {
      setBusy(false);
    }
  };

  const willChange = plan?.targets.filter((t) => t.status === 'ok'
    && (t.roles || t.groups || t.overrides)).length ?? 0;
  const skipped = plan?.targets.filter((t) => t.status === 'skipped').length ?? 0;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card copy-access-card" role="dialog" aria-label="Copy access">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Access</div>
            <h3>Copy access</h3>
            <p className="page-hint">Use one person's setup as the starting point for others. Preview first; nothing changes until you apply.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full"><label>Source</label>
              <ComboBox options={options} value={source} placeholder="Copy from…" disabled={busy}
                        onChange={reset(setSource)} /></div>
            <div className="full"><label>Copy to</label>
              <PersonChipPicker options={options.filter((o) => o.value !== source)}
                                selected={targets} disabled={busy}
                                onChange={reset(setTargets)} placeholder="Add person…" /></div>
            <div><label>Copy</label>
              <div className="copy-parts">
                {(Object.keys(PART_LABELS) as CopyPart[]).map((p) => (
                  <label key={p} className="init-check">
                    <input type="checkbox" checked={parts.has(p)} disabled={busy}
                           onChange={() => reset(setParts)(new Set(
                             parts.has(p) ? [...parts].filter((x) => x !== p) : [...parts, p]))} />
                    {PART_LABELS[p]}
                  </label>
                ))}
              </div></div>
            <div><label>Mode</label>
              <div className="segmented" role="group" aria-label="Copy mode">
                <button type="button" className={mode === 'replace' ? 'on' : ''} disabled={busy}
                        aria-pressed={mode === 'replace'} onClick={() => reset(setMode)('replace')}>Replace</button>
                <button type="button" className={mode === 'add' ? 'on' : ''} disabled={busy}
                        aria-pressed={mode === 'add'} onClick={() => reset(setMode)('add')}>Add only</button>
              </div>
              <p className="set-note">{MODE_HINT[mode]}</p></div>
          </div>

          {plan && (
            <div className="copy-plan">
              {plan.targets.map((t) => (
                <div key={t.person_id} className={`copy-plan-row ${t.status}`}>
                  <b>{t.display_name}</b>
                  {t.status === 'skipped' ? (
                    <span className="copy-skip">Skipped — {SKIP_REASONS[t.reason ?? 'rank_too_low']}</span>
                  ) : (
                    <ul>{partList.map((p) => <li key={p}>{planLine(t, p)}</li>)}</ul>
                  )}
                </div>
              ))}
              <p className="set-note">{willChange} will change, {skipped} skipped</p>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={!plan || willChange === 0 || busy}
                  onClick={() => void run(false)}>
            {busy && plan ? 'Applying…' : 'Apply'}
          </button>
          <button className="mini-btn accent" disabled={!ready} onClick={() => void run(true)}>
            {busy && !plan ? 'Previewing…' : 'Preview'}
          </button>
          <button className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
```

The house `segmented` group styles its active button with class `on` (directory.css), which the markup above sets.

- [ ] **Step 5: Wire the Members tab**

In `MembersTab.tsx`: import `CopyAccessModal`, `useToast` from `'../../lib/notificationsContext'`. State: `const [copyFor, setCopyFor] = useState<{ open: boolean; sourceId: string | null }>({ open: false, sourceId: null });` and `const toast = useToast();`. In the toolbar, after `ExportButton`, when `canEdit`:

```tsx
          {canEdit && (
            <button className="mini-btn accent" onClick={() => setCopyFor({ open: true, sourceId: null })}>
              Copy access…
            </button>
          )}
```

In each row's last cell, after the Overrides button, when `canEdit`:

```tsx
                  {canEdit && (
                    <button className="mini-btn" onClick={() => setCopyFor({ open: true, sourceId: m.person_id })}>
                      Copy
                    </button>
                  )}
```

Mount after the OverrideEditor block:

```tsx
      {copyFor.open && members && (
        <CopyAccessModal
          members={members}
          sourceId={copyFor.sourceId}
          onClose={() => setCopyFor({ open: false, sourceId: null })}
          onApplied={(result) => {
            setCopyFor({ open: false, sourceId: null });
            const changed = result.targets.filter((t) => t.status === 'ok' && (t.roles || t.groups || t.overrides)).length;
            const skipped = result.targets.filter((t) => t.status === 'skipped').length;
            toast(`Access copied to ${changed} ${changed === 1 ? 'person' : 'people'}`
              + (skipped ? `, ${skipped} skipped` : ''));
            load();
            onChanged();
          }}
        />
      )}
```

Widen the grid's last column from `110px` to `170px` in the `grid` template string (line ~155) so Overrides and Copy sit side by side.

- [ ] **Step 6: Styles** — append to `portal/src/styles/access.css`:

```css
/* ── copy access ─────────────────────────────────────────── */
.modal-card.reports-modal-card.rgm-card.copy-access-card { width: min(720px, 96vw); max-width: 96vw; overflow: visible; max-height: none; }
.chip-picker { display: flex; flex-direction: column; gap: 8px; }
.chip-picker-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-picker .chip { display: inline-flex; align-items: center; gap: 6px; }
.chip-x { border: 0; background: transparent; cursor: pointer; font-size: 14px; line-height: 1; color: inherit; padding: 0 2px; }
.copy-parts { display: flex; flex-wrap: wrap; gap: 12px; padding-top: 6px; }
.copy-plan { margin-top: 14px; border-top: 1px solid var(--c-amber-bd, rgba(255, 161, 46, 0.38)); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.copy-plan-row { display: grid; grid-template-columns: 180px 1fr; gap: 10px; font-size: 12.5px; }
.copy-plan-row ul { margin: 0; padding-left: 16px; }
.copy-plan-row.skipped { color: var(--text-mute); }
.copy-skip { font-style: italic; }
```

The border reuses the `.save-bar` amber token so the plan reads as the pending-change area.

- [ ] **Step 7: Run the whole suite and type check**

Run: `npm --prefix portal run test` then `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: all PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Copy access modal on the Members tab with preview, Replace/Add only, and a chip people picker"
```

---

### Task 6: Portal — role change review modal on the Roles tab

**Files:**
- Modify: `portal/src/lib/api.ts` (types + `previewRoleMatrix`, after `putRoleMatrix`)
- Create: `portal/src/components/access/RoleReviewModal.tsx`
- Modify: `portal/src/components/access/RolesTab.tsx` (Save opens the modal; Confirm runs `save`)
- Modify: `portal/src/styles/access.css`
- Test: create `portal/src/components/access/RoleReviewModal.test.tsx`

**Interfaces:**
- Consumes: Task 4 endpoint.
- Produces: `previewRoleMatrix(name, matrix): Promise<MatrixPreviewOut>`; `RoleReviewModal` props `{ role: AccessRole; matrix: Matrix; resources: AccessResourceOut[]; onBack(): void; onConfirm(): Promise<void>; }`.

- [ ] **Step 1: API** in `portal/src/lib/api.ts`, after `putRoleMatrix`:

```ts
export interface MatrixPreviewMember {
  person_id: string; display_name: string; avatar_url: string | null; max_rank: number;
  flips: { resource: string; action: Action; from: boolean; to: boolean }[];
  masked: { resource: string; action: Action; by: 'override' | 'gate' | 'hard_gate' | 'floor' | 'role' }[];
}
export interface MatrixPreviewOut {
  role: string; granted: string[]; revoked: string[];
  member_count: number; affected_count: number; members: MatrixPreviewMember[];
}

export async function previewRoleMatrix(
  name: string, matrix: Record<string, Record<Action, boolean>>,
): Promise<MatrixPreviewOut> {
  const resp = await apiFetch(`/access/roles/${name}/matrix/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matrix }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 2: Write the failing test** `portal/src/components/access/RoleReviewModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ previewRoleMatrix: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: RoleReviewModal } = await import('./RoleReviewModal');

afterEach(cleanup);

const role = { name: 'staff', label: 'Staff', color: null, description: '', rank: 40,
  scope_anchor: 'global', is_system: true, member_count: 2, matrix: {} } as never;
const resources = [
  { id: 'workers', label: 'Workers', developer_only: false, always_viewable: false, gated_by: [] },
  { id: 'settings', label: 'Settings', developer_only: false, always_viewable: false, gated_by: [] },
];

it('summarizes grants and members, expands flips and masks, confirms', async () => {
  api.previewRoleMatrix.mockResolvedValue({
    role: 'staff', granted: ['settings:change'], revoked: ['workers:delete'],
    member_count: 2, affected_count: 1,
    members: [
      { person_id: 'p1', display_name: 'Plain Staff', avatar_url: null, max_rank: 40,
        flips: [{ resource: 'workers', action: 'delete', from: true, to: false }], masked: [] },
      { person_id: 'p2', display_name: 'Over Staff', avatar_url: null, max_rank: 40,
        flips: [], masked: [{ resource: 'workers', action: 'delete', by: 'override' }] },
    ],
  });
  const onConfirm = vi.fn(async () => {});
  render(<RoleReviewModal role={role} matrix={{}} resources={resources}
                          onBack={() => {}} onConfirm={onConfirm} />);
  expect(await screen.findByText('1 of 2 members affected')).toBeTruthy();
  expect(screen.getByText('Settings · change')).toBeTruthy();
  expect(screen.getByText('Workers · delete')).toBeTruthy();
  fireEvent.click(screen.getByText('Plain Staff'));
  expect(screen.getByText('Workers · delete: on → off')).toBeTruthy();
  fireEvent.click(screen.getByText('Over Staff'));
  expect(screen.getByText('Workers · delete — unchanged, decided by override')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalled());
});

it('says when nobody holds the role and still allows confirm', async () => {
  api.previewRoleMatrix.mockResolvedValue({ role: 'staff', granted: [], revoked: ['workers:delete'],
    member_count: 0, affected_count: 0, members: [] });
  render(<RoleReviewModal role={role} matrix={{}} resources={resources}
                          onBack={() => {}} onConfirm={async () => {}} />);
  expect(await screen.findByText('No one holds this role')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(false);
});
```

Run: `(cd portal && node_modules/.bin/vitest run src/components/access/RoleReviewModal.test.tsx)` → FAIL (module not found).

- [ ] **Step 3: `RoleReviewModal.tsx`**

```tsx
/**
 * RoleReviewModal — the blast radius of a role-matrix edit before it is
 * saved: which grants change, and for every member whether their effective
 * access actually flips or is masked by an override, gate or another role.
 */
import { useEffect, useState } from 'react';

import { RANK_LABELS } from '../../lib/access';
import {
  ApiError, previewRoleMatrix,
  type AccessResourceOut, type AccessRole, type MatrixPreviewOut,
} from '../../lib/api';
import { avatarGradient, initials } from '../../lib/format';

type Matrix = Record<string, Record<string, boolean>>;

const BY_LABEL: Record<string, string> = {
  override: 'override', gate: 'group gate', hard_gate: 'hard gate',
  floor: 'always-viewable floor', role: 'another role they hold',
};
const ERRORS: Record<string, string> = {
  rank_too_low: 'Your rank is too low to change this role.',
  cannot_edit_own_role: 'You cannot edit a role you hold.',
  developer_only_resource: 'Developer-only pages can only be granted to the developer role.',
  access_view_locked: 'Access · view is locked on — a role that can reach this page must keep it.',
};
const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

const rankLabel = (rank: number): string =>
  RANK_LABELS.find(([r]) => rank >= r)?.[1] ?? 'Custom';

export default function RoleReviewModal({ role, matrix, resources, onBack, onConfirm }: {
  role: AccessRole;
  matrix: Matrix;
  resources: AccessResourceOut[];
  onBack: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<MatrixPreviewOut | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    previewRoleMatrix(role.name, matrix as never).then(setPreview).catch((e) => setError(msgFor(e)));
  }, [role.name, matrix]);

  const label = (cell: string) => {
    const [res, action] = cell.split(':');
    return `${resources.find((r) => r.id === res)?.label ?? res} · ${action}`;
  };
  const cellLabel = (res: string, action: string) => label(`${res}:${action}`);

  const confirm = async () => {
    setSaving(true);
    setError('');
    try { await onConfirm(); } catch (e) { setError(msgFor(e)); setSaving(false); }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onBack(); }}>
      <div className="modal-card reports-modal-card rgm-card role-review-card" role="dialog" aria-label="Review role changes">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Roles</div>
            <h3>Review changes to {role.label}</h3>
            <p className="page-hint">Everyone holding this role is affected the moment you confirm.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onBack} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {!preview && !error && <p className="set-note">Working out who this affects…</p>}
          {preview && (
            <>
              <div className="rr-summary">
                <span className="chip c-green">+{preview.granted.length} grants</span>
                <span className="chip c-red">−{preview.revoked.length} grants</span>
                <span className="chip">{preview.affected_count} of {preview.member_count} members affected</span>
              </div>
              <div className="rr-grants">
                <div><b>Added</b>{preview.granted.length === 0 ? <span>—</span>
                  : preview.granted.map((c) => <span key={c}>{label(c)}</span>)}</div>
                <div><b>Removed</b>{preview.revoked.length === 0 ? <span>—</span>
                  : preview.revoked.map((c) => <span key={c}>{label(c)}</span>)}</div>
              </div>
              {preview.members.length === 0 ? (
                <div className="dir-empty"><b>No one holds this role</b>The change takes effect for anyone granted it later.</div>
              ) : (
                <div className="rr-members">
                  {preview.members.map((m) => {
                    const isOpen = open.has(m.person_id);
                    return (
                      <div key={m.person_id} className="rr-member">
                        <button type="button" className="rr-member-head" aria-expanded={isOpen}
                                onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(m.person_id)) n.delete(m.person_id); else n.add(m.person_id); return n; })}>
                          <span className="dir-avatar" style={{ background: m.avatar_url ? 'var(--surface-2)' : avatarGradient(m.display_name) }}>
                            {m.avatar_url ? <img src={m.avatar_url} alt="" /> : initials(m.display_name)}
                          </span>
                          <span className="rr-name">{m.display_name}</span>
                          <span className="rr-rank">{rankLabel(m.max_rank)}</span>
                          <span className={`rr-count ${m.flips.length ? 'on' : ''}`}>
                            {m.flips.length ? `${m.flips.length} permission${m.flips.length === 1 ? '' : 's'} change` : 'no effective change'}
                          </span>
                        </button>
                        {isOpen && (
                          <ul className="rr-detail">
                            {m.flips.map((f) => (
                              <li key={`${f.resource}:${f.action}`}>{cellLabel(f.resource, f.action)}: {f.from ? 'on' : 'off'} → {f.to ? 'on' : 'off'}</li>
                            ))}
                            {m.masked.map((k) => (
                              <li key={`${k.resource}:${k.action}`} className="rr-masked">
                                {cellLabel(k.resource, k.action)} — unchanged, decided by {BY_LABEL[k.by]}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={!preview || saving} onClick={() => void confirm()}>
            {saving ? 'Saving…' : 'Confirm'}
          </button>
          <button className="mini-btn" onClick={onBack} disabled={saving}>Back</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
```

`chip c-green` / `chip c-red` are defined in `directory.css`.

- [ ] **Step 4: Wire the Roles tab**

In `RolesTab.tsx`: import `RoleReviewModal`; add `const [reviewOpen, setReviewOpen] = useState(false);`. Change the save-bar's Save button to `onClick={() => setReviewOpen(true)}` with label "Save changes". Make `save` close the modal on success: after `await onChanged();` add `setReviewOpen(false);`, and on failure rethrow so the modal shows the error:

```ts
  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      await putRoleMatrix(role.name, draft);
      await onChanged();
      setReviewOpen(false);
    } catch (e) {
      setErr(msgFor(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };
```

Mount next to `CloneRoleModal`:

```tsx
      {reviewOpen && (
        <RoleReviewModal role={role} matrix={draft} resources={summary.resources}
                         onBack={() => setReviewOpen(false)} onConfirm={save} />
      )}
```

There is no `RolesTab.test.tsx` today; `Access.test.tsx` does not exercise Save, so nothing else changes.

- [ ] **Step 5: Styles** — append to `portal/src/styles/access.css`:

```css
/* ── role change review ──────────────────────────────────── */
.modal-card.reports-modal-card.rgm-card.role-review-card { width: min(760px, 96vw); max-width: 96vw; }
.rr-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.rr-grants { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12.5px; margin-bottom: 14px; }
.rr-grants > div { display: flex; flex-direction: column; gap: 3px; }
.rr-grants b { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-mute); }
.rr-members { display: flex; flex-direction: column; gap: 4px; max-height: 340px; overflow: auto; }
.rr-member-head { display: grid; grid-template-columns: 32px 1fr 110px 170px; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; border: 0; background: transparent; text-align: left; cursor: pointer; border-radius: 8px; font: inherit; color: inherit; }
.rr-member-head:hover { background: var(--surface-2); }
.rr-name { font-weight: 600; }
.rr-rank, .rr-count { font-size: 12px; color: var(--text-mute); }
.rr-count.on { color: var(--text-dark); font-weight: 600; }
.rr-detail { margin: 0 0 6px 50px; padding-left: 16px; font-size: 12.5px; }
.rr-masked { color: var(--text-mute); }
```

- [ ] **Step 6: Run the whole suite and type check**

Run: `npm --prefix portal run test` then `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: all PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Save on the Roles tab opens a review of who the matrix change affects"
```

---

### Task 7: Full suites

- [ ] **Step 1:** `SS_TEST_DB=serversherpa_test_accesscopy PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests -q` (about 22 minutes; prefix `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` for the WeasyPrint tests). Expected: all PASS.
- [ ] **Step 2:** `npm --prefix portal run test` and `(cd portal && node_modules/.bin/tsc --noEmit)`. Expected: all PASS.
- [ ] **Step 3:** Append `Task 7: full suites green` to `.superpowers/sdd/progress.md`.
