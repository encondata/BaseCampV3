"""Kiosk Asset Lookup: which devices a kiosk lookup may reach, and how a
typed or scanned value matches them. Read-only; nothing here writes.
Design: docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md

Reach is decided by the registered kiosk's move (`Device.current_initiative_id`),
never by a move id the screen sends:
- a move-password session: its own move's devices only;
- admin and above (rank 60): their portal `assets:view` scope, plus the
  kiosk's move;
- below admin: the kiosk's move, plus that move's client's devices on its
  other live moves or on no move (the `/kiosk/sync/assets` and
  `/kiosk/sync/client-assets` set). A kiosk with no move reaches nothing.
"""

import uuid
from dataclasses import dataclass

import sqlalchemy as sa
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import AccessInfo
from serversherpa.access.scope import scope_conditions
from serversherpa.assets.bulk_update import normalize_rfid
from serversherpa.db.models import Asset, Device, Initiative, InitiativeAsset
from serversherpa.db.ordering import natural

LOOKUP_CAP = 25
_BIGINT_DIGITS = 18     # every 18-digit number fits a bigint; 19 may not


@dataclass(frozen=True)
class LookupReach:
    admin: bool
    kiosk_move_id: uuid.UUID | None
    kiosk_client_id: uuid.UUID | None
    locked_move_id: uuid.UUID | None
    access: AccessInfo
    person_id: uuid.UUID


@dataclass(frozen=True)
class LookupHit:
    asset: Asset
    matched: list[str]      # "asset_tag" | "serial" | "rfid" | "name"


async def lookup_reach(db: AsyncSession, device: Device, *, access: AccessInfo,
                       person_id: uuid.UUID,
                       locked_move_id: uuid.UUID | None) -> LookupReach:
    move_id = device.current_initiative_id
    client_id = (await db.scalar(select(Initiative.client_id).where(Initiative.id == move_id))
                 if move_id is not None else None)
    return LookupReach(admin=access.max_rank >= GATE_BYPASS_RANK, kiosk_move_id=move_id,
                       kiosk_client_id=client_id, locked_move_id=locked_move_id,
                       access=access, person_id=person_id)


def _live_move() -> ColumnElement[bool]:
    return sa.and_(Initiative.initiative_type == "move", Initiative.archived_at.is_(None))


def _on_move(initiative_id: uuid.UUID) -> ColumnElement[bool]:
    return Asset.id.in_(select(InitiativeAsset.asset_id)
                        .where(InitiativeAsset.initiative_id == initiative_id))


def asset_reach(reach: LookupReach) -> ColumnElement[bool]:
    """WHERE clause over Asset: the devices this lookup may see."""
    live = Asset.archived_at.is_(None)
    if reach.locked_move_id is not None:
        return sa.and_(live, _on_move(reach.locked_move_id))
    kiosk_move = (_on_move(reach.kiosk_move_id) if reach.kiosk_move_id is not None
                  else sa.false())
    if reach.admin:
        if not reach.access.can("assets", "view"):
            return sa.and_(live, kiosk_move)
        scope = scope_conditions("assets", reach.access, reach.person_id)
        if scope is None:
            return live
        return sa.and_(live, sa.or_(scope, kiosk_move))
    if reach.kiosk_move_id is None:
        return sa.false()
    legs: list[ColumnElement[bool]] = [kiosk_move]
    if reach.kiosk_client_id is not None:
        legs.append(Asset.client_id == reach.kiosk_client_id)
        legs.append(Asset.id.in_(
            select(InitiativeAsset.asset_id)
            .join(Initiative, Initiative.id == InitiativeAsset.initiative_id)
            .where(Initiative.client_id == reach.kiosk_client_id, _live_move())))
    return sa.and_(live, sa.or_(*legs))


def move_reach(reach: LookupReach) -> ColumnElement[bool]:
    """WHERE clause over Initiative: the live moves this lookup may show."""
    live = _live_move()
    if reach.locked_move_id is not None:
        return sa.and_(live, Initiative.id == reach.locked_move_id)
    kiosk_move = (Initiative.id == reach.kiosk_move_id if reach.kiosk_move_id is not None
                  else sa.false())
    if reach.admin:
        scope = scope_conditions("initiatives", reach.access, reach.person_id)
        if scope is None:
            return live
        return sa.and_(live, sa.or_(scope, kiosk_move))
    legs: list[ColumnElement[bool]] = [kiosk_move]
    if reach.kiosk_client_id is not None:
        legs.append(Initiative.client_id == reach.kiosk_client_id)
    return sa.and_(live, sa.or_(*legs))


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def find_assets(db: AsyncSession, reach: LookupReach,
                      raw: str) -> tuple[list[LookupHit], bool]:
    """Exact hits first (asset tag, serial, RFID, in that order, grouped
    per asset); a part-name search only when nothing matched exactly.
    Returns at most LOOKUP_CAP hits and whether more exist."""
    value = (raw or "").strip()
    if not value:
        return [], False
    in_reach = asset_reach(reach)

    exact: list[tuple[str, ColumnElement[bool]]] = []
    # isascii: "²".isdigit() is True but int("²") raises
    if (value.isascii() and value.isdigit() and value[0] != "0"
            and len(value) <= _BIGINT_DIGITS):
        exact.append(("asset_tag", Asset.legacy_id == int(value)))
    exact.append(("serial", Asset.serial_number == value))
    tag = normalize_rfid(value)
    if tag is not None:
        exact.append(("rfid", Asset.rfid_tag == tag))

    found: dict[uuid.UUID, LookupHit] = {}
    for kind, cond in exact:
        rows = (await db.scalars(select(Asset).where(cond, in_reach)
                                 .order_by(Asset.legacy_id))).all()
        for asset in rows:
            hit = found.setdefault(asset.id, LookupHit(asset=asset, matched=[]))
            hit.matched.append(kind)
    if found:
        hits = list(found.values())
        return hits[:LOOKUP_CAP], len(hits) > LOOKUP_CAP

    rows = (await db.scalars(
        select(Asset)
        .where(Asset.name.ilike(f"%{_like_escape(value)}%", escape="\\"), in_reach)
        .order_by(natural(Asset.name), Asset.legacy_id)
        .limit(LOOKUP_CAP + 1))).all()
    return ([LookupHit(asset=a, matched=["name"]) for a in rows[:LOOKUP_CAP]],
            len(rows) > LOOKUP_CAP)


async def asset_in_reach(db: AsyncSession, reach: LookupReach,
                         asset_id: uuid.UUID) -> Asset | None:
    return await db.scalar(select(Asset).where(Asset.id == asset_id, asset_reach(reach)))
