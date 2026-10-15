"""Account invites and admin-sent reset links (spec 2026-10-15 user-admin fixes):
both are one-time links to /reset-password, issued through the password-reset
token store and sent through the mail outbox. Never commits."""
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import Person, UserAccount
from serversherpa.mail.outbox import enqueue
from serversherpa.services import password_reset
from serversherpa.services.first_admin import ttl_text


async def send_invite(db: AsyncSession, person: Person, account: UserAccount, *, now: datetime) -> None:
    """Issue an invite token (retiring any older unused link) and queue
    `user_invite` to the login email."""
    minutes = get_settings().invite_ttl_minutes
    raw = await password_reset.issue_token(db, person.id, minutes=minutes, now=now)
    await enqueue(db, "user_invite", account.email, person_id=person.id,
                  name=person.preferred_name or person.first_name, email=account.email,
                  link=password_reset.portal_url(f"/reset-password#token={raw}"),
                  ttl_text=ttl_text(minutes), login_url=password_reset.portal_url("/login"))


async def send_reset_link(db: AsyncSession, person: Person, account: UserAccount, *, now: datetime) -> None:
    """The self-service reset email, sent by an admin: same token lifetime,
    same template and variables as password_reset.request_reset."""
    minutes = get_settings().password_reset_ttl_minutes
    raw = await password_reset.issue_token(db, person.id, minutes=minutes, now=now)
    await enqueue(db, "password_reset", account.email, person_id=person.id,
                  name=person.first_name,
                  link=password_reset.portal_url(f"/reset-password#token={raw}"),
                  ttl_minutes=minutes)
