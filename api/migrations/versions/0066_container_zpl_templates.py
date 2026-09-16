"""Container labels as ZPL — a 4" x 6" barcode label and info label, each
seeded at 203 and 300 dpi, plus the vocab and placeholders they need.

The container label prints x5 and the info label x1 per container, which
is why their type rows carry `default_copies`; that mirrors the Avery
sheet's five barcode labels plus one info label without the sheet's
six-slot geometry dictating the count.

Design literals live here rather than being imported from the
application so this migration stays frozen (same reasoning as 0058).

`generation_rules` is deliberately `{}`: `length_limits` truncates the
placeholder VALUE, which feeds the barcode and QR as well as the printed
name, so capping `container_name` would produce a barcode that scans to
the wrong string.

The seed statements live in `seed(conn)`, a plain function taking a raw
connection, rather than being written straight into `upgrade()` as
`op.execute(...)` calls. The test suite's `clean_db` fixture truncates
label_vocab/label_placeholders/label_templates before every test, so a
row this migration seeds never survives to the next test and has to be
re-seeded directly against the test database — the same convention as
0053's `repoint_survey_templates(conn)` and 0057's `INSERT_DEFINITION_SQL`.
`upgrade()` itself is just `seed(op.get_bind())`.

Design: docs/superpowers/specs/2026-09-16-container-labels-zpl-design.md

Revision ID: 0066
Revises: 0065
Create Date: 2026-09-16
"""
import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0066"
down_revision: str | None = "0065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONTAINER_DESIGN = {
    "size": {"w": 4, "h": 6},
    "elements": [
        {"id": "tag_bar", "type": "box", "x": 0.2, "y": 0.3, "w": 3.6,
         "h": 0.8, "rotation": 0, "strokeIn": 0.8},
        {"id": "tag_text", "type": "text", "x": 0.2, "y": 0.52, "w": 3.6,
         "h": 0.36, "rotation": 0, "content": "{label_tag}",
         "fontSizePt": 26, "bold": True, "align": "center", "reverse": True},
        {"id": "barcode", "type": "barcode", "x": 0.8, "y": 1.6, "w": 2.4,
         "h": 1.2, "rotation": 0, "symbology": "code128",
         "data": "{container_name}", "showText": False, "moduleIn": 0.01},
        {"id": "name", "type": "text", "x": 0.2, "y": 3.1, "w": 3.6,
         "h": 1.0, "rotation": 0, "content": "{container_name}",
         "fontSizePt": 24, "bold": True, "align": "center", "lines": 2},
        {"id": "move_name", "type": "text", "x": 0.2, "y": 5.55, "w": 3.6,
         "h": 0.2, "rotation": 0, "content": "{move_name}",
         "fontSizePt": 10, "bold": False, "align": "center"},
    ],
}

CONTAINER_INFO_DESIGN = {
    "size": {"w": 4, "h": 6},
    "elements": [
        {"id": "qr", "type": "qr", "x": 2.5, "y": 0.3, "w": 1.2, "h": 1.2,
         "rotation": 0, "data": "{container_name}"},
        {"id": "source_label", "type": "text", "x": 0.3, "y": 0.4, "w": 1.9,
         "h": 0.25, "rotation": 0, "content": "Source:", "fontSizePt": 14,
         "bold": True, "align": "left"},
        {"id": "source_value", "type": "text", "x": 0.5, "y": 0.7, "w": 1.9,
         "h": 0.25, "rotation": 0, "content": "{source_site}",
         "fontSizePt": 14, "bold": False, "align": "left"},
        {"id": "dest_label", "type": "text", "x": 0.3, "y": 1.1, "w": 1.9,
         "h": 0.25, "rotation": 0, "content": "Dest:", "fontSizePt": 14,
         "bold": True, "align": "left"},
        {"id": "dest_value", "type": "text", "x": 0.5, "y": 1.4, "w": 1.9,
         "h": 0.25, "rotation": 0, "content": "{destination_site}",
         "fontSizePt": 14, "bold": False, "align": "left"},
        {"id": "date_label", "type": "text", "x": 0.3, "y": 1.8, "w": 3.0,
         "h": 0.25, "rotation": 0, "content": "Date:", "fontSizePt": 14,
         "bold": True, "align": "left"},
        {"id": "date_value", "type": "text", "x": 0.5, "y": 2.1, "w": 3.0,
         "h": 0.25, "rotation": 0, "content": "{move_date_long}",
         "fontSizePt": 14, "bold": False, "align": "left"},
        {"id": "container_label", "type": "text", "x": 0.3, "y": 2.5,
         "w": 3.0, "h": 0.25, "rotation": 0, "content": "Container:",
         "fontSizePt": 14, "bold": True, "align": "left"},
        {"id": "container_value", "type": "text", "x": 0.5, "y": 2.8,
         "w": 3.0, "h": 0.6, "rotation": 0, "content": "{container_name}",
         "fontSizePt": 14, "bold": False, "align": "left", "lines": 2},
        {"id": "rfid_rule_top", "type": "line", "x": 0.4, "y": 4.6, "w": 3.2,
         "h": 0.01, "rotation": 0, "strokeIn": 0.01},
        {"id": "rfid_text", "type": "text", "x": 0.4, "y": 4.85, "w": 3.2,
         "h": 0.25, "rotation": 0, "content": "RFID TAG HERE",
         "fontSizePt": 14, "bold": False, "align": "center"},
        {"id": "rfid_rule_bottom", "type": "line", "x": 0.4, "y": 5.15,
         "w": 3.2, "h": 0.01, "rotation": 0, "strokeIn": 0.01},
    ],
}

TEMPLATES = [
    ("Container Label 4x6 203dpi", "container", "203",
     "Crate barcode label: tag bar, Code 128 and the container name.",
     CONTAINER_DESIGN),
    ("Container Label 4x6 300dpi", "container", "300",
     "Crate barcode label: tag bar, Code 128 and the container name.",
     CONTAINER_DESIGN),
    ("Container Info 4x6 203dpi", "container_info", "203",
     "Crate info label: QR, source, destination, date and the RFID zone.",
     CONTAINER_INFO_DESIGN),
    ("Container Info 4x6 300dpi", "container_info", "300",
     "Crate info label: QR, source, destination, date and the RFID zone.",
     CONTAINER_INFO_DESIGN),
]


def _q(value: str) -> str:
    """Single-quoted SQL literal with quotes doubled."""
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _seed_statements() -> list[str]:
    """The exact statements `seed()` runs, in order. A plain list (rather
    than inlining each `op.execute(...)` call) so both `upgrade()` and the
    test suite iterate the identical set of statements."""
    statements = [
        """
        INSERT INTO label_vocab (kind, key, label, description, meta, sort_order)
        VALUES ('size', '4x6', '4" x 6"', 'Zebra roll label, portrait.',
                '{"width_in": 4, "height_in": 6, "has_tab": false}', 7)
        ON CONFLICT (kind, key) DO NOTHING
        """,
        """
        INSERT INTO label_vocab (kind, key, label, description, meta, sort_order)
        VALUES ('type', 'container_info', 'Container Info Label',
                'The crate''s QR, route, date and RFID zone.',
                '{"default_copies": 1}', 5)
        ON CONFLICT (kind, key) DO NOTHING
        """,
        """
        UPDATE label_vocab SET meta = meta || '{"default_copies": 5}'::jsonb
        WHERE kind = 'type' AND key = 'container'
        """,
        # Placeholder scoping: the info label needs the site names, and
        # both container types need everything the `container` type
        # already had.
        """
        UPDATE label_placeholders
        SET applies_to = (
            SELECT array_agg(DISTINCT t)
            FROM unnest(applies_to || ARRAY['container', 'container_info']) AS t)
        WHERE key IN ('source_site', 'destination_site')
        """,
        """
        UPDATE label_placeholders
        SET applies_to = (
            SELECT array_agg(DISTINCT t)
            FROM unnest(applies_to || ARRAY['container_info']) AS t)
        WHERE key IN ('move_name', 'move_date', 'container_name', 'container_id')
        """,
        """
        INSERT INTO label_placeholders
            (key, label, description, sample_value, applies_to, sort_order)
        VALUES
            ('label_tag', 'Container tag',
             'Priority / Vendor / Accessories / Warehouse / E-Waste, upper-cased. '
             'Falls back to CONTAINER when the container has no tag.',
             'PRIORITY', '{container,container_info}', 17),
            ('move_date_long', 'Move date (long)',
             'The move date as DD-MON-YYYY, which reads unambiguously in every '
             'region the company operates in.',
             '01-SEP-2026', '{top,front,rail,container,container_info}', 18)
        ON CONFLICT (key) DO NOTHING
        """,
    ]
    for name, label_type, dpi_key, description, design in TEMPLATES:
        statements.append(f"""
            INSERT INTO label_templates
                (name, description, label_type, size_key, dpi_key,
                 language_key, kind, design, generation_rules, is_active)
            VALUES (
                {_q(name)}, {_q(description)}, {_q(label_type)}, '4x6',
                {_q(dpi_key)}, 'zpl', 'design',
                {_q(json.dumps(design))}::jsonb, '{{}}'::jsonb, true)
            ON CONFLICT (name) DO NOTHING
        """)
    return statements


def seed(conn) -> None:
    """Run every seed statement against `conn` (a raw connection, sync or
    the one alembic hands `op`). Idempotent — every statement carries its
    own ON CONFLICT — so calling it more than once is harmless, which is
    what lets the test suite call it fresh in every test."""
    for sql in _seed_statements():
        conn.execute(sa.text(sql))


def upgrade() -> None:
    seed(op.get_bind())


def downgrade() -> None:
    conn = op.get_bind()
    names = ", ".join(_q(t[0]) for t in TEMPLATES)
    conn.execute(sa.text(f"DELETE FROM label_templates WHERE name IN ({names})"))
    conn.execute(sa.text(
        "DELETE FROM label_placeholders WHERE key IN ('label_tag', 'move_date_long')"))
    conn.execute(sa.text("""
        UPDATE label_placeholders
        SET applies_to = array_remove(applies_to, 'container_info')
        WHERE key IN ('source_site', 'destination_site', 'move_name', 'move_date',
                       'container_name', 'container_id')
    """))
    conn.execute(sa.text("""
        UPDATE label_placeholders
        SET applies_to = array_remove(applies_to, 'container')
        WHERE key IN ('source_site', 'destination_site')
    """))
    conn.execute(sa.text(
        "UPDATE label_vocab SET meta = meta - 'default_copies' "
        "WHERE kind = 'type' AND key = 'container'"))
    conn.execute(sa.text(
        "DELETE FROM label_vocab WHERE kind = 'type' AND key = 'container_info'"))
    conn.execute(sa.text("DELETE FROM label_vocab WHERE kind = 'size' AND key = '4x6'"))
