"""Initiative creation rules shared by POST /initiatives and Bulk Actions ›
Create a move in steps (its draft routes validate with ref_problem; the
import worker creates the move with create_initiative_row inside the job's
own transaction). Pure of HTTP: a problem comes back as (code, extra)."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Client, Initiative, Partner, Site, StatusValue
from serversherpa.services.audit import audit, snapshot

PARTNER_FIELDS = (
    "shipping_partner_id",
    "origin_tech_partner_id", "origin_cable_partner_id",
    "origin_logistics_partner_id",
    "destination_tech_partner_id", "destination_cable_partner_id",
    "destination_logistics_partner_id",
)
SITE_FIELDS = ("site_id", "origin_site_id", "destination_site_id")
INITIATIVE_FIELDS = [
    "name", "description", "color", "initiative_type", "sub_type", "status",
    "client_id", "site_id", "location", "scheduled_start", "scheduled_end",
    "sky_command_project_id", "origin_site_id", "destination_site_id",
    "real_start_at", "real_end_at", "priority_devices", "shipping_types",
    "origin_vendor_involved", "destination_vendor_involved",
    *PARTNER_FIELDS,
]

# Twelve hues spaced around the wheel, each legible through the portal's
# `.chip.custom` rule (which clamps lightness per theme, so a stored hex
# only has to be a reasonable hue). Migration 0065 keeps its own frozen
# copy of this list — deliberately, so the backfill never moves when this
# one does.
INITIATIVE_PALETTE = [
    "#1668a7", "#0f7c86", "#178a4c", "#5d8a17", "#a36207", "#c05a1f",
    "#c03540", "#b3316d", "#8b3fb8", "#6d4fc4", "#3f63c4", "#51606f",
]


async def next_color(db: AsyncSession) -> str:
    """The palette color held by the fewest UNARCHIVED initiatives, ties
    broken by palette order (see INITIATIVE_PALETTE)."""
    counts = dict((await db.execute(
        select(Initiative.color, func.count())
        .where(Initiative.archived_at.is_(None),
               Initiative.color.in_(INITIATIVE_PALETTE))
        .group_by(Initiative.color)
    )).all())
    return min(INITIATIVE_PALETTE, key=lambda c: counts.get(c, 0))


async def ref_problem(db: AsyncSession, data: dict) -> tuple[str, dict] | None:
    """The first reference in `data` that does not resolve, as the same
    (code, extra) POST /initiatives answers 422 with; None when all do."""
    if data.get("client_id") is not None and \
            await db.get(Client, data["client_id"]) is None:
        return "client_not_found", {}
    for field in SITE_FIELDS:
        if data.get(field) is not None and await db.get(Site, data[field]) is None:
            return "site_not_found", {"field": field}
    for field in PARTNER_FIELDS:
        if data.get(field) is not None and await db.get(Partner, data[field]) is None:
            return "partner_not_found", {"field": field}
    for field, record_type, code in (
        ("status", "initiative", "unknown_status"),
        ("initiative_type", "initiative_type", "unknown_initiative_type"),
        ("sub_type", "initiative_sub_type", "unknown_sub_type"),
    ):
        if data.get(field) is not None and await db.scalar(
            select(StatusValue).where(StatusValue.record_type == record_type,
                                      StatusValue.key == data[field])) is None:
            return code, {}
    if data.get("shipping_types"):
        keys = set(await db.scalars(select(StatusValue.key).where(
            StatusValue.record_type == "shipping_type")))
        if unknown := [s for s in data["shipping_types"] if s not in keys]:
            return "unknown_shipping_type", {"values": unknown}
    return None


async def create_initiative_row(db: AsyncSession, data: dict,
                                actor_id: uuid.UUID | None) -> Initiative:
    """Insert one initiative from already-validated fields and write its
    create audit. An omitted color takes next_color ("auto select a unique
    color which can be changed"). Flushes; never commits."""
    data = dict(data)
    if not data.get("color"):
        data["color"] = await next_color(db)
    initiative = Initiative(**data, created_by=actor_id)
    db.add(initiative)
    await db.flush()
    initial = snapshot(initiative, INITIATIVE_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "", [])}
    audit(db, actor_id=actor_id, entity_type="initiative",
          entity_id=str(initiative.id), action="create", changes=changes)
    return initiative
