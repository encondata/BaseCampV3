"""services/initiatives — the create rules POST /initiatives and Create a
move in steps share."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Site
from serversherpa.services.initiatives import (
    INITIATIVE_PALETTE,
    create_initiative_row,
    next_color,
    ref_problem,
)


async def test_create_initiative_row_assigns_a_color_and_audits(db):
    ini = await create_initiative_row(
        db, {"name": "Move A", "initiative_type": "move"}, None)
    assert ini.color == INITIATIVE_PALETTE[0]
    assert ini.status == "planned"
    [row] = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.action == "create"))).all()
    assert row.entity_id == str(ini.id)
    assert row.changes["name"] == {"from": None, "to": "Move A"}
    assert await next_color(db) == INITIATIVE_PALETTE[1]


async def test_create_initiative_row_keeps_an_explicit_color(db):
    ini = await create_initiative_row(
        db, {"name": "B", "initiative_type": "move", "color": "#123456"}, None)
    assert ini.color == "#123456"


async def test_ref_problem_names_the_failing_field(db):
    site = Site(name="DC")
    db.add(site)
    await db.commit()
    assert await ref_problem(db, {"origin_site_id": site.id}) is None
    assert await ref_problem(db, {"destination_site_id": uuid.uuid4()}) == (
        "site_not_found", {"field": "destination_site_id"})
    assert await ref_problem(db, {"status": "nope"}) == ("unknown_status", {})
    assert await ref_problem(db, {"shipping_types": ["truck", "boat"]}) == (
        "unknown_shipping_type", {"values": ["boat"]})
