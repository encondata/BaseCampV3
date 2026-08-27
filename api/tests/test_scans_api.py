"""Scans API — raw paging + filters, processed denormalization, gates."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import (
    Asset, Container, Person, PersonRole, ProcessedScan, RawScan, Site,
)

from .test_assets_api import login, make_login

T0 = datetime(2026, 8, 27, 9, 0, tzinfo=UTC)


def _raw(value, minutes=0, **kw):
    return RawScan(scanned_value=value, scan_type=kw.pop("scan_type", "rfid"),
                   scanned_at=T0 + timedelta(minutes=minutes), **kw)


async def test_raw_list_pages_newest_first(client, db, seeded_user):
    hdrs = await login(client)
    db.add_all([_raw(f"EPC-{i:03d}", minutes=i) for i in range(5)])
    await db.commit()

    resp = await client.get("/scans/raw?limit=2&offset=0", headers=hdrs)
    assert resp.status_code == 200, resp.text
    page = resp.json()
    assert [r["scanned_value"] for r in page] == ["EPC-004", "EPC-003"]

    resp = await client.get("/scans/raw?limit=2&offset=4", headers=hdrs)
    assert [r["scanned_value"] for r in resp.json()] == ["EPC-000"]


async def test_raw_list_denormalizes(client, db, seeded_user):
    hdrs = await login(client)
    op_ = Person(first_name="Op", last_name="Erator")
    site = Site(name="DC-1")
    db.add_all([op_, site])
    await db.flush()
    db.add(_raw("EPC-A", device_id="dock-reader-1", operator_id=op_.id,
                site_id=site.id, location_detail="Dock 3", source="reader"))
    await db.commit()

    row = (await client.get("/scans/raw", headers=hdrs)).json()[0]
    assert row["scan_type_label"] == "RFID"
    assert row["scan_type_color"]
    assert row["operator_name"] == "Op Erator"
    assert row["site_name"] == "DC-1"
    assert row["device_id"] == "dock-reader-1"
    assert row["source"] == "reader"


async def test_raw_filters(client, db, seeded_user):
    hdrs = await login(client)
    op_ = Person(first_name="Op", last_name="Only")
    site = Site(name="DC-F")
    db.add_all([op_, site])
    await db.flush()
    db.add_all([
        _raw("AAA-1", minutes=0, device_id="dev-1"),
        _raw("BBB-1", minutes=1, device_id="dev-2", operator_id=op_.id,
             site_id=site.id, scan_type="barcode"),
    ])
    await db.commit()

    async def values(**params):
        # params= so httpx URL-encodes datetimes ("+00:00" would otherwise
        # arrive as a space in a hand-built query string)
        resp = await client.get("/scans/raw", headers=hdrs, params=params)
        assert resp.status_code == 200, resp.text
        return [r["scanned_value"] for r in resp.json()]

    assert await values(device_id="dev-1") == ["AAA-1"]
    assert await values(operator_id=str(op_.id)) == ["BBB-1"]
    assert await values(site_id=str(site.id)) == ["BBB-1"]
    assert await values(scan_type="barcode") == ["BBB-1"]
    assert await values(value="bbb") == ["BBB-1"]  # case-insensitive substring
    cutoff = (T0 + timedelta(seconds=30)).isoformat()
    assert await values(since=cutoff) == ["BBB-1"]
    assert await values(until=cutoff) == ["AAA-1"]


async def test_processed_list_denormalizes_each_match_type(client, db, seeded_user):
    hdrs = await login(client)
    asset = Asset(name="srv-9", serial_number="SN-9")
    box = Container(name="Crate Z")
    badge = Person(first_name="Badge", last_name="Holder")
    db.add_all([asset, box, badge])
    await db.flush()

    def _p(value, minutes, **kw):
        return ProcessedScan(
            scanned_value=value, scan_type="rfid",
            scanned_at=T0 + timedelta(minutes=minutes),
            processed_at=T0 + timedelta(minutes=minutes + 1), **kw)

    db.add_all([
        _p("EPC-AST", 0, match_type="asset", asset_id=asset.id,
           raw_scan_id=101),
        _p("EPC-CON", 1, match_type="container", container_id=box.id),
        _p("EPC-PER", 2, match_type="person", person_id=badge.id),
    ])
    await db.commit()

    rows = (await client.get("/scans/processed", headers=hdrs)).json()
    assert [r["scanned_value"] for r in rows] == ["EPC-PER", "EPC-CON", "EPC-AST"]
    by_type = {r["match_type"]: r for r in rows}
    assert by_type["asset"]["matched_name"] == "srv-9"
    assert by_type["asset"]["match_type_label"] == "Asset"
    assert by_type["asset"]["raw_scan_id"] == 101
    assert by_type["container"]["matched_name"] == "Crate Z"
    assert by_type["person"]["matched_name"] == "Badge Holder"
    assert by_type["person"]["person_id"] == str(badge.id)


async def test_scans_view_gate(client, db, seeded_user):
    # worker role has no scans grant at all
    w = Person(first_name="Wk", last_name="NoScan")
    db.add(w)
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    hdrs = await make_login(db, client, w, "wk-noscan@test.example.com")
    for path in ("/scans/raw", "/scans/processed"):
        resp = await client.get(path, headers=hdrs)
        assert resp.status_code == 403, path


async def test_processed_patch_whitelist_and_audit(client, db, seeded_user):
    # login(client)'s default account (seeded_user) is role="staff", which
    # per the scans grant matrix is view-only — bump to admin so the PATCH
    # below (requires scans:change) doesn't 403 before reaching the route.
    db.add(PersonRole(person_id=seeded_user.id, role="admin"))
    await db.flush()
    hdrs = await login(client)
    asset = Asset(name="srv-p")
    site = Site(name="DC-P")
    op_ = Person(first_name="Fix", last_name="Er")
    db.add_all([asset, site, op_])
    await db.flush()
    p = ProcessedScan(
        scanned_value="EPC-P", scan_type="rfid", scanned_at=T0,
        match_type="asset", asset_id=asset.id, processed_at=T0)
    db.add(p)
    await db.commit()

    resp = await client.patch(f"/scans/processed/{p.id}", headers=hdrs, json={
        "site_id": str(site.id), "location_detail": "Row 4",
        "operator_id": str(op_.id),
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["site_name"] == "DC-P"
    assert body["location_detail"] == "Row 4"
    assert body["operator_name"] == "Fix Er"

    # match fields are not accepted at all (extra=forbid -> FastAPI 422)
    resp = await client.patch(f"/scans/processed/{p.id}", headers=hdrs,
                              json={"match_type": "person"})
    assert resp.status_code == 422

    # the change was audited
    resp = await client.get(
        f"/audit?entity_type=processed_scan&entity_id={p.id}", headers=hdrs)
    rows = resp.json()
    assert rows and rows[0]["action"] == "update"
    assert rows[0]["entity_name"]  # entity_refs resolves a display name
    assert "location_detail" in rows[0]["changes"]


async def test_processed_patch_validation(client, db, seeded_user):
    # see test_processed_patch_whitelist_and_audit: PATCH needs scans:change
    db.add(PersonRole(person_id=seeded_user.id, role="admin"))
    await db.flush()
    hdrs = await login(client)
    asset = Asset(name="srv-v")
    db.add(asset)
    await db.flush()
    p = ProcessedScan(
        scanned_value="EPC-V", scan_type="rfid", scanned_at=T0,
        match_type="asset", asset_id=asset.id, processed_at=T0)
    db.add(p)
    await db.commit()

    resp = await client.patch(
        "/scans/processed/00000000-0000-0000-0000-000000000000",
        headers=hdrs, json={"location_detail": "x"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "processed_scan_not_found"

    resp = await client.patch(f"/scans/processed/{p.id}", headers=hdrs, json={
        "site_id": "00000000-0000-0000-0000-000000000000"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "site_not_found"

    resp = await client.patch(f"/scans/processed/{p.id}", headers=hdrs, json={
        "operator_id": "00000000-0000-0000-0000-000000000000"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "operator_not_found"

    resp = await client.patch(f"/scans/processed/{p.id}", headers=hdrs,
                              json={"location_detail": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "location_detail_required"


async def test_processed_patch_requires_change(client, db, seeded_user):
    # staff holds only scans:view — list succeeds, PATCH must 403
    staff = Person(first_name="St", last_name="Aff")
    db.add(staff)
    await db.flush()
    db.add(PersonRole(person_id=staff.id, role="staff"))
    asset = Asset(name="srv-g")
    db.add(asset)
    await db.flush()
    p = ProcessedScan(
        scanned_value="EPC-G", scan_type="rfid", scanned_at=T0,
        match_type="asset", asset_id=asset.id, processed_at=T0)
    db.add(p)
    await db.commit()
    hdrs = await make_login(db, client, staff, "staff-scan@test.example.com")
    assert (await client.get("/scans/processed", headers=hdrs)).status_code == 200
    resp = await client.patch(f"/scans/processed/{p.id}", headers=hdrs,
                              json={"location_detail": "nope"})
    assert resp.status_code == 403


async def test_processed_scan_god_deletable(client, db, seeded_user):
    from serversherpa.api.routes.devtools import DELETABLE
    from serversherpa.db.models import ProcessedScan as PS
    assert DELETABLE["processed_scan"] is PS
