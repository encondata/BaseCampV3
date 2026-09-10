"""gather() pulls an initiative + its asset roster into plain dataclasses."""

from decimal import Decimal

import pytest

from serversherpa.db.models import (
    Asset, AssetModel, Client, Initiative, InitiativeAsset, Site,
)
from serversherpa.reports.move_report.gather import InitiativeUnavailable, gather


async def test_gather_builds_move_data(db):
    client = Client(name="Acme")
    src = Site(name="DC-A", status="active")
    dst = Site(name="DC-B", status="active")
    db.add_all([client, src, dst])
    await db.flush()
    ini = Initiative(name="NAP11", initiative_type="move", status="planned",
                     client_id=client.id, origin_site_id=src.id, destination_site_id=dst.id)
    model = AssetModel(make="Dell", model="R740", ru_size=2, weight_lbs=Decimal("50"),
                       rail_type="Sliding", category="server")  # seeded asset_categories row
    db.add_all([ini, model])
    await db.flush()
    asset = Asset(serial_number="SN1", name="web-01", model_id=model.id)
    db.add(asset)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=ini.id, asset_id=asset.id, priority_wave="W1",
                           source_rack="R1", source_ru=Decimal("10"), source_position="front",
                           destination_rack="D1", destination_ru=Decimal("20.1")))
    await db.commit()

    data = await gather(db, ini.id)
    assert data.name == "NAP11" and data.client_name == "Acme"
    assert data.origin_site.name == "DC-A" and data.destination_site.name == "DC-B"
    [a] = data.assets
    assert (a.name, a.serial, a.make, a.model, a.ru_size, a.rail_type) == (
        "web-01", "SN1", "Dell", "R740", 2, "Sliding")
    assert a.source_ru == 10.0 and a.destination_ru == 20.1
    # category label/color ride along so the rack renderer fills faceplates
    # exactly as the portal's RackViewModal does
    assert (a.category_label, a.category_color) == ("Server", "#1668a7")
    row = a.to_row()
    assert row["source_rack"] == "R1" and row["asset"]["ru_size"] == 2
    assert row["asset"]["name"] == "web-01" and row["destination_ru"] == 20.1
    assert row["asset"]["model_category_label"] == "Server"
    assert row["asset"]["model_category_color"] == "#1668a7"


async def test_gather_rejects_missing_or_archived(db):
    from datetime import UTC, datetime
    from uuid import uuid4
    with pytest.raises(InitiativeUnavailable):
        await gather(db, uuid4())
    ini = Initiative(name="Old", initiative_type="move", status="completed",
                     archived_at=datetime.now(UTC))
    db.add(ini)
    await db.commit()
    with pytest.raises(InitiativeUnavailable):
        await gather(db, ini.id)
