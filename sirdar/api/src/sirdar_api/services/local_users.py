"""Sirdar-only (source = local) break-glass accounts. The import never
reads or changes them. No 2FA in v1."""

import uuid
from datetime import UTC, datetime

from email_validator import EmailNotValidError, validate_email
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import get_settings
from sirdar_api.db.models import Role, User, UserRole
from sirdar_api.security.passwords import hash_password
from sirdar_api.services.audit import audit

class LocalUserError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _normalize_email(email: str) -> str:
    """Same validator pydantic's EmailStr uses on the login form, so an
    account that can be created can also sign in."""
    try:
        return validate_email(email, check_deliverability=False).normalized
    except EmailNotValidError:
        raise LocalUserError("invalid_email") from None


def _hash(password: str) -> str:
    if len(password) < get_settings().password_min_length:
        raise LocalUserError("password_too_short")
    return hash_password(password, pepper=get_settings().password_pepper.get_secret_value())


async def create_local_admin(db: AsyncSession, *, email: str, first_name: str, last_name: str,
                             role: str, password: str) -> User:
    email = _normalize_email(email)
    if await db.get(Role, role) is None:
        raise LocalUserError("unknown_role")
    if await db.scalar(select(User).where(User.email == email)) is not None:
        raise LocalUserError("email_taken")
    now = datetime.now(UTC)
    user = User(person_id=uuid.uuid4(), source="local", email=email, first_name=first_name,
                last_name=last_name, password_hash=_hash(password), password_updated_at=now)
    db.add(user)
    await db.flush()
    db.add(UserRole(person_id=user.person_id, role=role))
    audit(db, actor_id=None, action="user.create_local", entity_type="user",
          entity_id=str(user.person_id), changes={"email": email, "role": role})
    await db.commit()
    return user


async def reset_local_password(db: AsyncSession, *, email: str, password: str) -> User:
    email = _normalize_email(email)
    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        raise LocalUserError("not_found")
    if user.source != "local":
        raise LocalUserError("not_local")
    user.password_hash = _hash(password)
    now = datetime.now(UTC)
    user.password_updated_at = now
    user.failed_login_count = 0
    user.locked_until = None
    user.updated_at = now
    audit(db, actor_id=None, action="user.reset_local_password", entity_type="user",
          entity_id=str(user.person_id))
    await db.commit()
    return user
