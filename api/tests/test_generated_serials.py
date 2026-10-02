"""Generated serials: gnrtd- + 6 hex, unique in the file and across assets."""
import re

from sqlalchemy import select

from serversherpa.db.models import Asset, Initiative
from serversherpa.imports.move_assets import (
    assign_generated_serials,
    parse_row,
    run_import,
)
from serversherpa.imports.parsing import CANONICAL

GEN = re.compile(r"gnrtd-[0-9a-f]{6}")


def _rows(*specs):
    """specs: (serial, name) pairs -> parsed rows with generation on."""
    out = []
    for i, (serial, name) in enumerate(specs, start=2):
        canonical = {c: "" for c in CANONICAL}
        canonical.update(serial_number=serial, asset_name=name)
        out.append(parse_row(i, canonical, {}, generate_serials=True))
    return out


async def _move(db):
    ini = Initiative(name="Move G", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    return ini


async def test_assigns_unique_serials_and_name_fallback(db):
    rows = _rows(("", "web-01"), ("", ""), ("SN-1", "db-01"))
    await assign_generated_serials(db, rows)
    a, b, c = rows
    assert GEN.fullmatch(a["serial_number"]) and GEN.fullmatch(b["serial_number"])
    assert a["serial_number"] != b["serial_number"]
    assert a["asset_name"] == "web-01"
    assert b["asset_name"] == b["serial_number"]
    assert c["serial_number"] == "sn-1" and c["serial_generated"] is False


async def test_redraws_when_the_candidate_is_an_existing_asset(db):
    db.add(Asset(serial_number="gnrtd-aaaaaa", name="old"))
    await db.commit()
    draws = iter(["gnrtd-aaaaaa", "gnrtd-bbbbbb"])
    rows = _rows(("", "web-01"))
    await assign_generated_serials(db, rows, draw=lambda: next(draws))
    assert rows[0]["serial_number"] == "gnrtd-bbbbbb"


async def test_redraws_when_the_candidate_is_an_archived_asset(db):
    from datetime import UTC, datetime
    db.add(Asset(serial_number="gnrtd-aaaaaa", name="old",
                 archived_at=datetime.now(UTC)))
    await db.commit()
    draws = iter(["gnrtd-aaaaaa", "gnrtd-bbbbbb"])
    rows = _rows(("", "web-01"))
    await assign_generated_serials(db, rows, draw=lambda: next(draws))
    assert rows[0]["serial_number"] == "gnrtd-bbbbbb"


async def test_redraws_when_the_candidate_is_another_rows_serial_or_a_sibling_draw(db):
    draws = iter(["gnrtd-cccccc", "gnrtd-cccccc", "gnrtd-dddddd", "gnrtd-eeeeee"])
    rows = _rows(("GNRTD-CCCCCC", "given"), ("", "x"), ("", "y"))
    await assign_generated_serials(db, rows, draw=lambda: next(draws))
    got = {r["serial_number"] for r in rows[1:]}
    assert "gnrtd-cccccc" not in got and len(got) == 2
    assert got == {"gnrtd-dddddd", "gnrtd-eeeeee"}
    assert rows[0]["serial_number"] == "gnrtd-cccccc"


async def test_sibling_draw_collision_redraws_within_a_round(db):
    draws = iter(["gnrtd-111111", "gnrtd-111111", "gnrtd-222222"])
    rows = _rows(("", "x"), ("", "y"))
    await assign_generated_serials(db, rows, draw=lambda: next(draws))
    assert [r["serial_number"] for r in rows] == ["gnrtd-111111", "gnrtd-222222"]


async def test_error_rows_and_filled_rows_are_untouched(db):
    canonical = {c: "" for c in CANONICAL}
    err = parse_row(2, canonical, {}, generate_serials=False)
    rows = [err] + _rows(("SN-9", "keep"))
    await assign_generated_serials(db, rows)
    assert err["serial_number"] == "" and err["status"] == "error"
    assert rows[1]["serial_number"] == "sn-9"


async def test_run_import_writes_generated_serials(db):
    ini = await _move(db)
    await db.commit()

    # validate pass: succeeds, details carry the generated serials, no writes
    dry = _rows(("", "web-01"), ("", ""))
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=dry, write=False)
    assert result["summary"]["created"] == 2 and result["summary"]["errors"] == 0
    for d in result["details"]:
        assert GEN.fullmatch(d["serial_number"]) and d["serial_generated"] is True
    assert (await db.scalars(select(Asset))).all() == []

    # commit pass: assets are created with the generated serials
    rows = _rows(("", "web-01"), ("", ""), ("SN-1", "db-01"))
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"]["created"] == 3 and result["summary"]["errors"] == 0
    by_row = {d["row"]: d for d in result["details"]}
    assert by_row[2]["serial_generated"] is True
    assert by_row[3]["serial_generated"] is True
    assert by_row[4]["serial_generated"] is False

    assets = (await db.scalars(select(Asset))).all()
    serials = {a.serial_number for a in assets}
    generated = {s for s in serials if GEN.fullmatch(s)}
    assert len(generated) == 2 and "sn-1" in serials
    names = {a.serial_number: a.name for a in assets}
    assert names[by_row[2]["serial_number"]] == "web-01"
    blank_name = names[by_row[3]["serial_number"]]
    assert blank_name == by_row[3]["serial_number"]


async def _roster(db, ini, *specs):
    """specs: (serial, name) -> assets on the move's roster."""
    from serversherpa.db.models import InitiativeAsset
    assets = []
    for serial, name in specs:
        a = Asset(serial_number=serial, name=name)
        db.add(a)
        await db.flush()
        db.add(InitiativeAsset(initiative_id=ini.id, asset_id=a.id))
        assets.append(a)
    await db.commit()
    return assets


async def test_reuse_by_name_takes_the_roster_assets_gnrtd_serial(db):
    ini = await _move(db)
    await _roster(db, ini, ("gnrtd-111111", "web-01"))
    rows = _rows(("", "Web-01"))
    await assign_generated_serials(db, rows, initiative_id=ini.id)
    r = rows[0]
    assert r["serial_number"] == "gnrtd-111111"
    assert r["serial_generated"] is False
    assert ("Serial gnrtd-111111 reused from the existing asset with the "
            "same name") in r["notes"]


async def test_reupload_updates_the_existing_asset_instead_of_duplicating(db):
    ini = await _move(db)
    await _roster(db, ini, ("gnrtd-111111", "web-01"))
    rows = _rows(("", "Web-01"))
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"]["created"] == 0
    assert result["summary"]["updated"] == 1
    assert result["details"][0]["serial_number"] == "gnrtd-111111"
    assert result["details"][0]["serial_generated"] is False
    named = (await db.scalars(select(Asset).where(Asset.name == "web-01"))).all()
    assert len(named) == 1


async def test_two_roster_assets_with_the_name_draw_fresh(db):
    ini = await _move(db)
    await _roster(db, ini, ("gnrtd-111111", "web-01"),
                  ("gnrtd-222222", "web-01"))
    rows = _rows(("", "web-01"))
    await assign_generated_serials(db, rows, initiative_id=ini.id)
    assert GEN.fullmatch(rows[0]["serial_number"])
    assert rows[0]["serial_number"] not in ("gnrtd-111111", "gnrtd-222222")
    assert rows[0]["serial_generated"] is True


async def test_two_file_rows_with_the_name_both_draw_fresh(db):
    ini = await _move(db)
    await _roster(db, ini, ("gnrtd-111111", "web-01"))
    rows = _rows(("", "web-01"), ("", "Web-01"))
    await assign_generated_serials(db, rows, initiative_id=ini.id)
    got = [r["serial_number"] for r in rows]
    assert all(GEN.fullmatch(s) and s != "gnrtd-111111" for s in got)
    assert got[0] != got[1]
    assert all(r["serial_generated"] is True for r in rows)


async def test_a_non_gnrtd_roster_serial_is_not_reused(db):
    ini = await _move(db)
    await _roster(db, ini, ("sn-9", "web-01"))
    rows = _rows(("", "web-01"))
    await assign_generated_serials(db, rows, initiative_id=ini.id)
    assert GEN.fullmatch(rows[0]["serial_number"])
    assert rows[0]["serial_generated"] is True


async def test_no_initiative_id_means_no_reuse(db):
    ini = await _move(db)
    await _roster(db, ini, ("gnrtd-111111", "web-01"))
    rows = _rows(("", "web-01"))
    await assign_generated_serials(db, rows)
    assert rows[0]["serial_number"] != "gnrtd-111111"
    assert GEN.fullmatch(rows[0]["serial_number"])
    assert rows[0]["serial_generated"] is True


async def test_reuse_skips_a_serial_another_row_already_carries(db):
    ini = await _move(db)
    await _roster(db, ini, ("gnrtd-111111", "web-01"))
    rows = _rows(("GNRTD-111111", "other"), ("", "web-01"))
    await assign_generated_serials(db, rows, initiative_id=ini.id)
    assert rows[1]["serial_number"] != "gnrtd-111111"
    assert rows[1]["serial_generated"] is True
