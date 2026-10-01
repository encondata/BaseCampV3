"""Local-user TOTP enrollment and backup-code regeneration (the portal's
flow, minus trusted devices). Backup codes are 10 characters from the
portal's alphabet, shown as xxxxx-xxxxx and stored hashed like passwords."""

import secrets
import uuid
from datetime import UTC, datetime

import pyotp
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import get_settings
from sirdar_api.db.models import TotpBackupCode, User
from sirdar_api.security.passwords import hash_password
from sirdar_api.security.totp import (
    BACKUP_CODE_LENGTH, TotpSeedError, compact_code, decrypt_secret, encrypt_secret,
    is_app_code, match_counter,
)
from sirdar_api.services.audit import audit
from sirdar_api.services.auth import AuthError, _strike

BACKUP_CODE_COUNT = 8
BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
ISSUER = "Sirdar"


def _key() -> str:
    return get_settings().totp_encryption_key.get_secret_value()


def is_enrolled(user: User) -> bool:
    return bool(user.totp_enabled and user.totp_confirmed_at and user.totp_secret_enc)


def start_enrollment(user: User) -> dict:
    """Store a fresh unconfirmed seed. Does not commit."""
    if is_enrolled(user):
        raise AuthError("totp_already_enrolled")
    secret = pyotp.random_base32()
    user.totp_secret_enc = encrypt_secret(secret, key=_key())
    user.totp_confirmed_at = None
    user.totp_last_counter = None
    user.totp_enabled = False
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name=ISSUER)
    return {"secret": secret, "otpauth_uri": uri}


async def _replace_backup_codes(db: AsyncSession, user: User) -> list[str]:
    pepper = get_settings().password_pepper.get_secret_value()
    await db.execute(delete(TotpBackupCode).where(TotpBackupCode.person_id == user.person_id))
    shown = []
    for _ in range(BACKUP_CODE_COUNT):
        raw = "".join(secrets.choice(BACKUP_ALPHABET) for _ in range(BACKUP_CODE_LENGTH))
        db.add(TotpBackupCode(person_id=user.person_id, code_hash=hash_password(raw, pepper=pepper)))
        shown.append(f"{raw[:5]}-{raw[5:]}")
    return shown


async def _locked_user(db: AsyncSession, person_id: uuid.UUID) -> User:
    from sqlalchemy import select
    return await db.scalar(select(User).where(User.person_id == person_id)
                           .with_for_update().execution_options(populate_existing=True))


async def confirm_enrollment(db: AsyncSession, person_id: uuid.UUID, code: str,
                             ip: str | None) -> list[str]:
    user = await _locked_user(db, person_id)
    if user.totp_secret_enc is None or user.totp_confirmed_at is not None:
        await db.rollback()
        raise AuthError("totp_not_started")
    try:
        seed = decrypt_secret(user.totp_secret_enc, key=_key())
    except TotpSeedError:
        await db.rollback()
        raise AuthError("totp_seed_unreadable") from None
    compact = compact_code(code)
    counter = match_counter(seed, compact, None) if is_app_code(compact) else None
    if counter is None:
        await db.rollback()
        raise AuthError("totp_invalid")
    now = datetime.now(UTC)
    user.totp_confirmed_at = now
    user.totp_last_counter = counter
    user.totp_enabled = True
    user.updated_at = now
    codes = await _replace_backup_codes(db, user)
    audit(db, actor_id=user.person_id, entity_type="user", entity_id=str(user.person_id),
          action="totp.enroll", ip=ip)
    await db.commit()
    return codes


async def regenerate_backup_codes(db: AsyncSession, person_id: uuid.UUID, code: str,
                                  ip: str | None) -> list[str]:
    settings = get_settings()
    user = await _locked_user(db, person_id)
    now = datetime.now(UTC)
    if user.locked_until is not None and user.locked_until > now:
        await db.rollback()
        raise AuthError("account_locked")
    if not is_enrolled(user):
        await db.rollback()
        raise AuthError("totp_not_enrolled")
    try:
        seed = decrypt_secret(user.totp_secret_enc, key=_key())
    except TotpSeedError:
        await db.rollback()
        raise AuthError("totp_seed_unreadable") from None
    compact = compact_code(code)
    counter = match_counter(seed, compact, user.totp_last_counter) if is_app_code(compact) else None
    if counter is None:
        _strike(user, now, settings)
        audit(db, actor_id=user.person_id, entity_type="user", entity_id=str(user.person_id),
              action="totp.verify_failed", ip=ip)
        await db.commit()
        raise AuthError("totp_invalid")
    user.totp_last_counter = counter
    codes = await _replace_backup_codes(db, user)
    audit(db, actor_id=user.person_id, entity_type="user", entity_id=str(user.person_id),
          action="totp.backup_codes_regenerated", ip=ip)
    await db.commit()
    return codes
