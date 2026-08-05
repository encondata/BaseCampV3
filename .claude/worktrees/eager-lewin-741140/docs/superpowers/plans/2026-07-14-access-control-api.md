# Access Control API Implementation Plan (1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-authoritative access control (roles/ranks/groups/overrides/row-scoping) plus an app-wide audit trail, with every existing endpoint converted from `require_roles` to `require_permission`.

**Architecture:** A code-side resource registry + DB-stored grants, resolved per-request by one resolver (`effective_permissions`) whose precedence is hard gates → override → group gate → role union, with `always_viewable` floor. Row scoping composes separately via `scope_conditions()`. A shared `audit()` service writes an append-only `audit_log` row inside the same transaction as every mutation.

**Tech Stack:** FastAPI (async), SQLAlchemy 2.0, Alembic, Postgres, pytest (asyncio), httpx test client.

**Spec:** `docs/superpowers/specs/2026-07-14-access-control-design.md` — read it first. This plan is 1 of 2; the portal plan is `2026-07-14-access-control-portal.md`.

## Global Constraints

- Work on branch `feature/access-control` (worktree created at execution time).
- Run API tests with: `cd api && .venv/bin/pytest tests/ -x -q` (conftest auto-migrates `serversherpa_test`).
- All timestamps `datetime.now(UTC)`. All new tables follow existing conventions (uuid PKs via `gen_random_uuid()`, `TIMESTAMP(timezone=True)`).
- Ranks: developer/founder 100, super_admin 80, admin 60, staff 40, client_owner/vendor_owner 30, client_admin/vendor_admin 20, client_viewer/vendor_viewer 10, worker 10, external 5. Group-gate bypass threshold: `max_rank >= 60`.
- Rank rule (one function, used everywhere): `can_touch_rank(actor_rank, target_rank) = actor_rank >= 100 or target_rank < actor_rank`. Self-targeting stays forbidden on admin endpoints.
- Hard gates (`developer_only`, anchor-visibility) beat everything including `always_viewable`; `always_viewable` beats overrides/gates/role grants. (This resolves a spec ambiguity: external users do NOT see the access page just because of the anti-lockout floor.)
- `access:change` is seeded for admin (60) and above. super_admin differs from admin by *rank* (can manage admins), per spec §2; the spec §9 phrase "super_admin = admin + access editing" is superseded by "access:change defaults to admin+" (§2 rule 4, §6).
- Never log sensitive fields to audit: denylist `{"password_hash", "temp_password", "password", "token_hash", "totp_secret_enc"}`.
- Error responses always `{"code": "<snake_case>"}` via `HTTPException(status_code=…, detail={"code": …})`.
- Deviation from spec §6 (noted, intentional): person role reassignment reuses the existing `PUT /users/{person_id}/roles` endpoint (upgraded to `access:change` + rank rules) instead of adding a duplicate `PUT /access/people/{id}/role`.
- Commit after every task with the message given in its final step.

---

### Task 1: Migration 0009 + model classes + conftest update

**Files:**
- Create: `api/migrations/versions/0009_access_control.py`
- Modify: `api/src/serversherpa/db/models.py` (append new classes; extend `Role`)
- Modify: `api/tests/conftest.py:52-54` (truncate list + matrix reseed)
- Test: `api/tests/test_access_model.py`

**Interfaces:**
- Produces: tables `role_permissions`, `access_groups`, `access_group_members`, `resource_group_gates`, `permission_overrides`, `audit_log`; extended `roles` columns `rank/scope_anchor/is_system/label/color`; model classes `RolePermission`, `AccessGroup`, `AccessGroupMember`, `ResourceGroupGate`, `PermissionOverride`, `AuditLog`.
- Produces: system roles seeded per Global Constraints; existing grants remapped `client→client_viewer`, `vendor→vendor_viewer`; role rows `client`, `vendor` deleted.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_access_model.py
"""Migration 0009 sanity: system roles seeded, grants remapped, matrix populated."""
import pytest
from sqlalchemy import text


async def test_system_roles_seeded(db):
    rows = (await db.execute(text(
        "SELECT name, rank, scope_anchor, is_system FROM roles ORDER BY rank DESC, name"
    ))).all()
    by_name = {r.name: r for r in rows}
    assert by_name["developer"].rank == 100
    assert by_name["founder"].rank == 100
    assert by_name["super_admin"].rank == 80
    assert by_name["admin"].rank == 60
    assert by_name["staff"].rank == 40
    assert by_name["client_owner"].rank == 30
    assert by_name["client_owner"].scope_anchor == "client"
    assert by_name["vendor_viewer"].scope_anchor == "partner"
    assert by_name["worker"].scope_anchor == "self"
    assert "client" not in by_name and "vendor" not in by_name
    assert all(by_name[n].is_system for n in by_name)


async def test_default_matrix_seeded(db):
    n = (await db.execute(text(
        "SELECT count(*) FROM role_permissions WHERE role='staff' AND resource='workers'"
    ))).scalar_one()
    assert n == 4  # staff: view/add/change/delete on workers
    dev_devtools = (await db.execute(text(
        "SELECT count(*) FROM role_permissions WHERE role='developer' AND resource='devtools'"
    ))).scalar_one()
    assert dev_devtools == 4
    founder_devtools = (await db.execute(text(
        "SELECT count(*) FROM role_permissions WHERE role='founder' AND resource='devtools'"
    ))).scalar_one()
    assert founder_devtools == 0


async def test_new_tables_exist(db):
    for table in ("access_groups", "access_group_members", "resource_group_gates",
                  "permission_overrides", "audit_log"):
        ok = (await db.execute(text(
            "SELECT 1 FROM information_schema.tables WHERE table_name = :t"),
            {"t": table})).scalar()
        assert ok == 1, table
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_access_model.py -x -q`
Expected: FAIL (alembic head is 0008 — `rank` column / tables missing).

- [ ] **Step 3: Write the migration**

```python
# api/migrations/versions/0009_access_control.py
"""access control — rank/scope on roles, permission matrix, groups + gates,
per-person overrides, app-wide audit log. Remaps client→client_viewer and
vendor→vendor_viewer, then retires the flat roles.

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (name, rank, anchor, label, color, description)
SYSTEM_ROLES = [
    ("developer",     100, "global",  "Developer",      "c-red",    "Full control including backend/server-side surfaces"),
    ("founder",       100, "global",  "Founder",        "c-red",    "Full administrative control; backend surfaces excluded"),
    ("super_admin",    80, "global",  "Super admin",    "c-amber",  "Manages admins and everything below"),
    ("admin",          60, "global",  "Administrator",  "c-amber",  "Full business administration"),
    ("staff",          40, "global",  "Staff",          "c-aqua",   "Day-to-day operations"),
    ("client_owner",   30, "client",  "Client owner",   "c-blue",   "Client org — owner"),
    ("client_admin",   20, "client",  "Client admin",   "c-blue",   "Client org — admin"),
    ("client_viewer",  10, "client",  "Client viewer",  "c-blue",   "Client org — read-only"),
    ("vendor_owner",   30, "partner", "Vendor owner",   "c-violet", "Vendor org — owner"),
    ("vendor_admin",   20, "partner", "Vendor admin",   "c-violet", "Vendor org — admin"),
    ("vendor_viewer",  10, "partner", "Vendor viewer",  "c-violet", "Vendor org — read-only"),
    ("worker",         10, "self",    "Worker",         "c-green",  "Field worker — own records"),
    ("external",        5, "self",    "External",       "c-slate",  "Minimal external access"),
]

FULL = ("view", "add", "change", "delete")
_ALL = ["dashboard", "users", "workers", "clients", "partners",
        "attachments", "settings", "access", "audit", "devtools"]
# NOTE: keep in sync with serversherpa/access/defaults.py (live copy).
DEFAULT_GRANTS: dict[str, dict[str, tuple[str, ...]]] = {
    "developer":   {r: FULL for r in _ALL},
    "founder":     {r: FULL for r in _ALL if r != "devtools"},
    "super_admin": {r: FULL for r in _ALL if r != "devtools"},
    "admin": {"dashboard": ("view",), "users": FULL, "workers": FULL,
              "clients": FULL, "partners": FULL, "attachments": FULL,
              "settings": ("view", "change"), "access": ("view", "change"),
              "audit": ("view",)},
    "staff": {"dashboard": ("view",), "users": ("view", "add", "change"),
              "workers": FULL, "clients": FULL, "partners": FULL,
              "attachments": FULL, "settings": ("view",), "access": ("view",)},
    "client_owner":  {"dashboard": ("view",), "clients": ("view", "change"),
                      "attachments": ("view",)},
    "client_admin":  {"dashboard": ("view",), "clients": ("view", "change"),
                      "attachments": ("view",)},
    "client_viewer": {"dashboard": ("view",), "clients": ("view",)},
    "vendor_owner":  {"dashboard": ("view",), "partners": ("view", "change"),
                      "workers": ("view",)},
    "vendor_admin":  {"dashboard": ("view",), "partners": ("view", "change"),
                      "workers": ("view",)},
    "vendor_viewer": {"dashboard": ("view",), "partners": ("view",)},
    "worker":   {"dashboard": ("view",), "workers": ("view",)},
    "external": {},
}


def upgrade() -> None:
    op.add_column("roles", sa.Column("rank", sa.Integer, nullable=False,
                                     server_default="0"))
    op.add_column("roles", sa.Column("scope_anchor", sa.Text, nullable=False,
                                     server_default="global"))
    op.add_column("roles", sa.Column("is_system", sa.Boolean, nullable=False,
                                     server_default=sa.text("false")))
    op.add_column("roles", sa.Column("label", sa.Text))
    op.add_column("roles", sa.Column("color", sa.Text))
    op.create_check_constraint(
        "roles_scope_anchor_check", "roles",
        "scope_anchor IN ('global','client','partner','self')")

    conn = op.get_bind()
    for name, rank, anchor, label, color, desc in SYSTEM_ROLES:
        conn.execute(sa.text("""
            INSERT INTO roles (name, description, rank, scope_anchor, is_system, label, color)
            VALUES (:n, :d, :r, :a, true, :l, :c)
            ON CONFLICT (name) DO UPDATE SET description = :d, rank = :r,
                scope_anchor = :a, is_system = true, label = :l, color = :c
        """), {"n": name, "d": desc, "r": rank, "a": anchor, "l": label, "c": color})

    # remap retired flat roles (ALL rows incl. revoked history — FK-safe)
    conn.execute(sa.text("UPDATE person_roles SET role='client_viewer' WHERE role='client'"))
    conn.execute(sa.text("UPDATE person_roles SET role='vendor_viewer' WHERE role='vendor'"))
    conn.execute(sa.text("DELETE FROM roles WHERE name IN ('client','vendor')"))

    op.create_table(
        "role_permissions",
        sa.Column("role", sa.Text, sa.ForeignKey("roles.name", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("resource", sa.Text, primary_key=True),
        sa.Column("action", sa.Text, primary_key=True),
        sa.CheckConstraint("action IN ('view','add','change','delete')",
                           name="role_permissions_action_check"),
    )
    for role, grants in DEFAULT_GRANTS.items():
        for resource, actions in grants.items():
            for action in actions:
                conn.execute(sa.text(
                    "INSERT INTO role_permissions (role, resource, action) "
                    "VALUES (:r, :res, :a)"),
                    {"r": role, "res": resource, "a": action})

    op.create_table(
        "access_groups",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text, nullable=False, unique=True),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("icon", sa.Text, nullable=False, server_default="users"),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_table(
        "access_group_members",
        sa.Column("group_id", UUID(as_uuid=True),
                  sa.ForeignKey("access_groups.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  primary_key=True),
        sa.Column("added_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("added_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_table(
        "resource_group_gates",
        sa.Column("resource", sa.Text, primary_key=True),
        sa.Column("group_id", UUID(as_uuid=True),
                  sa.ForeignKey("access_groups.id", ondelete="CASCADE"),
                  primary_key=True),
    )
    op.create_table(
        "permission_overrides",
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  primary_key=True),
        sa.Column("resource", sa.Text, primary_key=True),
        sa.Column("action", sa.Text, primary_key=True),
        sa.Column("allow", sa.Boolean, nullable=False),
        sa.Column("set_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("set_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("action IN ('view','add','change','delete')",
                           name="permission_overrides_action_check"),
    )
    op.create_table(
        "audit_log",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("actor_person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  comment="NULL only for pre-auth events (failed logins)"),
        sa.Column("entity_type", sa.Text, nullable=False),
        sa.Column("entity_id", sa.Text, comment="uuid as text; email for login events"),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("changes", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("ip", INET),
        sa.Column("at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("audit_log_entity_idx", "audit_log",
                    ["entity_type", "entity_id", "at"])
    op.create_index("audit_log_actor_idx", "audit_log", ["actor_person_id", "at"])


def downgrade() -> None:
    op.drop_table("audit_log")
    op.drop_table("permission_overrides")
    op.drop_table("resource_group_gates")
    op.drop_table("access_group_members")
    op.drop_table("access_groups")
    op.drop_table("role_permissions")
    conn = op.get_bind()
    conn.execute(sa.text("""
        INSERT INTO roles (name, description) VALUES
        ('client', 'Client contact'), ('vendor', 'Vendor contact')
        ON CONFLICT (name) DO NOTHING"""))
    conn.execute(sa.text("UPDATE person_roles SET role='client' WHERE role='client_viewer'"))
    conn.execute(sa.text("UPDATE person_roles SET role='vendor' WHERE role='vendor_viewer'"))
    conn.execute(sa.text(
        "DELETE FROM roles WHERE name NOT IN "
        "('admin','staff','worker','client','vendor','external')"))
    op.drop_constraint("roles_scope_anchor_check", "roles")
    for col in ("rank", "scope_anchor", "is_system", "label", "color"):
        op.drop_column("roles", col)
```

- [ ] **Step 4: Extend models.py**

In `api/src/serversherpa/db/models.py`, replace the `Role` class body and append after `WorkerCertification`:

```python
class Role(Base):
    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(primary_key=True)
    description: Mapped[str]
    rank: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    scope_anchor: Mapped[str] = mapped_column(server_default="global")
    is_system: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    label: Mapped[str | None]
    color: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

```python
class RolePermission(Base):
    __tablename__ = "role_permissions"

    role: Mapped[str] = mapped_column(
        ForeignKey("roles.name", ondelete="CASCADE"), primary_key=True)
    resource: Mapped[str] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(primary_key=True)


class AccessGroup(Base):
    __tablename__ = "access_groups"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    icon: Mapped[str] = mapped_column(server_default="users")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AccessGroupMember(Base):
    __tablename__ = "access_group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("access_groups.id", ondelete="CASCADE"), primary_key=True)
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True)
    added_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    added_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ResourceGroupGate(Base):
    __tablename__ = "resource_group_gates"

    resource: Mapped[str] = mapped_column(primary_key=True)
    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("access_groups.id", ondelete="CASCADE"), primary_key=True)


class PermissionOverride(Base):
    __tablename__ = "permission_overrides"

    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("people.id"), primary_key=True)
    resource: Mapped[str] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(primary_key=True)
    allow: Mapped[bool] = mapped_column(Boolean)
    set_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    set_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    actor_person_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    entity_type: Mapped[str]
    entity_id: Mapped[str | None]
    action: Mapped[str]
    changes: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    ip: Mapped[str | None] = mapped_column(INET)
    at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

- [ ] **Step 5: Update conftest cleanup**

In `api/tests/conftest.py`, replace the TRUNCATE statement (lines 52-54) with:

```python
        await session.execute(text(
            "TRUNCATE auth_sessions, person_roles, user_accounts, clients, "
            "partners, people, access_groups, access_group_members, "
            "resource_group_gates, permission_overrides, audit_log CASCADE"))
        # role matrix is editable seed data — restore defaults & drop customs
        await session.execute(text("DELETE FROM roles WHERE is_system = false"))
        await session.execute(text("DELETE FROM role_permissions"))
        from serversherpa.access.defaults import seed_default_grants
        await seed_default_grants(session)
```

(`seed_default_grants` arrives in Task 2 — write Task 1 and Task 2 tests before running the suite, or temporarily inline the inserts; the Task 2 commit closes the loop.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd api && .venv/bin/pytest tests/test_access_model.py -x -q`
Expected: PASS (3 tests). NOTE: full-suite runs stay red until Task 2 provides `seed_default_grants`.

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0009_access_control.py api/src/serversherpa/db/models.py api/tests/conftest.py api/tests/test_access_model.py
git commit -m "feat(access): migration 0009 — ranks, matrix, groups, overrides, audit_log"
```

---

### Task 2: Resource registry + live default grants

**Files:**
- Create: `api/src/serversherpa/access/__init__.py` (empty)
- Create: `api/src/serversherpa/access/resources.py`
- Create: `api/src/serversherpa/access/defaults.py`
- Test: `api/tests/test_access_registry.py`

**Interfaces:**
- Produces: `REGISTRY: dict[str, Resource]`, `Resource` dataclass with `.id .label .routes .visible_to .developer_only .always_viewable`, `ACTIONS = ("view","add","change","delete")`, `ROUTE_RESOURCE: dict[str,str]`.
- Produces: `DEFAULT_GRANTS` (same shape as migration copy), `async seed_default_grants(session)`, `GATE_BYPASS_RANK = 60`, `TOP_RANK = 100`.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_access_registry.py
from serversherpa.access.resources import ACTIONS, REGISTRY, ROUTE_RESOURCE


def test_registry_shape():
    assert set(REGISTRY) == {"dashboard", "users", "workers", "clients", "partners",
                             "attachments", "settings", "access", "audit", "devtools"}
    assert ACTIONS == ("view", "add", "change", "delete")
    assert REGISTRY["devtools"].developer_only is True
    assert REGISTRY["access"].always_viewable is True
    assert REGISTRY["access"].visible_to == frozenset({"global"})
    assert REGISTRY["workers"].visible_to == frozenset({"global", "partner", "self"})
    assert REGISTRY["clients"].visible_to == frozenset({"global", "client"})


def test_route_map():
    assert ROUTE_RESOURCE["/people/workers"] == "workers"
    assert ROUTE_RESOURCE["/access"] == "access"
    assert ROUTE_RESOURCE["/"] == "dashboard"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_access_registry.py -x -q`
Expected: FAIL — `ModuleNotFoundError: serversherpa.access`.

- [ ] **Step 3: Write the registry**

```python
# api/src/serversherpa/access/resources.py
"""Resource registry — the code-side list of app surfaces access control
knows about. Deploys introduce resources; the DB stores only grants."""

from dataclasses import dataclass, field

ACTIONS: tuple[str, ...] = ("view", "add", "change", "delete")


@dataclass(frozen=True)
class Resource:
    id: str
    label: str
    routes: tuple[str, ...] = ()
    # which scope anchors can see this resource at all (hard gate)
    visible_to: frozenset[str] = field(
        default_factory=lambda: frozenset({"global"}))
    developer_only: bool = False
    always_viewable: bool = False


_RESOURCES = [
    Resource("dashboard", "Dashboard", routes=("/",),
             visible_to=frozenset({"global", "client", "partner", "self"})),
    Resource("users", "Users", routes=("/people/users",)),
    Resource("workers", "Workers", routes=("/people/workers",),
             visible_to=frozenset({"global", "partner", "self"})),
    Resource("clients", "Clients", routes=("/stakeholders/clients",),
             visible_to=frozenset({"global", "client"})),
    Resource("partners", "Partners", routes=("/stakeholders/partners",),
             visible_to=frozenset({"global", "partner"})),
    Resource("attachments", "Files & attachments",
             visible_to=frozenset({"global", "client", "partner"})),
    Resource("settings", "Settings", routes=("/settings",)),
    Resource("access", "Access control", routes=("/access",),
             always_viewable=True),
    Resource("audit", "Audit log", routes=("/audit",)),
    Resource("devtools", "Developer tools", developer_only=True),
]

REGISTRY: dict[str, Resource] = {r.id: r for r in _RESOURCES}
ROUTE_RESOURCE: dict[str, str] = {
    route: r.id for r in _RESOURCES for route in r.routes}
```

```python
# api/src/serversherpa/access/defaults.py
"""Live copy of the seeded permission matrix (migration 0009 holds the
frozen snapshot). Used by tests to restore the matrix between runs."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

GATE_BYPASS_RANK = 60
TOP_RANK = 100

FULL = ("view", "add", "change", "delete")
_ALL = ["dashboard", "users", "workers", "clients", "partners",
        "attachments", "settings", "access", "audit", "devtools"]

DEFAULT_GRANTS: dict[str, dict[str, tuple[str, ...]]] = {
    "developer":   {r: FULL for r in _ALL},
    "founder":     {r: FULL for r in _ALL if r != "devtools"},
    "super_admin": {r: FULL for r in _ALL if r != "devtools"},
    "admin": {"dashboard": ("view",), "users": FULL, "workers": FULL,
              "clients": FULL, "partners": FULL, "attachments": FULL,
              "settings": ("view", "change"), "access": ("view", "change"),
              "audit": ("view",)},
    "staff": {"dashboard": ("view",), "users": ("view", "add", "change"),
              "workers": FULL, "clients": FULL, "partners": FULL,
              "attachments": FULL, "settings": ("view",), "access": ("view",)},
    "client_owner":  {"dashboard": ("view",), "clients": ("view", "change"),
                      "attachments": ("view",)},
    "client_admin":  {"dashboard": ("view",), "clients": ("view", "change"),
                      "attachments": ("view",)},
    "client_viewer": {"dashboard": ("view",), "clients": ("view",)},
    "vendor_owner":  {"dashboard": ("view",), "partners": ("view", "change"),
                      "workers": ("view",)},
    "vendor_admin":  {"dashboard": ("view",), "partners": ("view", "change"),
                      "workers": ("view",)},
    "vendor_viewer": {"dashboard": ("view",), "partners": ("view",)},
    "worker":   {"dashboard": ("view",), "workers": ("view",)},
    "external": {},
}


async def seed_default_grants(session: AsyncSession) -> None:
    for role, grants in DEFAULT_GRANTS.items():
        for resource, actions in grants.items():
            for action in actions:
                await session.execute(text(
                    "INSERT INTO role_permissions (role, resource, action) "
                    "VALUES (:r, :res, :a) ON CONFLICT DO NOTHING"),
                    {"r": role, "res": resource, "a": action})
```

Also create empty `api/src/serversherpa/access/__init__.py`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && .venv/bin/pytest tests/test_access_registry.py tests/test_access_model.py -x -q`
Expected: PASS. Then run the FULL suite: `cd api && .venv/bin/pytest tests/ -x -q` — the conftest reseed now resolves; all pre-existing tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/access/ api/tests/test_access_registry.py
git commit -m "feat(access): resource registry + live default grants"
```

---

### Task 3: The resolver (core)

**Files:**
- Create: `api/src/serversherpa/access/resolver.py`
- Test: `api/tests/test_access_resolver.py`

**Interfaces:**
- Consumes: models from Task 1, `REGISTRY`/`ACTIONS` from Task 2.
- Produces:
  ```python
  @dataclass
  class AccessInfo:
      perms: dict[str, dict[str, bool]]      # resource -> action -> bool
      max_rank: int                           # 0 when no grants
      role_names: list[str]                   # sorted active role names
      anchors: set[str]                       # anchors held
      client_ids: set[uuid.UUID]
      partner_ids: set[uuid.UUID]
      is_global: bool
      def can(self, resource: str, action: str) -> bool: ...

  async def resolve_access(db: AsyncSession, person_id: uuid.UUID) -> AccessInfo
  def can_touch_rank(actor_rank: int, target_rank: int) -> bool
  ```

- [ ] **Step 1: Write the failing tests (the core investment — write all of these)**

```python
# api/tests/test_access_resolver.py
"""Unit tests for effective-permission resolution — precedence, hard gates,
group gating, floor, multi-role union, scope sets, rank rules."""
import pytest
from sqlalchemy import text

from serversherpa.access.resolver import can_touch_rank, resolve_access
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, Client, Partner, PermissionOverride,
    Person, PersonRole, ResourceGroupGate,
)


async def make_person(db, role, *, client_id=None, partner_id=None):
    p = Person(first_name="T", last_name=role)
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role=role,
                      client_id=client_id, partner_id=partner_id))
    await db.commit()
    return p


async def test_role_grants_flow_through(db):
    p = await make_person(db, "staff")
    a = await resolve_access(db, p.id)
    assert a.perms["workers"] == {"view": True, "add": True,
                                  "change": True, "delete": True}
    assert a.perms["settings"]["change"] is False
    assert a.max_rank == 40 and a.is_global


async def test_override_beats_role(db):
    p = await make_person(db, "staff")
    db.add(PermissionOverride(person_id=p.id, resource="workers",
                              action="delete", allow=False))
    db.add(PermissionOverride(person_id=p.id, resource="settings",
                              action="change", allow=True))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["workers"]["delete"] is False   # deny beats role grant
    assert a.perms["settings"]["change"] is True   # allow beats role absence


async def test_group_gate_blocks_nonmembers_below_rank_60(db):
    p = await make_person(db, "staff")
    g = AccessGroup(name="Finance")
    db.add(g)
    await db.flush()
    db.add(ResourceGroupGate(resource="clients", group_id=g.id))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["clients"]["view"] is False     # staff (40) gated off
    db.add(AccessGroupMember(group_id=g.id, person_id=p.id))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["clients"]["view"] is True      # member again


async def test_rank_60_bypasses_gate(db):
    p = await make_person(db, "admin")
    g = AccessGroup(name="Finance")
    db.add(g)
    await db.flush()
    db.add(ResourceGroupGate(resource="clients", group_id=g.id))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["clients"]["view"] is True


async def test_override_beats_group_gate(db):
    p = await make_person(db, "staff")
    g = AccessGroup(name="Finance")
    db.add(g)
    await db.flush()
    db.add(ResourceGroupGate(resource="clients", group_id=g.id))
    db.add(PermissionOverride(person_id=p.id, resource="clients",
                              action="view", allow=True))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["clients"]["view"] is True


async def test_developer_only_immune_to_matrix_and_overrides(db):
    p = await make_person(db, "founder")
    db.add(PermissionOverride(person_id=p.id, resource="devtools",
                              action="view", allow=True))
    await db.execute(text(
        "INSERT INTO role_permissions (role, resource, action) "
        "VALUES ('founder','devtools','view') ON CONFLICT DO NOTHING"))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["devtools"]["view"] is False    # hard gate wins
    d = await make_person(db, "developer")
    ad = await resolve_access(db, d.id)
    assert ad.perms["devtools"]["view"] is True


async def test_always_viewable_floor_and_anchor_gate(db):
    staff = await make_person(db, "staff")
    a = await resolve_access(db, staff.id)
    assert a.perms["access"]["view"] is True       # floor for global anchor
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    ext = await make_person(db, "client_viewer", client_id=c.id)
    ae = await resolve_access(db, ext.id)
    assert ae.perms["access"]["view"] is False     # anchor gate beats floor
    assert ae.perms["users"]["view"] is False      # users invisible to client anchor
    assert ae.perms["clients"]["view"] is True
    assert ae.client_ids == {c.id} and not ae.is_global


async def test_multi_role_union(db):
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    p = await make_person(db, "worker")
    db.add(PersonRole(person_id=p.id, role="client_viewer", client_id=c.id))
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.perms["workers"]["view"] is True      # from worker
    assert a.perms["clients"]["view"] is True      # from client_viewer
    assert a.anchors == {"self", "client"}
    assert a.max_rank == 10


async def test_revoked_grants_ignored(db):
    from datetime import UTC, datetime
    p = await make_person(db, "admin")
    await db.execute(text(
        "UPDATE person_roles SET revoked_at = :now WHERE person_id = :pid"),
        {"now": datetime.now(UTC), "pid": p.id})
    await db.commit()
    a = await resolve_access(db, p.id)
    assert a.max_rank == 0
    assert a.perms["users"]["view"] is False


def test_can_touch_rank():
    assert can_touch_rank(100, 100) is True    # top rank manages peers
    assert can_touch_rank(100, 60) is True
    assert can_touch_rank(80, 60) is True
    assert can_touch_rank(60, 60) is False     # strictly below only
    assert can_touch_rank(40, 60) is False
    assert can_touch_rank(60, 100) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && .venv/bin/pytest tests/test_access_resolver.py -x -q`
Expected: FAIL — `ModuleNotFoundError` on `serversherpa.access.resolver`.

- [ ] **Step 3: Write the resolver**

```python
# api/src/serversherpa/access/resolver.py
"""Effective-permission resolution. Precedence per resource x action:
hard gates (developer_only, anchor visibility) -> override -> group gate
-> role union; always_viewable floors view=true AFTER overrides/gates but
NEVER past a hard gate."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK, TOP_RANK
from serversherpa.access.resources import ACTIONS, REGISTRY
from serversherpa.db.models import (
    AccessGroupMember, PermissionOverride, PersonRole, ResourceGroupGate, Role,
    RolePermission,
)


def can_touch_rank(actor_rank: int, target_rank: int) -> bool:
    """Strictly-below management; top rank may also manage peers."""
    return actor_rank >= TOP_RANK or target_rank < actor_rank


@dataclass
class AccessInfo:
    perms: dict[str, dict[str, bool]] = field(default_factory=dict)
    max_rank: int = 0
    role_names: list[str] = field(default_factory=list)
    anchors: set[str] = field(default_factory=set)
    client_ids: set[uuid.UUID] = field(default_factory=set)
    partner_ids: set[uuid.UUID] = field(default_factory=set)
    is_global: bool = False

    def can(self, resource: str, action: str) -> bool:
        return self.perms.get(resource, {}).get(action, False)


async def resolve_access(db: AsyncSession, person_id: uuid.UUID) -> AccessInfo:
    grants = (await db.execute(
        select(PersonRole.role, PersonRole.client_id, PersonRole.partner_id,
               Role.rank, Role.scope_anchor)
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None))
    )).all()

    info = AccessInfo()
    for role, client_id, partner_id, rank, anchor in grants:
        info.role_names.append(role)
        info.max_rank = max(info.max_rank, rank)
        info.anchors.add(anchor)
        if anchor == "client" and client_id:
            info.client_ids.add(client_id)
        elif anchor == "partner" and partner_id:
            info.partner_ids.add(partner_id)
    info.role_names = sorted(set(info.role_names))
    info.is_global = "global" in info.anchors
    role_set = set(info.role_names)

    granted: dict[str, set[str]] = {}
    if role_set:
        for res, action in (await db.execute(
            select(RolePermission.resource, RolePermission.action)
            .where(RolePermission.role.in_(role_set))
        )).all():
            granted.setdefault(res, set()).add(action)

    overrides: dict[str, dict[str, bool]] = {}
    for res, action, allow in (await db.execute(
        select(PermissionOverride.resource, PermissionOverride.action,
               PermissionOverride.allow)
        .where(PermissionOverride.person_id == person_id)
    )).all():
        overrides.setdefault(res, {})[action] = allow

    gated_resources: set[str] = set()
    member_ok: set[str] = set()
    gates = (await db.execute(select(ResourceGroupGate.resource,
                                     ResourceGroupGate.group_id))).all()
    if gates:
        gated_resources = {res for res, _ in gates}
        my_groups = set(await db.scalars(
            select(AccessGroupMember.group_id)
            .where(AccessGroupMember.person_id == person_id)))
        member_ok = {res for res, gid in gates if gid in my_groups}

    for res_id, res in REGISTRY.items():
        cell = {a: False for a in ACTIONS}
        hard_blocked = (
            (res.developer_only and "developer" not in role_set)
            or not (res.visible_to & info.anchors)
        )
        if not hard_blocked:
            gate_blocks = (res_id in gated_resources
                           and res_id not in member_ok
                           and info.max_rank < GATE_BYPASS_RANK)
            for action in ACTIONS:
                ov = overrides.get(res_id, {}).get(action)
                if ov is not None:
                    cell[action] = ov
                elif gate_blocks:
                    cell[action] = False
                else:
                    cell[action] = action in granted.get(res_id, set())
            if res.always_viewable:
                cell["view"] = True
        info.perms[res_id] = cell
    return info
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && .venv/bin/pytest tests/test_access_resolver.py -x -q`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/access/resolver.py api/tests/test_access_resolver.py
git commit -m "feat(access): effective-permission resolver + rank rule"
```

---

### Task 4: Row-scope filters

**Files:**
- Create: `api/src/serversherpa/access/scope.py`
- Test: `api/tests/test_access_scope.py`

**Interfaces:**
- Consumes: `AccessInfo` from Task 3.
- Produces: `def scope_conditions(resource: str, access: AccessInfo, person_id: uuid.UUID) -> ColumnElement | None` — `None` = unrestricted (global); otherwise a SQLAlchemy boolean clause to AND into the query (`sa.false()` if the person has no matching scope).

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_access_scope.py
import pytest

from serversherpa.access.resolver import resolve_access
from serversherpa.access.scope import scope_conditions
from serversherpa.db.models import Client, Partner, Person, PersonRole, WorkerProfile
from sqlalchemy import select


async def test_global_actor_unrestricted(db):
    p = Person(first_name="A", last_name="Admin")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="admin"))
    await db.commit()
    access = await resolve_access(db, p.id)
    assert scope_conditions("workers", access, p.id) is None


async def test_partner_actor_sees_only_their_workers(db):
    pa, pb = Partner(name="VendA"), Partner(name="VendB")
    db.add_all([pa, pb])
    await db.flush()
    contact = Person(first_name="V", last_name="Contact")
    w1 = Person(first_name="W", last_name="One")
    w2 = Person(first_name="W", last_name="Two")
    db.add_all([contact, w1, w2])
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="vendor_admin", partner_id=pa.id))
    db.add(WorkerProfile(person_id=w1.id, partner_id=pa.id))
    db.add(WorkerProfile(person_id=w2.id, partner_id=pb.id))
    await db.commit()
    access = await resolve_access(db, contact.id)
    cond = scope_conditions("workers", access, contact.id)
    assert cond is not None
    rows = list(await db.scalars(select(WorkerProfile.person_id).where(cond)))
    assert rows == [w1.id]


async def test_self_actor_sees_own_worker_row(db):
    w1 = Person(first_name="W", last_name="One")
    w2 = Person(first_name="W", last_name="Two")
    db.add_all([w1, w2])
    await db.flush()
    db.add(PersonRole(person_id=w1.id, role="worker"))
    db.add(WorkerProfile(person_id=w1.id))
    db.add(WorkerProfile(person_id=w2.id))
    await db.commit()
    access = await resolve_access(db, w1.id)
    cond = scope_conditions("workers", access, w1.id)
    rows = list(await db.scalars(select(WorkerProfile.person_id).where(cond)))
    assert rows == [w1.id]


async def test_client_actor_scope_on_clients(db):
    ca, cb = Client(name="Acme"), Client(name="Bcme")
    db.add_all([ca, cb])
    await db.flush()
    contact = Person(first_name="C", last_name="Contact")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()
    access = await resolve_access(db, contact.id)
    cond = scope_conditions("clients", access, contact.id)
    rows = list(await db.scalars(select(Client.id).where(cond)))
    assert rows == [ca.id]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_access_scope.py -x -q`
Expected: FAIL — no module `serversherpa.access.scope`.

- [ ] **Step 3: Implement**

```python
# api/src/serversherpa/access/scope.py
"""Row-scope filters: which ROWS a non-global actor may touch, per resource.
Composes with (does not replace) the action matrix."""

import uuid

import sqlalchemy as sa
from sqlalchemy.sql.elements import ColumnElement

from serversherpa.access.resolver import AccessInfo
from serversherpa.db.models import Client, Partner, Person, WorkerProfile

# resource -> anchor -> column carrying that anchor's id
SCOPE_COLUMNS = {
    "workers": {"partner": WorkerProfile.partner_id,
                "self": WorkerProfile.person_id},
    "clients": {"client": Client.id},
    "partners": {"partner": Partner.id},
    "users": {"self": Person.id},
}


def scope_conditions(
    resource: str, access: AccessInfo, person_id: uuid.UUID,
) -> ColumnElement | None:
    """None = unrestricted. sa.false() = actor has no scope into this
    resource (require_permission should already have blocked; defensive)."""
    if access.is_global:
        return None
    cols = SCOPE_COLUMNS.get(resource, {})
    conds: list[ColumnElement] = []
    if "client" in cols and access.client_ids:
        conds.append(cols["client"].in_(access.client_ids))
    if "partner" in cols and access.partner_ids:
        conds.append(cols["partner"].in_(access.partner_ids))
    if "self" in cols and "self" in access.anchors:
        conds.append(cols["self"] == person_id)
    if not conds:
        return sa.false()
    return sa.or_(*conds)
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd api && .venv/bin/pytest tests/test_access_scope.py -x -q`

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/access/scope.py api/tests/test_access_scope.py
git commit -m "feat(access): row-scope filter helper"
```

---

### Task 5: Audit service

**Files:**
- Create: `api/src/serversherpa/services/audit.py`
- Test: `api/tests/test_audit_service.py`

**Interfaces:**
- Produces:
  ```python
  SENSITIVE_FIELDS = {"password_hash", "temp_password", "password", "token_hash", "totp_secret_enc"}
  def snapshot(obj, fields: list[str]) -> dict            # JSON-safe copy of named attrs
  def diff(before: dict, after: dict) -> dict             # {field: {"from": x, "to": y}} changed only, sensitive redacted
  def audit(db, *, actor_id, entity_type, entity_id, action, changes=None, ip=None) -> None
  ```
  `audit()` only does `db.add(AuditLog(...))` — the caller's own commit/rollback governs it (same-transaction guarantee).

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_audit_service.py
import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Person
from serversherpa.services.audit import audit, diff, snapshot


def test_diff_reports_only_changes_and_redacts():
    before = {"first_name": "Al", "phone": None, "password_hash": "aaa"}
    after = {"first_name": "Alice", "phone": None, "password_hash": "bbb"}
    d = diff(before, after)
    assert d == {"first_name": {"from": "Al", "to": "Alice"},
                 "password_hash": {"from": "[redacted]", "to": "[redacted]"}}


def test_snapshot_json_safe():
    import uuid as _uuid
    from datetime import UTC, datetime

    class Obj:
        name = "x"
        when = datetime(2026, 7, 14, tzinfo=UTC)
        ref = _uuid.UUID(int=1)
    s = snapshot(Obj(), ["name", "when", "ref"])
    assert s["name"] == "x"
    assert isinstance(s["when"], str) and isinstance(s["ref"], str)


async def test_audit_row_in_same_transaction(db):
    p = Person(first_name="A", last_name="B")
    db.add(p)
    await db.flush()
    audit(db, actor_id=p.id, entity_type="person", entity_id=str(p.id),
          action="create", changes={"first_name": {"from": None, "to": "A"}})
    await db.commit()
    row = await db.scalar(select(AuditLog))
    assert row.entity_type == "person" and row.action == "create"
    assert row.changes["first_name"]["to"] == "A"


async def test_audit_rolls_back_with_mutation(db):
    p = Person(first_name="A", last_name="B")
    db.add(p)
    await db.flush()
    audit(db, actor_id=p.id, entity_type="person", entity_id=str(p.id),
          action="update")
    await db.rollback()
    assert await db.scalar(select(AuditLog)) is None
```

- [ ] **Step 2: Run to verify FAIL** — `cd api && .venv/bin/pytest tests/test_audit_service.py -x -q`

- [ ] **Step 3: Implement**

```python
# api/src/serversherpa/services/audit.py
"""App-wide audit trail: who did what, to what, and what changed.
audit() adds a row to the CALLER's transaction — never commits itself, so
an audit row can never outlive a rolled-back mutation (or vice versa)."""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AuditLog

SENSITIVE_FIELDS = {"password_hash", "temp_password", "password",
                    "token_hash", "totp_secret_enc"}
_REDACTED = "[redacted]"


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, bytes):
        return _REDACTED
    return value


def snapshot(obj: Any, fields: list[str]) -> dict:
    return {f: _jsonable(getattr(obj, f)) for f in fields}


def diff(before: dict, after: dict) -> dict:
    out: dict = {}
    for key in after:
        if before.get(key) == after[key]:
            continue
        if key in SENSITIVE_FIELDS:
            out[key] = {"from": _REDACTED, "to": _REDACTED}
        else:
            out[key] = {"from": _jsonable(before.get(key)),
                        "to": _jsonable(after[key])}
    return out


def audit(
    db: AsyncSession, *,
    actor_id: uuid.UUID | None,
    entity_type: str,
    entity_id: str | None,
    action: str,
    changes: dict | None = None,
    ip: str | None = None,
) -> None:
    db.add(AuditLog(actor_person_id=actor_id, entity_type=entity_type,
                    entity_id=entity_id, action=action,
                    changes=changes or {}, ip=ip))
```

- [ ] **Step 4: Run tests, expect PASS** — `cd api && .venv/bin/pytest tests/test_audit_service.py -x -q`

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/services/audit.py api/tests/test_audit_service.py
git commit -m "feat(audit): shared audit service (diff, redaction, same-txn rows)"
```

---

### Task 6: `require_permission` dependency + session payload

**Files:**
- Modify: `api/src/serversherpa/api/deps.py`
- Modify: `api/src/serversherpa/services/auth.py` (AuthResult gains access)
- Modify: `api/src/serversherpa/api/schemas.py` (SessionOut/MeOut gain perms/max_rank/scope; new `ScopeOut`)
- Modify: `api/src/serversherpa/api/routes/auth.py` (payload wiring)
- Test: `api/tests/test_access_deps.py`

**Interfaces:**
- Produces: `AuthContext.access: AccessInfo` (and `.roles` kept, now from `access.role_names`); `require_permission(resource: str, action: str)` FastAPI dependency (403 `{"code":"forbidden"}`); `SessionOut`/`MeOut` fields `perms: dict[str, dict[str, bool]]`, `max_rank: int`, `scope: ScopeOut` where `ScopeOut = {global: bool, client_ids: list[UUID], partner_ids: list[UUID]}`.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_access_deps.py
import pytest


async def login(client, email="alice@test.example.com", pw="CorrectHorse9!"):
    resp = await client.post("/auth/login", json={"email": email, "password": pw})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_login_payload_has_perms(client, seeded_user):
    data = await login(client)
    assert data["perms"]["workers"]["change"] is True     # staff default
    assert data["perms"]["settings"]["change"] is False
    assert data["max_rank"] == 40
    assert data["scope"]["global"] is True


async def test_me_payload_has_perms(client, seeded_user):
    data = await login(client)
    hdrs = {"Authorization": f"Bearer {data['access_token']}"}
    me = (await client.get("/auth/me", headers=hdrs)).json()
    assert me["perms"]["workers"]["view"] is True
    assert me["max_rank"] == 40


async def test_require_permission_blocks(client, db, seeded_user):
    """Staff lacks settings:change; a settings-guarded endpoint arrives in a
    later task, so exercise the guard directly via a throwaway route."""
    from serversherpa.api.deps import require_permission
    from serversherpa.api.app import create_app

    app = create_app()

    @app.get("/_test/needs-settings-change")
    async def probe(actor=require_permission("settings", "change")):
        return {"ok": True}

    from httpx import ASGITransport, AsyncClient
    data = await login(client)
    hdrs = {"Authorization": f"Bearer {data['access_token']}"}
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://testserver") as c:
        resp = await c.get("/_test/needs-settings-change", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"
```

- [ ] **Step 2: Run to verify FAIL** — `cd api && .venv/bin/pytest tests/test_access_deps.py -x -q` (KeyError `perms`).

- [ ] **Step 3: Implement**

In `api/src/serversherpa/api/deps.py`:

```python
# add imports
from serversherpa.access.resolver import AccessInfo, resolve_access

# AuthContext: add field + keep roles
@dataclass
class AuthContext:
    person: Person
    account: UserAccount
    roles: list[str]
    session: AuthSession
    access: AccessInfo

    def has_role(self, *names: str) -> bool:
        return bool(set(names) & set(self.roles))

# in get_current_user, replace the get_active_roles call in the return with:
    access = await resolve_access(db, account.person_id)
    return AuthContext(
        person=account.person,
        account=account,
        roles=access.role_names,
        session=session,
        access=access,
    )

# new guard, below require_roles:
def require_permission(resource: str, action: str):
    """Route guard: require an effective (resource, action) permission."""

    async def guard(user: CurrentUser) -> AuthContext:
        if not user.access.can(resource, action):
            raise HTTPException(status_code=403, detail={"code": "forbidden"})
        return user

    return Depends(guard)
```

(`from serversherpa.services.auth import get_active_roles` import can be dropped.)

In `api/src/serversherpa/services/auth.py` — `AuthResult` gains `access: AccessInfo`; in both `login()` and `refresh()` where the result is built, add `access=await resolve_access(db, account.person_id)` (import `resolve_access` at top; `roles` list = `access.role_names`).

In `api/src/serversherpa/api/schemas.py` add:

```python
class ScopeOut(BaseModel):
    global_: bool = Field(alias="global")
    client_ids: list[uuid.UUID] = []
    partner_ids: list[uuid.UUID] = []
    model_config = ConfigDict(populate_by_name=True)
```

and extend `SessionOut` and `MeOut` with:

```python
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut
```

In `api/src/serversherpa/api/routes/auth.py`, add a helper and use it in `_session_response` and `me`:

```python
def _scope_out(access) -> ScopeOut:
    return ScopeOut(**{"global": access.is_global},
                    client_ids=sorted(access.client_ids),
                    partner_ids=sorted(access.partner_ids))

# _session_response gains:
        perms=result.access.perms,
        max_rank=result.access.max_rank,
        scope=_scope_out(result.access),
# me() gains:
        perms=user.access.perms,
        max_rank=user.access.max_rank,
        scope=_scope_out(user.access),
```

- [ ] **Step 4: Run tests** — `cd api && .venv/bin/pytest tests/test_access_deps.py tests/test_auth_flow.py tests/test_me_api.py -x -q` — all PASS (existing auth tests must not regress).

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/deps.py api/src/serversherpa/services/auth.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/auth.py api/tests/test_access_deps.py
git commit -m "feat(access): require_permission guard + perms in session payload"
```

---

### Task 7: Access router — summary + effective (Explorer)

**Files:**
- Create: `api/src/serversherpa/api/routes/access.py`
- Modify: `api/src/serversherpa/api/app.py` (register router)
- Modify: `api/src/serversherpa/api/schemas.py` (access schemas)
- Test: `api/tests/test_access_api.py`

**Interfaces:**
- Produces `GET /access/summary` → `{stats: {members, roles, groups, gated_resources, overrides}, resources: [{id,label,developer_only,always_viewable,gated_by:[group_id]}], roles: [{name,label,color,description,rank,scope_anchor,is_system,member_count,matrix:{resource:{action:bool}}}], groups: [{id,name,description,icon,member_count,members:[{person_id,display_name,avatar_url}]}]}`.
- Produces `GET /access/effective/{person_id}` → `{person_id, display_name, roles:[str], max_rank, groups:[{id,name}], scope:{global,client_ids,partner_ids}, cells:{resource:{action:{value:bool,source:"role"|"override"|"gate"|"hard_gate"|"floor"}}}}`. The `source` powers the Explorer's violet override rings.
- Guard: `access:view`; rank < 60 may only query their own `person_id` (403 `not_your_record`).

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_access_api.py
import pytest
from sqlalchemy import text

from serversherpa.db.models import PermissionOverride, Person, PersonRole


async def login(client, email="alice@test.example.com", pw="CorrectHorse9!"):
    resp = await client.post("/auth/login", json={"email": email, "password": pw})
    assert resp.status_code == 200, resp.text
    d = resp.json()
    return {"Authorization": f"Bearer {d['access_token']}"}, d


async def test_summary_readable_by_staff(client, seeded_user):
    hdrs, _ = await login(client)
    resp = await client.get("/access/summary", headers=hdrs)
    assert resp.status_code == 200
    body = resp.json()
    role_names = {r["name"] for r in body["roles"]}
    assert {"developer", "founder", "admin", "staff"} <= role_names
    staff = next(r for r in body["roles"] if r["name"] == "staff")
    assert staff["matrix"]["workers"]["delete"] is True
    assert staff["member_count"] == 1


async def test_effective_self_allowed_others_blocked_for_staff(client, db, seeded_user):
    hdrs, data = await login(client)
    me_id = data["person"]["id"]
    resp = await client.get(f"/access/effective/{me_id}", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["cells"]["workers"]["view"]["value"] is True

    other = Person(first_name="O", last_name="Ther")
    db.add(other)
    await db.flush()
    db.add(PersonRole(person_id=other.id, role="staff"))
    await db.commit()
    resp = await client.get(f"/access/effective/{other.id}", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "not_your_record"


async def test_effective_marks_override_source(client, db, seeded_user):
    hdrs, data = await login(client)
    me_id = data["person"]["id"]
    db.add(PermissionOverride(person_id=seeded_user.id, resource="workers",
                              action="delete", allow=False))
    await db.commit()
    body = (await client.get(f"/access/effective/{me_id}", headers=hdrs)).json()
    cell = body["cells"]["workers"]["delete"]
    assert cell == {"value": False, "source": "override"}
    assert body["cells"]["workers"]["view"]["source"] == "role"
```

- [ ] **Step 2: Run to verify FAIL** — 404s (`/access/*` unregistered).

- [ ] **Step 3: Implement router (part 1) and register**

```python
# api/src/serversherpa/api/routes/access.py
"""Access control admin API. Reads need access:view (floored on for every
global-anchor role — anti-lockout); writes need access:change + rank rules."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import can_touch_rank, resolve_access
from serversherpa.access.resources import ACTIONS, REGISTRY
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PermissionOverride, Person, PersonRole,
    ResourceGroupGate, Role, RolePermission,
)
from serversherpa.services.audit import audit
from serversherpa.services.storage import presign_get

router = APIRouter(prefix="/access", tags=["access"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _role_matrices(db: DbSession) -> dict[str, dict[str, dict[str, bool]]]:
    out: dict[str, dict[str, dict[str, bool]]] = {}
    for role, res, action in (await db.execute(
        select(RolePermission.role, RolePermission.resource,
               RolePermission.action))).all():
        out.setdefault(role, {}).setdefault(res, {})[action] = True
    return out


@router.get("/summary")
async def summary(
    db: DbSession,
    _actor: AuthContext = require_permission("access", "view"),
) -> dict:
    roles = (await db.scalars(select(Role).order_by(
        Role.rank.desc(), Role.name))).all()
    matrices = await _role_matrices(db)
    member_counts = dict((await db.execute(
        select(PersonRole.role, func.count(func.distinct(PersonRole.person_id)))
        .where(PersonRole.revoked_at.is_(None)).group_by(PersonRole.role))).all())

    groups = (await db.scalars(select(AccessGroup).order_by(AccessGroup.name))).all()
    members_by_group: dict = {}
    rows = (await db.execute(
        select(AccessGroupMember.group_id, Person)
        .join(Person, Person.id == AccessGroupMember.person_id))).all()
    for gid, person in rows:
        members_by_group.setdefault(gid, []).append({
            "person_id": str(person.id), "display_name": person.display_name,
            "avatar_url": presign_get(person.avatar_key)})
    gates: dict[str, list[str]] = {}
    for res, gid in (await db.execute(
        select(ResourceGroupGate.resource, ResourceGroupGate.group_id))).all():
        gates.setdefault(res, []).append(str(gid))

    n_members = (await db.execute(
        select(func.count(func.distinct(PersonRole.person_id)))
        .where(PersonRole.revoked_at.is_(None)))).scalar_one()
    n_overrides = (await db.execute(
        select(func.count()).select_from(PermissionOverride))).scalar_one()

    def matrix_for(name: str) -> dict:
        m = matrices.get(name, {})
        return {res: {a: m.get(res, {}).get(a, False) for a in ACTIONS}
                for res in REGISTRY}

    return {
        "stats": {"members": n_members, "roles": len(roles),
                  "groups": len(groups), "gated_resources": len(gates),
                  "overrides": n_overrides},
        "resources": [
            {"id": r.id, "label": r.label, "developer_only": r.developer_only,
             "always_viewable": r.always_viewable,
             "gated_by": gates.get(r.id, [])}
            for r in REGISTRY.values()],
        "roles": [
            {"name": r.name, "label": r.label or r.name, "color": r.color,
             "description": r.description, "rank": r.rank,
             "scope_anchor": r.scope_anchor, "is_system": r.is_system,
             "member_count": member_counts.get(r.name, 0),
             "matrix": matrix_for(r.name)}
            for r in roles],
        "groups": [
            {"id": str(g.id), "name": g.name, "description": g.description,
             "icon": g.icon,
             "member_count": len(members_by_group.get(g.id, [])),
             "members": members_by_group.get(g.id, [])}
            for g in groups],
    }


@router.get("/effective/{person_id}")
async def effective(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("access", "view"),
) -> dict:
    if actor.access.max_rank < GATE_BYPASS_RANK and person_id != actor.person.id:
        raise _err(403, "not_your_record")
    person = await db.get(Person, person_id)
    if person is None:
        raise _err(404, "person_not_found")

    access = await resolve_access(db, person_id)
    overrides = {(o.resource, o.action): o.allow for o in await db.scalars(
        select(PermissionOverride).where(
            PermissionOverride.person_id == person_id))}
    group_rows = (await db.execute(
        select(AccessGroup.id, AccessGroup.name)
        .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
        .where(AccessGroupMember.person_id == person_id))).all()
    gated = {res for (res,) in (await db.execute(
        select(ResourceGroupGate.resource).distinct())).all()}
    member_res = set()
    if group_rows:
        gids = {gid for gid, _ in group_rows}
        member_res = {res for res, gid in (await db.execute(
            select(ResourceGroupGate.resource, ResourceGroupGate.group_id))).all()
            if gid in gids}

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
                source = "override"
            elif res.always_viewable and a == "view" and value and not (
                    (res_id, a) in overrides):
                # floor may be what made it true; report role if role granted it
                source = "floor" if gate_blocks or not value else "role"
            elif gate_blocks:
                source = "gate"
            else:
                source = "role"
            cells[res_id][a] = {"value": value, "source": source}

    return {
        "person_id": str(person_id), "display_name": person.display_name,
        "roles": access.role_names, "max_rank": access.max_rank,
        "groups": [{"id": str(gid), "name": name} for gid, name in group_rows],
        "scope": {"global": access.is_global,
                  "client_ids": [str(c) for c in sorted(access.client_ids)],
                  "partner_ids": [str(p) for p in sorted(access.partner_ids)]},
        "cells": cells,
    }
```

In `api/src/serversherpa/api/app.py`: add `access` to the routes import and `app.include_router(access.router)` after `auth.router`.

- [ ] **Step 4: Run tests, expect PASS** — `cd api && .venv/bin/pytest tests/test_access_api.py -x -q`

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/access.py api/src/serversherpa/api/app.py api/tests/test_access_api.py
git commit -m "feat(access): summary + effective (explorer) endpoints"
```

---

### Task 8: Access router — role matrix edit, clone, delete

**Files:**
- Modify: `api/src/serversherpa/api/routes/access.py` (append)
- Modify: `api/src/serversherpa/api/schemas.py` (append `MatrixIn`, `RoleCloneIn`)
- Test: `api/tests/test_access_roles_api.py`

**Interfaces:**
- `PUT /access/roles/{name}/matrix` body `{"matrix": {resource: {action: bool}}}` — full replace of that role's grants. Guard `access:change`; reject: unknown resource/action (422 `unknown_resource`/`unknown_action`), editing a role with `rank >= actor` unless actor rank 100 (403 `rank_too_low`), granting on `developer_only` resources to any role but `developer` (422 `developer_only_resource`), removing `access.view` (422 `access_view_locked`).
- `POST /access/roles` body `{"source": str, "name": str, "label": str, "rank": int}` — clone. Rank must satisfy `can_touch_rank(actor, rank)`; anchor inherited; 409 `role_exists`.
- `DELETE /access/roles/{name}` — custom roles only (422 `system_role`), no active grants (409 `role_in_use`), rank rule.
- All three audit: entity_type `"role"`, actions `"matrix.update"` / `"role.clone"` / `"role.delete"`.

- [ ] **Step 1: Failing tests**

```python
# api/tests/test_access_roles_api.py
import pytest
from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, PersonRole, Role


async def login_admin(client, db, seeded_user):
    """Upgrade alice to admin, then log in."""
    await db.execute(text(
        "UPDATE person_roles SET role='admin' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    d = resp.json()
    return {"Authorization": f"Bearer {d['access_token']}"}


def full_matrix(*, workers_delete=True):
    from serversherpa.access.defaults import DEFAULT_GRANTS
    from serversherpa.access.resources import ACTIONS, REGISTRY
    grants = DEFAULT_GRANTS["staff"]
    m = {res: {a: a in grants.get(res, ()) for a in ACTIONS} for res in REGISTRY}
    m["workers"]["delete"] = workers_delete
    return m


async def test_admin_edits_staff_matrix_and_audits(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.put("/access/roles/staff/matrix", headers=hdrs,
                            json={"matrix": full_matrix(workers_delete=False)})
    assert resp.status_code == 200, resp.text
    n = (await db.execute(text(
        "SELECT count(*) FROM role_permissions "
        "WHERE role='staff' AND resource='workers' AND action='delete'"
    ))).scalar_one()
    assert n == 0
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "matrix.update"))
    assert row is not None and row.entity_id == "staff"


async def test_admin_cannot_edit_own_or_higher_rank_role(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    for role in ("admin", "super_admin"):
        resp = await client.put(f"/access/roles/{role}/matrix", headers=hdrs,
                                json={"matrix": full_matrix()})
        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "rank_too_low"


async def test_devtools_and_access_view_locked(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    m = full_matrix()
    m["devtools"]["view"] = True
    resp = await client.put("/access/roles/staff/matrix", headers=hdrs,
                            json={"matrix": m})
    assert resp.json()["detail"]["code"] == "developer_only_resource"
    m = full_matrix()
    m["access"]["view"] = False
    resp = await client.put("/access/roles/staff/matrix", headers=hdrs,
                            json={"matrix": m})
    assert resp.json()["detail"]["code"] == "access_view_locked"


async def test_clone_and_delete_custom_role(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/access/roles", headers=hdrs, json={
        "source": "staff", "name": "ops_lead", "label": "Ops lead", "rank": 45})
    assert resp.status_code == 201, resp.text
    role = await db.get(Role, "ops_lead")
    assert role.rank == 45 and role.scope_anchor == "global" and not role.is_system
    # clone above own rank rejected
    resp = await client.post("/access/roles", headers=hdrs, json={
        "source": "staff", "name": "boss", "label": "Boss", "rank": 60})
    assert resp.status_code == 403
    # delete blocked while granted
    db.add(PersonRole(person_id=seeded_user.id, role="ops_lead"))
    await db.commit()
    resp = await client.delete("/access/roles/ops_lead", headers=hdrs)
    assert resp.status_code == 409
    await db.execute(text("DELETE FROM person_roles WHERE role='ops_lead'"))
    await db.commit()
    resp = await client.delete("/access/roles/ops_lead", headers=hdrs)
    assert resp.status_code == 204
    resp = await client.delete("/access/roles/staff", headers=hdrs)
    assert resp.json()["detail"]["code"] == "system_role"
```

- [ ] **Step 2: Run to verify FAIL** (405/404s).

- [ ] **Step 3: Implement** — append to `access.py`:

```python
from pydantic import BaseModel


class MatrixIn(BaseModel):
    matrix: dict[str, dict[str, bool]]


class RoleCloneIn(BaseModel):
    source: str
    name: str
    label: str
    rank: int


async def _load_role_for_edit(
    db: DbSession, actor: AuthContext, name: str,
) -> Role:
    role = await db.get(Role, name)
    if role is None:
        raise _err(404, "role_not_found")
    if not can_touch_rank(actor.access.max_rank, role.rank):
        raise _err(403, "rank_too_low")
    return role


@router.put("/roles/{name}/matrix")
async def put_matrix(
    name: str,
    body: MatrixIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    role = await _load_role_for_edit(db, actor, name)
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
    for res, a in before - desired:
        await db.execute(
            RolePermission.__table__.delete().where(
                RolePermission.role == name,
                RolePermission.resource == res,
                RolePermission.action == a))
    for res, a in desired - before:
        db.add(RolePermission(role=name, resource=res, action=a))
    audit(db, actor_id=actor.person.id, entity_type="role", entity_id=name,
          action="matrix.update",
          changes={"granted": sorted(f"{r}:{a}" for r, a in desired - before),
                   "revoked": sorted(f"{r}:{a}" for r, a in before - desired)})
    await db.commit()
    return {"role": name, "grants": len(desired)}


@router.post("/roles", status_code=201)
async def clone_role(
    body: RoleCloneIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    source = await db.get(Role, body.source)
    if source is None:
        raise _err(404, "role_not_found")
    if not can_touch_rank(actor.access.max_rank, body.rank):
        raise _err(403, "rank_too_low")
    if await db.get(Role, body.name) is not None:
        raise _err(409, "role_exists")
    db.add(Role(name=body.name, description=f"Custom role cloned from {body.source}",
                rank=body.rank, scope_anchor=source.scope_anchor,
                is_system=False, label=body.label, color=source.color))
    await db.flush()
    for rp in await db.scalars(
            select(RolePermission).where(RolePermission.role == body.source)):
        db.add(RolePermission(role=body.name, resource=rp.resource,
                              action=rp.action))
    audit(db, actor_id=actor.person.id, entity_type="role", entity_id=body.name,
          action="role.clone", changes={"source": {"from": None, "to": body.source},
                                        "rank": {"from": None, "to": body.rank}})
    await db.commit()
    return {"name": body.name, "rank": body.rank,
            "scope_anchor": source.scope_anchor}


@router.delete("/roles/{name}", status_code=204)
async def delete_role(
    name: str,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> None:
    role = await _load_role_for_edit(db, actor, name)
    if role.is_system:
        raise _err(422, "system_role")
    in_use = await db.scalar(select(PersonRole.id).where(
        PersonRole.role == name, PersonRole.revoked_at.is_(None)).limit(1))
    if in_use:
        raise _err(409, "role_in_use")
    audit(db, actor_id=actor.person.id, entity_type="role", entity_id=name,
          action="role.delete")
    await db.delete(role)
    await db.commit()
```

- [ ] **Step 4: Run tests, expect PASS** — `cd api && .venv/bin/pytest tests/test_access_roles_api.py -x -q`

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/access.py api/tests/test_access_roles_api.py
git commit -m "feat(access): role matrix edit, clone, delete with rank rules"
```

---

### Task 9: Access router — groups, membership, gates

**Files:**
- Modify: `api/src/serversherpa/api/routes/access.py` (append)
- Test: `api/tests/test_access_groups_api.py`

**Interfaces:**
- `POST /access/groups` `{name, description?, icon?}` → 201; 409 `group_exists`.
- `DELETE /access/groups/{group_id}` → 204 (cascades members + gates).
- `PUT /access/groups/{group_id}/members` `{person_ids: [uuid]}` — full replace; every ADDED person must satisfy `can_touch_rank` (403 `rank_too_low`).
- `PUT /access/resources/{resource}/gates` `{group_ids: [uuid]}` — full replace; 422 `unknown_resource`; `access` and `devtools` may not be gated (422 `resource_not_gateable`).
- Audit: entity_type `"access_group"` actions `group.create/group.delete/group.members`; entity_type `"resource"` action `resource.gates`.

- [ ] **Step 1: Failing tests**

```python
# api/tests/test_access_groups_api.py
import pytest
from sqlalchemy import select, text

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, Person, PersonRole, ResourceGroupGate,
)
from tests.test_access_roles_api import login_admin


async def test_group_crud_members_gates(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/access/groups", headers=hdrs,
                             json={"name": "Finance", "icon": "dollar"})
    assert resp.status_code == 201, resp.text
    gid = resp.json()["id"]

    staffer = Person(first_name="S", last_name="Member")
    db.add(staffer)
    await db.flush()
    db.add(PersonRole(person_id=staffer.id, role="staff"))
    await db.commit()

    resp = await client.put(f"/access/groups/{gid}/members", headers=hdrs,
                            json={"person_ids": [str(staffer.id)]})
    assert resp.status_code == 200
    members = list(await db.scalars(select(AccessGroupMember.person_id)))
    assert members == [staffer.id]

    resp = await client.put("/access/resources/clients/gates", headers=hdrs,
                            json={"group_ids": [gid]})
    assert resp.status_code == 200
    gates = list(await db.scalars(select(ResourceGroupGate.resource)))
    assert gates == ["clients"]

    resp = await client.put("/access/resources/access/gates", headers=hdrs,
                            json={"group_ids": [gid]})
    assert resp.json()["detail"]["code"] == "resource_not_gateable"

    resp = await client.delete(f"/access/groups/{gid}", headers=hdrs)
    assert resp.status_code == 204
    assert (await db.execute(select(ResourceGroupGate))).first() is None  # cascaded


async def test_membership_rank_rule(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/access/groups", headers=hdrs, json={"name": "Sec"})
    gid = resp.json()["id"]
    boss = Person(first_name="B", last_name="Oss")
    db.add(boss)
    await db.flush()
    db.add(PersonRole(person_id=boss.id, role="super_admin"))
    await db.commit()
    resp = await client.put(f"/access/groups/{gid}/members", headers=hdrs,
                            json={"person_ids": [str(boss.id)]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — append to `access.py`:

```python
class GroupIn(BaseModel):
    name: str
    description: str = ""
    icon: str = "users"


class MembersIn(BaseModel):
    person_ids: list[uuid.UUID]


class GatesIn(BaseModel):
    group_ids: list[uuid.UUID]


NOT_GATEABLE = {"access", "devtools"}


async def _target_max_rank(db: DbSession, person_id: uuid.UUID) -> int:
    rank = await db.scalar(
        select(func.max(Role.rank))
        .join(PersonRole, PersonRole.role == Role.name)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None)))
    return rank or 0


@router.post("/groups", status_code=201)
async def create_group(
    body: GroupIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    exists = await db.scalar(select(AccessGroup.id).where(
        AccessGroup.name == body.name))
    if exists:
        raise _err(409, "group_exists")
    group = AccessGroup(name=body.name, description=body.description,
                        icon=body.icon, created_by=actor.person.id)
    db.add(group)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="access_group",
          entity_id=str(group.id), action="group.create",
          changes={"name": {"from": None, "to": body.name}})
    await db.commit()
    return {"id": str(group.id), "name": group.name}


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(
    group_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> None:
    group = await db.get(AccessGroup, group_id)
    if group is None:
        raise _err(404, "group_not_found")
    audit(db, actor_id=actor.person.id, entity_type="access_group",
          entity_id=str(group_id), action="group.delete",
          changes={"name": {"from": group.name, "to": None}})
    await db.delete(group)   # members + gates cascade
    await db.commit()


@router.put("/groups/{group_id}/members")
async def set_members(
    group_id: uuid.UUID,
    body: MembersIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    if await db.get(AccessGroup, group_id) is None:
        raise _err(404, "group_not_found")
    current = set(await db.scalars(
        select(AccessGroupMember.person_id)
        .where(AccessGroupMember.group_id == group_id)))
    desired = set(body.person_ids)
    for pid in desired - current:
        if not can_touch_rank(actor.access.max_rank,
                              await _target_max_rank(db, pid)):
            raise _err(403, "rank_too_low")
    for pid in current - desired:
        await db.execute(AccessGroupMember.__table__.delete().where(
            AccessGroupMember.group_id == group_id,
            AccessGroupMember.person_id == pid))
    for pid in desired - current:
        db.add(AccessGroupMember(group_id=group_id, person_id=pid,
                                 added_by=actor.person.id))
    audit(db, actor_id=actor.person.id, entity_type="access_group",
          entity_id=str(group_id), action="group.members",
          changes={"added": sorted(str(p) for p in desired - current),
                   "removed": sorted(str(p) for p in current - desired)})
    await db.commit()
    return {"members": len(desired)}


@router.put("/resources/{resource}/gates")
async def set_gates(
    resource: str,
    body: GatesIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    if resource not in REGISTRY:
        raise _err(422, "unknown_resource")
    if resource in NOT_GATEABLE:
        raise _err(422, "resource_not_gateable")
    current = set(await db.scalars(
        select(ResourceGroupGate.group_id)
        .where(ResourceGroupGate.resource == resource)))
    desired = set(body.group_ids)
    for gid in desired - current:
        if await db.get(AccessGroup, gid) is None:
            raise _err(404, "group_not_found")
    for gid in current - desired:
        await db.execute(ResourceGroupGate.__table__.delete().where(
            ResourceGroupGate.resource == resource,
            ResourceGroupGate.group_id == gid))
    for gid in desired - current:
        db.add(ResourceGroupGate(resource=resource, group_id=gid))
    audit(db, actor_id=actor.person.id, entity_type="resource",
          entity_id=resource, action="resource.gates",
          changes={"added": sorted(str(g) for g in desired - current),
                   "removed": sorted(str(g) for g in current - desired)})
    await db.commit()
    return {"resource": resource, "gates": len(desired)}
```

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/access.py api/tests/test_access_groups_api.py
git commit -m "feat(access): groups, membership, resource gates"
```

---

### Task 10: Access router — per-person overrides

**Files:**
- Modify: `api/src/serversherpa/api/routes/access.py` (append)
- Test: `api/tests/test_access_overrides_api.py`

**Interfaces:**
- `GET /access/overrides/{person_id}` → `{person_id, overrides: {resource: {action: bool}}}`.
- `PUT /access/overrides/{person_id}` body `{"overrides": {resource: {action: true|false|null}}}` — null/missing = inherit (delete the row). Guards: `access:change` + `can_touch_rank` on target + no self-targeting (403 `cannot_target_self`) + unknown resource/action 422 + `developer_only` resources unoverridable (422 `developer_only_resource`).
- Audit: entity_type `"person"`, action `"override.set"`, entity_id = target person id.

- [ ] **Step 1: Failing tests**

```python
# api/tests/test_access_overrides_api.py
import pytest
from sqlalchemy import select

from serversherpa.db.models import PermissionOverride, Person, PersonRole
from tests.test_access_roles_api import login_admin


async def make_staffer(db):
    p = Person(first_name="S", last_name="Taff")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="staff"))
    await db.commit()
    return p


async def test_put_get_and_clear_overrides(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    target = await make_staffer(db)
    resp = await client.put(f"/access/overrides/{target.id}", headers=hdrs,
                            json={"overrides": {"workers": {"delete": False},
                                                "settings": {"change": True}}})
    assert resp.status_code == 200, resp.text
    body = (await client.get(f"/access/overrides/{target.id}",
                             headers=hdrs)).json()
    assert body["overrides"] == {"workers": {"delete": False},
                                 "settings": {"change": True}}
    # null clears back to inherit
    resp = await client.put(f"/access/overrides/{target.id}", headers=hdrs,
                            json={"overrides": {"settings": {"change": True}}})
    assert resp.status_code == 200
    rows = list(await db.scalars(select(PermissionOverride)))
    assert len(rows) == 1 and rows[0].resource == "settings"


async def test_override_guards(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.put(f"/access/overrides/{seeded_user.id}", headers=hdrs,
                            json={"overrides": {"workers": {"view": True}}})
    assert resp.json()["detail"]["code"] == "cannot_target_self"
    target = await make_staffer(db)
    resp = await client.put(f"/access/overrides/{target.id}", headers=hdrs,
                            json={"overrides": {"devtools": {"view": True}}})
    assert resp.json()["detail"]["code"] == "developer_only_resource"
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — append to `access.py`:

```python
class OverridesIn(BaseModel):
    overrides: dict[str, dict[str, bool | None]]


@router.get("/overrides/{person_id}")
async def get_overrides(
    person_id: uuid.UUID,
    db: DbSession,
    _actor: AuthContext = require_permission("access", "view"),
) -> dict:
    out: dict = {}
    for o in await db.scalars(select(PermissionOverride).where(
            PermissionOverride.person_id == person_id)):
        out.setdefault(o.resource, {})[o.action] = o.allow
    return {"person_id": str(person_id), "overrides": out}


@router.put("/overrides/{person_id}")
async def put_overrides(
    person_id: uuid.UUID,
    body: OverridesIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    if person_id == actor.person.id:
        raise _err(403, "cannot_target_self")
    if await db.get(Person, person_id) is None:
        raise _err(404, "person_not_found")
    if not can_touch_rank(actor.access.max_rank,
                          await _target_max_rank(db, person_id)):
        raise _err(403, "rank_too_low")
    for res, actions in body.overrides.items():
        if res not in REGISTRY:
            raise _err(422, "unknown_resource")
        if REGISTRY[res].developer_only:
            raise _err(422, "developer_only_resource")
        for a in actions:
            if a not in ACTIONS:
                raise _err(422, "unknown_action")

    current = {(o.resource, o.action): o for o in await db.scalars(
        select(PermissionOverride).where(
            PermissionOverride.person_id == person_id))}
    desired = {(res, a): v for res, actions in body.overrides.items()
               for a, v in actions.items() if v is not None}
    changes: dict = {}
    for key, row in current.items():
        if key not in desired:
            changes[f"{key[0]}:{key[1]}"] = {"from": row.allow, "to": None}
            await db.delete(row)
        elif row.allow != desired[key]:
            changes[f"{key[0]}:{key[1]}"] = {"from": row.allow, "to": desired[key]}
            row.allow = desired[key]
            row.set_by = actor.person.id
            row.set_at = datetime.now(UTC)
    for key, value in desired.items():
        if key not in current:
            changes[f"{key[0]}:{key[1]}"] = {"from": None, "to": value}
            db.add(PermissionOverride(person_id=person_id, resource=key[0],
                                      action=key[1], allow=value,
                                      set_by=actor.person.id))
    audit(db, actor_id=actor.person.id, entity_type="person",
          entity_id=str(person_id), action="override.set", changes=changes)
    await db.commit()
    return {"person_id": str(person_id), "overrides": len(desired)}
```

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/access.py api/tests/test_access_overrides_api.py
git commit -m "feat(access): per-person tri-state overrides"
```

---

### Task 11: Convert users router (permissions + rank rules + audit)

**Files:**
- Modify: `api/src/serversherpa/api/routes/users.py`
- Modify: `api/src/serversherpa/api/schemas.py` (`UserItem` gains `max_rank: int = 0`)
- Modify: `api/tests/test_users_api.py`, `api/tests/test_account_mgmt.py` (updated expectations)

**Interfaces:**
- Consumes: `require_permission`, `can_touch_rank`, `_target_max_rank`-equivalent, `audit`, `snapshot`, `diff`.
- Produces: users endpoints guarded by `users:view` (list), `users:add` (create), `users:change` (reset-password/disable/enable/unlock/profile), `access:change` (set_roles). `UserItem.max_rank` for the portal's rank-aware menus.

- [ ] **Step 1: Update guards and helpers**

In `api/src/serversherpa/api/routes/users.py`:
- Imports: add `from serversherpa.access.resolver import can_touch_rank`, `from serversherpa.api.deps import require_permission`, `from serversherpa.db.models import Role`, `from sqlalchemy import func`, `from serversherpa.services.audit import audit, diff, snapshot`.
- Guard swaps (every endpoint):
  - `list_users`: `_user: AuthContext = require_permission("users", "view")`
  - `create_user`: `actor: AuthContext = require_permission("users", "add")`
  - `reset_password`, `disable_account`, `enable_account`, `unlock_account`, `admin_update_profile`: `require_permission("users", "change")`
  - `set_roles`: `require_permission("access", "change")`
- Replace `_load_target`'s admin check with the rank rule:

```python
async def _actor_can_touch(db: DbSession, actor: AuthContext,
                           person_id: uuid.UUID) -> None:
    target_rank = (await db.scalar(
        select(func.max(Role.rank))
        .join(PersonRole, PersonRole.role == Role.name)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None)))) or 0
    if not can_touch_rank(actor.access.max_rank, target_rank):
        raise _err(403, "rank_too_low")
```

and in `_load_target`, replace the two lines
`if "admin" in target_roles and not actor.has_role("admin"): raise _err(403, "admin_target_requires_admin")`
with `await _actor_can_touch(db, actor, person_id)`.

- In `create_user` and `set_roles`, replace the `"client" in …` special case with the general anchored-role rule and the rank cap:

```python
    role_rows = {r.name: r for r in await db.scalars(
        select(Role).where(Role.name.in_(desired or {""})))}
    for name in desired:
        role = role_rows.get(name)
        if role is None:
            raise _err(422, "unknown_role")
        if role.scope_anchor in ("client", "partner"):
            raise _err(422, "role_requires_org")   # granted via org contact flows
        if name not in current and not can_touch_rank(
                actor.access.max_rank, role.rank):
            raise _err(403, "rank_too_low")
```

(in `create_user` use `body.roles` as `desired` and `current = set()`.)

- [ ] **Step 2: Add `max_rank` to the list payload**

In `list_users`, extend the roles query to fetch ranks and compute per person:

```python
    role_rows = (await db.execute(
        select(PersonRole.person_id, PersonRole.role, Role.rank)
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.person_id.in_(person_ids or [None]),
               PersonRole.revoked_at.is_(None))
        .order_by(PersonRole.role)
    )).all()
    roles_by_person: dict = {}
    rank_by_person: dict = {}
    for pid, role, rank in role_rows:
        roles_by_person.setdefault(pid, []).append(role)
        rank_by_person[pid] = max(rank_by_person.get(pid, 0), rank)
```

and pass `max_rank=rank_by_person.get(person.id, 0)` into each `UserItem`. Add `max_rank: int = 0` to `UserItem` in `schemas.py`.

- [ ] **Step 3: Audit every mutation**

Exact insertions (each immediately before that endpoint's `await db.commit()`):

```python
# create_user:
    audit(db, actor_id=actor.person.id, entity_type="person",
          entity_id=str(person.id), action="create",
          changes={"first_name": {"from": None, "to": person.first_name},
                   "last_name": {"from": None, "to": person.last_name},
                   "roles": {"from": None, "to": list(dict.fromkeys(body.roles))},
                   "account": {"from": None, "to": bool(body.create_account)}})
# reset_password:
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="password.reset",
          changes={"must_change_password":
                   {"from": None, "to": body.must_change_password}})
# disable_account:
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="account.disable")
# enable_account:
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="account.enable")
# unlock_account:
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="account.unlock")
# set_roles:
    audit(db, actor_id=actor.person.id, entity_type="person",
          entity_id=str(person_id), action="role.set",
          changes={"roles": {"from": sorted(current), "to": sorted(desired)}})
# admin_update_profile — capture before/after around the setattr loop:
    fields = list(data.keys())
    before = snapshot(person, fields)
    ...setattr loop...
    audit(db, actor_id=actor.person.id, entity_type="person",
          entity_id=str(person_id), action="update",
          changes=diff(before, snapshot(person, fields)))
```

- [ ] **Step 4: Update existing tests**

In `api/tests/test_users_api.py` / `test_account_mgmt.py`: wherever a test asserts `admin_target_requires_admin` or `granting_admin_requires_admin`, change the expected code to `rank_too_low`; wherever it asserts `client_role_needs_client`, change to `role_requires_org` (role name in fixture payloads: `client` → `client_viewer`). Staff setting roles now requires `access:change` (staff seed has only `access:view`) — tests that had staff calling `PUT /users/{id}/roles` must switch the actor to an admin (reuse the `login_admin` pattern from `tests/test_access_roles_api.py`).

- [ ] **Step 5: Run** — `cd api && .venv/bin/pytest tests/test_users_api.py tests/test_account_mgmt.py tests/test_access_deps.py -x -q` — all PASS. Then full suite: `cd api && .venv/bin/pytest tests/ -x -q`.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/routes/users.py api/src/serversherpa/api/schemas.py api/tests/test_users_api.py api/tests/test_account_mgmt.py
git commit -m "feat(access): users router on require_permission + rank rules + audit"
```

---

### Task 12: Convert stakeholders router (permissions + scope + audit)

**Files:**
- Modify: `api/src/serversherpa/api/routes/stakeholders.py`
- Test: append to `api/tests/test_stakeholders.py`

**Interfaces:**
- Consumes: `require_permission`, `scope_conditions`, `audit`, `snapshot`, `diff`.
- The clients router uses resource `"clients"`, partners router `"partners"` (the shared factory takes the resource id as a parameter alongside the existing model/prefix parameters).

- [ ] **Step 1: Write the failing scope test**

```python
# append to api/tests/test_stakeholders.py
async def test_client_contact_sees_only_their_org(client, db, seeded_user):
    from serversherpa.config import get_settings
    from serversherpa.db.models import Client, Person, PersonRole, UserAccount
    from serversherpa.security.passwords import hash_password
    from datetime import UTC, datetime

    ca, cb = Client(name="Acme"), Client(name="Bcme")
    db.add_all([ca, cb])
    await db.flush()
    contact = Person(first_name="C", last_name="Contact",
                     email="contact@acme.example.com")
    db.add(contact)
    await db.flush()
    db.add(UserAccount(person_id=contact.id, email="contact@acme.example.com",
                       password_hash=hash_password(
                           "CorrectHorse9!",
                           pepper=get_settings().password_pepper.get_secret_value()),
                       password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "contact@acme.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    listing = (await client.get("/clients", headers=hdrs)).json()
    names = {c["name"] for c in listing}
    assert names == {"Acme"}                       # scoped list
    resp = await client.get(f"/clients/{cb.id}", headers=hdrs)
    assert resp.status_code == 404                 # out-of-scope detail = 404
    resp = await client.get("/partners", headers=hdrs)
    assert resp.status_code == 403                 # no partners:view
```

- [ ] **Step 2: Run to verify FAIL** (403 on `/clients` list — client_viewer holds no `client` role now, or all rows visible).

- [ ] **Step 3: Convert the router**

In `api/src/serversherpa/api/routes/stakeholders.py` (a factory builds clients/partners routers):
- Factory signature gains `resource: str` (`"clients"` / `"partners"`); pass it at both build sites.
- Guard swaps inside the factory (line refs from the current file):
  - list/detail endpoints (103, 272, 335 and the GET handlers): `require_permission(resource, "view")` (bind `actor` where scoping needs it)
  - create (130) → `require_permission(resource, "add")`
  - patch (145) → `require_permission(resource, "change")`
  - archive/unarchive (160/170) → `require_permission(resource, "change")`
  - contacts add/remove (213/237) → `require_permission(resource, "change")`
- Scoping — in each list/detail handler add:

```python
    from serversherpa.access.scope import scope_conditions
    cond = scope_conditions(resource, actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)          # list
    # detail: after loading the org row —
    if cond is not None:
        visible = await db.scalar(select(model.id).where(model.id == org_id, cond))
        if visible is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
```

- Audit — before each mutation's commit (entity_type is `"client"` or `"partner"` from the factory's model):

```python
# create:
    audit(db, actor_id=actor.person.id, entity_type=entity_type,
          entity_id=str(org.id), action="create",
          changes={"name": {"from": None, "to": org.name}})
# patch — around the field-apply loop:
    fields = list(data.keys())
    before = snapshot(org, fields)
    ...apply...
    audit(db, actor_id=actor.person.id, entity_type=entity_type,
          entity_id=str(org.id), action="update",
          changes=diff(before, snapshot(org, fields)))
# archive / unarchive:
    audit(db, actor_id=actor.person.id, entity_type=entity_type,
          entity_id=str(org_id), action="archive")      # or "restore"
# contact add / remove:
    audit(db, actor_id=actor.person.id, entity_type=entity_type,
          entity_id=str(org_id), action="contact.add",   # or "contact.remove"
          changes={"person_id": {"from": None, "to": str(person_id)}})
```

- Contact-grant roles: where the contact flow granted `client`/`vendor`, grant `client_viewer`/`vendor_viewer` (same `client_id`/`partner_id` scoping).

- [ ] **Step 4: Run** — `cd api && .venv/bin/pytest tests/test_stakeholders.py -x -q` — all PASS (old tests updated where they referenced `client`/`vendor` role names).

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/stakeholders.py api/tests/test_stakeholders.py
git commit -m "feat(access): stakeholders on require_permission + org scoping + audit"
```

---

### Task 13: Convert workers router (permissions + scope + audit)

**Files:**
- Modify: `api/src/serversherpa/api/routes/workers.py`
- Test: append to `api/tests/test_workers.py`

**Interfaces:** resource `"workers"`; vendor contacts see only their supplied workers; workers see only themselves.

- [ ] **Step 1: Failing scope test**

```python
# append to api/tests/test_workers.py
async def test_vendor_contact_sees_only_supplied_workers(client, db, seeded_user):
    from serversherpa.config import get_settings
    from serversherpa.db.models import (Partner, Person, PersonRole,
                                        UserAccount, WorkerProfile)
    from serversherpa.security.passwords import hash_password
    from datetime import UTC, datetime

    pa, pb = Partner(name="VendA"), Partner(name="VendB")
    db.add_all([pa, pb])
    await db.flush()
    w1 = Person(first_name="Wa", last_name="One")
    w2 = Person(first_name="Wb", last_name="Two")
    contact = Person(first_name="V", last_name="Contact",
                     email="v@venda.example.com")
    db.add_all([w1, w2, contact])
    await db.flush()
    db.add_all([WorkerProfile(person_id=w1.id, partner_id=pa.id),
                WorkerProfile(person_id=w2.id, partner_id=pb.id)])
    db.add(UserAccount(person_id=contact.id, email="v@venda.example.com",
                       password_hash=hash_password(
                           "CorrectHorse9!",
                           pepper=get_settings().password_pepper.get_secret_value()),
                       password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=contact.id, role="vendor_admin", partner_id=pa.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "v@venda.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    listing = (await client.get("/workers", headers=hdrs)).json()
    ids = {w["person_id"] for w in listing}
    assert ids == {str(w1.id)}
    resp = await client.put(f"/workers/{w1.id}/profile", headers=hdrs,
                            json={"trade": "racking", "level": "L2",
                                  "status": "active", "partner_id": str(pa.id)})
    assert resp.status_code == 403      # vendor has workers:view only
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Convert**

In `api/src/serversherpa/api/routes/workers.py`:
- Guard swaps: list/detail GETs → `require_permission("workers", "view")`; `PUT /{person_id}/profile` (114) → `require_permission("workers", "change")`; cert add (199) → `require_permission("workers", "add")`; cert delete (215) → `require_permission("workers", "delete")`; the self-service endpoint at 235 keeps `require_roles("admin", "staff", "worker")` (identity case — a worker reading their own profile); admin-only levels editing (247, levels_router) → `require_permission("settings", "change")`.
- Scoping in list/detail: same pattern as Task 12 with `scope_conditions("workers", actor.access, actor.person.id)` — the workers list query joins `WorkerProfile` already; AND the condition in. Detail (and every mutation) re-checks: load the target's `WorkerProfile`, and if `cond is not None` verify the row matches (else 404).
- Audit before each commit:

```python
# profile put — around the apply:
    fields = ["partner_id", "trade", "level", "status", "status_note"]
    before = snapshot(profile, fields)
    ...apply...
    audit(db, actor_id=actor.person.id, entity_type="worker",
          entity_id=str(person_id), action="profile.update",
          changes=diff(before, snapshot(profile, fields)))
# cert add:
    audit(db, actor_id=actor.person.id, entity_type="worker",
          entity_id=str(person_id), action="certification.add",
          changes={"name": {"from": None, "to": body.name}})
# cert delete:
    audit(db, actor_id=actor.person.id, entity_type="worker",
          entity_id=str(person_id), action="certification.remove",
          changes={"name": {"from": cert.name, "to": None}})
# levels edit (levels_router):
    audit(db, actor_id=actor.person.id, entity_type="worker_level",
          entity_id=level, action="update",
          changes=diff(before, snapshot(row, ["title", "description",
                                              "expected_skills"])))
```

- [ ] **Step 4: Run** — `cd api && .venv/bin/pytest tests/test_workers.py -x -q` — PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/workers.py api/tests/test_workers.py
git commit -m "feat(access): workers on require_permission + partner/self scoping + audit"
```

---

### Task 14: Audit retrofit — attachments, self-service, auth events

**Files:**
- Modify: `api/src/serversherpa/api/routes/attachments.py`
- Modify: `api/src/serversherpa/api/routes/me.py`
- Modify: `api/src/serversherpa/services/auth.py`
- Test: `api/tests/test_audit_trail.py`

**Interfaces:** audit actions `attachment.add` / `attachment.remove` / `update` (profile) / `password.change` / `session.revoke` / `login` / `login_failed` / `logout` / `token_replay_detected`.

- [ ] **Step 1: Failing tests**

```python
# api/tests/test_audit_trail.py
import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog


async def test_login_success_and_failure_audited(client, db, seeded_user):
    await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "wrong-password"})
    await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    rows = list(await db.scalars(select(AuditLog).order_by(AuditLog.at)))
    actions = [r.action for r in rows]
    assert "login_failed" in actions and "login" in actions
    failed = next(r for r in rows if r.action == "login_failed")
    assert failed.actor_person_id is None
    assert failed.entity_id == "alice@test.example.com"
    ok = next(r for r in rows if r.action == "login")
    assert ok.actor_person_id == seeded_user.id


async def test_password_change_audited_and_redacted(client, db, seeded_user):
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    resp = await client.post("/me/password", headers=hdrs, json={
        "current_password": "CorrectHorse9!",
        "new_password": "EvenBetterHorse10!"})
    assert resp.status_code == 204
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "password.change"))
    assert row is not None
    assert "password" not in str(row.changes) or "[redacted]" in str(row.changes)


async def test_profile_update_audited_with_diff(client, db, seeded_user):
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    await client.patch("/me/profile", headers=hdrs, json={"phone": "555-0100"})
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "update",
                                                 AuditLog.entity_type == "person"))
    assert row.changes["phone"]["to"] == "555-0100"
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

`services/auth.py` (import `audit` from `serversherpa.services.audit`):
- In `login()` — on success, before the commit that persists the session: `audit(db, actor_id=account.person_id, entity_type="auth", entity_id=str(account.person_id), action="login", ip=ip)`. In each failure path that knows the account (`bad_credentials` after account load, `account_locked`): `audit(db, actor_id=None, entity_type="auth", entity_id=email, action="login_failed", ip=ip)` followed by the existing commit of `failed_login_count` (unknown-email path: add the audit row + `await db.commit()` before raising).
- In `refresh()` — in the replay-detection branch (family revoked): `audit(db, actor_id=session.person_id, entity_type="auth", entity_id=str(session.person_id), action="token_replay_detected", ip=ip)` before its commit.
- In `logout()` — `audit(db, actor_id=session.person_id, entity_type="auth", entity_id=str(session.person_id), action="logout")` before the commit.

`routes/me.py`:
- `PATCH /profile` — same before/after pattern as Task 11's `admin_update_profile` (entity_type `"person"`, action `"update"`, actor = self).
- `POST /password` — `audit(db, actor_id=user.person.id, entity_type="user_account", entity_id=str(user.person.id), action="password.change")`.
- `DELETE /sessions/{family_id}` — `audit(db, actor_id=user.person.id, entity_type="auth", entity_id=str(user.person.id), action="session.revoke", changes={"family_id": {"from": str(family_id), "to": None}})`.

`routes/attachments.py`:
- POST — `audit(db, actor_id=actor.person.id, entity_type=body.entity_type, entity_id=str(body.entity_id), action="attachment.add", changes={"filename": {"from": None, "to": att.filename}})`.
- DELETE — `audit(db, actor_id=actor.person.id, entity_type=att.entity_type, entity_id=str(att.entity_id), action="attachment.remove", changes={"filename": {"from": att.filename, "to": None}})`.

- [ ] **Step 4: Run the FULL suite** — `cd api && .venv/bin/pytest tests/ -x -q` — everything PASSES.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/services/auth.py api/src/serversherpa/api/routes/me.py api/src/serversherpa/api/routes/attachments.py api/tests/test_audit_trail.py
git commit -m "feat(audit): auth events + self-service + attachments retrofit"
```

---

### Task 15: Scope global search (spec-gap closure)

`/search` currently has no permission or scope awareness — an external login could enumerate all people and orgs. (The spec missed this; it falls under §6 "scoped queries".)

**Files:**
- Modify: `api/src/serversherpa/api/routes/search.py`
- Test: append to `api/tests/test_search_api.py`

**Interfaces:** each search category maps to a resource — people/users results require `users:view`, workers → `workers`, clients → `clients`, partners → `partners`. A category the actor can't `view` is omitted entirely; visible categories get `scope_conditions(resource, actor.access, actor.person.id)` ANDed into their queries.

- [ ] **Step 1: Write the failing test**

```python
# append to api/tests/test_search_api.py
async def test_search_respects_permissions_and_scope(client, db, seeded_user):
    """A client_viewer searching sees only their own org — no people, no
    partners, no other clients."""
    from serversherpa.config import get_settings
    from serversherpa.db.models import Client, Person, PersonRole, UserAccount
    from serversherpa.security.passwords import hash_password
    from datetime import UTC, datetime

    ca, cb = Client(name="Acme Search"), Client(name="Bcme Search")
    db.add_all([ca, cb])
    await db.flush()
    contact = Person(first_name="C", last_name="Contact",
                     email="csearch@acme.example.com")
    db.add(contact)
    await db.flush()
    db.add(UserAccount(person_id=contact.id, email="csearch@acme.example.com",
                       password_hash=hash_password(
                           "CorrectHorse9!",
                           pepper=get_settings().password_pepper.get_secret_value()),
                       password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "csearch@acme.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    results = (await client.get("/search?q=Search", headers=hdrs)).json()
    flat = str(results)
    assert "Acme Search" in flat
    assert "Bcme Search" not in flat        # other client scoped out
    assert "alice" not in flat.lower()      # no users:view -> no people results
```

- [ ] **Step 2: Run to verify FAIL** — `cd api && .venv/bin/pytest tests/test_search_api.py -x -q`

- [ ] **Step 3: Implement**

In `global_search`, wrap each category block:

```python
    from serversherpa.access.scope import scope_conditions

    if user.access.can("users", "view"):
        cond = scope_conditions("users", user.access, user.person.id)
        query = select(Person, UserAccount)...   # existing query
        if cond is not None:
            query = query.where(cond)
        ...
    # same pattern for the workers / clients / partners category blocks,
    # each with its own resource id
```

- [ ] **Step 4: Run** — `cd api && .venv/bin/pytest tests/test_search_api.py -x -q` — PASS (existing staff search tests unchanged: staff holds view on all four).

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/search.py api/tests/test_search_api.py
git commit -m "feat(access): permission + scope aware global search"
```

---

## Completion

After Task 15 the API side is done: full suite green, every endpoint permission-guarded, external actors row-scoped (including search), every mutation audited. Continue with `docs/superpowers/plans/2026-07-14-access-control-portal.md` on the same branch.
