"""Move passwords: an admin-set password that signs a kiosk in for ONE
move. Stored encrypted (admins can reveal it) plus a keyed fingerprint
(unique across moves; the sign-in lookup). The move gets a hidden kiosk
identity — a worker-role person with no portal login — so scans and
punches made under the move password are attributed to "Kiosk · <move>".
Nothing here commits; callers own the transaction.
"""

import hashlib
import hmac
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from serversherpa.config import get_settings
from serversherpa.db.models import AuthSession, Initiative, Person, PersonRole, UserAccount
from serversherpa.security.secretbox import decrypt, encrypt
from serversherpa.services.audit import audit

MOVE_LOGIN_BLOCKED_STATUSES = ("completed", "cancelled", "historical")
MIN_LENGTH = 8
KIOSK_MOVE_SOURCE = "kiosk_move"


class MovePasswordError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def fingerprint(password: str) -> str:
    pepper = get_settings().password_pepper.get_secret_value()
    return hmac.new(pepper.encode(), password.encode(), hashlib.sha256).hexdigest()


def is_move_active(initiative: Initiative) -> bool:
    return initiative.archived_at is None and initiative.status not in MOVE_LOGIN_BLOCKED_STATUSES


def reveal(initiative: Initiative) -> str | None:
    return decrypt(initiative.kiosk_password_enc) if initiative.kiosk_password_enc else None


def _kiosk_email(initiative: Initiative) -> str:
    return f"kiosk+{initiative.id}@kiosk.serversherpa.local"


async def ensure_kiosk_identity(db: AsyncSession, initiative: Initiative) -> UserAccount:
    """The move's hidden worker: created once, kept for history. The returned
    account has `.person` loaded, ready for auth_service.start_session."""
    person: Person | None = None
    if initiative.kiosk_person_id is not None:
        account = await db.get(UserAccount, initiative.kiosk_person_id,
                               options=[joinedload(UserAccount.person)])
        if account is not None:
            return account
        # Repair path: the person exists but its account row went missing.
        # Recreate only the account (and the worker role if absent); never
        # mint a second person for the same move.
        person = await db.get(Person, initiative.kiosk_person_id)
    if person is None:
        person = Person(first_name="Kiosk", last_name=initiative.name, source=KIOSK_MOVE_SOURCE,
                        source_ref=str(initiative.id))
        db.add(person)
        await db.flush()
    # person= keeps account.person loaded: start_session reads it
    account = UserAccount(person_id=person.id, person=person,
                          email=_kiosk_email(initiative), password_hash=None)
    db.add(account)
    has_role = await db.scalar(select(PersonRole.person_id).where(
        PersonRole.person_id == person.id, PersonRole.role == "worker",
        PersonRole.revoked_at.is_(None)))
    if has_role is None:
        db.add(PersonRole(person_id=person.id, role="worker"))
    initiative.kiosk_person_id = person.id
    await db.flush()
    return account


async def rename_kiosk_identity(db: AsyncSession, initiative: Initiative) -> None:
    if initiative.kiosk_person_id is None:
        return
    person = await db.get(Person, initiative.kiosk_person_id)
    if person is not None and person.last_name != initiative.name:
        person.last_name = initiative.name
        person.updated_at = datetime.now(UTC)


async def set_password(db: AsyncSession, initiative: Initiative, password: str, *,
                       actor_id: uuid.UUID) -> None:
    if len(password) < MIN_LENGTH:
        raise MovePasswordError("kiosk_password_too_short")
    fp = fingerprint(password)
    other = await db.scalar(select(Initiative.id).where(
        Initiative.kiosk_password_fp == fp, Initiative.id != initiative.id))
    if other is not None:
        raise MovePasswordError("kiosk_password_in_use")
    was_set = initiative.kiosk_password_fp is not None
    initiative.kiosk_password_enc = encrypt(password)
    initiative.kiosk_password_fp = fp
    initiative.updated_at = datetime.now(UTC)
    await ensure_kiosk_identity(db, initiative)
    audit(db, actor_id=actor_id, entity_type="initiative", entity_id=str(initiative.id),
          action="update", changes={"kiosk_password": {"from": "set" if was_set else None, "to": "set"}})


async def clear_password(db: AsyncSession, initiative: Initiative, *, actor_id: uuid.UUID) -> None:
    if initiative.kiosk_password_fp is None:
        return
    initiative.kiosk_password_enc = None
    initiative.kiosk_password_fp = None
    initiative.updated_at = datetime.now(UTC)
    await revoke_move_sessions(db, initiative.id)
    audit(db, actor_id=actor_id, entity_type="initiative", entity_id=str(initiative.id),
          action="update", changes={"kiosk_password": {"from": "set", "to": None}})


async def find_initiative_by_password(db: AsyncSession, password: str) -> Initiative | None:
    return await db.scalar(select(Initiative).where(Initiative.kiosk_password_fp == fingerprint(password)))


async def revoke_move_sessions(db: AsyncSession, initiative_id: uuid.UUID) -> int:
    result = await db.execute(
        update(AuthSession)
        .where(AuthSession.initiative_id == initiative_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC), revoke_reason="admin"))
    return result.rowcount or 0
