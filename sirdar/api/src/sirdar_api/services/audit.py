import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.models import AuditLog


def audit(db: AsyncSession, *, actor_id: uuid.UUID | None, action: str, entity_type: str,
          entity_id: str | None = None, ip: str | None = None,
          changes: dict | None = None) -> None:
    """Queue one audit row on the caller's transaction (the caller commits)."""
    db.add(AuditLog(actor_id=actor_id, action=action, entity_type=entity_type,
                    entity_id=entity_id, ip=ip, changes=changes or {}))
