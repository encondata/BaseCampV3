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
