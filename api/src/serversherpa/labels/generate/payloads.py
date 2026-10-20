"""ORM rows -> the kiosk sync item shapes that labels/fields.py
`field_values` reads.

/kiosk/sync/assets builds each item with `asset_payload` (and adds only
the code-template `label` map), /kiosk/sync/containers each item with
`container_payload`, and the portal hands the same dicts to `field_values`
— so a label the laptop edge prints from the sync JSON carries exactly the
text the portal computes from the database. `label_context` is the move
half both read, the sync's `label_context` minus its `catalog_keys`.

Not pure (it reads ORM rows and, in `load_status_labels`, the database); the
pure half is labels/fields.py."""

import json
import uuid
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset,
    AssetModel,
    Container,
    Initiative,
    InitiativeAsset,
    Site,
    StatusValue,
)
from serversherpa.labels.label_values import make_model_text
from serversherpa.services.timezone import stored_day


async def load_status_labels(db: AsyncSession, record_type: str) -> dict[str, str]:
    """{key: label} for one status vocabulary, inactive keys included (a
    row can still sit on a retired status)."""
    return dict((await db.execute(
        select(StatusValue.key, StatusValue.label)
        .where(StatusValue.record_type == record_type))).all())


def ru_plain(ru: Decimal | None) -> str | None:
    """A roster RU (Numeric) as plain text: 14 -> "14", 14.50 -> "14.5"
    (labels.fields.ru_text is the label side: any synced RU, blank as "")."""
    if ru is None:
        return None
    return format(ru.normalize(), "f")


def ru_raw(ru: Decimal | None) -> str | None:
    """The stored RU exactly ("14.50"), so the edge rebuilds the Decimal."""
    return None if ru is None else str(ru)


def cable_info_dict(raw: str | None) -> dict | None:
    """The roster's `cable_info` TEXT as a dict: the From-To importer's JSON
    object ({"data_1".."data_6", "mgmt_1", "mgmt_2"}) as is, anything else
    (seeded or typed free text) as {"text": ...}; None when blank."""
    if raw is None or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return {"text": raw}
    return parsed if isinstance(parsed, dict) else {"text": raw}


def _label(labels: dict[str, str], key: str | None) -> str | None:
    return None if key is None else labels.get(key, key)


def asset_payload(asset: Asset, roster_row: InitiativeAsset, model: AssetModel | None,
                  status_labels: dict[str, str], *,
                  container_id: uuid.UUID | None = None) -> dict:
    """One roster asset as /kiosk/sync/assets sends it, minus `label`.
    `status_labels` is the `asset` vocabulary (`load_status_labels(db, "asset")`):
    both the asset's own status and its roster status use it.
    `container_id` is the crate the asset is packed in, if any.

    asset_id/make/model/make_model come straight from the asset and model
    columns — never out of the placeholder `label` map, which is filtered to
    the active catalog and can lose keys to an admin's edits."""
    ia = roster_row
    make = model.make if model else None
    model_name = model.model if model else None
    return {
        "id": asset.id,
        "asset_id": str(asset.legacy_id) if asset.legacy_id is not None else "",
        "legacy_id": asset.legacy_id,
        "name": asset.name,
        "rfid": asset.rfid_tag,
        "serial_number": asset.serial_number,
        "make": make,
        "model": model_name,
        "make_model": make_model_text(make or "", model_name or ""),
        "container_id": container_id,
        "source_rack": ia.source_rack,
        "source_ru": ru_plain(ia.source_ru),
        "source_ru_raw": ru_raw(ia.source_ru),
        "source_position": ia.source_position,
        "source_pod": ia.source_pod,
        "destination_rack": ia.destination_rack,
        "destination_ru": ru_plain(ia.destination_ru),
        "destination_ru_raw": ru_raw(ia.destination_ru),
        "destination_position": ia.destination_position,
        "destination_pod": ia.destination_pod,
        "priority_wave": ia.priority_wave,
        "disposition": ia.disposition,
        "pod_number": asset.pod_number,
        "asset_status": asset.status,
        "asset_status_label": _label(status_labels, asset.status),
        "has_rails": asset.has_rails,
        "location_detail": asset.location_detail,
        "owner": ia.owner,
        "cable_info": cable_info_dict(ia.cable_info),
        "vendor_involved": ia.vendor_involved,
        "roster_status": ia.status,
        "roster_status_label": _label(status_labels, ia.status),
        "raw_ft": ia.raw_ft if isinstance(ia.raw_ft, dict) else None,
    }


def label_context(initiative: Initiative, origin: Site | None,
                  destination: Site | None) -> dict:
    """The move's values every label of it shares: its name, code and day
    (the stored date, `stored_day`) and its origin and destination sites'
    names and codes."""
    return {
        "move_name": initiative.name,
        "move_code": initiative.code,
        "move_day": (stored_day(initiative.scheduled_start)
                     if initiative.scheduled_start is not None else None),
        "source_site": origin.name if origin else None,
        "source_site_code": origin.code if origin else None,
        "destination_site": destination.name if destination else None,
        "destination_site_code": destination.code if destination else None,
    }


def container_payload(container: Container, *, status_labels: dict[str, str],
                      type_labels: dict[str, str], site_name: str | None,
                      asset_count: int) -> dict:
    """One container as /kiosk/sync/containers sends it. `status_labels`
    is the `container` vocabulary, `type_labels` the `container_type` one."""
    c = container
    return {
        "id": c.id,
        "name": c.name,
        "legacy_id": c.legacy_id,
        "rfid_tag": c.rfid_tag,
        "label_tag": c.label_tag,
        "container_type": c.container_type,
        "container_type_label": _label(type_labels, c.container_type),
        "status": c.status,
        "status_label": status_labels.get(c.status) or c.status,
        "site_id": c.site_id,
        "site_name": site_name,
        "asset_count": asset_count,
    }
