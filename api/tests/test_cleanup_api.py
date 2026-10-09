"""Data cleanup (Dev -> Database -> Cleanup): the category registry, the
sign-in leftovers group, and the /devtools/cleanup preview + run routes."""

import uuid
from datetime import UTC, datetime, timedelta
from itertools import pairwise

import pytest
from sqlalchemy import select, text

from serversherpa.db.models import (
    AuditLog,
    AuthSession,
    PasswordResetToken,
    PermissionOverride,
    Person,
    PersonRole,
    TrustedDevice,
)
from tests.test_assets_api import make_login
from tests.test_devtools import login as devtools_login
from tests.test_devtools import set_role

NOW = datetime.now(UTC)
HOUR = timedelta(hours=1)


async def _developer(db, client, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    return await devtools_login(client)


def _session(person_id, *, expires=None, family=None, **kw):
    return AuthSession(
        person_id=person_id, family_id=family or uuid.uuid4(),
        token_hash=uuid.uuid4().hex,
        expires_at=expires if expires is not None else NOW + HOUR, **kw)


async def _session_state(db, *ids):
    """{id: replaced_by} for the given auth_sessions rows that still exist
    (the developer's own login session is left out of the picture)."""
    rows = (await db.execute(
        select(AuthSession.id, AuthSession.replaced_by)
        .where(AuthSession.id.in_(ids)))).all()
    return {r.id: r.replaced_by for r in rows}


async def _run(client, hdrs, group, categories, age=None):
    body = {"group": group, "categories": categories}
    if age is not None:
        body["older_than_days"] = age
    return await client.post("/devtools/cleanup/run", headers=hdrs, json=body)


def _by_key(items):
    return {i["key"]: i for i in items}


# -- preview ----------------------------------------------------------


async def test_preview_lists_the_three_groups_in_order(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get("/devtools/cleanup/preview", headers=hdrs)
    assert resp.status_code == 200, resp.text
    groups = resp.json()["groups"]
    assert [g["key"] for g in groups] == ["signin", "history", "deleted"]
    assert [g["needs_age"] for g in groups] == [False, True, True]
    signin = groups[0]
    assert signin["label"] == "Sign-in leftovers"
    assert [(c["key"], c["label"]) for c in signin["categories"]] == [
        ("sessions", "Expired sessions"),
        ("reset_links", "Used or expired password-reset links"),
        ("trusted_browsers", "Expired or revoked trusted browsers"),
    ]
    for g in groups:
        assert g["description"]
        for c in g["categories"]:
            assert c["description"]
            assert c["rows"] == 0 and c["files"] == 0


async def test_preview_age_is_validated(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    for bad in (0, 3651, -5):
        resp = await client.get(
            f"/devtools/cleanup/preview?older_than_days={bad}", headers=hdrs)
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "invalid_age"


# -- sessions ---------------------------------------------------------


async def test_sessions_only_expired_go_rotated_and_revoked_stay(
        client, db, seeded_user):
    pid = seeded_user.id
    expired = _session(pid, expires=NOW - HOUR)
    live = _session(pid)
    db.add_all([expired, live])
    await db.flush()
    rotated = _session(pid, rotated_at=NOW - HOUR, replaced_by=live.id)
    revoked = _session(pid, revoked_at=NOW - HOUR, revoke_reason="logout")
    db.add_all([rotated, revoked])
    await db.commit()
    ids = (expired.id, live.id, rotated.id, revoked.id)

    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["sessions"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["categories"][0]["rows_deleted"] == 1

    state = await _session_state(db, *ids)
    assert set(state) == {live.id, rotated.id, revoked.id}
    assert state[rotated.id] == live.id            # untouched: still needed


async def test_an_expired_session_a_kept_one_points_at_is_kept(
        client, db, seeded_user):
    """auth_sessions_rotation_pair_check forbids clearing a rotated row's
    replaced_by, so the expired target stays rather than reviving the spent
    token that points at it."""
    pid = seeded_user.id
    target = _session(pid, expires=NOW - HOUR)
    db.add(target)
    await db.flush()
    pointer = _session(pid, rotated_at=NOW - 2 * HOUR, replaced_by=target.id)
    db.add(pointer)
    await db.commit()
    ids = (target.id, pointer.id)

    hdrs = await _developer(db, client, seeded_user)
    preview = (await client.get("/devtools/cleanup/preview", headers=hdrs)).json()
    assert _by_key(preview["groups"][0]["categories"])["sessions"]["rows"] == 0
    resp = await _run(client, hdrs, "signin", ["sessions"])
    assert resp.json()["categories"][0]["rows_deleted"] == 0
    assert await _session_state(db, *ids) == {target.id: None, pointer.id: target.id}


async def test_sessions_chunking_deletes_everything_even_in_a_chain(
        client, db, seeded_user, monkeypatch):
    monkeypatch.setattr("serversherpa.devtools.cleanup.CHUNK_SIZE", 2)
    pid = seeded_user.id
    # five expired rows chained oldest -> newest through replaced_by, so a
    # chunk is likely to delete a row another (later) chunk's row points at
    chain = [_session(pid, expires=NOW - HOUR) for _ in range(5)]
    db.add_all(chain)
    await db.flush()
    for older, newer in pairwise(chain):
        older.rotated_at, older.replaced_by = NOW - 2 * HOUR, newer.id
    live = _session(pid)
    db.add(live)
    await db.commit()
    ids = [s.id for s in chain] + [live.id]

    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["sessions"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["categories"][0]["rows_deleted"] == 5
    assert set(await _session_state(db, *ids)) == {live.id}


# -- reset links and trusted browsers ---------------------------------


async def test_reset_links_used_and_expired_go_fresh_stays(client, db, seeded_user):
    pid = seeded_user.id

    def token(**kw):
        return PasswordResetToken(
            person_id=pid, token_hash=uuid.uuid4().hex,
            expires_at=kw.pop("expires_at", NOW + HOUR), **kw)

    used, expired, fresh = token(used_at=NOW - HOUR), token(expires_at=NOW - HOUR), token()
    db.add_all([used, expired, fresh])
    await db.commit()
    fresh_id = fresh.id

    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["reset_links"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["categories"][0]["rows_deleted"] == 2
    db.expire_all()
    left = (await db.execute(select(PasswordResetToken.id))).scalars().all()
    assert left == [fresh_id]


async def test_trusted_browsers_revoked_and_expired_go_live_stays(
        client, db, seeded_user):
    pid = seeded_user.id

    def device(**kw):
        return TrustedDevice(
            person_id=pid, token_hash=uuid.uuid4().hex,
            expires_at=kw.pop("expires_at", NOW + HOUR), **kw)

    revoked, expired, live = device(revoked_at=NOW - HOUR), device(expires_at=NOW - HOUR), device()
    db.add_all([revoked, expired, live])
    await db.commit()
    live_id = live.id

    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["trusted_browsers"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["categories"][0]["rows_deleted"] == 2
    db.expire_all()
    left = (await db.execute(select(TrustedDevice.id))).scalars().all()
    assert left == [live_id]


async def test_only_the_selected_categories_run(client, db, seeded_user):
    pid = seeded_user.id
    old = _session(pid, expires=NOW - HOUR)
    db.add_all([old, PasswordResetToken(person_id=pid, token_hash="x",
                                        expires_at=NOW - HOUR)])
    await db.commit()
    old_id = old.id
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["reset_links"])
    assert [c["key"] for c in resp.json()["categories"]] == ["reset_links"]
    assert set(await _session_state(db, old_id)) == {old_id}   # sessions untouched


# -- preview vs run, audit ---------------------------------------------


async def test_preview_counts_equal_what_the_run_deletes(client, db, seeded_user):
    pid = seeded_user.id
    db.add_all([
        _session(pid, expires=NOW - HOUR), _session(pid, expires=NOW - 2 * HOUR),
        _session(pid),
        PasswordResetToken(person_id=pid, token_hash="a", expires_at=NOW - HOUR),
        PasswordResetToken(person_id=pid, token_hash="b", expires_at=NOW + HOUR,
                           used_at=NOW),
        PasswordResetToken(person_id=pid, token_hash="c", expires_at=NOW + HOUR),
        TrustedDevice(person_id=pid, token_hash="d", expires_at=NOW + HOUR,
                      revoked_at=NOW),
    ])
    await db.commit()
    hdrs = await _developer(db, client, seeded_user)

    preview = (await client.get("/devtools/cleanup/preview", headers=hdrs)).json()
    signin = _by_key(preview["groups"][0]["categories"])
    assert (signin["sessions"]["rows"], signin["reset_links"]["rows"],
            signin["trusted_browsers"]["rows"]) == (2, 2, 1)

    resp = await _run(client, hdrs, "signin",
                      ["sessions", "reset_links", "trusted_browsers"])
    ran = _by_key(resp.json()["categories"])
    for key in signin:
        assert ran[key]["rows_deleted"] == signin[key]["rows"]
        assert ran[key]["files_deleted"] == 0

    after = (await client.get("/devtools/cleanup/preview", headers=hdrs)).json()
    assert all(c["rows"] == 0 for c in after["groups"][0]["categories"])


async def test_run_writes_one_audit_row(client, db, seeded_user):
    db.add(_session(seeded_user.id, expires=NOW - HOUR))
    await db.commit()
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["sessions", "reset_links"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["group"] == "signin"
    assert resp.json()["older_than_days"] is None

    rows = (await db.execute(
        select(AuditLog).where(AuditLog.action == "cleanup.run"))).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.entity_type == "system"
    assert row.actor_person_id == seeded_user.id
    assert row.changes["group"] == "signin"
    assert row.changes["older_than_days"] is None
    assert row.changes["categories"]["sessions"] == {
        "rows_deleted": 1, "files_deleted": 0, "files_kept": 0, "files_failed": 0}
    assert row.changes["categories"]["reset_links"]["rows_deleted"] == 0


# -- validation --------------------------------------------------------


async def test_unknown_group_or_category_is_422(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    for group, cats in (("nope", ["sessions"]), ("signin", ["nope"]),
                        ("signin", ["sessions", "mail"])):
        resp = await _run(client, hdrs, group, cats, age=90)
        assert resp.status_code == 422, (group, cats)
        assert resp.json()["detail"]["code"] == "unknown_category"


async def test_age_is_required_and_bounded_for_aged_groups(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    for group in ("history", "deleted"):
        for age in (None, 0, 3651, -1):
            resp = await client.post(
                "/devtools/cleanup/run", headers=hdrs,
                json={"group": group, "categories": ["x"],
                      **({} if age is None else {"older_than_days": age})})
            assert resp.status_code == 422
            # an unknown category and a bad age are both 422; age is checked
            # first because the group is known
            assert resp.json()["detail"]["code"] == "invalid_age"


async def test_signin_ignores_a_supplied_age(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["sessions"], age=99999)
    assert resp.status_code == 200, resp.text
    assert resp.json()["older_than_days"] is None


# -- permissions -------------------------------------------------------


async def test_non_developers_get_403_on_every_route(client, db, seeded_user):
    staff = Person(first_name="St", last_name="Aff")
    db.add(staff)
    await db.flush()
    db.add(PersonRole(person_id=staff.id, role="staff"))
    await db.commit()
    hdrs = await make_login(db, client, staff, "staff-cleanup@test.example.com")
    assert (await client.get("/devtools/cleanup/preview", headers=hdrs)).status_code == 403
    assert (await _run(client, hdrs, "signin", ["sessions"])).status_code == 403


async def test_view_only_developer_can_preview_but_not_run(client, db, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    db.add(PermissionOverride(person_id=seeded_user.id, resource="devtools",
                              action="change", allow=False))
    await db.commit()
    hdrs = await devtools_login(client)
    assert (await client.get("/devtools/cleanup/preview", headers=hdrs)).status_code == 200
    assert (await _run(client, hdrs, "signin", ["sessions"])).status_code == 403
    audits = (await db.execute(
        select(AuditLog).where(AuditLog.action == "cleanup.run"))).all()
    assert audits == []


async def test_unauthenticated_is_401(client):
    assert (await client.get("/devtools/cleanup/preview")).status_code == 401


async def test_empty_category_list_is_unknown_category(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", [])
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "unknown_category"}


async def test_preview_with_a_non_integer_age_is_422(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get("/devtools/cleanup/preview?older_than_days=abc", headers=hdrs)
    assert resp.status_code == 422


def test_registry_shape():
    from serversherpa.devtools import cleanup

    assert list(cleanup.GROUPS) == ["signin", "history", "deleted"]
    assert cleanup.GROUPS["signin"].needs_age is False
    assert cleanup.GROUPS["history"].needs_age is True
    assert cleanup.GROUPS["deleted"].needs_age is True
    assert cleanup.CHUNK_SIZE == 5000
    for group in cleanup.GROUPS.values():
        assert group.label and group.description
        for category in group.categories:
            assert category.label and category.description


# -- framework: storage deletes happen after commit; failures are counted --


async def test_delete_objects_counts_deleted_and_failed(monkeypatch):
    from serversherpa.devtools import cleanup

    gone = []

    async def fake_delete(key):
        if key == "bad":
            raise RuntimeError("storage down")
        gone.append(key)

    monkeypatch.setattr("serversherpa.devtools.cleanup.storage.delete_object", fake_delete)
    result = cleanup.CategoryResult("x")
    await cleanup.delete_objects(["a", "bad", "b"], result)
    assert gone == ["a", "b"]
    assert (result.files_deleted, result.files_failed) == (2, 1)


async def test_chunk_keys_are_deleted_only_after_the_rows_commit(
        db, seeded_user, monkeypatch):
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.devtools import cleanup

    monkeypatch.setattr("serversherpa.devtools.cleanup.CHUNK_SIZE", 2)
    db.add_all([PasswordResetToken(person_id=seeded_user.id, token_hash=f"t{i}",
                                   expires_at=NOW - HOUR) for i in range(3)])
    await db.commit()

    seen_rows_at_delete = []

    async def fake_delete(key):
        seen_rows_at_delete.append(
            await db.scalar(text("SELECT count(*) FROM password_reset_tokens")))
        if key == "k1":
            raise RuntimeError("storage down")

    monkeypatch.setattr("serversherpa.devtools.cleanup.storage.delete_object", fake_delete)

    async def keys(_session, ids, _result):
        return [f"k{len(ids)}"]          # chunk of 2 -> "k2", chunk of 1 -> "k1"

    result = cleanup.CategoryResult("reset_links")
    await cleanup.purge_in_chunks(
        get_sessionmaker(), PasswordResetToken, cleanup._spent_reset_links(),
        result, before=keys)
    assert result.rows_deleted == 3
    assert (result.files_deleted, result.files_failed) == (1, 1)
    assert seen_rows_at_delete == [1, 0]      # each delete saw its chunk already gone


async def test_duplicate_and_generator_keys_are_deleted_once(db, seeded_user, monkeypatch):
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.devtools import cleanup

    db.add(PasswordResetToken(person_id=seeded_user.id, token_hash="t",
                              expires_at=NOW - HOUR))
    await db.commit()
    gone = []

    async def fake_delete(key):
        gone.append(key)

    monkeypatch.setattr("serversherpa.devtools.cleanup.storage.delete_object", fake_delete)

    async def keys(_session, _ids, _result):
        return (k for k in ["a", "b", "a"])          # a generator with a duplicate

    result = cleanup.CategoryResult("reset_links")
    await cleanup.purge_in_chunks(
        get_sessionmaker(), PasswordResetToken, cleanup._spent_reset_links(),
        result, before=keys)
    assert gone == ["a", "b"]
    assert result.files_deleted == 2


async def test_a_full_chunk_whose_rows_vanished_moves_on_instead_of_looping(
        db, seeded_user, monkeypatch):
    from sqlalchemy import delete

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.devtools import cleanup

    monkeypatch.setattr("serversherpa.devtools.cleanup.CHUNK_SIZE", 2)
    db.add_all([PasswordResetToken(person_id=seeded_user.id, token_hash=f"t{i}",
                                   expires_at=NOW - HOUR) for i in range(3)])
    await db.commit()

    async def steal(session, ids, _result):
        # the rows vanish before the chunk's own delete runs
        await session.execute(delete(PasswordResetToken)
                              .where(PasswordResetToken.id.in_(ids)))
        return ()

    result = cleanup.CategoryResult("reset_links")
    stolen = []

    async def steal_once(session, ids, _result):
        if not stolen:
            stolen.append(ids)
            await steal(session, ids, _result)
        return ()

    # the first chunk's rows are gone, so its delete removes nothing; that is
    # not "no progress" (they no longer match), the next chunk is picked up
    await cleanup.purge_in_chunks(
        get_sessionmaker(), PasswordResetToken, cleanup._spent_reset_links(),
        result, before=steal_once)
    assert result.rows_deleted == 1


# -- a run that fails partway still audits what it removed -----------------


async def _audit_rows(db):
    db.expire_all()
    return (await db.execute(
        select(AuditLog).where(AuditLog.action == "cleanup.run"))).scalars().all()


async def test_failure_in_a_later_chunk_keeps_earlier_chunks_and_audits_them(
        client, db, seeded_user, monkeypatch):
    from serversherpa.devtools import cleanup

    monkeypatch.setattr("serversherpa.devtools.cleanup.CHUNK_SIZE", 2)
    pid = seeded_user.id
    expired = [_session(pid, expires=NOW - HOUR) for _ in range(5)]
    db.add_all(expired)
    await db.commit()
    ids = [x.id for x in expired]

    real = cleanup._release_replaced_by
    calls = []

    async def flaky(session, chunk_ids, result):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("disk on fire\nsecond line")
        return await real(session, chunk_ids, result)

    monkeypatch.setattr("serversherpa.devtools.cleanup._release_replaced_by", flaky)
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["sessions"])
    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert detail["code"] == "cleanup_failed"
    assert detail["categories"][0]["rows_deleted"] == 2

    assert len(await _session_state(db, *ids)) == 3          # first chunk stays deleted
    (row,) = await _audit_rows(db)
    assert row.changes["group"] == "signin"
    assert row.changes["error"] == "RuntimeError: disk on fire"
    assert row.changes["categories"]["sessions"]["rows_deleted"] == 2


async def test_failure_in_a_later_category_audits_the_finished_ones(
        client, db, seeded_user, monkeypatch):
    from dataclasses import replace

    from serversherpa.devtools import cleanup

    pid = seeded_user.id
    old = _session(pid, expires=NOW - HOUR)
    db.add(old)
    await db.commit()
    old_id = old.id

    async def boom(_maker, _cutoff):
        raise ValueError("nope")

    group = cleanup.GROUPS["signin"]
    broken = replace(group, categories=tuple(
        replace(c, purge=boom) if c.key == "reset_links" else c
        for c in group.categories))
    monkeypatch.setitem(cleanup.GROUPS, "signin", broken)

    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["sessions", "reset_links"])
    assert resp.status_code == 500
    assert resp.json()["detail"]["code"] == "cleanup_failed"
    assert await _session_state(db, old_id) == {}             # sessions finished first

    (row,) = await _audit_rows(db)
    assert row.changes["error"] == "ValueError: nope"
    assert list(row.changes["categories"]) == ["sessions"]
    assert row.changes["categories"]["sessions"]["rows_deleted"] == 1


# -- DB Testing sessions -----------------------------------------------


@pytest.mark.parametrize("status", ["snapshotting", "active", "reverting"])
async def test_run_is_refused_while_a_db_testing_session_is_unfinished(
        client, db, seeded_user, status):
    # a revert restores rows, not stored files, so a purge made during the
    # session could never be brought back
    from serversherpa.db.models import DbTestingSession

    reset = PasswordResetToken(
        person_id=seeded_user.id, token_hash=uuid.uuid4().hex, expires_at=NOW - HOUR)
    db.add_all([reset, DbTestingSession(
        status=status, row_counts={}, audit_watermark=NOW, started_by=seeded_user.id)])
    await db.commit()
    reset_id = reset.id
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["reset_links"])
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "testing_session_active"
    db.expire_all()
    assert await db.get(PasswordResetToken, reset_id) is not None
    audits = (await db.scalars(select(AuditLog).where(AuditLog.action == "cleanup.run"))).all()
    assert audits == []
    # looking is still fine
    assert (await client.get("/devtools/cleanup/preview", headers=hdrs)).status_code == 200


async def test_run_is_allowed_once_the_db_testing_session_has_ended(
        client, db, seeded_user):
    from serversherpa.db.models import DbTestingSession

    db.add(DbTestingSession(
        status="ended", ended_with="kept", row_counts={}, audit_watermark=NOW,
        started_by=seeded_user.id))
    await db.commit()
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "signin", ["reset_links"])
    assert resp.status_code == 200, resp.text
