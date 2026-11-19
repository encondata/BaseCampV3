"""Migration 0130: matching rules tables, seeded with v1 and the test set."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from serversherpa.matching_rules.seed import TEST_ROWS, V1_FLOWS, reset_matching_seed


async def test_seed_has_live_v1_per_place(db):
    rows = (await db.execute(text(
        "SELECT place, version, state, flow FROM matching_rule_versions ORDER BY place"))).all()
    assert [(p, v, s) for p, v, s, _ in rows] == [("printing", 1, "live"), ("scanning", 1, "live")]
    assert {p: f for p, _, _, f in rows} == V1_FLOWS


async def test_seed_test_set(db):
    assert await db.scalar(text("SELECT count(*) FROM matching_test_assets")) == 8
    assert await db.scalar(text("SELECT count(*) FROM matching_test_rows")) == 18


async def test_every_test_row_is_attached_to_its_asset(db):
    found = {
        (tag, place, value, expected)
        for tag, place, value, expected in (await db.execute(text(
            "SELECT a.asset_tag, r.place, r.value, r.expected FROM matching_test_rows r "
            "JOIN matching_test_assets a ON a.id = r.test_asset_id"))).all()
    }
    want = {(r["asset_tag"], r["place"], r["value"], r["expected"]) for r in TEST_ROWS}
    assert len(TEST_ROWS) == 18
    assert found == want


async def test_second_live_version_is_refused(db):
    with pytest.raises(IntegrityError):
        await db.execute(text(
            "INSERT INTO matching_rule_versions (place, version, state, flow) "
            "VALUES ('printing', 2, 'live', '{}')"))
        await db.flush()
    await db.rollback()


@pytest.mark.parametrize("place,state", [("printing", "deployed"), ("containers", "draft")])
async def test_bad_state_and_place_are_refused(db, place, state):
    with pytest.raises(IntegrityError):
        await db.execute(text(
            "INSERT INTO matching_rule_versions (place, version, state, flow) "
            "VALUES (:p, 9, :s, '{}')"), {"p": place, "s": state})
        await db.flush()
    await db.rollback()


async def test_reset_restores_the_seed(db):
    await db.execute(text("DELETE FROM matching_test_assets"))
    await db.commit()
    await reset_matching_seed(db)
    await db.commit()
    assert await db.scalar(text("SELECT count(*) FROM matching_test_rows")) == 18


def test_downgrade_drops_every_table():
    from importlib.util import module_from_spec, spec_from_file_location
    from pathlib import Path
    from unittest.mock import patch

    path = Path(__file__).resolve().parents[1] / "migrations/versions/0130_matching_rules.py"
    spec = spec_from_file_location("migration_0130", path)
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    with patch.object(mod.op, "drop_table") as drop:
        mod.downgrade()
    assert [c.args[0] for c in drop.call_args_list] == [
        "matching_test_rows", "matching_test_assets", "matching_rule_versions"]
