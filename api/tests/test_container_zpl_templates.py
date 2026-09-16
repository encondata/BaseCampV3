"""The seeded 4x6 container ZPL templates: they exist, they parse, and
they compile to plausible ZPL at both dpi.

`clean_db` (api/tests/conftest.py) truncates label_vocab,
label_placeholders and label_templates before every test and only
re-seeds the migration-0042 baseline, so migration 0066's rows never
survive to a test on their own. This file re-runs the migration's own
`seed(conn)` in an autouse fixture instead of assuming the rows are
already there — the same convention test_container_labels_report.py uses
for 0057's INSERT_DEFINITION_SQL and test_site_move_survey_fixtures.py
uses for 0053's repoint_survey_templates()."""

import importlib.util
from pathlib import Path

import pytest
from sqlalchemy import select

from serversherpa.db.models import LabelPlaceholder, LabelTemplate, LabelVocab
from serversherpa.labels.model import parse_design
from serversherpa.labels.zpl import compile_zpl

API_DIR = Path(__file__).resolve().parents[1]
MIGRATION_PATH = API_DIR / "migrations" / "versions" / "0066_container_zpl_templates.py"

NAMES = ("Container Label 4x6 203dpi", "Container Label 4x6 300dpi",
         "Container Info 4x6 203dpi", "Container Info 4x6 300dpi")


def _load_migration_0066():
    spec = importlib.util.spec_from_file_location("_migration_0066_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
async def _seed_container_templates(db):
    """Re-run migration 0066's seed() against the (freshly truncated) test
    database before every test in this file."""
    migration = _load_migration_0066()
    await db.run_sync(lambda session: migration.seed(session.connection()))
    await db.commit()


async def _template(db, name):
    return await db.scalar(select(LabelTemplate).where(LabelTemplate.name == name))


async def test_all_four_templates_are_seeded_and_active(db):
    for name in NAMES:
        tpl = await _template(db, name)
        assert tpl is not None, f"{name} was not seeded"
        assert tpl.is_active is True
        assert tpl.kind == "design"
        assert tpl.language_key == "zpl"
        assert tpl.size_key == "4x6"
        assert tpl.generation_rules == {}


async def test_the_pair_of_each_design_differs_only_in_dpi(db):
    for base in ("Container Label 4x6", "Container Info 4x6"):
        a = await _template(db, f"{base} 203dpi")
        b = await _template(db, f"{base} 300dpi")
        assert a.design == b.design
        assert (a.dpi_key, b.dpi_key) == ("203", "300")
        assert a.label_type == b.label_type


async def test_the_4x6_size_row_is_portrait(db):
    row = await db.get(LabelVocab, ("size", "4x6"))
    assert row is not None
    assert row.meta["width_in"] == 4
    assert row.meta["height_in"] == 6


async def test_container_types_carry_their_default_copies(db):
    assert (await db.get(LabelVocab, ("type", "container"))).meta["default_copies"] == 5
    assert (await db.get(LabelVocab, ("type", "container_info"))).meta["default_copies"] == 1


async def test_new_placeholders_are_scoped_to_the_container_types(db):
    tag = await db.get(LabelPlaceholder, "label_tag")
    assert set(tag.applies_to) == {"container", "container_info"}
    long_date = await db.get(LabelPlaceholder, "move_date_long")
    assert {"container_info", "top"} <= set(long_date.applies_to)
    for key in ("source_site", "destination_site"):
        assert "container_info" in (await db.get(LabelPlaceholder, key)).applies_to


async def test_container_label_compiles_with_a_reversed_tag_bar(db):
    tpl = await _template(db, "Container Label 4x6 203dpi")
    out = compile_zpl(parse_design(tpl.design), 203,
                      {"label_tag": "PRIORITY", "container_name": "crate-17",
                       "move_name": "NAP11 Migration"})
    assert "^PW812" in out and "^LL1218" in out
    assert "^GB731,162,162^FS" in out            # solid tag bar
    assert "^FR^FH_^FDPRIORITY^FS" in out        # knockout text
    assert "^BY2^BCN,244,N,N,N^FH_^FDcrate-17^FS" in out
    assert "^FDNAP11 Migration^FS" in out


async def test_container_info_compiles_with_the_qr_and_rfid_zone(db):
    tpl = await _template(db, "Container Info 4x6 300dpi")
    out = compile_zpl(parse_design(tpl.design), 300,
                      {"source_site": "NAP7", "destination_site": "NAP11",
                       "move_date_long": "15-SEP-2026", "container_name": "crate-17"})
    assert "^BQN,2," in out
    assert "^FDQA,crate-17^FS" in out
    assert "^FD15-SEP-2026^FS" in out
    assert "^FDRFID TAG HERE^FS" in out
    assert out.count("^GB") == 2                 # the two RFID rules only
