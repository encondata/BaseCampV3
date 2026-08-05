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

    # the old scope-check constraints hardcode the flat 'client'/'vendor'
    # names being retired below — drop them before the remap so the UPDATE
    # doesn't trip over its own constraint, then reinstate with the new
    # multi-tier role lists.
    op.drop_constraint("person_roles_client_scope_check", "person_roles")
    op.drop_constraint("person_roles_partner_scope_check", "person_roles")

    # remap retired flat roles (ALL rows incl. revoked history — FK-safe)
    conn.execute(sa.text("UPDATE person_roles SET role='client_viewer' WHERE role='client'"))
    conn.execute(sa.text("UPDATE person_roles SET role='vendor_viewer' WHERE role='vendor'"))
    conn.execute(sa.text("DELETE FROM roles WHERE name IN ('client','vendor')"))

    op.create_check_constraint(
        "person_roles_client_scope_check", "person_roles",
        "(role IN ('client_owner','client_admin','client_viewer')) "
        "= (client_id IS NOT NULL)")
    op.create_check_constraint(
        "person_roles_partner_scope_check", "person_roles",
        "(revoked_at IS NOT NULL) OR "
        "((role IN ('vendor_owner','vendor_admin','vendor_viewer')) "
        "= (partner_id IS NOT NULL))")

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

    op.drop_constraint("person_roles_client_scope_check", "person_roles")
    op.drop_constraint("person_roles_partner_scope_check", "person_roles")

    conn.execute(sa.text("""
        INSERT INTO roles (name, description) VALUES
        ('client', 'Client contact'), ('vendor', 'Vendor contact')
        ON CONFLICT (name) DO NOTHING"""))
    conn.execute(sa.text("UPDATE person_roles SET role='client' WHERE role='client_viewer'"))
    conn.execute(sa.text("UPDATE person_roles SET role='vendor' WHERE role='vendor_viewer'"))
    conn.execute(sa.text(
        "DELETE FROM roles WHERE name NOT IN "
        "('admin','staff','worker','client','vendor','external')"))

    op.create_check_constraint(
        "person_roles_client_scope_check", "person_roles",
        "(role = 'client') = (client_id IS NOT NULL)")
    op.create_check_constraint(
        "person_roles_partner_scope_check", "person_roles",
        "(revoked_at IS NOT NULL) OR ((role = 'vendor') = (partner_id IS NOT NULL))")

    op.drop_constraint("roles_scope_anchor_check", "roles")
    for col in ("rank", "scope_anchor", "is_system", "label", "color"):
        op.drop_column("roles", col)
