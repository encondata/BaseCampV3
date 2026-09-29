"""Move passwords: fingerprint/encrypt round trip, the hidden kiosk
identity, uniqueness and length rules, activity rule, session revocation."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import (
    AuditLog, AuthSession, Initiative, Person, PersonRole, UserAccount,
)
from serversherpa.services import auth as auth_service
from serversherpa.services.move_password import (
    MOVE_LOGIN_BLOCKED_STATUSES, MovePasswordError, clear_password, ensure_kiosk_identity,
    find_initiative_by_password, fingerprint, is_move_active, rename_kiosk_identity,
    reveal, revoke_move_sessions, set_password,
)


async def _move(db, name="Las Vegas 3", status="planned"):
    init = Initiative(name=name, initiative_type="move", status=status)
    db.add(init)
    await db.flush()
    return init


async def test_fingerprint_is_stable_and_keyed():
    assert fingerprint("Crew-2026!") == fingerprint("Crew-2026!")
    assert fingerprint("Crew-2026!") != fingerprint("crew-2026!")
    assert len(fingerprint("x")) == 64


async def test_set_reveal_and_clear(db, seeded_user):
    init = await _move(db)
    await set_password(db, init, "Crew-2026!", actor_id=seeded_user.id)
    await db.commit()
    assert reveal(init) == "Crew-2026!"
    assert init.kiosk_password_fp == fingerprint("Crew-2026!")
    assert init.kiosk_person_id is not None
    person = await db.get(Person, init.kiosk_person_id)
    assert (person.first_name, person.last_name, person.source) == ("Kiosk", "Las Vegas 3", "kiosk_move")
    account = await db.get(UserAccount, person.id)
    assert account.password_hash is None and account.email == f"kiosk+{init.id}@kiosk.serversherpa.local"
    roles = list(await db.scalars(select(PersonRole.role).where(
        PersonRole.person_id == person.id, PersonRole.revoked_at.is_(None))))
    assert roles == ["worker"]
    await clear_password(db, init, actor_id=seeded_user.id)
    await db.commit()
    assert reveal(init) is None and init.kiosk_password_fp is None
    assert init.kiosk_person_id == person.id     # the identity is kept for history
    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.entity_id == str(init.id))))
    assert [r.changes["kiosk_password"] for r in rows] == [
        {"from": None, "to": "set"}, {"from": "set", "to": None}]


async def test_rules_length_and_uniqueness(db, seeded_user):
    a = await _move(db, "A")
    b = await _move(db, "B")
    with pytest.raises(MovePasswordError) as exc:
        await set_password(db, a, "short7!", actor_id=seeded_user.id)
    assert exc.value.code == "kiosk_password_too_short"
    await set_password(db, a, "Crew-2026!", actor_id=seeded_user.id)
    await db.flush()
    with pytest.raises(MovePasswordError) as exc:
        await set_password(db, b, "Crew-2026!", actor_id=seeded_user.id)
    assert exc.value.code == "kiosk_password_in_use"
    # re-setting the same password on the same move is fine
    await set_password(db, a, "Crew-2026!", actor_id=seeded_user.id)


async def test_lookup_and_activity(db, seeded_user):
    init = await _move(db)
    await set_password(db, init, "Crew-2026!", actor_id=seeded_user.id)
    await db.commit()
    assert (await find_initiative_by_password(db, "Crew-2026!")).id == init.id
    assert await find_initiative_by_password(db, "nope-nope-nope") is None
    assert is_move_active(init)
    for status in MOVE_LOGIN_BLOCKED_STATUSES:
        init.status = status
        assert not is_move_active(init)
    init.status = "in_progress"
    init.archived_at = datetime.now(UTC)
    assert not is_move_active(init)


async def test_revoke_move_sessions_and_rename(db, seeded_user):
    init = await _move(db)
    await set_password(db, init, "Crew-2026!", actor_id=seeded_user.id)
    account = await ensure_kiosk_identity(db, init)
    await db.commit()
    result = await auth_service.start_session(
        db, account, ip=None, user_agent=None, client="kiosk",
        audit_action="login_move", initiative_id=init.id)
    await db.commit()
    session_id = result.session_id
    row = await db.get(AuthSession, session_id)
    assert row.initiative_id == init.id
    assert await revoke_move_sessions(db, init.id) == 1
    await db.commit()
    db.expire_all()
    row = await db.get(AuthSession, session_id)
    assert row.revoked_at is not None and row.revoke_reason == "admin"
    await db.refresh(init)      # expire_all() above left it unloaded
    init.name = "Las Vegas 3 Cluster Move"
    await rename_kiosk_identity(db, init)
    await db.commit()
    person = await db.get(Person, init.kiosk_person_id)
    assert person.last_name == "Las Vegas 3 Cluster Move"



async def test_kiosk_identity_is_idempotent(db, seeded_user):
    init = await _move(db)
    await set_password(db, init, "Crew-2026!", actor_id=seeded_user.id)
    first = await ensure_kiosk_identity(db, init)
    second = await ensure_kiosk_identity(db, init)
    await set_password(db, init, "Crew-2027!", actor_id=seeded_user.id)
    await db.commit()
    person_id = first.person_id
    assert second.person_id == person_id and init.kiosk_person_id == person_id
    accounts = list(await db.scalars(select(UserAccount).where(UserAccount.person_id == person_id)))
    assert len(accounts) == 1
    roles = list(await db.scalars(select(PersonRole).where(
        PersonRole.person_id == person_id, PersonRole.role == "worker",
        PersonRole.revoked_at.is_(None))))
    assert len(roles) == 1
    people = list(await db.scalars(select(Person).where(
        Person.source == "kiosk_move", Person.source_ref == str(init.id))))
    assert [p.id for p in people] == [person_id]


async def test_kiosk_identity_repairs_missing_account(db, seeded_user):
    init = await _move(db)
    await set_password(db, init, "Crew-2026!", actor_id=seeded_user.id)
    await db.commit()
    init_id, person_id = init.id, init.kiosk_person_id
    await db.delete(await db.get(UserAccount, person_id))
    await db.commit()
    db.expire_all()
    init = await db.get(Initiative, init_id)
    account = await ensure_kiosk_identity(db, init)
    email = account.email
    await db.commit()
    assert account.person_id == person_id and init.kiosk_person_id == person_id
    assert email == f"kiosk+{init_id}@kiosk.serversherpa.local"
    assert await db.scalar(select(func.count()).select_from(Person).where(
        Person.source == "kiosk_move", Person.source_ref == str(init_id))) == 1
    assert await db.scalar(select(func.count()).select_from(PersonRole).where(
        PersonRole.person_id == person_id, PersonRole.role == "worker",
        PersonRole.revoked_at.is_(None))) == 1
