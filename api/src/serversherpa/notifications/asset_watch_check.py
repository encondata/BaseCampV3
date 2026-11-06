"""The asset-watch check, run by notification-worker every 60 s, after the device check and before
the event sweep (`run_asset_watches_once`). A person watching an asset (notifications/
asset_watches.py) hears once, the first time what the watch waits for happens, and the watch
ends. Each watch keeps a snapshot of its asset (`snapshot`), and the check compares it with the
asset as it is now, so no writer has to say what it changed. One check is one session and one
transaction:

1. **Claim** every watch with FOR UPDATE SKIP LOCKED (`_claim`): production runs two workers on
   one database, and neither takes what the other holds, so nobody hears twice. A watch its owner
   is changing or stopping right now is held by that request (asset_watches.py locks it) and
   waits for the next check.
2. **Compare.** A Next update watch is due once anything in its snapshot differs. A Status
   becomes watch is due once the status it reads (`watched_status`: the asset's own, or its
   row's on the initiative the watch was set on) is the one it waits for, or once the asset has
   left that initiative.
3. **Tell** the owner of each watch that is due, with one `asset_watch` notice written with
   notify(), so their switches, schedule and summary apply as to any other. Only while their
   account is in use (`active_ids`) and they can still open the asset, and the initiative too for
   a watch set there (notifications/access.py), the rule asset_watches.py sets and lists watches
   by; a watch whose person has lost either since ends without a notice. The text is written for
   its person: it names a container or a truck only to someone whose Assets list shows one
   (assets/placement.py), and an initiative only to someone who can open it.
4. **End** every watch that was due, told or not (an Inbox switch that is off writes nothing),
   and commit once: a check that fails keeps nothing, and the next one starts over.

Spec: docs/superpowers/specs/2026-11-05-asset-watches-design.md (What counts, How it's checked,
When it fires, Notice wording)"""

import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from serversherpa.access.resolver import AccessInfo, resolve_access_many
from serversherpa.access.scope import scope_conditions
from serversherpa.db.models import (
    Asset,
    AssetWatch,
    Container,
    Initiative,
    Person,
    ProcessedScan,
    Site,
    Truck,
)
from serversherpa.notifications.access import active_ids, visible_among
from serversherpa.notifications.asset_watches import (
    asset_label,
    asset_watch_link,
    snapshot,
    watched_status,
)
from serversherpa.notifications.inbox import notify
from serversherpa.services.timezone import DEFAULT_TIMEZONE
from serversherpa.status.labels import status_fields, status_labels


def watch_time(at: datetime) -> str:
    """A moment in the company reference zone with its abbreviation, 24-hour, as an asset
    watch's notice reads: "Nov 5, 15:05 EST". `at` must be timezone-aware."""
    local = at.astimezone(ZoneInfo(DEFAULT_TIMEZONE))
    return f"{local.strftime('%b')} {local.day}, {local:%H:%M} {local.strftime('%Z')}"


# ── what happened ───────────────────────────────────────────────────

@dataclass(frozen=True)
class _Change:
    """One thing about an asset that differs from a watch's snapshot of it, as a Next update
    notice can say it. `kind` is "scan" (a scan came in), "packed" or "unpacked" (into or out of
    the container `ref`), "loaded" or "unloaded" (its container onto or off the truck `ref`),
    "added" or "removed" (to or from the initiative `ref`), or "status" (the status the watch
    reads is now `ref`). Ids are strings, as a snapshot keeps them."""

    kind: str
    ref: str | None = None


def _moment(iso: str | None) -> datetime | None:
    return datetime.fromisoformat(iso) if iso is not None else None


def _new_scan(baseline: Mapping, current: Mapping) -> bool:
    """Whether a scan of the asset came in between two snapshots of it: it has more scans, or one
    later than the latest then. The count catches a scan stamped before the watch was set (a long
    transaction commits it late), which no time can."""
    before, after = baseline["scans"], current["scans"]
    if after["count"] > before["count"]:
        return True
    latest, previous = _moment(after["latest"]), _moment(before["latest"])
    return latest is not None and (previous is None or latest > previous)


def _initiatives(taken: Mapping) -> set[str]:
    """The initiatives a snapshot has the asset on."""
    return {row["initiative_id"] for row in taken["rows"].values()}


def _changes(watch: AssetWatch, current: Mapping) -> list[_Change]:
    """What differs between the watch's snapshot and `current`, a snapshot of its asset as it is
    now, in the order a notice gives them: a new scan, its container, its truck, the initiatives
    it was added to and then those it was removed from (in id order), and the status the watch
    reads. The rest of what can differ (its record, its rows' other fields) has no change of its
    own: a notice calls it a record update. Pure."""
    baseline = watch.baseline
    found: list[_Change] = []
    if _new_scan(baseline, current):
        found.append(_Change("scan"))
    if current["container_id"] != baseline["container_id"]:
        found.append(_Change("packed", current["container_id"])
                     if current["container_id"] is not None
                     else _Change("unpacked", baseline["container_id"]))
    if current["truck_id"] != baseline["truck_id"]:
        found.append(_Change("loaded", current["truck_id"])
                     if current["truck_id"] is not None
                     else _Change("unloaded", baseline["truck_id"]))
    was_on, is_on = _initiatives(baseline), _initiatives(current)
    found += [_Change("added", ref) for ref in sorted(is_on - was_on)]
    found += [_Change("removed", ref) for ref in sorted(was_on - is_on)]
    status = watched_status(current, watch.initiative_id)
    if status is not None and status != watched_status(baseline, watch.initiative_id):
        found.append(_Change("status", status))
    return found


def _due(watch: AssetWatch, current: Mapping | None) -> bool:
    """Whether the watch ends in this check: a Next update watch once its asset differs from its
    snapshot, a Status becomes watch once the status it reads is the one it waits for or there is
    none to read (the asset has left the initiative the watch was set on). One whose asset is
    gone (`current` None) ends too, as its watches go with it."""
    if current is None:
        return True
    if watch.condition == "next_update":
        return current != watch.baseline
    status = watched_status(current, watch.initiative_id)
    return status is None or status == watch.status


# ── what a notice names ─────────────────────────────────────────────

@dataclass(frozen=True)
class _Names:
    """What a check's notices name, loaded once for all of them: each asset as notices name it,
    by id; the sites, containers, trucks and initiatives by id string, as snapshots keep them;
    the people who ran the scans, by id; the asset status labels; and each asset's newest
    processed scan."""

    assets: Mapping[uuid.UUID, str]
    sites: Mapping[str, str]
    containers: Mapping[str, str]
    trucks: Mapping[str, str]
    initiatives: Mapping[str, str]
    people: Mapping[uuid.UUID, str]
    statuses: dict[str, tuple[str, str]]
    scans: Mapping[uuid.UUID, ProcessedScan]

    def label(self, status: str) -> str:
        return status_fields(status, self.statuses)["status_label"]


async def _by_name(db: AsyncSession, model: type, ids: Iterable[str | None]) -> dict[str, str]:
    """Each row's name by its id string, for the ids given (a None among them is skipped)."""
    wanted = [uuid.UUID(ref) for ref in set(ids) if ref is not None]
    if not wanted:
        return {}
    return {str(row_id): name for row_id, name in await db.execute(
        select(model.id, model.name).where(model.id.in_(wanted)))}


async def _names(db: AsyncSession, due: Sequence[AssetWatch],
                 snapshots: Mapping[uuid.UUID, Mapping]) -> _Names:
    """Everything the notices of `due` can name, in a fixed number of queries however many there
    are. Containers, trucks and initiatives are named from both snapshots, so the container an
    asset was taken out of has its name too. The newest scan of an asset is the latest by
    processed_at, as the snapshot dates its scans."""
    asset_ids = list({watch.asset_id for watch in due})
    scans = {scan.asset_id: scan for scan in await db.scalars(
        select(ProcessedScan).where(ProcessedScan.asset_id.in_(asset_ids))
        .distinct(ProcessedScan.asset_id)
        .order_by(ProcessedScan.asset_id, ProcessedScan.processed_at.desc(),
                  ProcessedScan.created_at.desc(), ProcessedScan.id))}
    taken = [watch.baseline for watch in due] + [snapshots[asset_id] for asset_id in asset_ids
                                                 if asset_id in snapshots]
    initiatives = {ref for shot in taken for ref in _initiatives(shot)}
    initiatives |= {str(watch.initiative_id) for watch in due if watch.initiative_id is not None}
    operators = {scan.operator_id for scan in scans.values() if scan.operator_id is not None}
    people = {person.id: person.display_name for person in await db.scalars(
        select(Person).where(Person.id.in_(operators)))} if operators else {}
    return _Names(
        assets={asset.id: asset_label(asset) for asset in await db.scalars(
            select(Asset).where(Asset.id.in_(asset_ids)))},
        sites=await _by_name(db, Site, [shot["asset"]["site_id"] for shot in taken]
                             + [str(scan.site_id) for scan in scans.values()
                                if scan.site_id is not None]),
        containers=await _by_name(db, Container, [shot["container_id"] for shot in taken]),
        trucks=await _by_name(db, Truck, [shot["truck_id"] for shot in taken]),
        initiatives=await _by_name(db, Initiative, initiatives),
        people=people,
        statuses=await status_labels(db, "asset"),
        scans=scans)


@dataclass(frozen=True)
class _Sight:
    """What one person may be told of beyond the asset itself: its container, and that
    container's truck, as their Assets list shows them (assets/placement.py), and the
    initiatives (id strings) they can open."""

    containers: bool
    trucks: bool
    initiatives: frozenset[str]


def _shown(access: AccessInfo, person_id: uuid.UUID, resource: str) -> bool:
    """Whether the person's Assets list shows a placement of this kind (assets/placement.py):
    they can view the resource, and its row scope leaves every row to them. Containers and trucks
    have no row scope, so only a global person sees them."""
    return access.can(resource, "view") and scope_conditions(resource, access, person_id) is None


def _sight(access: AccessInfo, person_id: uuid.UUID, initiatives: Iterable[uuid.UUID]) -> _Sight:
    containers = _shown(access, person_id, "containers")
    return _Sight(containers=containers,
                  trucks=containers and _shown(access, person_id, "trucks"),
                  initiatives=frozenset(str(ref) for ref in initiatives))


# ── the notice ──────────────────────────────────────────────────────

# What each change says, given the name it names.
_SAYS = {"packed": "packed into {}", "unpacked": "taken out of {}", "loaded": "loaded on {}",
         "unloaded": "taken off {}", "added": "added to {}", "removed": "removed from {}",
         "status": "status changed to {}"}


def _scan_text(scan: ProcessedScan, names: _Names) -> str:
    """A scan as a notice describes it: a status edit (recorded with no raw scan) "status set to
    {label} by {person}", an off-move sighting "seen off-move at {site}", and any other "scanned
    at {site}". The person or the site is left out when there is none."""
    if scan.raw_scan_id is None and scan.status is not None:
        label = names.label(scan.status)
        person = names.people.get(scan.operator_id) if scan.operator_id is not None else None
        return f"status set to {label} by {person}" if person else f"status set to {label}"
    site = names.sites.get(str(scan.site_id)) if scan.site_id is not None else None
    if scan.off_move:
        return f"seen off-move at {site}" if site else "seen off-move"
    return f"scanned at {site}" if site else "scanned"


def _named(change: _Change, names: _Names, sight: _Sight) -> str | None:
    """The name a change gives its person, or None when they may not be told of it: a container
    or a truck their Assets list doesn't show them, or an initiative they can't open."""
    if change.kind in ("packed", "unpacked"):
        return names.containers.get(change.ref) if sight.containers else None
    if change.kind in ("loaded", "unloaded"):
        return names.trucks.get(change.ref) if sight.trucks else None
    if change.kind in ("added", "removed"):
        return names.initiatives.get(change.ref) if change.ref in sight.initiatives else None
    return names.label(change.ref)


def _headline(found: Sequence[_Change], scan: ProcessedScan | None, names: _Names,
              sight: _Sight, at: datetime) -> tuple[str, datetime]:
    """What a Next update notice says happened, and when: the first of `found` its person may be
    told of, else "record updated". A scan is dated by its processed_at, anything else by `at`,
    the moment of the check. Pure."""
    for change in found:
        if change.kind == "scan":
            if scan is not None:
                return _scan_text(scan, names), scan.processed_at
            continue
        name = _named(change, names, sight)
        if name:
            return _SAYS[change.kind].format(name), at
    return "record updated", at


def _placement(current: Mapping, names: _Names, sight: _Sight) -> str:
    """Where the asset is, as its person's Assets list says it (the portal's `placementText`,
    lib/assets.ts): "{container} · on {truck}", the container alone, or the location text."""
    container = names.containers.get(current["container_id"]) if sight.containers else None
    if container:
        truck = names.trucks.get(current["truck_id"]) if sight.trucks else None
        return f"{container} · on {truck}" if truck else container
    return current["asset"]["location_detail"] or ""


def _now_line(watch: AssetWatch, current: Mapping, names: _Names, sight: _Sight) -> str:
    """"Now: {status} · {site} · {placement}", the asset as it is now; a part that is missing is
    left out. The status is the one the watch reads, or the asset's own once there is none (the
    asset has left the initiative)."""
    status = watched_status(current, watch.initiative_id) or current["asset"]["status"]
    parts = (names.label(status), names.sites.get(current["asset"]["site_id"]),
             _placement(current, names, sight))
    return "Now: " + " · ".join(part for part in parts if part)


def _notice(watch: AssetWatch, current: Mapping, names: _Names, sight: _Sight,
            at: datetime) -> tuple[str, str]:
    """The watch's notice, its title and its body, in the spec's words: the asset as notices
    name it, what happened (a Next update watch) or the status it reached (a Status becomes
    watch), the asset as it is now, and when the watch was set. A Status becomes watch whose
    asset has left the initiative says so instead. Pure."""
    asset = names.assets.get(watch.asset_id, str(watch.asset_id))
    initiative = (names.initiatives.get(str(watch.initiative_id), str(watch.initiative_id))
                  if watch.initiative_id is not None else None)
    scan = names.scans.get(watch.asset_id) if _new_scan(watch.baseline, current) else None
    now_line = _now_line(watch, current, names, sight)
    set_on = watch_time(watch.created_at)
    if watch.condition == "next_update":
        what, when = _headline(_changes(watch, current), scan, names, sight, at)
        lines = [f"{what[:1].upper()}{what[1:]} · {watch_time(when)}", now_line]
        if initiative is not None:
            lines.append(f"On {initiative}")
        lines.append(f"You set this watch on {set_on} for its next update.")
        return f"{asset}: {what}", "\n".join(lines)

    label = names.label(watch.status)
    if watched_status(current, watch.initiative_id) is None:     # it has left the initiative
        return (f"{asset} was removed from {initiative}",
                "\n".join([f"Your watch for status {label} on it has ended.", now_line]))
    title = (f"{asset} is now {label}" if initiative is None
             else f"{asset} is now {label} on {initiative}")
    lines = [now_line]
    if scan is not None:
        lines.append(f"Last scan: {_scan_text(scan, names)} · {watch_time(scan.processed_at)}")
    lines.append(f"You set this watch on {set_on} for status {label}.")
    return title, "\n".join(lines)


def _row_id(current: Mapping, initiative_id: uuid.UUID | None) -> uuid.UUID | None:
    """The asset's row on the initiative in a snapshot of it, or None: it has none there, or the
    watch is on the asset itself."""
    if initiative_id is None:
        return None
    wanted = str(initiative_id)
    return next((uuid.UUID(row_id) for row_id, row in current["rows"].items()
                 if row["initiative_id"] == wanted), None)


# ── the check ───────────────────────────────────────────────────────

async def _claim(db: AsyncSession) -> list[AssetWatch]:
    """Every watch no other check or request holds, oldest first, locked until this check
    commits."""
    return list(await db.scalars(
        select(AssetWatch).order_by(AssetWatch.created_at, AssetWatch.id)
        .with_for_update(skip_locked=True)))


async def _tell(db: AsyncSession, due: Sequence[AssetWatch],
                snapshots: Mapping[uuid.UUID, Mapping], at: datetime) -> None:
    """Send each due watch's notice to its person, if their account is in use and they can still
    open its asset, and its initiative too for a watch set on one. Everyone's access is resolved
    once, and asked once per kind of thing however many watches there are."""
    active = await active_ids(db, [watch.person_id for watch in due])
    if not active:
        return
    access = await resolve_access_many(db, active)
    names = await _names(db, due, snapshots)
    assets = await visible_among(db, "asset", [watch.asset_id for watch in due], active,
                                 access=access)
    initiatives = await visible_among(db, "initiative",
                                      [uuid.UUID(ref) for ref in names.initiatives], active,
                                      access=access)
    for watch in due:
        current = snapshots.get(watch.asset_id)
        if current is None or watch.person_id not in active:
            continue
        if watch.asset_id not in assets.get(watch.person_id, frozenset()):
            continue
        opens = initiatives.get(watch.person_id, frozenset())
        if watch.initiative_id is not None and watch.initiative_id not in opens:
            continue
        sight = _sight(access[watch.person_id], watch.person_id, opens)
        title, body = _notice(watch, current, names, sight, at)
        link = asset_watch_link(watch, _row_id(current, watch.initiative_id))
        await notify(db, watch.person_id, "asset_watch", title, body=body, link=link)


async def run_asset_watches_once(maker: async_sessionmaker, *,
                                 now: datetime | None = None) -> int:
    """One check. Returns how many watches ended: every one that was due, whether its person was
    told or not. `now` (aware) is the moment of the check, which a notice gives for a change
    that isn't a scan; it defaults to the current time."""
    now = datetime.now(UTC) if now is None else now
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    async with maker() as db:
        watches = await _claim(db)
        snapshots = await snapshot(db, [watch.asset_id for watch in watches])
        due = [watch for watch in watches if _due(watch, snapshots.get(watch.asset_id))]
        if due:
            await _tell(db, due, snapshots, now)
            for watch in due:
                await db.delete(watch)
        await db.commit()
    return len(due)
