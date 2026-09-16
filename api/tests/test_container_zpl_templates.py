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
import inspect
import re
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
async def _seed_container_templates(clean_db, db):
    """Re-run migration 0066's seed() against the (freshly truncated) test
    database before every test in this file. `clean_db` is requested
    explicitly (even though it is also autouse in conftest.py) so this
    fixture is guaranteed to run after the truncate rather than relying on
    pytest's within-scope autouse ordering, which `db` itself does not
    pin down."""
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


def test_upgrade_calls_seed():
    """Guard against `upgrade()` being stubbed out or reimplemented without
    calling `seed()`: every other test in this file re-runs `seed()`
    directly (because `clean_db` truncates the seeded tables before each
    test), so none of them would notice `upgrade()` doing nothing at all."""
    migration = _load_migration_0066()
    source = inspect.getsource(migration.upgrade)
    assert "seed(" in source, (
        "upgrade() must call seed(...) — none of the other tests exercise "
        "upgrade() itself, so this is the only thing that would catch it "
        "being stubbed out"
    )


async def test_new_placeholders_are_scoped_to_the_container_types(db):
    tag = await db.get(LabelPlaceholder, "label_tag")
    assert set(tag.applies_to) == {"container", "container_info"}
    long_date = await db.get(LabelPlaceholder, "move_date_long")
    assert {"container_info", "top"} <= set(long_date.applies_to)
    for key in ("source_site", "destination_site"):
        applies_to = set((await db.get(LabelPlaceholder, key)).applies_to)
        assert {"container", "container_info"} <= applies_to
    for key in ("move_name", "move_date", "container_name", "container_id"):
        applies_to = set((await db.get(LabelPlaceholder, key)).applies_to)
        assert "container_info" in applies_to


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


_FO = re.compile(r"\^FO(\d+),(\d+)")
_GB = re.compile(r"\^GB(\d+),(\d+),(\d+)")
_BY = re.compile(r"\^BY(\d+)")
_BQ = re.compile(r"\^BQ[NRIB],\d+,(\d+)")


# Positions and box sizes are large numbers, so one dot at the coarser
# resolution is the right slack: it absorbs the two independent roundings
# without hiding anything that matters.
#
# A barcode module is NOT a large number. The seeded 0.01in module is two
# dots at 203 dpi, so a full-coarse-dot slack (0.0049in) is wider than the
# module itself and would wave through a hardcoded ^BY2 — which lands at
# 0.0099in vs 0.0067in, only 0.0032in apart. That is precisely the bug this
# test exists to catch, so `by` gets half a coarse dot. The real difference
# between the two correct designs is 0.0001in, so this is still 16x headroom.
# A QR magnification is coarser still: ^BQ sizes in whole 25-dot steps,
# so the finest grid a QR can land on is 25/203 = 0.1232in at 203 dpi and
# 25/300 = 0.0833in at 300 dpi. No width makes the two agree exactly; the
# closest any width gets is magnification 6 vs 9 (0.7389in vs 0.7500in),
# 0.0111in apart. Four coarse dots (0.0197in) leaves that a comfortable
# 1.8x of headroom while still rejecting every other choice: the next
# closest pairing is 0.0287in apart, and the capped ^BQN,2,10-at-both-dpi
# bug the seeded 1.2in QR had lands 0.3982in apart.
_TOLERANCE_IN = {"fo": 1 / 203, "gb": 1 / 203, "by": 0.5 / 203, "bq": 4 / 203}


def _inches(zpl: str, dpi: int) -> dict[str, list[float]]:
    """Every geometric number in the ZPL, converted back to inches."""
    return {
        "fo": [v / dpi for m in _FO.finditer(zpl) for v in map(int, m.groups())],
        "gb": [v / dpi for m in _GB.finditer(zpl) for v in map(int, m.groups())],
        "by": [v / dpi for m in _BY.finditer(zpl) for v in map(int, m.groups())],
        # ^BQ magnification is a multiplier on a 25-dot module block, so the
        # printed square is mag * 25 dots wide, not mag dots.
        "bq": [v * 25 / dpi for m in _BQ.finditer(zpl) for v in map(int, m.groups())],
    }


@pytest.mark.parametrize("base", ["Container Label 4x6", "Container Info 4x6"])
async def test_both_dpi_describe_the_same_physical_label(db, base):
    """A 203 and a 300 dpi version must place ink in the same physical
    places. This is the test that would have caught the hardcoded ^BY2,
    which made a barcode 1.5x narrower at 300 dpi than at 203, and the
    capped ^BQ magnification, which made the QR 1.23in at 203 dpi but
    only 0.83in at 300."""
    subs = {"label_tag": "PRIORITY", "container_name": "crate-17",
            "move_name": "NAP11 Migration", "source_site": "NAP7",
            "destination_site": "NAP11", "move_date_long": "15-SEP-2026"}
    lo = await _template(db, f"{base} 203dpi")
    hi = await _template(db, f"{base} 300dpi")
    a = _inches(compile_zpl(parse_design(lo.design), 203, subs), 203)
    b = _inches(compile_zpl(parse_design(hi.design), 300, subs), 300)

    assert set(a) == set(b)
    for kind in a:
        assert len(a[kind]) == len(b[kind]), f"{kind}: different element counts"
        tolerance = _TOLERANCE_IN[kind]
        for i, (lo_in, hi_in) in enumerate(zip(a[kind], b[kind])):
            assert abs(lo_in - hi_in) <= tolerance, (
                f"{kind}[{i}]: {lo_in:.4f}in at 203 vs {hi_in:.4f}in at 300")
