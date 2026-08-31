"""Entity matching for the scan-matching worker. Ladder: ID (uuid or
legacy numeric) → RFID tag → asset serial → name. Within a tier, tables
are tried in asset → container → person order; the first table with
hits decides. Multiple hits anywhere = ambiguous — the ladder STOPS and
returns None (the value clearly refers to something; guessing or
falling through would mis-attribute the scan). Archived entities are
excluded everywhere. All identifier columns are CITEXT, so equality is
case-insensitive for free."""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, Container, Person


@dataclass(frozen=True)
class Match:
    match_type: str          # 'asset' | 'container' | 'person'
    target_id: uuid.UUID


def _as_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except (ValueError, AttributeError):
        return None


def _as_int(value: str) -> int | None:
    try:
        return int(value.strip())
    except (ValueError, AttributeError):
        return None


async def _hits(db: AsyncSession, model, column, value) -> list[uuid.UUID]:
    """Up to 2 unarchived ids — enough to tell unique from ambiguous."""
    return (await db.scalars(
        select(model.id).where(column == value,
                               model.archived_at.is_(None)).limit(2))).all()


# (match_type, model, tag column) in ladder order for the RFID tier.
_RFID_TIER = (("asset", Asset, Asset.rfid_tag),
              ("container", Container, Container.rfid_tag),
              ("person", Person, Person.rfid_tag))
_NAME_TIER = (("asset", Asset, Asset.name),
              ("container", Container, Container.name))


async def match_scan(db: AsyncSession, scanned_value: str) -> Match | None:
    # Tier 1: ID — uuid PKs, then V2 numeric asset labels.
    uid = _as_uuid(scanned_value)
    if uid is not None:
        for match_type, model in (("asset", Asset), ("container", Container),
                                  ("person", Person)):
            ids = await _hits(db, model, model.id, uid)
            if ids:
                return Match(match_type, ids[0])
    legacy = _as_int(scanned_value)
    if legacy is not None:
        ids = await _hits(db, Asset, Asset.legacy_id, legacy)
        if len(ids) == 1:
            return Match("asset", ids[0])
        if ids:
            return None                      # ambiguous — stop the ladder

    # Tier 2: RFID (partial-unique per table — first table with a hit wins).
    for match_type, model, column in _RFID_TIER:
        ids = await _hits(db, model, column, scanned_value)
        if len(ids) == 1:
            return Match(match_type, ids[0])
        if ids:
            return None

    # Tier 3: asset serial (deliberately non-unique — dupes are ambiguous).
    ids = await _hits(db, Asset, Asset.serial_number, scanned_value)
    if len(ids) == 1:
        return Match("asset", ids[0])
    if ids:
        return None

    # Tier 4: name fallback. No people-by-name — badges are RFID-only.
    for match_type, model, column in _NAME_TIER:
        ids = await _hits(db, model, column, scanned_value)
        if len(ids) == 1:
            return Match(match_type, ids[0])
        if ids:
            return None
    return None
