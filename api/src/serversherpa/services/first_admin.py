"""The first admin of a fresh environment (`serversherpa bootstrap-admin`,
which Sirdar runs once on an environment that starts empty). A typed
password creates a ready account and, when a link is asked for, mails a
change-password link; an invite creates the account without a password and
mails a set-password link. No password ever goes in an email or an audit row.
The bar is the API's own (password_policy.length_problem). Never commits."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Person, PersonRole, Role, UserAccount
from serversherpa.mail import email_enabled, enqueue
from serversherpa.services import password_reset
from serversherpa.services.audit import audit
from serversherpa.services.password_policy import apply_password, length_problem


class FirstAdminError(Exception):
    """Nothing was created. `code`: account_exists, password_too_short
    (`min_length`), role_unknown, mail_not_configured, link_required."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


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
    if not invite and (min_length := length_problem(password)) is not None:
        raise FirstAdminError("password_too_short", min_length=min_length)
    if await db.get(Role, role) is None:
        raise FirstAdminError("role_unknown")
    if invite and not email_enabled():
        raise FirstAdminError("mail_not_configured")
    if await db.scalar(select(UserAccount).where(UserAccount.email == email)) is not None:
        raise FirstAdminError("account_exists")

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
