"""workers — profiles (trade/level/status/partner rollup), editable
level definitions, and certifications.

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # editable leveling scale — definitions are data, not code
    op.create_table(
        "worker_levels",
        sa.Column("level", sa.Text, primary_key=True),          # 'L1'..'L6'
        sa.Column("rank", sa.Integer, nullable=False, unique=True),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("expected_skills", JSONB, nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        INSERT INTO worker_levels (level, rank, title, description, expected_skills) VALUES
        ('L1', 1, 'Apprentice',  'Supervised tasks — learning the trade.',
         '["Follows direction", "Basic tool handling", "Safety awareness"]'),
        ('L2', 2, 'Junior Tech', 'Routine work with light oversight.',
         '["Standard packing/unpacking", "Labeling discipline", "Equipment handling"]'),
        ('L3', 3, 'Technician',  'Independent on standard scopes.',
         '["Independent rack work", "Scan workflows", "Cable management"]'),
        ('L4', 4, 'Senior Tech', 'Complex work, mentors juniors.',
         '["Complex de/re-installation", "Mentors juniors", "Client-facing"]'),
        ('L5', 5, 'Specialist',  'Expert scopes — design & review.',
         '["Move planning input", "Exception handling", "QA sign-off"]'),
        ('L6', 6, 'Master',      'Authority — sets standards.',
         '["Sets standards", "Crew leadership", "Escalation authority"]')
    """)

    op.create_table(
        "worker_profiles",
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id"), primary_key=True),
        sa.Column("partner_id", UUID(as_uuid=True), sa.ForeignKey("partners.id"),
                  comment="supplying partner; NULL = direct hire"),
        sa.Column("trade", sa.Text),
        sa.Column("level", sa.Text, sa.ForeignKey("worker_levels.level")),
        sa.Column("status", sa.Text, nullable=False, server_default="active"),
        sa.Column("status_note", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('active', 'standby', 'blacklist')",
                           name="worker_profiles_status_check"),
        # a do-not-use flag without a documented reason is a liability
        sa.CheckConstraint("status != 'blacklist' OR status_note IS NOT NULL",
                           name="worker_profiles_blacklist_note_check"),
    )
    op.create_index("worker_profiles_partner_idx", "worker_profiles", ["partner_id"])

    op.create_table(
        "worker_certifications",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("issuer", sa.Text),
        sa.Column("issued_on", sa.Date),
        sa.Column("expires_on", sa.Date),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("worker_certifications_person_idx",
                    "worker_certifications", ["person_id"])


def downgrade() -> None:
    op.drop_table("worker_certifications")
    op.drop_table("worker_profiles")
    op.drop_table("worker_levels")
