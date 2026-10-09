"""Data cleanup, "Deleted files" group: soft-deleted attachments, notes and
label fonts past the cutoff, with their stored objects."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.models import (
    Attachment,
    AuditLog,
    Client,
    Initiative,
    LabelFont,
    Note,
    Partner,
    Person,
    ReportDefinition,
    ReportRun,
)
from tests.test_cleanup_api import _by_key, _developer, _run
from tests.test_cleanup_history import _idmap, _ids, _key

NOW = datetime.now(UTC)
OLD = NOW - timedelta(days=100)
RECENT = NOW - timedelta(days=5)
AGE = 30


async def _go(client, db, seeded_user, category):
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "deleted", [category], AGE)
    assert resp.status_code == 200, resp.text
    return _by_key(resp.json()["categories"])[category], hdrs


async def _initiative(db):
    ini = Initiative(name=f"ini-{uuid.uuid4().hex[:6]}", initiative_type="move",
                     status="planned")
    db.add(ini)
    await db.flush()
    return ini


def _att(ini, key, *, deleted=OLD, kind="document"):
    return Attachment(entity_type="initiative", entity_id=ini.id, kind=kind,
                      storage_key=key, filename="f.pdf", content_type="x",
                      size_bytes=1, deleted_at=deleted)


def _font(key, *, name=None, deleted=OLD):
    return LabelFont(name=name or f"F{uuid.uuid4().hex[:8]}.TTF", storage_key=key,
                     size_bytes=1, deleted_at=deleted)


# -- registry ----------------------------------------------------------


def test_deleted_group_has_the_three_categories_in_order():
    from serversherpa.devtools import cleanup

    group = cleanup.GROUPS["deleted"]
    assert [(c.key, c.label) for c in group.categories] == [
        ("attachments", "Deleted files"),
        ("notes", "Deleted notes"),
        ("label_fonts", "Deleted label fonts"),
    ]
    assert all(c.description for c in group.categories)


# -- attachments -------------------------------------------------------


async def test_attachments_deleted_before_the_cutoff_go_with_their_object(
        client, db, seeded_user, storage_calls):
    ini = await _initiative(db)
    k_old, k_recent, k_live = _key(), _key(), _key()
    rows = {
        "old": _att(ini, k_old),
        "recent": _att(ini, k_recent, deleted=RECENT),
        "live": _att(ini, k_live, deleted=None),
    }
    db.add_all(rows.values())
    await db.commit()
    ids = _idmap(rows)
    res, _ = await _go(client, db, seeded_user, "attachments")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"],
            res["files_failed"]) == (1, 1, 0, 0)
    assert storage_calls.deleted == [k_old]
    assert await _ids(db, Attachment, *ids.values()) == {ids["recent"], ids["live"]}


async def test_attachments_a_report_run_link_is_cleared_and_the_run_stays(
        client, db, seeded_user, storage_calls):
    ini = await _initiative(db)
    d = ReportDefinition(name=f"d-{uuid.uuid4().hex[:6]}", report_type="x", is_system=False)
    db.add(d)
    await db.flush()
    att_key, run_key = _key(), _key()
    att = _att(ini, att_key)
    db.add(att)
    await db.flush()
    run = ReportRun(definition_id=d.id, report_type="x", initiative_id=ini.id,
                    requested_by=seeded_user.id, status="completed",
                    storage_key=run_key, finished_at=RECENT, attachment_id=att.id)
    db.add(run)
    await db.commit()
    run_id = run.id
    res, _ = await _go(client, db, seeded_user, "attachments")
    assert (res["rows_deleted"], res["files_deleted"]) == (1, 1)
    assert storage_calls.deleted == [att_key]
    db.expire_all()
    kept = await db.get(ReportRun, run_id)
    assert kept is not None and kept.attachment_id is None
    assert kept.storage_key == run_key


async def test_attachments_object_a_report_run_uses_is_kept(
        client, db, seeded_user, storage_calls):
    # the report-run copy of a file: the run's own key is the attachment's key,
    # whether or not the run still links to the attachment
    ini = await _initiative(db)
    d = ReportDefinition(name=f"d-{uuid.uuid4().hex[:6]}", report_type="x", is_system=False)
    db.add(d)
    await db.flush()
    linked, unlinked = _key(), _key()
    att = _att(ini, linked)
    db.add_all([att, _att(ini, unlinked)])
    await db.flush()
    db.add_all([
        ReportRun(definition_id=d.id, report_type="x", initiative_id=ini.id,
                  requested_by=seeded_user.id, status="completed",
                  storage_key=linked, finished_at=RECENT, attachment_id=att.id),
        ReportRun(definition_id=d.id, report_type="x", initiative_id=ini.id,
                  requested_by=seeded_user.id, status="completed",
                  storage_key=unlinked, finished_at=RECENT)])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "attachments")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (2, 0, 2)
    assert storage_calls.deleted == []


async def test_attachments_object_an_avatar_or_logo_still_uses_is_kept(
        client, db, seeded_user, storage_calls):
    ini = await _initiative(db)
    k_avatar, k_client, k_partner, k_free = _key(), _key(), _key(), _key()
    db.add_all([
        Person(first_name="A", last_name="B", avatar_key=k_avatar),
        Client(name=f"c-{uuid.uuid4().hex[:6]}", logo_key=k_client),
        Partner(name=f"p-{uuid.uuid4().hex[:6]}", logo_key=k_partner),
        _att(ini, k_avatar, kind="avatar"), _att(ini, k_client, kind="avatar"),
        _att(ini, k_partner, kind="avatar"), _att(ini, k_free),
    ])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "attachments")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (4, 1, 3)
    assert storage_calls.deleted == [k_free]


async def test_attachments_storage_failure_is_counted_rows_still_go(
        client, db, seeded_user, storage_calls):
    ini = await _initiative(db)
    bad, good = _key(), _key()
    db.add_all([_att(ini, bad), _att(ini, good)])
    await db.commit()
    storage_calls.fail.add(bad)
    res, _ = await _go(client, db, seeded_user, "attachments")
    assert (res["rows_deleted"], res["files_deleted"], res["files_failed"]) == (2, 1, 1)
    assert await db.scalar(select(Attachment.id).limit(1)) is None


# -- notes -------------------------------------------------------------


async def test_notes_deleted_before_the_cutoff_go_the_rest_stay(
        client, db, seeded_user, storage_calls):
    ini = await _initiative(db)
    rows = {n: Note(entity_type="initiative", entity_id=ini.id, body="b", deleted_at=d)
            for n, d in [("old", OLD), ("recent", RECENT), ("live", None)]}
    db.add_all(rows.values())
    await db.commit()
    ids = _idmap(rows)
    res, _ = await _go(client, db, seeded_user, "notes")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (1, 0, 0)
    assert await _ids(db, Note, *ids.values()) == {ids["recent"], ids["live"]}
    assert storage_calls.deleted == []


# -- label fonts -------------------------------------------------------


async def test_label_fonts_deleted_before_the_cutoff_go_with_their_object(
        client, db, seeded_user, storage_calls):
    k_old, k_recent, k_live = _key(), _key(), _key()
    rows = {"old": _font(k_old), "recent": _font(k_recent, deleted=RECENT),
            "live": _font(k_live, deleted=None)}
    db.add_all(rows.values())
    await db.commit()
    ids = _idmap(rows)
    res, _ = await _go(client, db, seeded_user, "label_fonts")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (1, 1, 0)
    assert storage_calls.deleted == [k_old]
    assert await _ids(db, LabelFont, *ids.values()) == {ids["recent"], ids["live"]}


async def test_label_fonts_object_a_live_font_uses_is_kept(
        client, db, seeded_user, storage_calls):
    shared = _key()
    db.add_all([_font(shared), _font(shared, deleted=None)])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "label_fonts")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (1, 0, 1)
    assert storage_calls.deleted == []


async def test_label_fonts_a_live_font_with_the_same_name_does_not_stop_the_purge(
        client, db, seeded_user, storage_calls):
    # a deleted name is free to reuse: the new font has its own object
    name, k_old, k_new = f"R{uuid.uuid4().hex[:8]}.TTF", _key(), _key()
    db.add_all([_font(k_old, name=name), _font(k_new, name=name, deleted=None)])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "label_fonts")
    assert (res["rows_deleted"], res["files_deleted"]) == (1, 1)
    assert storage_calls.deleted == [k_old]


# -- preview and audit -------------------------------------------------


async def test_preview_counts_rows_and_only_files_that_would_go(client, db, seeded_user):
    ini = await _initiative(db)
    d = ReportDefinition(name=f"d-{uuid.uuid4().hex[:6]}", report_type="x", is_system=False)
    db.add(d)
    await db.flush()
    shared, f_shared, f_solo = _key(), _key(), _key()
    db.add_all([
        ReportRun(definition_id=d.id, report_type="x", initiative_id=ini.id,
                  requested_by=seeded_user.id, status="completed",
                  storage_key=shared, finished_at=RECENT),      # keeps `shared`
        _att(ini, shared), _att(ini, _key()),
        _att(ini, _key(), deleted=RECENT),                      # too recent
        Note(entity_type="initiative", entity_id=ini.id, body="b", deleted_at=OLD),
        _font(f_shared), _font(f_shared, deleted=None), _font(f_solo),
    ])
    await db.commit()
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get(
        f"/devtools/cleanup/preview?older_than_days={AGE}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    group = next(g for g in resp.json()["groups"] if g["key"] == "deleted")
    cats = _by_key(group["categories"])
    assert (cats["attachments"]["rows"], cats["attachments"]["files"]) == (2, 1)
    assert (cats["notes"]["rows"], cats["notes"]["files"]) == (1, 0)
    assert (cats["label_fonts"]["rows"], cats["label_fonts"]["files"]) == (2, 1)


async def test_a_deleted_run_writes_one_audit_row(client, db, seeded_user, storage_calls):
    ini = await _initiative(db)
    db.add(_att(ini, _key()))
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "attachments")
    rows = (await db.scalars(
        select(AuditLog).where(AuditLog.action == "cleanup.run"))).all()
    assert len(rows) == 1
    assert rows[0].changes["group"] == "deleted"
    assert rows[0].changes["categories"]["attachments"]["rows_deleted"] == res["rows_deleted"]


async def test_attachments_in_small_chunks_clear_every_link_and_delete_every_file(
        client, db, seeded_user, storage_calls, monkeypatch):
    monkeypatch.setattr("serversherpa.devtools.cleanup.CHUNK_SIZE", 2)
    ini = await _initiative(db)
    d = ReportDefinition(name=f"d-{uuid.uuid4().hex[:6]}", report_type="x", is_system=False)
    db.add(d)
    await db.flush()
    keys = [_key() for _ in range(5)]
    atts = [_att(ini, k) for k in keys]
    db.add_all(atts)
    await db.flush()
    db.add_all([ReportRun(definition_id=d.id, report_type="x", initiative_id=ini.id,
                          requested_by=seeded_user.id, status="completed",
                          storage_key=_key(), finished_at=RECENT, attachment_id=a.id)
                for a in atts])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "attachments")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (5, 5, 0)
    assert sorted(storage_calls.deleted) == sorted(keys)
    assert await db.scalar(
        select(func.count()).select_from(ReportRun).where(
            ReportRun.attachment_id.is_not(None))) == 0
