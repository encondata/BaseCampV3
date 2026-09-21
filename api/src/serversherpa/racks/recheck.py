"""Apply the placement rule to one move's roster and move rows between the
three placement statuses. Called by the importer after its commit pass
and by POST /initiatives/{id}/assets/recheck-placement.

Only rows currently in one of RESETTABLE are ever restated; a row that
has progressed (labeled, racked, complete ...) keeps its status and is
not counted, even if it sits in a collision. A row in any conflict gets
COLLISION; a row that is only an orphan gets ORPHAN; a flagged row whose
condition is gone goes back to CLEAR. Statuses are set directly, the
same way the importer always has; this is not a manual status edit and
does not go through record_status_edit. The caller owns the commit.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, AssetModel, InitiativeAsset
from serversherpa.racks.placement import Placed, evaluate, place

CLEAR = "loaded_in_system"
COLLISION = "location_collision"
ORPHAN = "orphan_node"
RESETTABLE = frozenset({CLEAR, COLLISION, ORPHAN})


async def recheck_placement(db: AsyncSession, initiative_id: uuid.UUID) -> dict:
    rows = (await db.execute(
        select(InitiativeAsset, Asset.name, Asset.serial_number,
               AssetModel.ru_size, AssetModel.form_factor)
        .join(Asset, Asset.id == InitiativeAsset.asset_id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == initiative_id))).all()

    placed: list[Placed] = []
    for ia, name, serial, ru_size, form_factor in rows:
        if ia.destination_rack and ia.destination_ru is not None:
            placed.append(place(key=str(ia.id), label=name or serial or "",
                                rack=ia.destination_rack, ru=ia.destination_ru,
                                height=ru_size, form_factor=form_factor))
    result = evaluate(placed)
    colliding = result.colliding_keys
    orphaned = result.orphan_keys - colliding

    collisions = orphans = cleared = 0
    for ia, *_ in rows:
        key = str(ia.id)
        want = COLLISION if key in colliding else ORPHAN if key in orphaned else None
        if want is None:
            if ia.status in (COLLISION, ORPHAN):
                ia.status = CLEAR
                cleared += 1
            continue
        if ia.status in RESETTABLE:
            ia.status = want
        if ia.status == COLLISION:
            collisions += 1
        elif ia.status == ORPHAN:
            orphans += 1
    return {"checked": result.checked, "collisions": collisions,
            "orphans": orphans, "cleared": cleared}
