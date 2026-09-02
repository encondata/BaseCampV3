"""Client activity feed: asset-join correctness, 7d count, scope."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Asset, Client, ProcessedScan, Site

from tests.test_initiatives_client_scope import client_login
from tests.test_status_values_write import _make


async def _fixture(db):
    now = datetime.now(UTC)
    a, b = Client(name="Acme"), Client(name="Bravo")
    site = Site(name="NAP11 - Switch")
    db.add(a)
    db.add(b)
    db.add(site)
    await db.flush()
    mine = Asset(name="core-sw-01", serial_number="C7X-1",
                 client_id=a.id, status="in_transit")
    theirs = Asset(name="other-box", serial_number="ZZ-9",
                   client_id=b.id, status="labeled")
    db.add(mine)
    db.add(theirs)
    await db.flush()
    for days, asset, status in ((0, mine, mine.status), (1, mine, mine.status), (10, mine, mine.status), (0, theirs, theirs.status), (0, mine, None)):
        db.add(ProcessedScan(
            scanned_value=asset.serial_number or "", scan_type="rfid",
            status=status, scanned_at=now - timedelta(days=days),
            device_id="dock-reader-1", site_id=site.id,
            match_type="asset", asset_id=asset.id,
            processed_at=now))
    await db.commit()
    return a, b, mine


async def test_activity_joins_and_counts(client, db, seeded_user):
    a, _b, mine = await _fixture(db)
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get(f"/clients/{a.id}/activity", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["events"]) == 4            # only Acme's asset's scans (3 + 1 null-status)
    ev = body["events"][0]
    assert ev["asset_name"] == "core-sw-01"
    assert ev["serial_number"] == "C7X-1"
    assert ev["site_name"] == "NAP11 - Switch"
    assert ev["device_id"] == "dock-reader-1"
    assert ev["status_label"]                  # vocab-resolved
    assert ev["status_color"].startswith("#")
    # find the null-status event and verify it
    null_status_ev = next((e for e in body["events"] if e["status"] is None), None)
    assert null_status_ev is not None, "Expected null-status event not found"
    assert null_status_ev["status_label"] is None
    assert null_status_ev["status_color"] == "#51606f"
    assert body["activity_7d"] == 3            # the 10-day-old scan excluded
    # limit does not change the 7d count
    resp = await client.get(f"/clients/{a.id}/activity?limit=1",
                            headers=hdrs)
    assert len(resp.json()["events"]) == 1
    assert resp.json()["activity_7d"] == 3


async def test_activity_scope_and_empty(client, db, seeded_user):
    a, b, _mine = await _fixture(db)
    hdrs = await client_login(db, client, a.id)
    ok = await client.get(f"/clients/{a.id}/activity", headers=hdrs)
    assert ok.status_code == 200 and len(ok.json()["events"]) == 4
    foreign = await client.get(f"/clients/{b.id}/activity", headers=hdrs)
    assert foreign.status_code == 404
    # Bravo has one scan but a fresh client with no assets is empty-shaped
    c = Client(name="Empty Co")
    db.add(c)
    await db.commit()
    adm = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get(f"/clients/{c.id}/activity", headers=adm)
    assert resp.json() == {"events": [], "activity_7d": 0}
