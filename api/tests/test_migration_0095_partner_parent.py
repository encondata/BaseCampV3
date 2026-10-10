"""Migration 0095: partners.parent_id (self-FK, SET NULL, not-self check,
index)."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError


async def _partner(db, name):
    return await db.scalar(text(
        "INSERT INTO partners (name) VALUES (:n) RETURNING id"), {"n": name})


async def test_column_is_nullable_uuid_fk_with_index(db):
    col = (await db.execute(text(
        "SELECT data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name='partners' AND column_name='parent_id'"))).one()
    assert col == ("uuid", "YES")
    idx = await db.scalar(text(
        "SELECT indexname FROM pg_indexes WHERE tablename='partners' "
        "AND indexname='ix_partners_parent_id'"))
    assert idx == "ix_partners_parent_id"
    pid = await _partner(db, "Parent")
    cid = await _partner(db, "Child")
    await db.execute(text("UPDATE partners SET parent_id=:p WHERE id=:c"),
                     {"p": pid, "c": cid})
    await db.commit()
    assert await db.scalar(text("SELECT parent_id FROM partners WHERE id=:c"),
                           {"c": cid}) == pid


async def test_deleting_the_parent_nulls_the_child(db):
    pid = await _partner(db, "Parent")
    cid = await _partner(db, "Child")
    await db.execute(text("UPDATE partners SET parent_id=:p WHERE id=:c"),
                     {"p": pid, "c": cid})
    await db.commit()
    await db.execute(text("DELETE FROM partners WHERE id=:p"), {"p": pid})
    await db.commit()
    assert await db.scalar(text("SELECT parent_id FROM partners WHERE id=:c"),
                           {"c": cid}) is None


async def test_a_partner_cannot_be_its_own_parent(db):
    pid = await _partner(db, "Solo")
    await db.commit()
    with pytest.raises(DBAPIError):
        await db.execute(text("UPDATE partners SET parent_id=id WHERE id=:i"),
                         {"i": pid})
    await db.rollback()


async def test_unknown_parent_is_rejected(db):
    pid = await _partner(db, "Orphan")
    await db.commit()
    with pytest.raises(DBAPIError):
        await db.execute(text("UPDATE partners SET parent_id=:x WHERE id=:i"),
                         {"x": uuid.uuid4(), "i": pid})
    await db.rollback()


def test_downgrade_drops_everything_upgrade_adds():
    """Upgrade creates the column, index and check; downgrade drops each."""
    from importlib.util import module_from_spec, spec_from_file_location
    from pathlib import Path
    from unittest.mock import patch

    path = (Path(__file__).resolve().parents[1]
            / "migrations/versions/0095_partner_parent.py")
    spec = spec_from_file_location("migration_0095", path)
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    with patch.object(mod.op, "add_column") as add_col, \
            patch.object(mod.op, "drop_column") as drop_col, \
            patch.object(mod.op, "create_index") as create_idx, \
            patch.object(mod.op, "drop_index") as drop_idx, \
            patch.object(mod.op, "create_check_constraint") as create_ck, \
            patch.object(mod.op, "drop_constraint") as drop_ck:
        mod.upgrade()
        mod.downgrade()
    assert add_col.call_args.args[0] == "partners"
    assert add_col.call_args.args[1].name == "parent_id"
    assert drop_col.call_args.args[:2] == ("partners", "parent_id")
    assert create_idx.call_args.args[0] == "ix_partners_parent_id"
    assert drop_idx.call_args.args[0] == "ix_partners_parent_id"
    assert create_ck.call_args.args[0] == "ck_partners_parent_not_self"
    assert drop_ck.call_args.args[:2] == ("ck_partners_parent_not_self", "partners")
    assert drop_ck.call_args.kwargs["type_"] == "check"
