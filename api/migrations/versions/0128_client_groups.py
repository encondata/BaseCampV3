"""Client groups: per-client groups built from the From-To Owner column.

New tables `client_groups`, `client_group_aliases`, `client_group_dismissals`
and `client_contact_groups`; `initiative_assets.owner_group_id`; the
`asset_owner_current` view (each asset's newest roster row per client); and
the `client_individual` role (rank 8, client-anchored, the viewer's grants),
which the client-scope check on `person_roles` now allows.

Design: docs/superpowers/specs/2026-11-10-client-groups-design.md

Revision ID: 0128
Revises: 0127
Create Date: 2026-11-10
"""
import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0128"
down_revision: str | None = "0127"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

ZERO = "gen_random_uuid()"
OLD_TIERS = "('client_owner','client_admin','client_viewer')"
NEW_TIERS = "('client_owner','client_admin','client_viewer','client_individual')"

VIEW_SQL = """
CREATE VIEW asset_owner_current AS
SELECT DISTINCT ON (ia.asset_id, i.client_id)
       ia.asset_id, i.client_id, ia.owner, ia.owner_group_id
FROM initiative_assets ia
JOIN initiatives i ON i.id = ia.initiative_id
WHERE i.client_id IS NOT NULL
ORDER BY ia.asset_id, i.client_id, ia.created_at DESC, ia.id DESC
"""


def _client_scope_check(tiers: str) -> None:
    op.create_check_constraint(
        "person_roles_client_scope_check", "person_roles",
        f"(role IN {tiers}) = (client_id IS NOT NULL)")


def upgrade() -> None:
    conn = op.get_bind()

    op.create_table(
        "client_groups",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text(ZERO)),
        sa.Column("client_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("name_key", sa.Text, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("created_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.UniqueConstraint("client_id", "name_key", name="client_groups_client_name_key"),
    )
    op.create_table(
        "client_group_aliases",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text(ZERO)),
        sa.Column("group_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("client_groups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("client_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("alias", sa.Text, nullable=False),
        sa.Column("alias_key", sa.Text, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("client_id", "alias_key", name="client_group_aliases_client_alias_key"),
    )
    op.create_index("ix_client_group_aliases_group_id", "client_group_aliases", ["group_id"])
    op.create_table(
        "client_group_dismissals",
        sa.Column("client_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("value_key", sa.Text, nullable=False),
        sa.Column("dismissed_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("dismissed_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.PrimaryKeyConstraint("client_id", "value_key"),
    )
    op.create_table(
        "client_contact_groups",
        sa.Column("person_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), nullable=False),
        sa.Column("client_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        # NO ACTION, not CASCADE: a group someone still holds as a chip can't
        # be deleted (a Viewer whose last chip vanished would silently become
        # unrestricted). Deleting the client still takes every chip through
        # client_id's CASCADE in the same statement.
        sa.Column("group_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("client_groups.id"), nullable=False),
        sa.PrimaryKeyConstraint("person_id", "client_id", "group_id"),
    )

    op.add_column("initiative_assets", sa.Column(
        "owner_group_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("client_groups.id", ondelete="SET NULL"), nullable=True))
    op.create_index("ix_initiative_assets_owner_group_id", "initiative_assets", ["owner_group_id"])
    conn.execute(sa.text(VIEW_SQL))

    # the client_individual role: the viewer's grants, a rank just under it
    conn.execute(sa.text("""
        INSERT INTO roles (name, description, rank, scope_anchor, is_system, label, color)
        VALUES ('client_individual',
                'A client contact limited to the groups they are given',
                8, 'client', true, 'Client individual', 'c-blue')
        ON CONFLICT (name) DO UPDATE SET rank = 8, scope_anchor = 'client',
            is_system = true, label = 'Client individual', color = 'c-blue'
    """))
    op.drop_constraint("person_roles_client_scope_check", "person_roles")
    _client_scope_check(NEW_TIERS)
    conn.execute(sa.text(
        "INSERT INTO role_permissions (role, resource, action) "
        "SELECT 'client_individual', resource, action FROM role_permissions "
        "WHERE role = 'client_viewer' ON CONFLICT DO NOTHING"))

    both = conn.execute(sa.text("""
        SELECT count(DISTINCT c.person_id) FROM person_roles c
        JOIN person_roles w ON w.person_id = c.person_id
        WHERE c.role LIKE 'client\\_%' AND c.revoked_at IS NULL
          AND w.role = 'worker' AND w.revoked_at IS NULL
    """)).scalar_one()
    log.info("client groups: %s people hold a client tier and worker together", both)


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM person_roles WHERE role = 'client_individual'"))
    conn.execute(sa.text("DELETE FROM role_permissions WHERE role = 'client_individual'"))
    op.drop_constraint("person_roles_client_scope_check", "person_roles")
    _client_scope_check(OLD_TIERS)
    conn.execute(sa.text("DELETE FROM roles WHERE name = 'client_individual'"))

    conn.execute(sa.text("DROP VIEW IF EXISTS asset_owner_current"))
    op.drop_index("ix_initiative_assets_owner_group_id", table_name="initiative_assets")
    op.drop_column("initiative_assets", "owner_group_id")
    op.drop_table("client_contact_groups")
    op.drop_table("client_group_dismissals")
    op.drop_index("ix_client_group_aliases_group_id", table_name="client_group_aliases")
    op.drop_table("client_group_aliases")
    op.drop_table("client_groups")
