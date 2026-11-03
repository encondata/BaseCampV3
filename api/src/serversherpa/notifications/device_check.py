"""The device check, run by notification-worker every 60 s just before the event sweep
(`run_device_check_once`). It tells people when a covered device stops checking in: an RFID
Station, a fixed reader or an approved router. services/device_online.py says which devices are
covered, when each one reads as offline, where each lives in the portal and what it is called
there. One check is one session and one transaction:

1. **Maintenance.** Read-only mode refuses heartbeats, so every station would look offline. A
   check that sees it on stays quiet until the longest threshold from now (`quiet_until` in
   the state the worker keeps between checks; the worker loop pushes it too while it is
   paused, because the check doesn't run then, and sets it when the worker starts, because a
   new process can't tell whether read-only mode ended a moment ago). A device still offline
   once the window passes is announced then.
2. **Clear.** A device with a notice out (`offline_notified_at`) that is seen again, or is no
   longer covered, has its notice cleared, so its next outage is announced. This happens while
   quiet too.
3. **Announce,** unless quiet. The covered devices with no notice out that could be offline
   now are claimed with FOR UPDATE SKIP LOCKED (production runs two workers on one database):
   those quiet for longer than the shortest threshold, and the readers reported unreachable.
   A device seen recently with no notice out is not locked at all, so its heartbeat never
   waits on the check. Each claimed device that is offline now (`is_offline` decides) is
   announced (`device_offline`) and marked with `now`: one notice per outage.
4. **Commit** once: a check that fails keeps nothing, and the next one starts over.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5, Device offline)
"""

from collections.abc import Mapping
from datetime import UTC, datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from serversherpa.db.models import Device
from serversherpa.notifications.events import EventItem, Thing, announce
from serversherpa.notifications.status_changes import event_time
from serversherpa.services.device_online import (
    KIOSK_ONLINE,
    LONGEST_THRESHOLD,
    READER_STALE_AFTER,
    ROUTER_ONLINE,
    covered,
    covered_clause,
    device_link,
    device_list_link,
    display_name,
    is_offline,
    kind_label,
)
from serversherpa.services.initiatives import ancestor_ids
from serversherpa.status.labels import status_labels
from serversherpa.system.admin_config import read_admin_config

# No covered device reads as offline sooner than this after it was last seen, short of a reader
# reported unreachable: the claim leaves every device seen more recently alone.
_SHORTEST_THRESHOLD = min(KIOSK_ONLINE, ROUTER_ONLINE, READER_STALE_AFTER)


def keep_quiet(state: dict, now: datetime) -> None:
    """Keep the check quiet until the longest threshold after `now` (aware): devices that
    could not check in during maintenance get that long to come back before anyone is told."""
    state["quiet_until"] = now + LONGEST_THRESHOLD


async def _clear(db: AsyncSession, now: datetime) -> None:
    """Clear the notice of each device that is seen again or no longer covered. A device
    another check holds is left to that one."""
    for device in list(await db.scalars(
            select(Device).where(Device.offline_notified_at.is_not(None))
            .with_for_update(skip_locked=True))):
        if not covered(device) or not is_offline(device, now):
            device.offline_notified_at = None


async def _announce(db: AsyncSession, device: Device, vocab: Mapping[str, str]) -> None:
    """Announce that `device` has stopped checking in. It reaches the device's site, then its
    current initiative and the initiatives above that one, in id order. Nobody caused it."""
    reaches: list[Thing] = []
    if device.site_id is not None:
        reaches.append(Thing("site", device.site_id))
    if device.current_initiative_id is not None:
        reaches.append(Thing("initiative", device.current_initiative_id))
        reaches += [Thing("initiative", parent) for parent in sorted(
            await ancestor_ids(db, device.current_initiative_id))]
    announce(
        db, "device_offline",
        subject=Thing("device", device.id),
        item=EventItem(f"{display_name(device)} is offline",
                       line=(f"{kind_label(device, vocab)} · last seen "
                             f"{event_time(device.last_seen_at)}"),
                       link=device_link(device), initiative_id=device.current_initiative_id,
                       list_link=device_list_link(device)),
        reaches=reaches)


async def _announce_offline(db: AsyncSession, now: datetime) -> int:
    """Claim the covered devices with no notice out that could be offline at `now` (quiet for
    longer than the shortest threshold, or a reader reported unreachable), then announce each
    one that is offline and mark it. Returns how many were announced. The claim only narrows
    what is locked, on the check's own clock; `is_offline` decides, so a router quiet for 3
    minutes 30 seconds (its threshold is 4) is claimed and left alone."""
    claimed = list(await db.scalars(
        select(Device)
        .where(covered_clause(), Device.offline_notified_at.is_(None),
               Device.last_seen_at.is_not(None),
               or_(Device.last_seen_at < now - _SHORTEST_THRESHOLD,
                   and_(Device.device_type == "fixed_reader",
                        Device.raw_info["reachable"].astext == "false")))
        .order_by(Device.last_seen_at, Device.id)       # the one quiet longest first
        .with_for_update(skip_locked=True)))
    offline = [device for device in claimed if is_offline(device, now)]
    if not offline:
        return 0
    vocab = {key: label for key, (label, _color) in
             (await status_labels(db, "device_type")).items()}
    for device in offline:
        await _announce(db, device, vocab)
        device.offline_notified_at = now
    return len(offline)


async def run_device_check_once(maker: async_sessionmaker, *, now: datetime | None = None,
                                state: dict | None = None) -> int:
    """One check. Returns how many devices it announced offline. `state` carries the quiet
    window from one check to the next (the worker keeps it); without one, a check that sees
    read-only mode on still stays quiet itself. `now` (aware) defaults to the current time."""
    now = datetime.now(UTC) if now is None else now
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    state = {} if state is None else state
    async with maker() as db:
        if (await read_admin_config(db))["read_only"]:
            keep_quiet(state, now)
        await _clear(db, now)
        quiet_until = state.get("quiet_until")
        quiet = quiet_until is not None and now < quiet_until
        announced = 0 if quiet else await _announce_offline(db, now)
        await db.commit()
    return announced
