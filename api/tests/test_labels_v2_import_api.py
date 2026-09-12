"""End-to-end V2 label-template import against the test DB."""

import json
import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, LabelTemplate, LabelTemplateSite, Site,
)
from serversherpa.labels.v2_import import import_label_templates

# `=Q=` marks a quote that needs SQL-escaping (doubled) once this constant
# is embedded inside the dump's single-quoted `template_code` literal —
# the brackets around it are literal V2 `row['...']` alias syntax, typed
# outside the placeholder so they survive untouched.
ZPL = ("^XA\\n^PW406^LL203\\n^FO10,10^FD{row[=Q=asset id=Q=]}^FS\\n"
       "^FT10,110^FDTarget: {row[=Q=asset track=Q=]}^FS\\n^XZ").replace(
           "=Q=", "''")

DUMP_TEMPLATE = """
INSERT INTO label_templates (id, template_name, printer_type, template_code, sites, type, is_active, version, created_at, updated_at, label_generation_code, label_generation_code_json) VALUES (5, 'Vegas Destination', 'Zebra', '{zpl}', '3,99', 'asset_top', TRUE, 1, '2025-01-01 00:00:00+00', '2025-01-01 00:00:00+00', NULL, NULL);
INSERT INTO label_templates (id, template_name, printer_type, template_code, sites, type, is_active, version, created_at, updated_at, label_generation_code, label_generation_code_json) VALUES (3, 'container_manifest', 'epson', '{{{{INIT}}}}{{{{LF}}}}', NULL, 'manifest', TRUE, 1, '2025-01-01 00:00:00+00', '2025-01-01 00:00:00+00', NULL, NULL);
"""


def _write_dump(tmp_path):
    p = tmp_path / "v2.sql"
    p.write_text(DUMP_TEMPLATE.format(zpl=ZPL))
    return str(p)


# ── label_generation_code -> generation_rules mapping ────────────────

DUMP_WITH_RULES_TEMPLATE = """
INSERT INTO label_templates (id, template_name, printer_type, template_code, sites, type, is_active, version, created_at, updated_at, label_generation_code, label_generation_code_json) VALUES (5, 'Vegas Destination', 'Zebra', '{zpl}', '3,99', 'asset_top', TRUE, 1, '2025-01-01 00:00:00+00', '2025-01-01 00:00:00+00', '{gen_rules}', NULL);
"""

GENERATION_RULES = {"destination": {"1": "nap", "2": "row"}, "source": {"1": "dc"},
                    "length_limits": {"asset_name": 20}}

# A dirty V2 value: a bad position key, a non-token name, a negative
# limit, and an unrecognized top-level key — all of which must be
# dropped rather than failing the whole row.
DIRTY_GENERATION_RULES = {"destination": {"1": "nap", "0": "bad_pos"},
                          "source": {"1": "Bad Token!"},
                          "length_limits": {"asset_name": 20, "x": -5},
                          "unexpected": "ignored"}


def _write_dump_with_rules(tmp_path, rules: dict | None, *, name="v2_rules.sql"):
    p = tmp_path / name
    gen_rules = "NULL" if rules is None else f"'{json.dumps(rules)}'"
    # NULL needs to land unquoted (a real NULL literal, not the string
    # "NULL") — .format() can't conditionally drop the surrounding
    # quotes, so build the whole VALUES literal for that column directly.
    text = DUMP_WITH_RULES_TEMPLATE.format(zpl=ZPL, gen_rules="__GEN_RULES__")
    text = text.replace("'__GEN_RULES__'", gen_rules)
    p.write_text(text)
    return str(p)


async def test_import_maps_label_generation_code_to_generation_rules(
        db, tmp_path, seeded_user):
    await _seed_site(db)
    stats = await import_label_templates(
        db, _write_dump_with_rules(tmp_path, GENERATION_RULES))
    await db.commit()
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    assert row.generation_rules == GENERATION_RULES
    assert any("generation_rules mapped" in n for n in stats["notes"])


async def test_import_sanitizes_a_dirty_generation_rules_value(
        db, tmp_path, seeded_user):
    await _seed_site(db)
    await import_label_templates(
        db, _write_dump_with_rules(tmp_path, DIRTY_GENERATION_RULES))
    await db.commit()
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    # bad position ("0"), non-token source name, negative limit, and the
    # unrecognized "unexpected" key all dropped; an empty "source" after
    # cleaning is omitted entirely rather than kept as {}.
    assert row.generation_rules == {
        "destination": {"1": "nap"}, "length_limits": {"asset_name": 20}}


async def test_reimport_without_rules_preserves_a_hand_edit(
        db, tmp_path, seeded_user):
    await _seed_site(db)
    dump_without_rules = _write_dump(tmp_path)   # label_generation_code NULL
    await import_label_templates(db, dump_without_rules)
    await db.commit()
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    hand_edit = {"length_limits": {"asset_name": 9}}
    row.generation_rules = hand_edit
    await db.commit()

    stats = await import_label_templates(db, dump_without_rules)
    await db.commit()
    assert stats["unchanged"] == ["Vegas Destination"]   # V2 offered nothing -> no touch
    await db.refresh(row)
    assert row.generation_rules == hand_edit


async def test_reimport_with_rules_overwrites_when_v2_value_differs(
        db, tmp_path, seeded_user):
    await _seed_site(db)
    dump1 = _write_dump_with_rules(tmp_path, GENERATION_RULES, name="v2_rules1.sql")
    await import_label_templates(db, dump1)
    await db.commit()
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    assert row.generation_rules == GENERATION_RULES
    first_version = row.version

    changed_rules = {"destination": {"1": "campus"}}
    dump2 = _write_dump_with_rules(tmp_path, changed_rules, name="v2_rules2.sql")
    stats = await import_label_templates(db, dump2)
    await db.commit()
    assert stats["updated"] == ["Vegas Destination"]
    await db.refresh(row)
    assert row.generation_rules == changed_rules
    assert row.version == first_version + 1


async def _seed_site(db):
    s = Site(name="NAP11 - Switch",
             source_ref="backup_20260825_193157:sites/3")
    db.add(s)
    await db.commit()
    return s.id


async def test_import_creates_translated_inactive_template(db, tmp_path,
                                                           seeded_user):
    site_id = await _seed_site(db)
    stats = await import_label_templates(db, _write_dump(tmp_path))
    await db.commit()
    assert stats["created"] == ["Vegas Destination"]
    assert ("container_manifest",
            "printer_type 'epson' unsupported") in stats["skipped"]
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    assert row.kind == "code" and row.is_active is False
    assert row.language_key == "zpl" and row.dpi_key == "203"
    assert row.size_key == "2x1"            # 406x203 dots @203dpi = 2x1
    assert row.label_type == "top"
    assert "{asset_id}" in row.code
    assert "{row['asset track']}" in row.code   # unknown alias verbatim
    assert "v2 id 5" in row.description
    links = (await db.execute(select(LabelTemplateSite.site_id).where(
        LabelTemplateSite.template_id == row.id))).scalars().all()
    assert links == [site_id]               # id 99 unresolvable -> skipped
    assert any("99" in n for n in stats["notes"])
    assert any("asset track" in n for n in stats["notes"])
    audit_row = (await db.execute(select(AuditLog).where(
        AuditLog.entity_type == "label_template",
        AuditLog.action == "v2_import"))).scalars().first()
    assert audit_row is not None


async def test_reimport_is_idempotent_and_preserves_activation(
        db, tmp_path, seeded_user):
    await _seed_site(db)
    dump = _write_dump(tmp_path)
    await import_label_templates(db, dump)
    await db.commit()
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    first_version = row.version
    row.is_active = True                     # user activates it
    await db.commit()
    stats = await import_label_templates(db, dump)
    await db.commit()
    assert stats["unchanged"] == ["Vegas Destination"]
    await db.refresh(row)
    assert row.version == first_version      # no churn
    assert row.is_active is True             # activation preserved


async def test_design_kind_name_collision_is_skipped(db, tmp_path,
                                                     seeded_user):
    await _seed_site(db)
    db.add(LabelTemplate(name="Vegas Destination", label_type="top",
                         size_key="4x2", dpi_key="203", language_key="zpl",
                         kind="design",
                         design={"size": {"w": 4, "h": 2}, "elements": []}))
    await db.commit()
    stats = await import_label_templates(db, _write_dump(tmp_path))
    await db.commit()
    assert any(name == "Vegas Destination" and "design" in reason
               for name, reason in stats["skipped"])
    row = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination"))).scalar_one()
    assert row.kind == "design"              # untouched
