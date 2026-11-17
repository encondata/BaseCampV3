"""Where an asset is right now: the container it is in and the truck that
container is on. Set-based (two queries however many assets), permission
aware (containers:view / trucks:view plus row scope), archived rows skipped.
`container_position` answers where one container is on a map: its truck's
newest GPS report, else its site's pin, else nothing."""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import AccessInfo
from serversherpa.access.scope import scope_conditions
from serversherpa.db.models import (
    Container,
    ContainerAsset,
    Site,
    Truck,
    TruckContainer,
    TruckUpdate,
)


@dataclass(frozen=True)
class Placement:
    container_id: uuid.UUID
    container_name: str
    truck_id: uuid.UUID | None = None
    truck_name: str | None = None


async def asset_placements(
    db: AsyncSession, asset_ids: Iterable[uuid.UUID],
    access: AccessInfo, person_id: uuid.UUID,
) -> dict[uuid.UUID, Placement]:
    """asset id -> Placement for assets the actor may see in a container.
    Assets with no (visible) container are absent. A truck is reported only
    alongside a visible container, and only when the actor may view trucks;
    when a container is on several trucks the latest `added_at` wins."""
    ids = list(set(asset_ids))
    if not ids or not access.can("containers", "view"):
        return {}
    # one array parameter, not one bind per id: a ~15k-asset list stays
    # well under the driver's bind-parameter cap
    id_array = sa.literal(ids, ARRAY(sa.Uuid))
    query = (
        sa.select(ContainerAsset.asset_id, Container.id, Container.name)
        .join(Container, Container.id == ContainerAsset.container_id)
        .where(ContainerAsset.asset_id == sa.any_(id_array),
               Container.archived_at.is_(None)))
    cond = scope_conditions("containers", access, person_id)
    if cond is not None:
        query = query.where(cond)
    rows = (await db.execute(query)).all()
    if not rows:
        return {}
    out = {asset_id: Placement(container_id=cid, container_name=cname)
           for asset_id, cid, cname in rows}

    if access.can("trucks", "view"):
        cids = list({r[1] for r in rows})
        tq = (
            sa.select(TruckContainer.container_id, Truck.id, Truck.name)
            .join(Truck, Truck.id == TruckContainer.truck_id)
            .where(TruckContainer.container_id == sa.any_(
                       sa.literal(cids, ARRAY(sa.Uuid))),
                   Truck.archived_at.is_(None))
            .order_by(TruckContainer.added_at.desc(), Truck.id))
        tcond = scope_conditions("trucks", access, person_id)
        if tcond is not None:
            tq = tq.where(tcond)
        latest: dict[uuid.UUID, tuple[uuid.UUID, str]] = {}
        for cid, tid, tname in (await db.execute(tq)).all():
            latest.setdefault(cid, (tid, tname))      # first row = latest
        for asset_id, p in out.items():
            hit = latest.get(p.container_id)
            if hit is not None:
                out[asset_id] = Placement(
                    container_id=p.container_id,
                    container_name=p.container_name,
                    truck_id=hit[0], truck_name=hit[1])
    return out


@dataclass(frozen=True)
class Position:
    kind: Literal["truck", "site", "none"]
    name: str | None = None
    lat: float | None = None
    lng: float | None = None
    recorded_at: datetime | None = None
    approximate_address: str = ""


async def container_position(
    db: AsyncSession, container: Container,
    access: AccessInfo, person_id: uuid.UUID,
) -> Position:
    """Where a container is, for a map. The caller has loaded it and passed
    the container gate. Its latest in-scope truck wins when the actor may
    view trucks (coordinates from that truck's newest report that has them,
    none when it has none; never the site). Otherwise its site's pin when
    the actor may view sites; otherwise nothing."""
    if access.can("trucks", "view"):
        tq = (
            sa.select(Truck.id, Truck.name)
            .join(TruckContainer, TruckContainer.truck_id == Truck.id)
            .where(TruckContainer.container_id == container.id,
                   Truck.archived_at.is_(None))
            .order_by(TruckContainer.added_at.desc(), Truck.id)
            .limit(1))
        tcond = scope_conditions("trucks", access, person_id)
        if tcond is not None:
            tq = tq.where(tcond)
        truck = (await db.execute(tq)).first()
        if truck is not None:
            report = (await db.execute(
                sa.select(TruckUpdate.lat, TruckUpdate.lng,
                          TruckUpdate.recorded_at,
                          TruckUpdate.approximate_address)
                .where(TruckUpdate.truck_id == truck.id,
                       TruckUpdate.lat.is_not(None),
                       TruckUpdate.lng.is_not(None))
                .order_by(TruckUpdate.recorded_at.desc(),
                          TruckUpdate.id.desc())
                .limit(1))).first()
            if report is None:
                return Position("truck", truck.name)
            return Position("truck", truck.name, report.lat, report.lng,
                            report.recorded_at, report.approximate_address)

    if container.site_id is not None and access.can("sites", "view"):
        sq = sa.select(Site.name, Site.latitude, Site.longitude).where(
            Site.id == container.site_id)
        scond = scope_conditions("sites", access, person_id)
        if scond is not None:
            sq = sq.where(scond)
        site = (await db.execute(sq)).first()
        if site is not None and site.latitude is not None \
                and site.longitude is not None:
            return Position("site", site.name, float(site.latitude),
                            float(site.longitude))
    return Position("none")
