"""labels — vocabularies, placeholder catalog, templates, resource grants.

label_vocab holds all four label dropdown vocabularies discriminated by
`kind` (type/size/dpi/language); kind-specific facts live in meta JSONB.
Codegen keys off well-known `key` values — rows only control what the UI
offers. label_templates: kind='design' rows own element-model JSON,
kind='code' rows own raw printer code with {placeholder} tokens (CHECK
enforces exactly-one). No FK from templates into label_vocab (four
generated-column FKs would be noise; routes validate instead).

Revision ID: 0042
Revises: 0041
Create Date: 2026-09-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, JSONB, UUID

revision: str = "0042"
down_revision: str | None = "0041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
GRANTS = {"developer": FULL, "founder": FULL, "super_admin": FULL,
          "admin": FULL, "staff": ("view",)}

VOCAB_SEEDS = """
    INSERT INTO label_vocab (kind, key, label, description, meta, sort_order) VALUES
      ('type','top','Top Label','Placed on the asset''s top face.','{}',1),
      ('type','front','Front Label','Placed on the asset''s front face.','{}',2),
      ('type','rail','Rail Label','Placed on the rack rail at the destination RU.','{}',3),
      ('type','container','Container Label','Placed on crates and containers.','{}',4),
      ('size','4x2','4" x 2"','','{"width_in": 4, "height_in": 2, "has_tab": false}',1),
      ('size','2x1','2" x 1"','','{"width_in": 2, "height_in": 1, "has_tab": false}',2),
      ('size','4x3-tab','4" x 3" (w/ tab)','','{"width_in": 4, "height_in": 3, "has_tab": true}',3),
      ('size','1x1','1" x 1"','','{"width_in": 1, "height_in": 1, "has_tab": false}',4),
      ('size','6x4','6" x 4"','','{"width_in": 6, "height_in": 4, "has_tab": false}',5),
      ('size','id-badge','ID Badge','CR80 card, 3.375" x 2.125".','{"width_in": 3.375, "height_in": 2.125, "has_tab": false}',6),
      ('dpi','203','203 DPI','','{"dots": 203}',1),
      ('dpi','300','300 DPI','','{"dots": 300}',2),
      ('language','zpl','ZPL','Zebra Programming Language.','{"family": "zebra"}',1),
      ('language','escp','Brother ESC/P','','{"family": "brother"}',2),
      ('language','ptouch','Brother P-Touch Template','','{"family": "brother"}',3)
"""

PLACEHOLDER_SEEDS = """
    INSERT INTO label_placeholders (key, label, description, sample_value, applies_to, sort_order) VALUES
      ('asset_id','Asset ID','','10482','{top,front,rail}',1),
      ('asset_name','Asset name','','core-sw-01','{top,front,rail}',2),
      ('serial_number','Serial number','','C7X-00412-A','{top,front,rail}',3),
      ('make','Make','','Cisco','{top,front,rail}',4),
      ('model','Model','','Nexus 9336C','{top,front,rail}',5),
      ('make_model','Make + model','','Cisco Nexus 9336C','{top,front,rail}',6),
      ('source_raw','Source (raw)','','NAP7 A12','{top,front,rail}',7),
      ('source_ru','Source RU','','U14','{top,front,rail}',8),
      ('source_site','Source site','','NAP7','{top,front,rail}',9),
      ('destination_raw','Destination (raw)','','NAP11 C03','{top,front,rail}',10),
      ('destination_ru','Destination RU','','U22','{top,front,rail}',11),
      ('destination_site','Destination site','','NAP11','{top,front,rail}',12),
      ('move_name','Initiative / move name','','NAP11 Hall Migration','{top,front,rail,container}',13),
      ('move_date','Move date','','09/15/2026','{top,front,rail,container}',14),
      ('container_name','Container name','','crate-17','{container}',15),
      ('container_id','Container ID','','C-0017','{container}',16)
"""


def upgrade() -> None:
    op.create_table(
        "label_vocab",
        sa.Column("kind", sa.Text, primary_key=True),
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("meta", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("kind IN ('type','size','dpi','language')",
                           name="label_vocab_kind_check"),
    )
    op.create_table(
        "label_placeholders",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("sample_value", sa.Text, nullable=False, server_default=""),
        sa.Column("applies_to", ARRAY(sa.Text), nullable=False,
                  server_default=sa.text("'{}'::text[]")),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_table(
        "label_templates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False, unique=True),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("label_type", sa.Text, nullable=False),
        sa.Column("size_key", sa.Text, nullable=False),
        sa.Column("dpi_key", sa.Text, nullable=False),
        sa.Column("language_key", sa.Text, nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("design", JSONB),
        sa.Column("code", sa.Text),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("is_active", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("kind IN ('design','code')",
                           name="label_templates_kind_check"),
        sa.CheckConstraint(
            "((kind = 'design') = (design IS NOT NULL)) "
            "AND ((kind = 'code') = (code IS NOT NULL))",
            name="label_templates_payload_check"),
    )
    op.create_index("label_templates_type_idx", "label_templates", ["label_type"])
    op.execute(VOCAB_SEEDS)
    op.execute(PLACEHOLDER_SEEDS)
    conn = op.get_bind()
    for role, actions in GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'labels', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    op.drop_table("label_templates")
    op.drop_table("label_placeholders")
    op.drop_table("label_vocab")
    op.get_bind().execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'labels'"))
