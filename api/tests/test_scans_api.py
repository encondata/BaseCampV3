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

    resp = await client.get("/scans/raw", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert [r["scanned_value"] for r in resp.json()] == [
        "EPC-004", "EPC-003", "EPC-002", "EPC-001", "EPC-000"]

    resp = await client.get("/scans/raw?limit=2&offset=0", headers=hdrs)
    assert resp.status_code == 200, resp.text
    page = resp.json()
    assert [r["scanned_value"] for r in page] == ["EPC-004", "EPC-003"]

    resp = await client.get("/scans/raw?limit=2&offset=4", headers=hdrs)
    assert [r["scanned_value"] for r in resp.json()] == ["EPC-000"]


async def test_raw_list_gzip_encoded(client, db, seeded_user):
    """GZipMiddleware(minimum_size=1024) should actually engage once the
    /scans/raw response body clears the threshold and the client advertises
    gzip support."""
    hdrs = await login(client)
    db.add_all([_raw(f"EPC-{i:04d}", minutes=i) for i in range(60)])
    await db.commit()

    resp = await client.get(
        "/scans/raw", headers={**hdrs, "Accept-Encoding": "gzip"})
    assert resp.status_code == 200, resp.text

    # Sanity check: the seeded response is genuinely above the middleware's
    # threshold, so a missing content-encoding below is a real negative and
    # not an artifact of an under-sized fixture.
    assert len(resp.json()) == 60
    assert len(resp.content) > 1024

    assert resp.headers.get("content-encoding") == "gzip"


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


async def test_asset_scan_history(client, db, seeded_user, monkeypatch):
    from serversherpa.config import get_settings

    # Pin the env default to 15 so the cap assertions below stay meaningful
    # regardless of what SS_SCANS_HISTORY_DEFAULT is set to elsewhere.
    monkeypatch.setenv("SS_SCANS_HISTORY_DEFAULT", "15")
    get_settings.cache_clear()

    hdrs = await login(client)
    target = Asset(name="hist-target")
    other = Asset(name="hist-other")
    box = Container(name="hist-crate")
    db.add_all([target, other, box])
    await db.flush()

    def _scan(minutes, **kw):
        ts = T0 + timedelta(minutes=minutes)
        return ProcessedScan(
            scanned_value=f"EPC-H-{minutes:03d}", scan_type="rfid",
            scanned_at=ts, processed_at=ts, **kw)

    # 20 scans for the target (exceeds the 15 cap), plus noise rows that
    # must be excluded: another asset, and a container match.
    db.add_all([_scan(i, match_type="asset", asset_id=target.id)
                for i in range(20)])
    db.add(_scan(99, match_type="asset", asset_id=other.id))
    db.add(_scan(98, match_type="container", container_id=box.id))
    db.add(_scan(97, match_type="asset", asset_id=target.id, archived_at=T0))
    await db.commit()

    resp = await client.get(f"/scans/asset/{target.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 15                       # default cap
    values = [r["scanned_value"] for r in rows]  # newest first: 19..5
    assert values[0] == "EPC-H-019"
    assert values[-1] == "EPC-H-005"
    assert "EPC-H-099" not in values             # other asset excluded
    assert "EPC-H-097" not in values             # archived scan excluded
    assert rows[0]["scan_type_label"] == "RFID"

    resp = await client.get(f"/scans/asset/{target.id}?limit=3", headers=hdrs)
    assert [r["scanned_value"] for r in resp.json()] == [
        "EPC-H-019", "EPC-H-018", "EPC-H-017"]

    # unknown asset id -> empty list, not 404
    resp = await client.get(
        "/scans/asset/00000000-0000-0000-0000-000000000000", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json() == []

    get_settings.cache_clear()


async def test_asset_scan_history_gate(client, db, seeded_user):
    w = Person(first_name="Wk", last_name="NoHist")
    asset = Asset(name="hist-gate")
    db.add_all([w, asset])
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    hdrs = await make_login(db, client, w, "wk-nohist@test.example.com")
    resp = await client.get(f"/scans/asset/{asset.id}", headers=hdrs)
    assert resp.status_code == 403


async def test_asset_scan_history_env_default(client, db, seeded_user, monkeypatch):
    from serversherpa.config import get_settings

    hdrs = await login(client)
    asset = Asset(name="hist-env")
    db.add(asset)
    await db.flush()
    db.add_all([ProcessedScan(
        scanned_value=f"EPC-E-{i:03d}", scan_type="rfid",
        scanned_at=T0 + timedelta(minutes=i),
        processed_at=T0 + timedelta(minutes=i),
        match_type="asset", asset_id=asset.id) for i in range(8)])
    await db.commit()

    # omitted limit -> settings default (patched small so the test is cheap)
    # Settings is a frozen pydantic model (monkeypatch.setattr would raise a
    # frozen_instance ValidationError), so patch via env + cache_clear like
    # test_cors_dev.py does.
    monkeypatch.setenv("SS_SCANS_HISTORY_DEFAULT", "5")
    get_settings.cache_clear()
    resp = await client.get(f"/scans/asset/{asset.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) == 5

    # explicit limit still wins over the setting
    resp = await client.get(f"/scans/asset/{asset.id}?limit=2", headers=hdrs)
    assert len(resp.json()) == 2

    # bounds: le=500
    resp = await client.get(f"/scans/asset/{asset.id}?limit=501", headers=hdrs)
    assert resp.status_code == 422

    get_settings.cache_clear()
