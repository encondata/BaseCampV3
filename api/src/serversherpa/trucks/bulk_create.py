"""Numbered truck batches for Create a move in steps: every truck is
attached to the move and starts at its origin and ends at its destination;
drivers, loads and tracking are filled in per truck later. One create audit
per truck, the same shape POST /trucks writes. Never commits."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Truck
from serversherpa.services.audit import audit, snapshot

TRUCK_FIELDS = [
    "name", "driver_name", "co_driver_name", "team_drive", "contact_info",
    "status", "load_number", "seal_id", "tracking_type",
    "initiative_id", "start_site_id", "end_site_id",
]


class TruckBulkError(Exception):
    def __init__(self, code: str, names: list[str]) -> None:
        super().__init__(code)
        self.code = code
        self.names = names


async def find_clashes(db: AsyncSession, names: list[str]) -> list[str]:
    if not names:
        return []
    existing = {n.lower() for n in await db.scalars(
        select(Truck.name).where(Truck.name.in_(names), Truck.archived_at.is_(None)))}
    return [name for name in names if name.lower() in existing]


async def create_trucks(
    db: AsyncSession, names: list[str], initiative_id: uuid.UUID | None,
    start_site_id: uuid.UUID | None, end_site_id: uuid.UUID | None,
    actor: uuid.UUID | None,
) -> list[Truck]:
    if clashes := await find_clashes(db, names):
        raise TruckBulkError("name_collision", clashes)
    trucks = [Truck(name=name, status="created", contact_info="", team_drive=False,
                    tracking_type={}, initiative_id=initiative_id,
                    start_site_id=start_site_id, end_site_id=end_site_id, created_by=actor)
              for name in names]
    db.add_all(trucks)
    await db.flush()
    for truck in trucks:
        initial = snapshot(truck, TRUCK_FIELDS)
        changes = {field: {"from": None, "to": value}
                   for field, value in initial.items() if value not in (None, "", {}, False)}
        audit(db, actor_id=actor, entity_type="truck", entity_id=str(truck.id),
              action="create", changes=changes)
    return trucks
