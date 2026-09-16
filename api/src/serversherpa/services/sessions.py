"""Live login families for one person — shared by /auth/me/sessions (adds
the `current` flag) and GET /users/{id} (admin view, no current flag)."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AuthSession


async def live_session_rows(db: AsyncSession, person_id: uuid.UUID) -> list[dict]:
    now = datetime.now(UTC)
    live = (await db.scalars(
        select(AuthSession).where(
            AuthSession.person_id == person_id,
            AuthSession.revoked_at.is_(None),
            AuthSession.rotated_at.is_(None),
            AuthSession.expires_at > now,
        )
    )).all()
    family_ids = [s.family_id for s in live]
    starts = dict((await db.execute(
        select(AuthSession.family_id, func.min(AuthSession.created_at))
        .where(AuthSession.family_id.in_(family_ids or [uuid.uuid4()]))
        .group_by(AuthSession.family_id)
    )).all())
    rows = [{
        "family_id": s.family_id,
        "started_at": starts.get(s.family_id, s.created_at),
        "last_active_at": s.created_at,
        "expires_at": s.expires_at,
        "ip_address": str(s.ip_address) if s.ip_address is not None else None,
        "user_agent": s.user_agent,
    } for s in live]
    rows.sort(key=lambda r: r["last_active_at"], reverse=True)
    return rows
