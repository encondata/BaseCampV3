"""Two-factor authentication (TOTP) service.

Owns everything about the second factor: the seed encrypted at rest
(Fernet, SS_TOTP_ENCRYPTION_KEY), code verification with a replay guard,
one-time backup codes (Argon2 hashes), trusted browsers (the ss_trust
cookie's token stored as SHA-256), the policy resolver, and the short-lived
challenge token the portal carries between the password step and the code
step. Routes never touch a secret directly.
"""

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

import jwt
import pyotp
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup,
    AccessGroupMember,
    PersonRole,
    Role,
    TotpBackupCode,
    TrustedDevice,
    UserAccount,
)
from serversherpa.security.passwords import hash_password, verify_password
from serversherpa.security.tokens import ISSUER as JWT_ISSUER
from serversherpa.security.tokens import TokenError
from serversherpa.services.audit import audit
from serversherpa.services.auth import AuthError
from serversherpa.system.config_store import read_section

ISSUER = "ServerSherpa"
CHALLENGE_TTL_SECONDS = 300
BACKUP_CODE_COUNT = 8
BACKUP_CODE_LENGTH = 10
# no 0/1/i/l/o: the codes get read off a printout
BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
SECURITY_SECTION = "security"

Purpose = Literal["verify", "enroll"]


@dataclass(frozen=True)
class TotpPolicy:
    enabled: bool   # site master switch
    required: bool  # this account must use 2FA (implies enabled)


# ── secrets at rest ─────────────────────────────────────────────────

def _fernet() -> Fernet:
    key = get_settings().totp_encryption_key.get_secret_value()
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise RuntimeError("SS_TOTP_ENCRYPTION_KEY is not a valid Fernet key") from exc


def encrypt_secret(secret: str) -> bytes:
    return _fernet().encrypt(secret.encode())


def decrypt_secret(blob: bytes) -> str:
    try:
        return _fernet().decrypt(bytes(blob)).decode()
    except InvalidToken as exc:
        raise RuntimeError("stored TOTP seed does not decrypt with SS_TOTP_ENCRYPTION_KEY") from exc


# ── policy ──────────────────────────────────────────────────────────

async def policy_for(db: AsyncSession, account: UserAccount) -> TotpPolicy:
    cfg = await read_section(db, SECURITY_SECTION)
    if not cfg.get("two_factor_enabled"):
        return TotpPolicy(enabled=False, required=False)
    if cfg.get("two_factor_required") or account.totp_required:
        return TotpPolicy(enabled=True, required=True)
    group_hit = await db.scalar(
        select(AccessGroup.id)
        .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
        .where(AccessGroupMember.person_id == account.person_id,
               AccessGroup.totp_required.is_(True))
        .limit(1))
    if group_hit is not None:
        return TotpPolicy(enabled=True, required=True)
    role_hit = await db.scalar(
        select(Role.name)
        .join(PersonRole, PersonRole.role == Role.name)
        .where(PersonRole.person_id == account.person_id,
               PersonRole.revoked_at.is_(None),
               Role.totp_required.is_(True))
        .limit(1))
    return TotpPolicy(enabled=True, required=role_hit is not None)


# ── challenge tokens ────────────────────────────────────────────────

def make_challenge_token(person_id: uuid.UUID, purpose: Purpose) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {"iss": JWT_ISSUER, "sub": str(person_id), "purpose": purpose,
         "iat": now, "exp": now + timedelta(seconds=CHALLENGE_TTL_SECONDS),
         "typ": "totp"},
        get_settings().jwt_secret.get_secret_value(), algorithm="HS256")


def decode_challenge_token(token: str) -> tuple[uuid.UUID, str]:
    try:
        claims = jwt.decode(
            token, get_settings().jwt_secret.get_secret_value(), algorithms=["HS256"],
            issuer=JWT_ISSUER, options={"require": ["exp", "iat", "sub", "purpose"]},
            leeway=10)
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    if claims.get("typ") != "totp" or claims["purpose"] not in ("verify", "enroll"):
        raise TokenError("wrong token type")
    return uuid.UUID(claims["sub"]), claims["purpose"]


# ── enrollment ──────────────────────────────────────────────────────

def _otp(secret: str) -> pyotp.TOTP:
    return pyotp.TOTP(secret, digits=6, interval=30)


async def begin_enrollment(
    db: AsyncSession, account: UserAccount, *, actor_id: uuid.UUID | None, ip: str | None,
) -> tuple[str, str]:
    """Mint a fresh seed (an unconfirmed one is simply replaced) and return
    (secret, otpauth URI). Commits."""
    if account.totp_confirmed_at is not None:
        raise AuthError("totp_already_enrolled")
    secret = pyotp.random_base32()
    account.totp_secret_enc = encrypt_secret(secret)
    account.totp_last_counter = None
    account.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.enroll", ip=ip)
    await db.commit()
    uri = _otp(secret).provisioning_uri(name=account.email, issuer_name=ISSUER)
    return secret, uri


def _match_counter(secret: str, code: str, last_counter: int | None) -> int | None:
    """The time-step counter the code belongs to (±1 step of drift), or
    None when it matches nothing new. A counter at or below the last one
    accepted is a replay and also returns None."""
    otp = _otp(secret)
    base = otp.timecode(datetime.now(UTC))
    for offset in (0, -1, 1):
        counter = base + offset
        if hmac.compare_digest(otp.generate_otp(counter), code):
            if last_counter is not None and counter <= last_counter:
                return None
            return counter
    return None


async def confirm_enrollment(
    db: AsyncSession, account: UserAccount, code: str, *,
    actor_id: uuid.UUID | None, ip: str | None,
) -> list[str]:
    """First code from the app confirms the seed; returns the plaintext
    backup codes (shown once). Commits."""
    if account.totp_confirmed_at is not None:
        raise AuthError("totp_already_enrolled")
    if account.totp_secret_enc is None:
        raise AuthError("totp_not_started")
    counter = _match_counter(decrypt_secret(account.totp_secret_enc), _digits(code), None)
    if counter is None:
        await _record_failure(db, account, ip=ip)
        raise AuthError("totp_invalid")
    now = datetime.now(UTC)
    account.totp_confirmed_at = now
    account.totp_last_counter = counter
    account.updated_at = now
    await revoke_trust(db, account.person_id)
    codes = await _replace_backup_codes(db, account.person_id)
    audit(db, actor_id=actor_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.confirm", ip=ip)
    await db.commit()
    return codes


# ── verification ────────────────────────────────────────────────────

def _digits(code: str) -> str:
    return "".join(ch for ch in code if ch.isdigit())


def _normalize_backup(code: str) -> str:
    return "".join(ch for ch in code.lower() if ch.isalnum())


async def _record_failure(db: AsyncSession, account: UserAccount, *, ip: str | None) -> None:
    """Same counters as a wrong password: N strikes → temporary lockout."""
    settings = get_settings()
    now = datetime.now(UTC)
    account.failed_login_count += 1
    account.updated_at = now
    if account.failed_login_count >= settings.max_failed_logins:
        account.locked_until = now + timedelta(seconds=settings.lockout_seconds)
        account.failed_login_count = 0
    audit(db, actor_id=None, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.verify_failed", ip=ip)
    await db.commit()


async def verify_code(
    db: AsyncSession, account: UserAccount, code: str, *, ip: str | None,
) -> Literal["totp", "backup"]:
    """Accept a 6-digit app code (±1 step, no replays) or an unused backup
    code. Raises AuthError("account_locked") while locked out and
    AuthError("totp_invalid") otherwise; a failure counts toward lockout.
    Commits."""
    now = datetime.now(UTC)
    if account.locked_until is not None and account.locked_until > now:
        raise AuthError("account_locked")
    if account.totp_confirmed_at is None or account.totp_secret_enc is None:
        raise AuthError("totp_not_enrolled")

    digits = _digits(code)
    if len(digits) == 6 and digits == code.strip():
        counter = _match_counter(decrypt_secret(account.totp_secret_enc), digits,
                                 account.totp_last_counter)
        if counter is not None:
            account.totp_last_counter = counter
            account.failed_login_count = 0
            account.updated_at = now
            await db.commit()
            return "totp"
    else:
        wanted = _normalize_backup(code)
        pepper = get_settings().password_pepper.get_secret_value()
        if len(wanted) == BACKUP_CODE_LENGTH:
            rows = list(await db.scalars(select(TotpBackupCode).where(
                TotpBackupCode.person_id == account.person_id,
                TotpBackupCode.used_at.is_(None))))
            for row in rows:
                if verify_password(row.code_hash, wanted, pepper=pepper):
                    row.used_at = now
                    account.failed_login_count = 0
                    account.updated_at = now
                    audit(db, actor_id=account.person_id, entity_type="user_account",
                          entity_id=str(account.person_id), action="totp.backup_used", ip=ip)
                    await db.commit()
                    return "backup"
    await _record_failure(db, account, ip=ip)
    raise AuthError("totp_invalid")


# ── backup codes ────────────────────────────────────────────────────

def format_backup_code(code: str) -> str:
    return f"{code[:5]}-{code[5:]}"


def _new_backup_code() -> str:
    return "".join(secrets.choice(BACKUP_ALPHABET) for _ in range(BACKUP_CODE_LENGTH))


async def _replace_backup_codes(db: AsyncSession, person_id: uuid.UUID) -> list[str]:
    """Delete every existing code (used or not) and store a fresh set;
    returns the plaintext codes formatted for display. Does not commit."""
    pepper = get_settings().password_pepper.get_secret_value()
    for row in list(await db.scalars(select(TotpBackupCode).where(
            TotpBackupCode.person_id == person_id))):
        await db.delete(row)
    codes = [_new_backup_code() for _ in range(BACKUP_CODE_COUNT)]
    for code in codes:
        db.add(TotpBackupCode(person_id=person_id, code_hash=hash_password(code, pepper=pepper)))
    return [format_backup_code(c) for c in codes]


async def backup_codes_remaining(db: AsyncSession, person_id: uuid.UUID) -> int:
    rows = list(await db.scalars(select(TotpBackupCode.id).where(
        TotpBackupCode.person_id == person_id, TotpBackupCode.used_at.is_(None))))
    return len(rows)


async def regenerate_backup_codes(
    db: AsyncSession, account: UserAccount, *, actor_id: uuid.UUID | None, ip: str | None,
) -> list[str]:
    if account.totp_confirmed_at is None:
        raise AuthError("totp_not_enrolled")
    codes = await _replace_backup_codes(db, account.person_id)
    audit(db, actor_id=actor_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.codes_regenerated", ip=ip)
    await db.commit()
    return codes


# ── reset (admin / CLI) ─────────────────────────────────────────────

async def reset(
    db: AsyncSession, account: UserAccount, *, actor_id: uuid.UUID | None, ip: str | None,
) -> None:
    """Forget the seed, the backup codes and every trusted browser. The
    user enrolls again at their next sign-in if policy requires it. Does
    NOT commit — the caller owns the transaction."""
    account.totp_secret_enc = None
    account.totp_confirmed_at = None
    account.totp_last_counter = None
    account.updated_at = datetime.now(UTC)
    for row in list(await db.scalars(select(TotpBackupCode).where(
            TotpBackupCode.person_id == account.person_id))):
        await db.delete(row)
    await revoke_trust(db, account.person_id)
    audit(db, actor_id=actor_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.reset", ip=ip)


# ── trusted browsers ────────────────────────────────────────────────

def _hash_trust(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def issue_trust(
    db: AsyncSession, account: UserAccount, *, user_agent: str | None, ip: str | None,
) -> str:
    """Create a trusted-browser row and return the cookie token. Commits."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    db.add(TrustedDevice(
        person_id=account.person_id, token_hash=_hash_trust(token),
        user_agent=user_agent, last_used_at=now,
        expires_at=now + timedelta(days=get_settings().totp_trust_days)))
    audit(db, actor_id=account.person_id, entity_type="user_account",
          entity_id=str(account.person_id), action="totp.trust", ip=ip)
    await db.commit()
    return token


async def check_trust(db: AsyncSession, account: UserAccount, token: str | None) -> bool:
    if not token:
        return False
    now = datetime.now(UTC)
    row = await db.scalar(select(TrustedDevice).where(
        TrustedDevice.person_id == account.person_id,
        TrustedDevice.token_hash == _hash_trust(token)))
    if row is None or row.revoked_at is not None or row.expires_at <= now:
        return False
    row.last_used_at = now
    await db.commit()
    return True


async def revoke_trust(db: AsyncSession, person_id: uuid.UUID) -> None:
    """Does not commit."""
    await db.execute(
        update(TrustedDevice)
        .where(TrustedDevice.person_id == person_id, TrustedDevice.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC)))
