"""POST /kiosk/station/scans: RFID scans a laptop kiosk uploads under its
station key, stored as the kiosk's own scans (no operator). One move per key;
shares its implementation with POST /kiosk/scans. Spec §3.2 / §5."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Initiative, RawScan, Site
from serversherpa.services import station_keys
from tests.test_kiosk_station_key import SERIAL, _device
from tests.test_sites_api import login
from tests.test_system_admin_api import _admin

T0 = datetime(2026, 10, 16, 8, 0, tzinfo=UTC)


def _scan(value="EPC-ST-1", minutes=0, **kw):
    return {"client_scan_id": kw.pop("client_scan_id", str(uuid.uuid4())),
            "scanned_value": value, "scan_type": kw.pop("scan_type", "rfid"),
            "scanned_at": (T0 + timedelta(minutes=minutes)).isoformat(), **kw}


def _auth(key):
    return {"Authorization": f"Station {key}"}


async def _station(db, person_id=None):
    """A registered RFID laptop with a key for its move. -> (device, move, key)."""
    device, init = await _device(db, person_id=person_id)
    live = await db.get(Device, device.id)
    home = Site(name=f"St Home {uuid.uuid4().hex[:6]}")
    db.add(home)
    await db.flush()
    (await db.get(Initiative, init.id)).origin_site_id = home.id
    live.site_id = home.id   # scans that omit a site land on the move's origin
    key = await station_keys.issue(db, live, actor_id=person_id, via="password")
    await db.commit()
    return device, init, key


async def _post(client, key, scans, serial=SERIAL):
    return await client.post("/kiosk/station/scans", headers=_auth(key),
                             json={"serial": serial, "scans": scans})


async def _rows(db, value=None):
    db.expire_all()
    q = select(RawScan)
    if value:
        q = q.where(RawScan.scanned_value == value)
    return (await db.scalars(q)).all()


async def test_station_scans_store_kiosk_name_and_no_operator(client, db, seeded_user):
    device, init, key = await _station(db)
    r = await _post(client, key, [_scan("EPC-OWN")])
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["accepted"]) == 1 and body["rejected"] == []
    assert body["clear_setup"] is None
    [row] = await _rows(db, "EPC-OWN")
    assert row.device_id == device.name
    assert row.operator_id is None
    assert row.scan_type == "rfid"
    assert row.source == "kiosk"
    assert row.initiative_id == init.id
    assert row.off_move is False
    live = await db.get(Device, device.id)
    assert live.last_seen_at is not None


async def test_station_scans_idempotent(client, db, seeded_user):
    _, _, key = await _station(db)
    s = _scan("EPC-IDEM")
    for _ in range(2):
        r = await _post(client, key, [s])
        assert r.status_code == 200
        assert r.json()["accepted"] == [s["client_scan_id"]]
    assert len(await _rows(db, "EPC-IDEM")) == 1


async def test_key_move_rules(client, db, seeded_user):
    device, a, key = await _station(db)
    a_id = a.id
    b = Initiative(name="Key Move B", initiative_type="move", status="in_progress")
    db.add(b)
    await db.commit()
    await db.refresh(b)
    b_id = b.id

    r = await _post(client, key, [_scan("EPC-A", initiative_id=str(a_id)),
                                  _scan("EPC-B", initiative_id=str(b_id)),
                                  _scan("EPC-DEFAULT")])
    out = r.json()
    assert len(out["accepted"]) == 2
    assert [x["code"] for x in out["rejected"]] == ["move_locked"]

    # completed -> move_inactive; cancelled likewise
    for status in ("completed", "cancelled"):
        (await db.get(Initiative, a_id)).status = status
        await db.commit()
        r = await _post(client, key, [_scan("EPC-INACT", initiative_id=str(a_id))])
        assert [x["code"] for x in r.json()["rejected"]] == ["move_inactive"], status
    (await db.get(Initiative, a_id)).status = "in_progress"
    await db.commit()

    # archived -> move_inactive
    (await db.get(Initiative, a_id)).archived_at = datetime.now(UTC)
    await db.commit()
    r = await _post(client, key, [_scan("EPC-ARCH")])
    assert [x["code"] for x in r.json()["rejected"]] == ["move_inactive"]
    (await db.get(Initiative, a_id)).archived_at = None
    await db.commit()

    # re-setup for B and re-issue: A is locked out, B is accepted
    live = await db.get(Device, device.id)
    live.current_initiative_id = b_id
    (await db.get(Initiative, b_id)).origin_site_id = live.site_id
    new_key = await station_keys.issue(db, live, actor_id=None, via="password")
    await db.commit()
    r = await _post(client, new_key, [_scan("EPC-A2", initiative_id=str(a_id)),
                                      _scan("EPC-B2", initiative_id=str(b_id))])
    out = r.json()
    assert len(out["accepted"]) == 1
    assert [x["code"] for x in out["rejected"]] == ["move_locked"]
    # the old key no longer works
    assert (await _post(client, key, [_scan("EPC-OLD")])).status_code == 401


async def test_bad_missing_revoked_key_401(client, db, seeded_user):
    device, _, key = await _station(db)
    scans = [_scan("EPC-401")]
    for headers in ({}, _auth("wrong-key"), {"Authorization": f"Bearer {key}"},
                    {"Authorization": "Station "}):
        r = await client.post("/kiosk/station/scans", headers=headers,
                              json={"serial": SERIAL, "scans": scans})
        assert r.status_code == 401 and r.json()["detail"]["code"] == "station_key_invalid"
    r = await _post(client, key, scans, serial="other-serial")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "station_key_invalid"
    live = await db.get(Device, device.id)
    await station_keys.revoke(db, live, actor_id=None, reason="test")
    await db.commit()
    r = await _post(client, key, scans)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "station_key_invalid"
    assert await _rows(db, "EPC-401") == []


async def test_more_than_50_is_422(client, db, seeded_user):
    _, _, key = await _station(db)
    assert (await _post(client, key, [_scan(f"E{i}", i) for i in range(51)])
            ).status_code == 422
    assert (await _post(client, key, [_scan(f"F{i}", i) for i in range(50)])
            ).status_code == 200
    assert (await _post(client, key, [])).status_code == 422


async def test_off_move_flag_stored(client, db, seeded_user):
    _, _, key = await _station(db)
    r = await _post(client, key, [_scan("EPC-OFF", off_move=True), _scan("EPC-ON")])
    assert len(r.json()["accepted"]) == 2
    [off] = await _rows(db, "EPC-OFF")
    off_flag = off.off_move
    [on] = await _rows(db, "EPC-ON")
    assert off_flag is True and on.off_move is False


async def test_reply_carries_clear_setup(client, db, seeded_user):
    device, _, key = await _station(db)
    rid = uuid.uuid4()
    (await db.get(Device, device.id)).setup_clear_id = rid
    await db.commit()
    r = await _post(client, key, [_scan("EPC-CLR")])
    assert r.status_code == 200 and r.json()["clear_setup"] == str(rid)


async def test_person_scans_route_unchanged(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    await _device(db, person_id=uid)
    r = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan("EPC-PERSON")]})
    assert r.status_code == 200, r.text
    assert "clear_setup" not in r.json()
    [row] = await _rows(db, "EPC-PERSON")
    assert row.operator_id == uid


async def test_station_scans_blocked_in_read_only_mode(client, db, seeded_user):
    _, _, key = await _station(db)
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    before = len((await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_scans"))).all())
    r = await _post(client, key, [_scan("EPC-RO")])
    assert r.status_code == 423 and r.json()["detail"]["code"] == "read_only_mode"
    assert await _rows(db, "EPC-RO") == []
    db.expire_all()
    assert len((await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_scans"))).all()) == before


async def test_station_scope_rfid_only_and_key_move_sites(client, db, seeded_user):
    device, a, key = await _station(db)
    origin, dest, other = Site(name="St Origin"), Site(name="St Dest"), Site(name="St Other")
    db.add_all([origin, dest, other])
    await db.flush()
    (await db.get(Initiative, a.id)).origin_site_id = origin.id
    (await db.get(Initiative, a.id)).destination_site_id = dest.id
    (await db.get(Device, device.id)).site_id = None
    await db.commit()
    r = await _post(client, key, [
        _scan("EPC-S1", site_id=str(origin.id)),
        _scan("EPC-S2", site_id=str(dest.id)),
        _scan("EPC-S3", site_id=str(other.id)),
        _scan("EPC-S4"),                       # no site on scan or device
        _scan("EPC-S5", scan_type="barcode", site_id=str(origin.id))])
    out = r.json()
    assert len(out["accepted"]) == 2
    codes = {x["client_scan_id"]: x["code"] for x in out["rejected"]}
    assert sorted(codes.values()) == ["bad_scan_type", "bad_site", "bad_site"]
    # the device's own site counts when the scan omits one
    (await db.get(Device, device.id)).site_id = dest.id
    await db.commit()
    r = await _post(client, key, [_scan("EPC-S6")])
    assert len(r.json()["accepted"]) == 1
    # the person route is unchanged: barcode scans and any site still land
    hdrs = await login(client)
    r = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan("EPC-P1", scan_type="barcode",
                                          site_id=str(other.id))]})
    assert len(r.json()["accepted"]) == 1, r.text


async def test_station_audit_marks_via(client, db, seeded_user):
    _, _, key = await _station(db)
    await _post(client, key, [_scan("EPC-AUD")])
    db.expire_all()
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_scans"))).all()
    assert rows and rows[-1].changes.get("via") == "station_key"


async def test_setup_moved_without_reissue_is_move_locked(client, db, seeded_user):
    device, a, key = await _station(db)
    b = Initiative(name="Key Move B", initiative_type="move", status="in_progress")
    db.add(b)
    await db.flush()
    (await db.get(Device, device.id)).current_initiative_id = b.id
    await db.commit()
    r = await _post(client, key, [_scan("EPC-NOINIT")])
    assert [x["code"] for x in r.json()["rejected"]] == ["move_locked"]


async def test_scan_first_sent_on_person_route_then_station_is_one_row(
        client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    _, _, key = await _station(db, person_id=uid)
    s = _scan("EPC-BOTH")
    r = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [s]})
    assert r.status_code == 200, r.text
    r = await _post(client, key, [s])
    assert r.json()["accepted"] == [s["client_scan_id"]]
    assert len(await _rows(db, "EPC-BOTH")) == 1
