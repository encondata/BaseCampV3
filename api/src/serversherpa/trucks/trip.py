"""Trip start rule — one place for every writer of `trucks.status`.

A trip starts when a truck's status changes into `active` (loading) or
`in_transit` from any status other than those two, so Active -> In transit
keeps the same trip. `trucks.trip_started_at` records that moment; the
shipment map draws only the points reported since then.
"""

from datetime import UTC, datetime

from serversherpa.db.models import Truck

TRIP_STATUSES = frozenset({"active", "in_transit"})


def apply_status_change(truck: Truck, new_status: str,
                        now: datetime | None = None) -> bool:
    """Set `truck.status`, restarting the trip when the rule says so.
    Returns True when `trip_started_at` was reset."""
    old = truck.status
    truck.status = new_status
    if new_status in TRIP_STATUSES and old not in TRIP_STATUSES:
        truck.trip_started_at = now or datetime.now(UTC)
        return True
    return False


def start_trip_if_needed(truck: Truck, now: datetime | None = None) -> bool:
    """For a brand-new truck created already `active`/`in_transit`: its trip
    starts at creation."""
    if truck.status in TRIP_STATUSES:
        truck.trip_started_at = now or datetime.now(UTC)
        return True
    return False
