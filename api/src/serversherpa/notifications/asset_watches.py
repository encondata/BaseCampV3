"""Asset watches. A person watches one asset, set on the asset itself or on an initiative it is
on, for its next update or for a status: `AssetWatch`, migration 0121. Unlike a watch on a thing
(watches.py), it waits for one condition and then ends. This module validates and stores them,
lists a person's, and takes the snapshot each one keeps of its asset (`snapshot`), which the
notification worker's check compares with the asset as it is now. `asset_label`,
`asset_watch_link` and `watched_status` say how a watch names its asset, where it links and
which status it reads, for the routes and the check alike.

A watch needs what the asset's page needs (`assets:view` and the asset's client scope). One on an
initiative also needs what the initiative's asset list needs (`initiatives:view` and the
initiative's scope), and the asset has to be on that initiative. Both are asked of the one test
every notification asks (notifications/access.py), and the check asks the same when a watch fires
(asset_watch_check.py), so setting, listing and firing agree: no watch can be set that would end
without a notice for want of access. Access is not stored: a watch whose owner can't open its
asset or initiative stays in place and is not listed until they can again.

Each write is audited on the person's account, as their other watches are (`watch.add`,
`watch.update` and `watch.remove`, with thing "asset"). Like notify() and audit(), nothing here
commits: the routes do.

Spec: docs/superpowers/specs/2026-11-05-asset-watches-design.md (What counts, Data and API,
Link)"""

import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import resolve_access_many
from serversherpa.api.schemas import AssetWatchOut, AssetWatchStateOut
from serversherpa.db.models import (
    Asset,
    AssetWatch,
    Container,
    ContainerAsset,
    Initiative,
    InitiativeAsset,
    ProcessedScan,
    Truck,
    TruckContainer,
)
from serversherpa.notifications.access import viewers, visible_among
from serversherpa.notifications.events import Thing
from serversherpa.services.audit import audit, diff
from serversherpa.status.labels import active_statuses, status_fields, status_labels

# What a watch waits for: the asset's next update, or a status.
CONDITIONS = ("next_update", "status")

# The unique index over a person, an asset and a place: a second watch there collides on it.
_UNIQUE_TARGET = "uq_asset_watches_target"


class AssetWatchError(Exception):
    """An asset watch request that can't be honored. `.status` is the HTTP status a route
    answers with and `.code` its error code."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def asset_label(asset: Asset) -> str:
    """The asset as its notices name it: its serial number, else its name, else its id."""
    return asset.serial_number or asset.name or str(asset.id)


def asset_watch_link(watch: AssetWatch, row_id: uuid.UUID | None) -> str:
    """Where the watch was set: the move asset page of the asset's row (`row_id`) on the
    initiative, or the asset's own page for a watch on the asset and once the row is gone."""
    if watch.initiative_id is not None and row_id is not None:
        return f"/initiatives/{watch.initiative_id}/assets/{row_id}"
    return f"/assets/{watch.asset_id}"


# ── the snapshot ────────────────────────────────────────────────────

def _iso(at: datetime | None) -> str | None:
    return at.isoformat() if at is not None else None


def _str(value: uuid.UUID | None) -> str | None:
    return str(value) if value is not None else None


async def snapshot(db: AsyncSession, asset_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """What a watch keeps of each asset, to tell later whether anything about it has changed:
    its record (`asset`), each of its initiative rows by row id (`rows`), the container it is in
    and the truck that container is on, and how many processed scans it has with the latest
    `processed_at` among them (`scans`). Ids are strings and times ISO strings, so it is stored
    as JSON and a later snapshot of an unchanged asset compares equal to it; None means none.

    The placement follows assets/placement.py without its per-person gating: an archived
    container or truck is skipped, and of the trucks a container is on, the latest load wins.
    Every scan of the asset counts, archived or not. An id with no asset is left out. The cost
    doesn't grow with the number of assets: five queries at most."""
    ids = list(dict.fromkeys(asset_ids))
    if not ids:
        return {}
    out: dict[uuid.UUID, dict] = {}
    for row in await db.execute(
            select(Asset.id, Asset.updated_at, Asset.last_seen_at, Asset.status, Asset.site_id,
                   Asset.location_detail, Asset.archived_at).where(Asset.id.in_(ids))):
        out[row.id] = {
            "asset": {"updated_at": _iso(row.updated_at),
                      "last_seen_at": _iso(row.last_seen_at),
                      "status": row.status, "site_id": _str(row.site_id),
                      "location_detail": row.location_detail,
                      "archived_at": _iso(row.archived_at)},
            "rows": {},
            "container_id": None,
            "truck_id": None,
            "scans": {"count": 0, "latest": None},
        }
    found = list(out)
    if not found:
        return {}

    for row in await db.execute(
            select(InitiativeAsset.id, InitiativeAsset.asset_id, InitiativeAsset.initiative_id,
                   InitiativeAsset.status, InitiativeAsset.updated_at)
            .where(InitiativeAsset.asset_id.in_(found))):
        out[row.asset_id]["rows"][str(row.id)] = {
            "initiative_id": str(row.initiative_id), "status": row.status,
            "updated_at": _iso(row.updated_at)}

    # asset id -> container id (an asset is in one container at most)
    containers = dict((await db.execute(
        select(ContainerAsset.asset_id, ContainerAsset.container_id)
        .join(Container, Container.id == ContainerAsset.container_id)
        .where(ContainerAsset.asset_id.in_(found), Container.archived_at.is_(None)))).all())
    if containers:
        trucks: dict[uuid.UUID, uuid.UUID] = {}
        for container_id, truck_id in await db.execute(
                select(TruckContainer.container_id, TruckContainer.truck_id)
                .join(Truck, Truck.id == TruckContainer.truck_id)
                .where(TruckContainer.container_id.in_(list(set(containers.values()))),
                       Truck.archived_at.is_(None))
                .order_by(TruckContainer.added_at.desc(), Truck.id)):
            trucks.setdefault(container_id, truck_id)          # the first row is the latest
        for asset_id, container_id in containers.items():
            out[asset_id]["container_id"] = str(container_id)
            out[asset_id]["truck_id"] = _str(trucks.get(container_id))

    for asset_id, count, latest in await db.execute(
            select(ProcessedScan.asset_id, func.count(), func.max(ProcessedScan.processed_at))
            .where(ProcessedScan.asset_id.in_(found))
            .group_by(ProcessedScan.asset_id)):
        out[asset_id]["scans"] = {"count": count, "latest": _iso(latest)}
    return out


def watched_status(taken: Mapping | None, initiative_id: uuid.UUID | None) -> str | None:
    """The status a watch in this place reads, in a snapshot of its asset (`snapshot`): the
    asset's own for a watch set on the asset, else its row's on the initiative. None when there
    is none to read: no snapshot (the asset is gone), or the asset isn't on the initiative."""
    if taken is None:
        return None
    if initiative_id is None:
        return taken["asset"]["status"]
    wanted = str(initiative_id)
    return next((row["status"] for row in taken["rows"].values()
                 if row["initiative_id"] == wanted), None)


# ── who can open a watch ────────────────────────────────────────────

def _opens(asset_id: uuid.UUID, initiative_id: uuid.UUID | None) -> tuple[Thing, ...]:
    """What a watch's owner has to be able to open: the asset, and for a watch set on an
    initiative that initiative too, whose asset list is where the watch was set."""
    if initiative_id is None:
        return (Thing("asset", asset_id),)
    return (Thing("asset", asset_id), Thing("initiative", initiative_id))


async def _can_open(db: AsyncSession, person_id: uuid.UUID, asset_id: uuid.UUID,
                    initiative_id: uuid.UUID | None) -> bool:
    """Whether the person can open everything a watch in this place needs (`_opens`) now."""
    access = await resolve_access_many(db, [person_id])
    for thing in _opens(asset_id, initiative_id):
        if person_id not in await viewers(db, thing, [person_id], access=access):
            return False
    return True


async def _visible(db: AsyncSession, person_id: uuid.UUID,
                   watches: Sequence[AssetWatch]) -> list[AssetWatch]:
    """The watches whose asset, and initiative for one set there, the person can open now, by
    the rule each page uses (notifications/access.py), asked once per kind of thing however many
    there are."""
    if not watches:
        return []
    ids: dict[str, list[uuid.UUID]] = defaultdict(list)
    for watch in watches:
        for thing in _opens(watch.asset_id, watch.initiative_id):
            ids[thing.type].append(thing.id)
    access = await resolve_access_many(db, [person_id])
    seen: set[Thing] = set()
    for thing_type, thing_ids in ids.items():
        theirs = (await visible_among(db, thing_type, thing_ids, [person_id],
                                      access=access)).get(person_id, frozenset())
        seen.update(Thing(thing_type, thing_id) for thing_id in theirs)
    return [watch for watch in watches
            if seen.issuperset(_opens(watch.asset_id, watch.initiative_id))]


# ── setting, changing and stopping one ──────────────────────────────

def _at(initiative_id: uuid.UUID | None) -> ColumnElement[bool]:
    """A watch's place: on the asset itself (no initiative), or on this initiative."""
    if initiative_id is None:
        return AssetWatch.initiative_id.is_(None)
    return AssetWatch.initiative_id == initiative_id


async def _existing(db: AsyncSession, person_id: uuid.UUID, asset_id: uuid.UUID,
                    initiative_id: uuid.UUID | None) -> AssetWatch | None:
    """The person's watch on this asset in this place, if any."""
    return await db.scalar(select(AssetWatch).where(
        AssetWatch.person_id == person_id, AssetWatch.asset_id == asset_id, _at(initiative_id)))


async def _own(db: AsyncSession, person_id: uuid.UUID, watch_id: uuid.UUID) -> AssetWatch:
    """One of the person's own watches, locked until the caller commits. Anyone else's (or none)
    is 404 `watch_not_found`. The lock keeps it from the asset-watch check, which claims watches
    FOR UPDATE SKIP LOCKED and deletes those that end: a change that comes in while the check
    holds it waits, then finds it gone (404, never a write to a deleted row)."""
    watch = await db.get(AssetWatch, watch_id, with_for_update=True)
    if watch is None or watch.person_id != person_id:
        raise AssetWatchError(404, "watch_not_found")
    return watch


async def _check(db: AsyncSession, condition: str, status: str | None, current: str) -> None:
    """What the watch waits for, in the spec's order: the condition is one of the two (422
    `invalid_condition`); a Next update watch names no status (422 `invalid_status`); a Status
    becomes watch names one (422 `status_required`) that is an active asset status, as the
    pickers offer them (422 `invalid_status`), and not `current`, the status it reads now (422
    `already_at_status`)."""
    if condition not in CONDITIONS:
        raise AssetWatchError(422, "invalid_condition")
    if condition == "next_update":
        if status is not None:
            raise AssetWatchError(422, "invalid_status")
        return
    if status is None:
        raise AssetWatchError(422, "status_required")
    if status not in {value.key for value in await active_statuses(db, "asset")}:
        raise AssetWatchError(422, "invalid_status")
    if status == current:
        raise AssetWatchError(422, "already_at_status")


def _target(watch: AssetWatch) -> dict:
    """What a watch is on, as the audit records it: the asset, and the initiative it was set on
    (None for one on the asset itself)."""
    return {"thing": "asset", "thing_id": str(watch.asset_id),
            "initiative_id": _str(watch.initiative_id)}


def _audit(db: AsyncSession, person_id: uuid.UUID, action: str, changes: dict) -> None:
    """A write on the person's own watch, audited on their account as their other watches are."""
    audit(db, actor_id=person_id, entity_type="user_account", entity_id=str(person_id),
          action=action, changes=changes)


async def add_asset_watch(db: AsyncSession, person_id: uuid.UUID, *, asset_id: uuid.UUID,
                          initiative_id: uuid.UUID | None, condition: str,
                          status: str | None) -> AssetWatch:
    """Watch an asset for the person, on its own (`initiative_id` None) or on an initiative it
    is on, and keep a snapshot of it. Checked in the spec's order: access, the initiative row,
    the condition, the status. It flushes, audits `watch.add` and never commits.

    404 `thing_not_found` when the asset or the initiative is missing or the person can't open
    it (a watch on an initiative needs both), so a refusal tells nothing of an asset they can't
    see. 422 `not_on_initiative` for an asset they can open that isn't on the initiative. 422
    for a condition or status that doesn't make a watch (`_check`). 409 `already_watching` when
    they already watch the asset there, including when a concurrent request wins the insert."""
    # The same answer for a thing that isn't there and one the person can't open, so a 404
    # tells nothing about the thing.
    if not await _can_open(db, person_id, asset_id, initiative_id):
        raise AssetWatchError(404, "thing_not_found")
    taken = (await snapshot(db, [asset_id])).get(asset_id)
    current = watched_status(taken, initiative_id)
    if current is None:
        # The asset is gone since the check above, or isn't on the initiative: they can open
        # it, so they may learn that it is there, though not on the initiative.
        if taken is None:
            raise AssetWatchError(404, "thing_not_found")
        raise AssetWatchError(422, "not_on_initiative")
    await _check(db, condition, status, current)
    if await _existing(db, person_id, asset_id, initiative_id) is not None:
        raise AssetWatchError(409, "already_watching")

    # Stamped by the app's clock, as a change restamps it and as scans are (scans/worker.py),
    # so the times a notice compares come from one clock.
    watch = AssetWatch(person_id=person_id, asset_id=asset_id, initiative_id=initiative_id,
                       condition=condition, status=status, baseline=taken,
                       created_at=datetime.now(UTC))
    try:
        async with db.begin_nested():
            db.add(watch)
            await db.flush()
    except IntegrityError as exc:
        # Lost the check-then-insert race to a concurrent request, which the unique index
        # settled. Any other violation is a different bug and must not read as a friendly
        # duplicate (the constraint name is on asyncpg's own exception, chained onto
        # SQLAlchemy's DBAPI wrapper).
        asyncpg_exc = exc.orig.__cause__ if exc.orig is not None else None
        if getattr(asyncpg_exc, "constraint_name", None) != _UNIQUE_TARGET:
            raise
        raise AssetWatchError(409, "already_watching") from None
    _audit(db, person_id, "watch.add", {**_target(watch), "condition": condition,
                                        "status": status})
    return watch


async def change_asset_watch(db: AsyncSession, person_id: uuid.UUID, watch_id: uuid.UUID, *,
                             condition: str, status: str | None) -> AssetWatch:
    """Change what one of the person's watches waits for. The watch starts over: it takes a new
    snapshot, and `created_at` becomes now, so even the same choice again is a change. Checked
    as a new watch is: access, the initiative row, the condition, the status. It flushes,
    audits `watch.update` and never commits.

    404 `watch_not_found` when the watch isn't theirs, and when they can't open its asset or
    initiative now (as in the list: its answer would carry the asset's name). 422
    `not_on_initiative` once the asset has left the initiative the watch was set on. 422 for a
    condition or status that doesn't make a watch (`_check`)."""
    watch = await _own(db, person_id, watch_id)
    if not await _can_open(db, person_id, watch.asset_id, watch.initiative_id):
        raise AssetWatchError(404, "watch_not_found")
    taken = (await snapshot(db, [watch.asset_id])).get(watch.asset_id)
    if taken is None:                   # the asset is deleted, and its watches with it
        raise AssetWatchError(404, "watch_not_found")
    current = watched_status(taken, watch.initiative_id)
    if current is None:
        raise AssetWatchError(422, "not_on_initiative")
    await _check(db, condition, status, current)

    before = {"condition": watch.condition, "status": watch.status}
    watch.condition, watch.status = condition, status
    watch.baseline = taken
    watch.created_at = datetime.now(UTC)
    await db.flush()
    _audit(db, person_id, "watch.update",
           {**_target(watch), **diff(before, {"condition": condition, "status": status})})
    return watch


async def remove_asset_watch(db: AsyncSession, person_id: uuid.UUID,
                             watch_id: uuid.UUID) -> None:
    """Stop one of the person's watches, whether or not they can still open its asset or
    initiative. It audits `watch.remove` and never commits. 404 `watch_not_found` when the
    watch isn't theirs."""
    watch = await _own(db, person_id, watch_id)
    _audit(db, person_id, "watch.remove", _target(watch))
    await db.delete(watch)


# ── showing them ────────────────────────────────────────────────────

def _label(labels: Mapping[str, tuple[str, str]], status: str | None) -> str | None:
    return status_fields(status, labels)["status_label"] if status is not None else None


async def _outs(db: AsyncSession, watches: Sequence[AssetWatch]) -> list[AssetWatchOut]:
    """Each watch as the API shows it, in order, in four queries however many there are. One
    whose asset is gone is left out."""
    if not watches:
        return []
    asset_ids = list({watch.asset_id for watch in watches})
    initiative_ids = list({watch.initiative_id for watch in watches
                           if watch.initiative_id is not None})
    assets = {asset.id: asset for asset in await db.scalars(
        select(Asset).where(Asset.id.in_(asset_ids)))}
    names: dict[uuid.UUID, str] = {}
    rows: dict[tuple[uuid.UUID, uuid.UUID], InitiativeAsset] = {}
    if initiative_ids:
        names = dict((await db.execute(select(Initiative.id, Initiative.name)
                                       .where(Initiative.id.in_(initiative_ids)))).all())
        rows = {(row.initiative_id, row.asset_id): row for row in await db.scalars(
            select(InitiativeAsset).where(InitiativeAsset.initiative_id.in_(initiative_ids),
                                          InitiativeAsset.asset_id.in_(asset_ids)))}
    labels = await status_labels(db, "asset")

    out = []
    for watch in watches:
        asset = assets.get(watch.asset_id)
        if asset is None:
            continue
        if watch.initiative_id is None:
            row, current = None, asset.status
        else:
            row = rows.get((watch.initiative_id, watch.asset_id))
            current = row.status if row is not None else None
        row_id = row.id if row is not None else None
        out.append(AssetWatchOut(
            id=watch.id, asset_id=watch.asset_id, asset_name=asset_label(asset),
            initiative_id=watch.initiative_id,
            initiative_name=names.get(watch.initiative_id) if watch.initiative_id else None,
            initiative_asset_id=row_id, condition=watch.condition, status=watch.status,
            status_label=_label(labels, watch.status), current_status=current,
            current_status_label=_label(labels, current),
            link=asset_watch_link(watch, row_id), created_at=watch.created_at))
    return out


async def asset_watch_out(db: AsyncSession, watch: AssetWatch) -> AssetWatchOut:
    """One watch as the API shows it, for the route that has just set or changed it. One whose
    asset is gone (and the watch with it) is 404 `watch_not_found`."""
    shown = await _outs(db, [watch])
    if not shown:
        raise AssetWatchError(404, "watch_not_found")
    return shown[0]


async def list_asset_watches(db: AsyncSession, person_id: uuid.UUID) -> list[AssetWatchOut]:
    """The person's asset watches, newest first. Only those whose asset, and initiative for one
    set there, they can open now are listed; the rest stay stored and are listed again once they
    can."""
    watches = (await db.scalars(
        select(AssetWatch).where(AssetWatch.person_id == person_id)
        .order_by(AssetWatch.created_at.desc(), AssetWatch.id))).all()
    return await _outs(db, await _visible(db, person_id, watches))


async def asset_watch_state(db: AsyncSession, person_id: uuid.UUID, asset_id: uuid.UUID,
                            initiative_id: uuid.UUID | None) -> AssetWatchStateOut:
    """Whether the person watches the asset in this place (on the asset itself when
    `initiative_id` is None), and the watch, for the Watch button. A watch on what they can't
    open now reads as none, as in the list, so the answer never names it."""
    watch = await _existing(db, person_id, asset_id, initiative_id)
    shown = await _outs(db, await _visible(db, person_id, [watch] if watch is not None else []))
    if not shown:
        return AssetWatchStateOut(watching=False, watch=None)
    return AssetWatchStateOut(watching=True, watch=shown[0])
