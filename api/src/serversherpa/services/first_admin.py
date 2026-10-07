"""The first admin of a fresh environment (`serversherpa bootstrap-admin`,
which Sirdar runs once on an environment that starts empty). A typed
password creates a ready account and, when a link is asked for, mails a
change-password link; an invite creates the account without a password and
mails a set-password link. No password ever goes in an email or an audit row.
The bar is the API's own (password_policy.length_problem). Never commits."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, Role, UserAccount
from serversherpa.mail import email_enabled, enqueue
from serversherpa.services import password_reset
from serversherpa.services.audit import audit
from serversherpa.services.password_policy import apply_password, length_problem


class FirstAdminError(Exception):
    """Nothing was created. `code`: account_exists (the email has an account,
    or the person with that email has one), person_exists (a person with that
    email but no account), password_too_short (`min_length`), role_unknown
    (no such role, or one that isn't global), mail_not_configured,
    link_required, email_invalid (`reason`: the portal couldn't sign in with it)."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


_LOGIN_EMAIL = TypeAdapter(EmailStr)   # the portal's LoginIn.email


def email_problem(email: str) -> str | None:
    """Why the portal couldn't sign in with `email` (LoginIn.email is an
    EmailStr, which refuses e.g. .local and .test), else None."""
    try:
        _LOGIN_EMAIL.validate_python(email)
    except ValidationError as e:
        return str(e.errors()[0].get("msg") or "not a valid email address")
    return None


@dataclass(frozen=True)
class FirstAdminResult:
    person_id: uuid.UUID
    emailed: bool


def ttl_text(minutes: int) -> str:
    if minutes % 60 == 0:
        hours = minutes // 60
        return f"{hours} hour{'' if hours == 1 else 's'}"
    return f"{minutes} minute{'' if minutes == 1 else 's'}"


async def create_admin(db: AsyncSession, *, email: str, first_name: str, last_name: str,
                       role: str = "admin", password: str | None,
                       link_minutes: int | None,
                       now: datetime | None = None) -> FirstAdminResult:
    now = now or datetime.now(UTC)
    invite = password is None
    if invite and not link_minutes:
        raise FirstAdminError("link_required")
    if (reason := email_problem(email)) is not None:
        raise FirstAdminError("email_invalid", reason=reason)
    # first, so a re-run on an environment that already has its admin is a no-op
    if await db.scalar(select(UserAccount.person_id)
                       .where(UserAccount.email == email)) is not None:
        raise FirstAdminError("account_exists")
    person_id = await db.scalar(select(Person.id).where(Person.email == email))
    if person_id is not None:
        if await db.get(UserAccount, person_id) is not None:
            raise FirstAdminError("account_exists")
        raise FirstAdminError("person_exists")
    if not invite:
        if not password:
            raise FirstAdminError("password_too_short",
                                  min_length=get_settings().password_min_length)
        if (min_length := length_problem(password)) is not None:
            raise FirstAdminError("password_too_short", min_length=min_length)
    found = await db.get(Role, role)
    if found is None or found.scope_anchor != "global":
        raise FirstAdminError("role_unknown")    # a client/partner/self role needs an org
    if invite and not email_enabled():
        raise FirstAdminError("mail_not_configured")

    person = Person(first_name=first_name, last_name=last_name, email=email, source="manual")
    db.add(person)
    await db.flush()
    account = UserAccount(person_id=person.id, email=email)
    db.add(account)
    await db.flush()      # password_history references the account
    if not invite:
        await apply_password(db, account, password, must_change=False, now=now)
    db.add(PersonRole(person_id=person.id, role=role))    # granted_by NULL = bootstrap
    emailed = False
    if link_minutes and email_enabled():
        raw = await password_reset.issue_token(db, person.id, minutes=link_minutes, now=now)
        await enqueue(db, "account_invite" if invite else "account_ready", email,
                      person_id=person.id, name=first_name, email=email,
                      link=password_reset.portal_url(f"/reset-password#token={raw}"),
                      ttl_text=ttl_text(link_minutes),
                      login_url=password_reset.portal_url("/login"))
        emailed = True
    audit(db, actor_id=None, entity_type="user_account", entity_id=str(person.id),
          action="user.bootstrap", changes={"role": role, "invite": invite, "emailed": emailed})
    await db.flush()
    return FirstAdminResult(person_id=person.id, emailed=emailed)
