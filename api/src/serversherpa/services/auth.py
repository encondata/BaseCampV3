"""Authentication service: login, refresh rotation with reuse detection,
logout. Sessions have an ABSOLUTE lifetime: every rotation inherits the
original login's deadline (SS_SESSION_TTL_SECONDS from login time).
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from serversherpa.access.resolver import AccessInfo, resolve_access
from serversherpa.config import get_settings
from serversherpa.db.models import AuthSession, Person, UserAccount
from serversherpa.security.passwords import DUMMY_HASH, verify_password
from serversherpa.security.tokens import (
    create_access_token,
    generate_refresh_token,
    hash_refresh_token,
)
from serversherpa.services.audit import audit


class AuthError(Exception):
    """Auth failure with a stable machine-readable code."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass
class AuthResult:
    access_token: str
    refresh_token: str
    session_expires_at: datetime
    person: Person
    account: UserAccount
    roles: list[str]
    access: AccessInfo


@dataclass
class LoginChallenge:
    """Password accepted; a second factor is owed before any session exists."""

    purpose: str                        # "verify" | "enroll"
    account: UserAccount
    backup_codes_remaining: int | None


async def _load_account(db: AsyncSession, email: str) -> UserAccount | None:
    return await db.scalar(
        select(UserAccount)
        .options(joinedload(UserAccount.person))
        .where(UserAccount.email == email)
    )


def _check_account_usable(account: UserAccount) -> None:
    if account.disabled_at is not None or account.person.archived_at is not None:
        raise AuthError("account_disabled")


async def login(
    db: AsyncSession, *, email: str, password: str,
    ip: str | None = None, user_agent: str | None = None,
    client: str = "portal", trust_token: str | None = None,
) -> AuthResult | LoginChallenge:
    settings = get_settings()
    pepper = settings.password_pepper.get_secret_value()
    now = datetime.now(UTC)

    account = await _load_account(db, email)
    if account is None or account.password_hash is None:
        # burn the same time as a real verification (no enumeration oracle)
        verify_password(DUMMY_HASH, password, pepper=pepper)
        audit(db, actor_id=None, entity_type="auth", entity_id=email,
              action="login_failed", ip=ip)
        await db.commit()
        raise AuthError("invalid_credentials")

    if not verify_password(account.password_hash, password, pepper=pepper):
        account.failed_login_count += 1
        account.updated_at = now
        if account.failed_login_count >= settings.max_failed_logins:
            account.locked_until = now + timedelta(seconds=settings.lockout_seconds)
            account.failed_login_count = 0
        audit(db, actor_id=None, entity_type="auth", entity_id=email,
              action="login_failed", ip=ip)
        await db.commit()
        raise AuthError("invalid_credentials")

    # Password is correct from here on — safe to reveal account-specific
    # status codes. Checking disabled/locked before verify_password would
    # let an attacker sort an email list into real-disabled/real-locked/
    # other without ever knowing the password (an enumeration oracle), so
    # these checks stay gated behind a successful verification: only the
    # account's own owner, who has the right password, learns its status.
    _check_account_usable(account)

    if account.locked_until is not None and account.locked_until > now:
        audit(db, actor_id=None, entity_type="auth", entity_id=email,
              action="login_failed", ip=ip)
        await db.commit()
        raise AuthError("account_locked")

    if client == "portal":
        # kiosk password logins and phone pairing are never challenged
        from serversherpa.services import totp as totp_service

        policy = await totp_service.policy_for(db, account)
        if policy.enabled:
            if account.totp_confirmed_at is not None:
                if not await totp_service.check_trust(db, account, trust_token):
                    return LoginChallenge(
                        purpose="verify", account=account,
                        backup_codes_remaining=await totp_service.backup_codes_remaining(
                            db, account.person_id))
            elif policy.required:
                return LoginChallenge(purpose="enroll", account=account,
                                      backup_codes_remaining=None)

    access: AccessInfo | None = None
    if client == "kiosk":
        access = await resolve_access(db, account.person_id)
        if not access.can("kiosk", "view"):
            # right password, wrong place: audited, but never a lockout strike
            audit(db, actor_id=account.person_id, entity_type="auth",
                  entity_id=email, action="login_failed",
                  changes={"reason": "kiosk_not_allowed"}, ip=ip)
            await db.commit()
            raise AuthError("kiosk_not_allowed")

    return await start_session(db, account, ip=ip, user_agent=user_agent,
                               access=access)


async def start_session(
    db: AsyncSession, account: UserAccount, *,
    ip: str | None, user_agent: str | None,
    audit_action: str = "login", access: AccessInfo | None = None,
) -> AuthResult:
    """Mint a session for an account whose holder has just proven who they
    are — a password login, or a kiosk pairing they approved on their
    phone (audit_action="login_pair"). Resets lockout state, stamps the
    last-login telemetry, audits, commits. `account.person` must be
    loaded (see _load_account)."""
    settings = get_settings()
    now = datetime.now(UTC)
    account.failed_login_count = 0
    account.locked_until = None
    account.last_login_at = now
    account.last_login_ip = ip
    account.updated_at = now

    refresh_token = generate_refresh_token()
    session_id = uuid.uuid4()
    session = AuthSession(
        id=session_id,
        person_id=account.person_id,
        family_id=session_id,  # first session identifies the family
        token_hash=hash_refresh_token(refresh_token),
        expires_at=now + timedelta(seconds=settings.session_ttl_seconds),
        ip_address=ip,
        user_agent=user_agent,
    )
    db.add(session)
    audit(db, actor_id=account.person_id, entity_type="auth",
          entity_id=str(account.person_id), action=audit_action, ip=ip)
    await db.commit()

    if access is None:
        access = await resolve_access(db, account.person_id)
    return AuthResult(
        access_token=create_access_token(
            person_id=account.person_id, session_id=session_id,
            secret=settings.jwt_secret.get_secret_value(),
            ttl_seconds=settings.access_token_ttl_seconds,
        ),
        refresh_token=refresh_token,
        session_expires_at=session.expires_at,
        person=account.person,
        account=account,
        roles=access.role_names,
        access=access,
    )


async def revoke_family(
    db: AsyncSession, family_id: uuid.UUID, *, reason: str
) -> None:
    await db.execute(
        update(AuthSession)
        .where(AuthSession.family_id == family_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC), revoke_reason=reason)
    )


async def refresh(
    db: AsyncSession, *, refresh_token: str,
    ip: str | None = None, user_agent: str | None = None,
) -> AuthResult:
    settings = get_settings()
    now = datetime.now(UTC)

    # row-lock: two concurrent refreshes of the same token can't both rotate
    session = await db.scalar(
        select(AuthSession)
        .where(AuthSession.token_hash == hash_refresh_token(refresh_token))
        .with_for_update()
    )
    if session is None:
        raise AuthError("invalid_session")

    if session.revoked_at is not None:
        raise AuthError("invalid_session")

    if session.rotated_at is not None:
        # a rotated token presented again = replay of a stolen token.
        # Kill the entire family, including the currently-live successor.
        await revoke_family(db, session.family_id, reason="reuse_detected")
        audit(db, actor_id=session.person_id, entity_type="auth",
              entity_id=str(session.person_id), action="token_replay_detected",
              ip=ip)
        await db.commit()
        raise AuthError("session_reuse_detected")

    if session.expires_at <= now:
        raise AuthError("session_expired")

    account = await db.scalar(
        select(UserAccount)
        .options(joinedload(UserAccount.person))
        .where(UserAccount.person_id == session.person_id)
    )
    assert account is not None  # FK guarantees
    _check_account_usable(account)

    new_token = generate_refresh_token()
    new_id = uuid.uuid4()
    db.add(AuthSession(
        id=new_id,
        person_id=session.person_id,
        family_id=session.family_id,
        token_hash=hash_refresh_token(new_token),
        expires_at=session.expires_at,  # ABSOLUTE deadline inherited, never extended
        ip_address=ip,
        user_agent=user_agent,
    ))
    # successor row must hit the DB before the old row can point at it
    await db.flush()
    session.rotated_at = now
    session.replaced_by = new_id
    await db.commit()

    access = await resolve_access(db, account.person_id)
    return AuthResult(
        access_token=create_access_token(
            person_id=account.person_id, session_id=new_id,
            secret=settings.jwt_secret.get_secret_value(),
            ttl_seconds=settings.access_token_ttl_seconds,
        ),
        refresh_token=new_token,
        session_expires_at=session.expires_at,
        person=account.person,
        account=account,
        roles=access.role_names,
        access=access,
    )


async def logout(db: AsyncSession, *, refresh_token: str) -> None:
    """Revoke the whole login (family). Unknown tokens are a silent no-op —
    logout must never fail."""
    session = await db.scalar(
        select(AuthSession)
        .where(AuthSession.token_hash == hash_refresh_token(refresh_token))
    )
    if session is not None:
        await revoke_family(db, session.family_id, reason="logout")
        audit(db, actor_id=session.person_id, entity_type="auth",
              entity_id=str(session.person_id), action="logout")
        await db.commit()
