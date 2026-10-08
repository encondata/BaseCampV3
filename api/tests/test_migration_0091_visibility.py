"""Migration 0091: notes/attachments visibility + backfill that keeps
today's effective access (non-physical hosts → internal, avatars stay
everyone)."""

import importlib.util
import uuid
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

MIGRATION_PATH = (Path(__file__).resolve().parents[1] / "migrations" / "versions"
                  / "0091_note_file_visibility.py")


def _load():
    spec = importlib.util.spec_from_file_location("_migration_0091_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _note(db, entity_type):
    return await db.scalar(text(
        "INSERT INTO notes (entity_type, entity_id, body) VALUES (:t, :i, 'x') RETURNING id"),
        {"t": entity_type, "i": uuid.uuid4()})


async def _att(db, entity_type, kind):
    return await db.scalar(text(
        "INSERT INTO attachments (entity_type, entity_id, kind, storage_key, filename, "
        "content_type, size_bytes) VALUES (:t, :i, :k, :sk, 'f', 'text/plain', 1) RETURNING id"),
        {"t": entity_type, "i": uuid.uuid4(), "k": kind, "sk": f"k-{uuid.uuid4()}"})


async def test_columns_default_everyone_and_are_checked(db):
    nid = await _note(db, "asset")
    assert await db.scalar(text("SELECT visibility FROM notes WHERE id=:i"), {"i": nid}) == "everyone"
    with pytest.raises(DBAPIError):
        await db.execute(text("UPDATE notes SET visibility='secret' WHERE id=:i"), {"i": nid})
    await db.rollback()
    aid = await _att(db, "asset", "photo")
    with pytest.raises(DBAPIError):
        await db.execute(text("UPDATE attachments SET visibility='nope' WHERE id=:i"), {"i": aid})
    await db.rollback()


async def test_backfill_keeps_todays_access(db):
    m = _load()
    notes = {t: await _note(db, t) for t in
             ("asset", "container", "truck", "site", "initiative", "person", "client", "partner")}
    atts = {
        "asset_photo": await _att(db, "asset", "photo"),
        "site_doc": await _att(db, "site", "document"),
        "initiative_doc": await _att(db, "initiative", "document"),
        "person_doc": await _att(db, "person", "document"),
        "person_avatar": await _att(db, "person", "avatar"),
        "client_logo": await _att(db, "client", "avatar"),
        "partner_doc": await _att(db, "partner", "document"),
        "report_def": await _att(db, "report_definition", "survey_template"),
    }
    await db.commit()
    await db.run_sync(lambda s: m.backfill_visibility(s.connection()))
    await db.commit()

    async def nv(i):
        return await db.scalar(text("SELECT visibility FROM notes WHERE id=:i"), {"i": i})

    async def av(i):
        return await db.scalar(text("SELECT visibility FROM attachments WHERE id=:i"), {"i": i})

    for t in ("asset", "container", "truck", "site"):
        assert await nv(notes[t]) == "everyone"
    for t in ("initiative", "person", "client", "partner"):
        assert await nv(notes[t]) == "internal"
    assert await av(atts["asset_photo"]) == "everyone"
    assert await av(atts["site_doc"]) == "everyone"
    assert await av(atts["initiative_doc"]) == "internal"
    assert await av(atts["person_doc"]) == "internal"
    assert await av(atts["partner_doc"]) == "internal"
    assert await av(atts["person_avatar"]) == "everyone"
    assert await av(atts["client_logo"]) == "everyone"
    assert await av(atts["report_def"]) == "everyone"
