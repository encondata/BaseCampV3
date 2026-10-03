"""Self-service password reset. Raw tokens are 32 random bytes
(token_urlsafe) that live only in the email; the DB keeps their SHA-256.
A token is valid when it exists, is unused, unexpired, its account is
still active, and the password hasn't changed since it was issued. The
request side never reveals whether an account exists — callers answer
the same way whatever happens here."""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.config import get_settings
from serversherpa.db.models import PasswordResetToken, UserAccount
from serversherpa.mail import email_enabled, enqueue
from serversherpa.notifications import reset_requests
from serversherpa.services import totp as totp_service
from serversherpa.services.audit import audit
from serversherpa.services.password_policy import apply_password
from serversherpa.services.sessions import revoke_all_sessions

TOKEN_BYTES = 32


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _portal(path: str) -> str:
    return f"{get_settings().portal_origin.rstrip('/')}{path}"


def _active(account: UserAccount | None) -> bool:
    return (account is not None and account.disabled_at is None
            and account.person.archived_at is None)


async def _account_by(db: AsyncSession, **where) -> UserAccount | None:
    query = select(UserAccount).options(selectinload(UserAccount.person))
    for key, value in where.items():
        query = query.where(getattr(UserAccount, key) == value)
    return await db.scalar(query)


async def _retire_unused(db: AsyncSession, person_id: uuid.UUID, now: datetime) -> None:
    await db.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.person_id == person_id,
               PasswordResetToken.used_at.is_(None))
        .values(used_at=now))


async def request_reset(db: AsyncSession, email: str, *, ip: str | None) -> None:
    account = await _account_by(db, email=email.strip())
    if not _active(account):
        return
    now = datetime.now(UTC)
    if email_enabled():
        settings = get_settings()
        await _retire_unused(db, account.person_id, now)
        raw = secrets.token_urlsafe(TOKEN_BYTES)
        db.add(PasswordResetToken(
            person_id=account.person_id, token_hash=hash_token(raw), created_at=now,
            expires_at=now + timedelta(minutes=settings.password_reset_ttl_minutes),
            requested_ip=ip))
        await enqueue(db, "password_reset", account.email, person_id=account.person_id,
                      name=account.person.first_name,
                      link=_portal(f"/reset-password#token={raw}"),
                      ttl_minutes=settings.password_reset_ttl_minutes)
        via = "email"
    else:
        await reset_requests.open_or_bump(db, account.person)
        via = "admin"
    audit(db, actor_id=None, entity_type="auth", entity_id=account.email,
          action="password.reset_requested", changes={"via": via}, ip=ip)
    await db.commit()


async def find_valid(db: AsyncSession, raw: str
                     ) -> tuple[PasswordResetToken, UserAccount] | None:
    token = await db.scalar(
        select(PasswordResetToken)
        .where(PasswordResetToken.token_hash == hash_token(raw))
        .with_for_update())
    now = datetime.now(UTC)
    if token is None or token.used_at is not None or token.expires_at <= now:
        return None
    account = await _account_by(db, person_id=token.person_id)
    if not _active(account):
        return None
    if account.password_updated_at is not None and account.password_updated_at > token.created_at:
        return None
    return token, account


async def complete(db: AsyncSession, token: PasswordResetToken, account: UserAccount,
                   new_password: str, *, ip: str | None) -> None:
    """Apply the reset. Does not commit. The caller must run
    `require_password_length` and `raise_if_reused` first (the confirm
    route does)."""
    now = datetime.now(UTC)
    await apply_password(db, account, new_password, must_change=False, now=now)
    await _retire_unused(db, account.person_id, now)
    token.used_at = now
    account.failed_login_count = 0
    account.locked_until = None
    await revoke_all_sessions(db, account.person_id, "password_change")
    await totp_service.revoke_trust(db, account.person_id)
    person = account.person
    await reset_requests.resolve(db, account.person_id,
                                 f"{person.first_name} {person.last_name}")
    audit(db, actor_id=account.person_id, entity_type="user_account",
          entity_id=str(account.person_id), action="password.reset_self", ip=ip)
    await enqueue(db, "password_changed", account.email, person_id=account.person_id,
                  name=person.first_name, login_url=_portal("/login"))
