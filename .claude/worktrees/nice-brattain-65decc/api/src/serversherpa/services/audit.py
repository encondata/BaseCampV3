"""App-wide audit trail: who did what, to what, and what changed.
audit() adds a row to the CALLER's transaction — never commits itself, so
an audit row can never outlive a rolled-back mutation (or vice versa)."""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AuditLog

SENSITIVE_FIELDS = {"password_hash", "temp_password", "password",
                    "token_hash", "totp_secret_enc"}
_REDACTED = "[redacted]"


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, bytes):
        return _REDACTED
    return value


def snapshot(obj: Any, fields: list[str]) -> dict:
    return {f: _jsonable(getattr(obj, f)) for f in fields}


def diff(before: dict, after: dict) -> dict:
    out: dict = {}
    for key in after:
        if before.get(key) == after[key]:
            continue
        if key in SENSITIVE_FIELDS:
            out[key] = {"from": _REDACTED, "to": _REDACTED}
        else:
            out[key] = {"from": _jsonable(before.get(key)),
                        "to": _jsonable(after[key])}
    return out


def audit(
    db: AsyncSession, *,
    actor_id: uuid.UUID | None,
    entity_type: str,
    entity_id: str | None,
    action: str,
    changes: dict | None = None,
    ip: str | None = None,
) -> None:
    db.add(AuditLog(actor_person_id=actor_id, entity_type=entity_type,
                    entity_id=entity_id, action=action,
                    changes=changes or {}, ip=ip))
