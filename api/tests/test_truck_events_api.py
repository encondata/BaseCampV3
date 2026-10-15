"""GET /trucks/{id}/events and Clear updates clearing trip events."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.models import Truck, TruckEvent
from tests.test_sites_api import login

T0 = datetime(2026, 5, 1, 12, tzinfo=UTC)


async def test_list_newest_first_and_clear(client, db, seeded_user):
    hdrs = await login(client)
    t = Truck(name="Eventful")
    db.add(t)
    await db.flush()
    db.add_all([
        TruckEvent(truck_id=t.id, recorded_at=T0, event="Arrived at Pickup",
                   event_kind="arrived", stop="pickup", source="macropoint", source_ref="a"),
        TruckEvent(truck_id=t.id, recorded_at=T0 + timedelta(hours=1),
                   event="Departed at Pickup", event_kind="departed", stop="pickup",
                   source="macropoint", source_ref="b"),
    ])
    await db.commit()

    resp = await client.get(f"/trucks/{t.id}/events", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert [e["event"] for e in resp.json()] == ["Departed at Pickup", "Arrived at Pickup"]
    assert resp.json()[0]["stop"] == "pickup"

    assert (await client.delete(f"/trucks/{t.id}/updates", headers=hdrs)).status_code == 204
    assert await db.scalar(select(func.count()).select_from(TruckEvent)) == 0


async def test_events_404_for_unknown_truck(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/trucks/00000000-0000-0000-0000-000000000000/events", headers=hdrs)
    assert resp.status_code == 404
