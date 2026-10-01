"""Sign-in, 2FA and sessions — the portal's flow (serversherpa/services/
auth.py + totp.py) with Sirdar's extra refusals. Sessions have an ABSOLUTE
lifetime: every refresh rotation inherits the original deadline."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import AccessInfo, resolve_access
from sirdar_api.config import Settings, get_settings
from sirdar_api.db.models import AuthSession, TotpBackupCode, User
from sirdar_api.security.passwords import DUMMY_HASH, verify_password
from sirdar_api.security.tokens import (
    TokenError, create_access_token, create_challenge_token, decode_challenge_token,
    generate_refresh_token, hash_refresh_token,
)
from sirdar_api.security.totp import (
    BACKUP_CODE_LENGTH, TotpSeedError, compact_code, decrypt_secret, is_app_code,
    match_counter, normalize_backup,
)
from sirdar_api.services.audit import audit


class AuthError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass
class AuthResult:
    access_token: str
    refresh_token: str
    session_expires_at: datetime
    user: User
    access: AccessInfo
    session_id: uuid.UUID


@dataclass
class LoginChallenge:
    user: User
    challenge_token: str
    backup_codes_remaining: int


def _strike(user: User, now: datetime, settings: Settings) -> None:
    """A wrong password or code: N strikes -> temporary lockout."""
    user.failed_login_count += 1
    user.updated_at = now
    if user.failed_login_count >= settings.max_failed_logins:
        user.locked_until = now + timedelta(seconds=settings.lockout_seconds)
        user.failed_login_count = 0


async def _refuse(db: AsyncSession, user: User, code: str, ip: str | None) -> AuthError:
    audit(db, actor_id=user.person_id, entity_type="auth", entity_id=str(user.person_id),
          action="login_failed", changes={"reason": code}, ip=ip)
    await db.commit()
    return AuthError(code)


async def backup_codes_remaining(db: AsyncSession, person_id: uuid.UUID) -> int:
    return await db.scalar(select(func.count(TotpBackupCode.id)).where(
        TotpBackupCode.person_id == person_id, TotpBackupCode.used_at.is_(None))) or 0


async def login(db: AsyncSession, *, email: str, password: str, ip: str | None = None,
                user_agent: str | None = None) -> AuthResult | LoginChallenge:
    settings = get_settings()
    pepper = settings.password_pepper.get_secret_value()
    now = datetime.now(UTC)

    user = await db.scalar(select(User).where(User.email == email))
    if user is None or user.password_hash is None:
        verify_password(DUMMY_HASH, password, pepper=pepper)   # same time as a real check
        audit(db, actor_id=None, entity_type="auth", entity_id=email,
              action="login_failed", ip=ip)
        await db.commit()
        raise AuthError("invalid_credentials")

    if not verify_password(user.password_hash, password, pepper=pepper):
        _strike(user, now, settings)
        audit(db, actor_id=None, entity_type="auth", entity_id=email,
              action="login_failed", ip=ip)
        await db.commit()
        raise AuthError("invalid_credentials")

    # Password is correct from here on — only now is it safe to reveal
    # account status (otherwise an email list could be sorted into
    # disabled / locked / other without knowing any password).
    if user.disabled_at is not None:
        raise await _refuse(db, user, "account_disabled", ip)
    if user.locked_until is not None and user.locked_until > now:
        raise await _refuse(db, user, "account_locked", ip)
    if user.source == "portal" and (
            user.must_change_password
            or (user.password_expires_at is not None and user.password_expires_at <= now)):
        raise await _refuse(db, user, "password_change_required", ip)
    if user.totp_required and user.totp_confirmed_at is None:
        raise await _refuse(db, user, "totp_enrollment_required", ip)

    if (user.totp_enabled and user.totp_confirmed_at is not None
            and user.totp_secret_enc is not None):
        audit(db, actor_id=user.person_id, entity_type="auth",
              entity_id=str(user.person_id), action="login_challenged", ip=ip)
        await db.commit()
        return LoginChallenge(
            user=user,
            challenge_token=create_challenge_token(
                person_id=user.person_id, secret=settings.jwt_secret.get_secret_value()),
            backup_codes_remaining=await backup_codes_remaining(db, user.person_id))

    return await start_session(db, user, ip=ip, user_agent=user_agent)


async def verify_totp(db: AsyncSession, *, challenge_token: str, code: str,
                      ip: str | None = None, user_agent: str | None = None) -> AuthResult:
    settings = get_settings()
    try:
        person_id = decode_challenge_token(
            challenge_token, secret=settings.jwt_secret.get_secret_value())
    except TokenError:
        raise AuthError("invalid_challenge") from None

    # row lock: two concurrent verifies can't both accept the same code
    user = await db.scalar(select(User).where(User.person_id == person_id)
                           .with_for_update().execution_options(populate_existing=True))
    now = datetime.now(UTC)
    if user is None or user.disabled_at is not None:
        raise AuthError("invalid_challenge")
    if user.locked_until is not None and user.locked_until > now:
        raise AuthError("account_locked")
    if user.totp_confirmed_at is None or user.totp_secret_enc is None:
        raise AuthError("invalid_challenge")

    compact = compact_code(code)
    if is_app_code(compact):
        try:
            seed = decrypt_secret(user.totp_secret_enc,
                                  key=settings.totp_encryption_key.get_secret_value())
        except TotpSeedError:
            raise AuthError("totp_seed_unreadable") from None
        counter = match_counter(seed, compact, user.totp_last_counter)
        if counter is not None:
            user.totp_last_counter = counter
            return await start_session(db, user, ip=ip, user_agent=user_agent)
    else:
        wanted = normalize_backup(code)
        if len(wanted) == BACKUP_CODE_LENGTH:
            pepper = settings.password_pepper.get_secret_value()
            rows = list(await db.scalars(select(TotpBackupCode).where(
                TotpBackupCode.person_id == user.person_id, TotpBackupCode.used_at.is_(None))))
            for row in rows:
                if verify_password(row.code_hash, wanted, pepper=pepper):
                    # conditional: a concurrent request may have used it first
                    result = await db.execute(update(TotpBackupCode).where(
                        TotpBackupCode.id == row.id, TotpBackupCode.used_at.is_(None),
                    ).values(used_at=now))
                    if result.rowcount == 0:
                        continue
                    audit(db, actor_id=user.person_id, entity_type="user",
                          entity_id=str(user.person_id), action="totp.backup_used", ip=ip)
                    return await start_session(db, user, ip=ip, user_agent=user_agent)

    _strike(user, now, settings)
    audit(db, actor_id=None, entity_type="user", entity_id=str(user.person_id),
          action="totp.verify_failed", ip=ip)
    await db.commit()
    raise AuthError("totp_invalid")


async def start_session(db: AsyncSession, user: User, *, ip: str | None,
                        user_agent: str | None) -> AuthResult:
    """Reset lockout state, stamp last login, open a session family. Commits."""
    settings = get_settings()
    now = datetime.now(UTC)
    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = now
    user.last_login_ip = ip
    user.updated_at = now

    refresh_token = generate_refresh_token()
    session_id = uuid.uuid4()
    session = AuthSession(id=session_id, person_id=user.person_id, family_id=session_id,
                          token_hash=hash_refresh_token(refresh_token),
                          expires_at=now + timedelta(seconds=settings.session_ttl_seconds),
                          ip_address=ip, user_agent=user_agent)
    db.add(session)
    audit(db, actor_id=user.person_id, entity_type="auth", entity_id=str(user.person_id),
          action="login", ip=ip)
    await db.commit()

    access = await resolve_access(db, user.person_id)
    return AuthResult(
        access_token=create_access_token(
            person_id=user.person_id, session_id=session_id,
            secret=settings.jwt_secret.get_secret_value(),
            ttl_seconds=settings.access_token_ttl_seconds),
        refresh_token=refresh_token, session_expires_at=session.expires_at,
        user=user, access=access, session_id=session_id)


async def _revoke_family(db: AsyncSession, family_id: uuid.UUID, *, reason: str) -> None:
    await db.execute(update(AuthSession)
                     .where(AuthSession.family_id == family_id, AuthSession.revoked_at.is_(None))
                     .values(revoked_at=datetime.now(UTC), revoke_reason=reason))


async def refresh(db: AsyncSession, *, refresh_token: str, ip: str | None = None,
                  user_agent: str | None = None) -> AuthResult:
    settings = get_settings()
    now = datetime.now(UTC)
    session = await db.scalar(select(AuthSession)
                              .where(AuthSession.token_hash == hash_refresh_token(refresh_token))
                              .with_for_update())
    if session is None or session.revoked_at is not None:
        raise AuthError("invalid_session")
    if session.rotated_at is not None:
        # a rotated token presented again = replay of a stolen token
        await _revoke_family(db, session.family_id, reason="reuse_detected")
        audit(db, actor_id=session.person_id, entity_type="auth",
              entity_id=str(session.person_id), action="token_replay_detected", ip=ip)
        await db.commit()
        raise AuthError("session_reuse_detected")
    if session.expires_at <= now:
        raise AuthError("session_expired")

    user = await db.get(User, session.person_id)
    if user is None or user.disabled_at is not None:
        raise AuthError("account_disabled")

    new_token = generate_refresh_token()
    new_id = uuid.uuid4()
    db.add(AuthSession(id=new_id, person_id=session.person_id, family_id=session.family_id,
                       token_hash=hash_refresh_token(new_token),
                       expires_at=session.expires_at,   # absolute deadline, never extended
                       ip_address=ip, user_agent=user_agent))
    await db.flush()   # the successor must exist before the old row points at it
    session.rotated_at = now
    session.replaced_by = new_id
    await db.commit()

    access = await resolve_access(db, user.person_id)
    return AuthResult(
        access_token=create_access_token(
            person_id=user.person_id, session_id=new_id,
            secret=settings.jwt_secret.get_secret_value(),
            ttl_seconds=settings.access_token_ttl_seconds),
        refresh_token=new_token, session_expires_at=session.expires_at,
        user=user, access=access, session_id=new_id)


async def logout(db: AsyncSession, *, refresh_token: str) -> None:
    """Revoke the whole login (family). Unknown tokens are a silent no-op."""
    session = await db.scalar(select(AuthSession)
                              .where(AuthSession.token_hash == hash_refresh_token(refresh_token)))
    if session is not None:
        await _revoke_family(db, session.family_id, reason="logout")
        audit(db, actor_id=session.person_id, entity_type="auth",
              entity_id=str(session.person_id), action="logout")
        await db.commit()


async def revoke_sessions(db: AsyncSession, person_id: uuid.UUID, *, reason: str) -> int:
    """Revoke every live session family of a person. Returns the number of
    families revoked. Does not commit."""
    families = set(await db.scalars(select(AuthSession.family_id).where(
        AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None),
        AuthSession.rotated_at.is_(None))))
    await db.execute(update(AuthSession)
                     .where(AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None))
                     .values(revoked_at=datetime.now(UTC), revoke_reason=reason))
    return len(families)
