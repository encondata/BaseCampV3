"""Step 1 of the Move Report: read the initiative + its asset roster into
plain dataclasses. Nothing downstream touches the ORM."""

import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, AssetCategory, AssetModel, Client, Initiative, InitiativeAsset, Site,
    StatusValue,
)


class InitiativeUnavailable(Exception):
    """The initiative is gone or archived — the run fails with this reason."""


def _f(v: Decimal | None) -> float | None:
    return None if v is None else float(v)


@dataclass(frozen=True)
class MoveAsset:
    row_id: str
    asset_id: str
    name: str | None
    serial: str | None
    make: str | None
    model: str | None
    ru_size: int | None
    weight_lbs: Decimal | None
    weight_kg: Decimal | None
    length_in: Decimal | None
    width_in: Decimal | None
    height_in: Decimal | None
    rail_type: str | None
    priority_wave: str | None
    source_rack: str | None
    source_ru: float | None
    source_verified: bool | None
    source_position: str | None
    destination_rack: str | None
    destination_ru: float | None
    destination_verified: bool | None
    destination_position: str | None
    # Model category (asset_categories via AssetModel.category) — the rack
    # renderer fills faceplates with the category color, exactly as the
    # portal's RackViewModal does. Defaulted so fixtures without a category
    # keep constructing.
    category_label: str | None = None
    category_color: str | None = None
    # Model form factor: standalone | chassis | node | None. Read by the
    # placement rule and the rail report; defaulted so fixtures without
    # one keep constructing.
    form_factor: str | None = None

    @property
    def label(self) -> str:
        return self.name or self.serial or "—"

    @property
    def make_model(self) -> str:
        return " ".join(p for p in (self.make, self.model) if p) or "—"

    def to_row(self) -> dict:
        """The subset of the portal's InitiativeAssetRow that rackLayout()
        reads — fed to the Node rack renderer as JSON."""
        return {
            "id": self.row_id,
            "source_rack": self.source_rack, "source_ru": self.source_ru,
            "source_verified": self.source_verified, "source_position": self.source_position,
            "destination_rack": self.destination_rack, "destination_ru": self.destination_ru,
            "destination_verified": self.destination_verified,
            "destination_position": self.destination_position,
            "asset": {"name": self.name, "serial_number": self.serial,
                      "ru_size": self.ru_size, "model_make": self.make,
                      "model_name": self.model,
                      "model_category_label": self.category_label,
                      "model_category_color": self.category_color},
        }


@dataclass(frozen=True)
class SiteInfo:
    name: str
    address: str


@dataclass(frozen=True)
class MoveData:
    id: str
    name: str
    initiative_type: str
    type_label: str
    status: str
    status_label: str
    client_name: str | None
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    origin_site: SiteInfo | None
    destination_site: SiteInfo | None
    assets: list[MoveAsset]


def _site_info(site: Site | None) -> SiteInfo | None:
    if site is None:
        return None
    city_region = ", ".join(p for p in (site.city, site.region) if p)
    parts = [site.address_line1, site.address_line2,
             " ".join(p for p in (city_region, site.postal_code) if p)]
    return SiteInfo(name=site.name, address="\n".join(p for p in parts if p))


async def gather(db: AsyncSession, initiative_id: uuid.UUID) -> MoveData:
    ini = await db.get(Initiative, initiative_id)
    if ini is None or ini.archived_at is not None:
        raise InitiativeUnavailable(str(initiative_id))
    labels = {(s.record_type, s.key): s.label for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type.in_(("initiative", "initiative_type"))))}
    client = await db.get(Client, ini.client_id) if ini.client_id else None
    origin = await db.get(Site, ini.origin_site_id) if ini.origin_site_id else None
    dest = await db.get(Site, ini.destination_site_id) if ini.destination_site_id else None

    rows = (await db.execute(
        select(InitiativeAsset, Asset, AssetModel, AssetCategory)
        .join(Asset, Asset.id == InitiativeAsset.asset_id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .outerjoin(AssetCategory, AssetCategory.key == AssetModel.category)
        .where(InitiativeAsset.initiative_id == initiative_id)
        .order_by(Asset.name.nullslast(), Asset.serial_number))).all()
    assets = [MoveAsset(
        row_id=str(ia.id), asset_id=str(a.id), name=a.name, serial=a.serial_number,
        make=m.make if m else None, model=m.model if m else None,
        ru_size=m.ru_size if m else None,
        weight_lbs=m.weight_lbs if m else None, weight_kg=m.weight_kg if m else None,
        length_in=m.length_in if m else None, width_in=m.width_in if m else None,
        height_in=m.height_in if m else None, rail_type=m.rail_type if m else None,
        priority_wave=ia.priority_wave,
        source_rack=ia.source_rack, source_ru=_f(ia.source_ru),
        source_verified=ia.source_verified, source_position=ia.source_position,
        destination_rack=ia.destination_rack, destination_ru=_f(ia.destination_ru),
        destination_verified=ia.destination_verified,
        destination_position=ia.destination_position,
        category_label=cat.label if cat else None,
        category_color=cat.color if cat else None,
        form_factor=m.form_factor if m else None,
    ) for ia, a, m, cat in rows]

    return MoveData(
        id=str(ini.id), name=ini.name, initiative_type=ini.initiative_type,
        type_label=labels.get(("initiative_type", ini.initiative_type), ini.initiative_type),
        status=ini.status, status_label=labels.get(("initiative", ini.status), ini.status),
        client_name=client.name if client else None,
        scheduled_start=ini.scheduled_start, scheduled_end=ini.scheduled_end,
        origin_site=_site_info(origin), destination_site=_site_info(dest), assets=assets)
