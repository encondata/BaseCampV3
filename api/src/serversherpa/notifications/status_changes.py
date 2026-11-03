"""The two status changes that announce themselves: an initiative's and a truck's.
Each helper builds the event (title, link and the things it reaches) and hands it to
announce(), so it joins the caller's transaction; the caller commits. A caller
announces only when the status really changed, and creating either thing announces
nothing.

An initiative's change reaches its parents (every level up the link graph) and its
sites; a truck's reaches its initiative and that one's parents, and its start and end
sites. Parents come in id order, so the stored list is the same every time.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5)"""

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, NotificationEvent, Truck
from serversherpa.notifications.events import EventItem, Thing, announce
from serversherpa.services.initiatives import ancestor_ids
from serversherpa.services.timezone import DEFAULT_TIMEZONE
from serversherpa.status.labels import status_labels


def event_time(at: datetime) -> str:
    """A moment in the company reference zone with its abbreviation, as it reads on
    a notification line: "Nov 2, 3:04 PM EST". `at` must be timezone-aware."""
    local = at.astimezone(ZoneInfo(DEFAULT_TIMEZONE))
    return (f"{local.strftime('%b')} {local.day}, {local.hour % 12 or 12}:{local.minute:02d} "
            f"{local.strftime('%p %Z')}")


def _title(name: str, old: str, new: str, labels: dict[str, tuple[str, str]]) -> str:
    """"{name}: {old label} → {new label}". A status with no label shows as its key."""
    def label(key: str) -> str:
        return labels[key][0] if key in labels else key

    return f"{name}: {label(old)} → {label(new)}"


async def _parents(db: AsyncSession, initiative_id: uuid.UUID) -> list[Thing]:
    """Every initiative above this one, in id order."""
    return [Thing("initiative", parent) for parent in sorted(await ancestor_ids(db, initiative_id))]


def _sites(*site_ids: uuid.UUID | None) -> list[Thing]:
    """The sites that are set."""
    return [Thing("site", site_id) for site_id in site_ids if site_id is not None]


async def announce_initiative_status_changed(
        db: AsyncSession, initiative: Initiative, *, old: str, new: str,
        actor_id: uuid.UUID | None) -> NotificationEvent:
    """Announce that `initiative` moved from status `old` to `new`. It reaches the
    initiatives above it, then its site, origin site and destination site."""
    labels = await status_labels(db, "initiative")
    reaches = [*await _parents(db, initiative.id),
               *_sites(initiative.site_id, initiative.origin_site_id,
                       initiative.destination_site_id)]
    return announce(
        db, "initiative_status_changed",
        subject=Thing("initiative", initiative.id),
        item=EventItem(_title(initiative.name, old, new, labels),
                       link=f"/initiatives/{initiative.id}", initiative_id=initiative.id),
        reaches=reaches, actor_id=actor_id)


async def announce_truck_status_changed(
        db: AsyncSession, truck: Truck, *, old: str, new: str, actor_id: uuid.UUID | None,
        at: datetime | None = None) -> NotificationEvent:
    """Announce that `truck` moved from status `old` to `new`. It reaches the truck's
    initiative and the initiatives above that one, then its start and end sites. `at`
    is when it happened, for a change applied after the fact (a MacroPoint message);
    the line then says when."""
    labels = await status_labels(db, "truck")
    reaches: list[Thing] = []
    if truck.initiative_id is not None:
        reaches = [Thing("initiative", truck.initiative_id),
                   *await _parents(db, truck.initiative_id)]
    reaches += _sites(truck.start_site_id, truck.end_site_id)
    return announce(
        db, "truck_status_changed",
        subject=Thing("truck", truck.id),
        item=EventItem(_title(truck.name, old, new, labels),
                       line=event_time(at) if at is not None else "",
                       link=f"/logistics/trucks/{truck.id}",
                       initiative_id=truck.initiative_id, at=at),
        reaches=reaches, actor_id=actor_id)
