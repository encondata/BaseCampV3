"""Shared worker-edit helpers (api/worker_edits.py) and attachments'
replace_avatar: the logic the portal's worker routes and the kiosk Rolodex
both run. None of them commit — the caller owns the transaction."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from serversherpa.access.resolver import resolve_access
from serversherpa.api.deps import AuthContext
from serversherpa.api.routes.attachments import replace_avatar
from serversherpa.api.worker_edits import (
    apply_person_update,
    apply_profile_update,
    target_rank,
)
from serversherpa.config import get_settings
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Attachment,
    AuditLog,
    AuthSession,
    Person,
    PersonRole,
    UserAccount,
    WorkerProfile,
)
from serversherpa.security.passwords import hash_password

PW = "CorrectHorse9!"


async def _person(db, first, last, *, roles=("worker",), email=None,
                  account=False, job_title=None, avatar_key=None):
    person = Person(first_name=first, last_name=last, email=email,
                    job_title=job_title, avatar_key=avatar_key)
    db.add(person)
    await db.flush()
    if account:
        db.add(UserAccount(
            person_id=person.id, email=email,
            password_hash=hash_password(
                PW, pepper=get_settings().password_pepper.get_secret_value())))
    for role in roles:
        db.add(PersonRole(person_id=person.id, role=role))
    await db.commit()
    return person


async def _actor(db, role="admin") -> AuthContext:
    person = await _person(db, "Ada", role.title(), roles=(role,))
    access = await resolve_access(db, person.id)
    return AuthContext(person=person, account=None, roles=access.role_names,
                       session=None, access=access)


async def _audit_rows(db, entity_type, entity_id):
    return (await db.scalars(
        select(AuditLog).where(AuditLog.entity_type == entity_type,
                               AuditLog.entity_id == str(entity_id)))).all()


async def test_target_rank_is_the_highest_live_role(db):
    nobody = await _person(db, "No", "Roles", roles=())
    worker = await _person(db, "Wan", "Worker")
    admin_worker = await _person(db, "Ann", "Admin", roles=("worker", "admin"))
    revoked = await _person(db, "Rev", "Oked", roles=("worker",))
    db.add(PersonRole(person_id=revoked.id, role="super_admin",
                      revoked_at=datetime.now(UTC)))
    await db.commit()

    assert await target_rank(db, nobody.id) == 0
    assert await target_rank(db, worker.id) == 10
    assert await target_rank(db, admin_worker.id) == 60
    assert await target_rank(db, revoked.id) == 10


async def test_apply_person_update_changes_and_audits(db):
    actor = await _actor(db)
    worker = await _person(db, "Wan", "Worker", job_title="Mover")

    changes = await apply_person_update(
        db, actor, worker, {"job_title": "Rigger"},
        audit_extra={"via": "kiosk_rolodex"})
    await db.commit()

    assert changes == {"job_title": {"from": "Mover", "to": "Rigger"}}
    assert worker.updated_at is not None
    rows = await _audit_rows(db, "person", worker.id)
    assert len(rows) == 1
    assert rows[0].action == "update"
    assert rows[0].actor_person_id == actor.person.id
    assert rows[0].changes["job_title"] == {"from": "Mover", "to": "Rigger"}
    assert rows[0].changes["via"] == "kiosk_rolodex"


async def test_apply_person_update_without_a_change_writes_no_audit(db):
    actor = await _actor(db)
    worker = await _person(db, "Wan", "Worker", job_title="Mover")

    changes = await apply_person_update(
        db, actor, worker, {"job_title": "Mover"},
        audit_extra={"via": "kiosk_rolodex"})
    await db.commit()

    assert changes == {}
    assert await _audit_rows(db, "person", worker.id) == []


async def test_apply_person_update_null_name_is_required(db):
    actor = await _actor(db)
    worker = await _person(db, "Wan", "Worker")

    for field in ("first_name", "last_name", "country"):
        with pytest.raises(HTTPException) as exc:
            await apply_person_update(db, actor, worker, {field: None})
        assert exc.value.status_code == 422
        assert exc.value.detail == {"code": f"{field}_required"}


async def test_apply_person_update_refuses_untouchable_account(db):
    actor = await _actor(db, "admin")
    peer = await _person(db, "Pat", "Peer", roles=("worker", "admin"),
                         email="pat@test.example.com", account=True)

    with pytest.raises(HTTPException) as exc:
        await apply_person_update(db, actor, peer, {"job_title": "Rigger"})
    assert exc.value.status_code == 403
    assert exc.value.detail == {"code": "rank_too_low"}

    # the same rank without a login is editable, and so is yourself
    no_login = await _person(db, "Nol", "Ogin", roles=("worker", "admin"))
    assert await apply_person_update(db, actor, no_login, {"job_title": "Rigger"})
    assert await apply_person_update(db, actor, actor.person, {"job_title": "Lead"})


async def test_apply_profile_update_blacklist_needs_note(db):
    actor = await _actor(db)
    worker = await _person(db, "Wan", "Worker")

    with pytest.raises(HTTPException) as exc:
        await apply_profile_update(db, actor, worker.id, {"status": "blacklist"})
    assert exc.value.status_code == 422
    assert exc.value.detail == {"code": "blacklist_requires_note"}


async def test_apply_profile_update_validation_codes(db):
    actor = await _actor(db)
    worker = await _person(db, "Wan", "Worker")

    cases = [
        ({"status": None}, 422, "status_required"),
        ({"level": "L9"}, 422, "unknown_level"),
        ({"partner_id": uuid.uuid4()}, 422, "partner_not_found"),
        ({"status": "on_vacation"}, 422, "unknown_status"),
    ]
    for data, status, code in cases:
        with pytest.raises(HTTPException) as exc:
            await apply_profile_update(db, actor, worker.id, data)
        assert (exc.value.status_code, exc.value.detail) == (status, {"code": code})

    # a status change on a peer is refused by rank, with or without a login
    peer = await _person(db, "Pat", "Peer", roles=("worker", "admin"))
    with pytest.raises(HTTPException) as exc:
        await apply_profile_update(db, actor, peer.id, {"status": "standby"})
    assert (exc.value.status_code, exc.value.detail) == (403, {"code": "rank_too_low"})

    # the rank check runs first, so only the top rank reaches the self check
    developer = await _actor(db, "developer")
    db.add(PersonRole(person_id=developer.person.id, role="worker"))
    await db.commit()
    with pytest.raises(HTTPException) as exc:
        await apply_profile_update(db, developer, developer.person.id, {"status": "standby"})
    assert (exc.value.status_code, exc.value.detail) == (403, {"code": "cannot_target_self"})


async def test_apply_profile_update_blacklist_disables_login(db):
    actor = await _actor(db)
    worker = await _person(db, "Wan", "Worker", email="wan@test.example.com",
                           account=True)
    session = AuthSession(person_id=worker.id, family_id=uuid.uuid4(),
                          token_hash=f"hash-{uuid.uuid4()}",
                          expires_at=datetime.now(UTC) + timedelta(hours=1))
    db.add(session)
    await db.commit()

    changes = await apply_profile_update(
        db, actor, worker.id,
        {"status": "blacklist", "status_note": "No-show twice"},
        audit_extra={"via": "kiosk_rolodex", "device": "SN-123"})
    await db.commit()

    assert changes["status"] == {"from": "active", "to": "blacklist"}
    account = await db.get(UserAccount, worker.id)
    await db.refresh(account)
    assert account.disabled_at is not None
    await db.refresh(session)
    assert session.revoked_at is not None
    assert session.revoke_reason == "account_disabled"
    rows = await _audit_rows(db, "worker", worker.id)
    assert [r.action for r in rows] == ["profile.update"]
    assert rows[0].changes["status"] == {"from": "active", "to": "blacklist"}
    assert rows[0].changes["via"] == "kiosk_rolodex"
    assert rows[0].changes["device"] == "SN-123"


async def test_nothing_committed(db):
    actor = await _actor(db)
    worker = await _person(db, "Wan", "Worker", job_title="Mover",
                           avatar_key="attachments/person/old.jpg")
    db.add(Attachment(entity_type="person", entity_id=worker.id, kind="avatar",
                      storage_key="attachments/person/old.jpg",
                      filename="old.jpg", content_type="image/jpeg",
                      size_bytes=10, uploaded_by=actor.person.id))
    await db.commit()

    await apply_person_update(db, actor, worker, {"job_title": "Rigger"},
                              audit_extra={"via": "kiosk_rolodex"})
    await apply_profile_update(db, actor, worker.id, {"trade": "Rigging"},
                               audit_extra={"via": "kiosk_rolodex"})
    await replace_avatar(db, entity_type="person", entity=worker,
                         key="attachments/person/new.jpg",
                         filename="kiosk-photo.jpg", content_type="image/jpeg",
                         size=20, actor_id=actor.person.id,
                         now=datetime.now(UTC))
    worker_id = worker.id         # rollback expires the instance
    await db.rollback()

    async with get_sessionmaker()() as fresh:
        person = await fresh.get(Person, worker_id)
        assert person.job_title == "Mover"
        assert person.avatar_key == "attachments/person/old.jpg"
        assert await fresh.get(WorkerProfile, worker_id) is None
        live = (await fresh.scalars(select(Attachment.storage_key).where(
            Attachment.entity_id == worker_id,
            Attachment.deleted_at.is_(None)))).all()
        assert live == ["attachments/person/old.jpg"]
        assert (await fresh.scalars(select(AuditLog))).all() == []


async def test_replace_avatar_retires_old_row(db):
    actor = await _actor(db)
    worker = await _person(db, "Wan", "Worker",
                           avatar_key="attachments/person/old.jpg")
    old = Attachment(entity_type="person", entity_id=worker.id, kind="avatar",
                     storage_key="attachments/person/old.jpg",
                     filename="old.jpg", content_type="image/jpeg",
                     size_bytes=10, uploaded_by=actor.person.id)
    photo = Attachment(entity_type="person", entity_id=worker.id, kind="photo",
                       storage_key="attachments/person/site.jpg",
                       filename="site.jpg", content_type="image/jpeg",
                       size_bytes=10, uploaded_by=actor.person.id)
    db.add_all([old, photo])
    await db.commit()

    now = datetime.now(UTC)
    new_key = f"attachments/person/{worker.id}/avatar/{uuid.uuid4()}.jpg"
    att = await replace_avatar(
        db, entity_type="person", entity=worker, key=new_key,
        filename="kiosk-photo.jpg", content_type="image/jpeg", size=2048,
        actor_id=actor.person.id, now=now,
        audit_extra={"via": "kiosk_rolodex", "device": "SN-123"})
    await db.commit()

    await db.refresh(old)
    await db.refresh(photo)
    await db.refresh(worker)
    assert old.deleted_at == now
    assert photo.deleted_at is None          # only avatars are retired
    assert worker.avatar_key == new_key
    assert worker.updated_at == now
    assert (att.entity_type, att.entity_id, att.kind) == ("person", worker.id, "avatar")
    assert (att.storage_key, att.filename, att.content_type, att.size_bytes) == (
        new_key, "kiosk-photo.jpg", "image/jpeg", 2048)
    assert att.uploaded_by == actor.person.id
    assert att.visibility == "everyone"
    assert att.deleted_at is None
    rows = await _audit_rows(db, "person", worker.id)
    assert [r.action for r in rows] == ["attachment.add"]
    assert rows[0].changes == {
        "filename": {"from": None, "to": "kiosk-photo.jpg"},
        "via": "kiosk_rolodex", "device": "SN-123"}
