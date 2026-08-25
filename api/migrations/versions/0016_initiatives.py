"""initiatives — unified V2 projects/events/moves as one entity.
Replaces the three V2 tables (projects, events, moves) with a single
initiatives table discriminated by initiative_type, plus people
assignments (V2 people_work_association) and initiative↔initiative
links (V2 projects_associations, generalised to any parent type).
Deliberately fixed from V2: shipping_type is a real text[] (was a
comma-joined string), *_vendor_involved is spelled correctly, the
orphan projects.site/events.site columns are gone, status is a seeded
vocabulary instead of a hardcoded id, and scheduled_end exists.

Revision ID: 0016
Revises: 0015
Create Date: 2026-08-24
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, UUID

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INITIATIVE_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('initiative','planned','Planned','Not yet scheduled.','#51606f',1),
      ('initiative','scheduled','Scheduled','Date set; not started.','#0f7c86',2),
      ('initiative','in_progress','In progress','Work underway.','#1668a7',3),
      ('initiative','on_hold','On hold','Paused.','#a36207',4),
      ('initiative','completed','Completed','Done; retained for history.','#178a4c',5),
      ('initiative','cancelled','Cancelled','Will not happen.','#c03540',6),
      ('initiative_type','project','Project','Long-running engagement.','#1668a7',1),
      ('initiative_type','event','Event','Date-bound occasion.','#6d4fc4',2),
      ('initiative_type','move','Move','Physical relocation of assets.','#a36207',3),
      ('initiative_sub_type','deployment','Deployment','New equipment install.','#178a4c',1),
      ('initiative_sub_type','decommission','Decommission','Teardown / removal.','#c03540',2),
      ('initiative_sub_type','migration','Migration','Data-centre migration.','#0f7c86',3),
      ('initiative_sub_type','maintenance','Maintenance','Scheduled maintenance.','#a36207',4),
      ('initiative_sub_type','conference','Conference','Conference or trade show.','#6d4fc4',5),
      ('initiative_sub_type','office_move','Office move','Office relocation.','#1668a7',6),
      ('initiative_work_type','lead','Lead','On-site lead.','#1668a7',1),
      ('initiative_work_type','tech','Tech','Hands-on technician.','#178a4c',2),
      ('initiative_work_type','cabling','Cabling','Structured cabling.','#0f7c86',3),
      ('initiative_work_type','logistics','Logistics','Transport & handling.','#a36207',4),
      ('initiative_work_type','other','Other','Anything else.','#51606f',5),
      ('shipping_type','truck','Truck','Road freight.','#1668a7',1),
      ('shipping_type','air','Air','Air freight.','#0f7c86',2),
      ('shipping_type','rail','Rail','Rail freight.','#a36207',3),
      ('shipping_type','ferry','Ferry','Sea / ferry.','#6d4fc4',4)
"""

FULL = ("view", "add", "change", "delete")
# initiatives: internal-only for this slice (like containers) — client
# visibility is a future decision; V2 exposed a client work-history view.
INITIATIVE_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
}

PARTNER_FK_COLUMNS = (
    "shipping_partner_id",
    "origin_tech_partner_id", "origin_cable_partner_id",
    "origin_logistics_partner_id",
    "destination_tech_partner_id", "destination_cable_partner_id",
    "destination_logistics_partner_id",
)


def upgrade() -> None:
    op.execute(INITIATIVE_SEEDS)

    op.create_table(
        "initiatives",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("initiative_type", sa.Text, nullable=False),
        sa.Column("sub_type", sa.Text),
        sa.Column("status", sa.Text, nullable=False, server_default="planned"),
        sa.Column("client_id", UUID(as_uuid=True), sa.ForeignKey("clients.id")),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("location", sa.Text),
        sa.Column("scheduled_start", sa.TIMESTAMP(timezone=True)),
        sa.Column("scheduled_end", sa.TIMESTAMP(timezone=True)),
        sa.Column("sky_command_project_id", sa.Text),
        # move block — nullable for every other type
        sa.Column("origin_site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("destination_site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id")),
        sa.Column("real_start_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("real_end_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("priority_devices", sa.Boolean),
        sa.Column("shipping_types", ARRAY(sa.Text),
                  comment="keys under status_values record_type='shipping_type'; "
                          "API-validated (composite FK can't cover arrays)"),
        *(sa.Column(col, UUID(as_uuid=True), sa.ForeignKey("partners.id"))
          for col in PARTNER_FK_COLUMNS),
        sa.Column("origin_vendor_involved", sa.Boolean),
        sa.Column("destination_vendor_involved", sa.Boolean),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    # composite FKs to status_values — the 0014/0015 idiom, three times
    op.execute("""
        ALTER TABLE initiatives ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('initiative') STORED
    """)
    op.create_foreign_key(
        "initiatives_status_fkey", "initiatives", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    op.execute("""
        ALTER TABLE initiatives ADD COLUMN type_record_type text
          GENERATED ALWAYS AS ('initiative_type') STORED
    """)
    op.create_foreign_key(
        "initiatives_type_fkey", "initiatives", "status_values",
        ["type_record_type", "initiative_type"], ["record_type", "key"])
    op.execute("""
        ALTER TABLE initiatives ADD COLUMN sub_type_record_type text
          GENERATED ALWAYS AS ('initiative_sub_type') STORED
    """)
    # MATCH SIMPLE: a NULL sub_type skips the check entirely
    op.create_foreign_key(
        "initiatives_sub_type_fkey", "initiatives", "status_values",
        ["sub_type_record_type", "sub_type"], ["record_type", "key"])

    op.create_index("initiatives_name_idx", "initiatives", ["name"])
    op.create_index("initiatives_type_idx", "initiatives", ["initiative_type"])
    op.create_index("initiatives_client_idx", "initiatives", ["client_id"])
    op.create_index("initiatives_site_idx", "initiatives", ["site_id"])

    op.create_table(
        "initiative_people",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  nullable=False),
        sa.Column("work_type", sa.Text),
        sa.Column("site_worked_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("rating", sa.SmallInteger),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("rating BETWEEN 1 AND 5",
                           name="initiative_people_rating_range"),
        sa.UniqueConstraint("initiative_id", "person_id",
                            name="initiative_people_uniq"),
    )
    op.execute("""
        ALTER TABLE initiative_people ADD COLUMN work_type_record_type text
          GENERATED ALWAYS AS ('initiative_work_type') STORED
    """)
    op.create_foreign_key(
        "initiative_people_work_type_fkey", "initiative_people",
        "status_values",
        ["work_type_record_type", "work_type"], ["record_type", "key"])
    op.create_index("initiative_people_initiative_idx", "initiative_people",
                    ["initiative_id"])

    op.create_table(
        "initiative_links",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("parent_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("child_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("role", sa.Text),
        sa.Column("sort_order", sa.Integer),
        sa.Column("notes", sa.Text),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("parent_id <> child_id",
                           name="initiative_links_no_self"),
        sa.UniqueConstraint("parent_id", "child_id",
                            name="initiative_links_uniq"),
    )
    op.create_index("initiative_links_parent_idx", "initiative_links",
                    ["parent_id"])
    op.create_index("initiative_links_child_idx", "initiative_links",
                    ["child_id"])

    conn = op.get_bind()
    for role, actions in INITIATIVE_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'initiatives', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'initiatives'"))
    op.drop_table("initiative_links")
    op.drop_table("initiative_people")
    op.drop_table("initiatives")
    conn.execute(sa.text(
        "DELETE FROM status_values WHERE record_type IN "
        "('initiative', 'initiative_type', 'initiative_sub_type', "
        "'initiative_work_type', 'shipping_type')"))
