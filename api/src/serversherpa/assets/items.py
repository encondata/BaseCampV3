"""The one builder of `AssetItem` — the asset record every asset list and
detail response carries (status/model/client/site lookups plus placement).
Set-based: the number of queries does not grow with the number of assets."""

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext
from serversherpa.api.schemas import AssetItem, AssetModelRef
from serversherpa.assets.placement import asset_placements
from serversherpa.db.models import (
    Asset,
    AssetCategory,
    AssetModel,
    Client,
    Site,
    StatusValue,
)


async def asset_statuses(db: AsyncSession) -> dict[str, tuple[str, str]]:
    return {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}


async def _model_refs(db: AsyncSession, model_ids: set[uuid.UUID]) -> dict:
    if not model_ids:
        return {}
    cats = {c.key: (c.label, c.color)
            for c in await db.scalars(select(AssetCategory))}
    models = (await db.scalars(
        select(AssetModel).where(AssetModel.id.in_(model_ids)))).all()
    out = {}
    for m in models:
        label, color = (cats.get(m.category, (m.category, "#51606f"))
                        if m.category is not None else (None, None))
        out[m.id] = AssetModelRef(
            id=m.id, make=m.make, model=m.model, category=m.category,
            category_label=label, category_color=color, ru_size=m.ru_size)
    return out


async def asset_items(db: AsyncSession, assets: Sequence[Asset],
                      actor: AuthContext) -> list[AssetItem]:
    """AssetItems for `assets`, in the same order."""
    statuses = await asset_statuses(db)
    models = await _model_refs(db, {a.model_id for a in assets if a.model_id})
    client_ids = {a.client_id for a in assets if a.client_id}
    clients = dict((await db.execute(
        select(Client.id, Client.name).where(Client.id.in_(client_ids))
    )).all()) if client_ids else {}
    site_ids = {a.site_id for a in assets if a.site_id}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    places = await asset_placements(
        db, [a.id for a in assets], actor.access, actor.person.id)

    out = []
    for a in assets:
        label, color = statuses.get(a.status, (a.status, "#51606f"))
        place = places.get(a.id)
        out.append(AssetItem(
            id=a.id, legacy_id=a.legacy_id,
            serial_number=a.serial_number, name=a.name,
            rfid_tag=a.rfid_tag, pod_number=a.pod_number,
            model_id=a.model_id, model=models.get(a.model_id),
            client_id=a.client_id, client_name=clients.get(a.client_id),
            site_id=a.site_id, site_name=sites.get(a.site_id),
            location_detail=a.location_detail,
            status=a.status, status_label=label, status_color=color,
            has_rails=a.has_rails, last_seen_at=a.last_seen_at,
            archived_at=a.archived_at, created_at=a.created_at,
            container_id=place.container_id if place else None,
            container_name=place.container_name if place else None,
            truck_id=place.truck_id if place else None,
            truck_name=place.truck_name if place else None,
        ))
    return out
