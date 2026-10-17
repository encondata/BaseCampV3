"""Kiosk config sync on both check-ins: POST /kiosk/heartbeat (person
session, kiosk:view) and POST /kiosk/station/heartbeat (station key). A beat
may carry the kiosk's whole config (`config` + `config_changed_at`) and the
version it last applied (`config_applied_version`); the reply carries the
server time, the portal's config version, the whole document only when the
kiosk is behind, and the device's scan type."""

import copy
from datetime import UTC, datetime, timedelta

from sqlalchemy import event, select

from serversherpa.db.engine import get_engine
from serversherpa.db.models import AuditLog, Device
from serversherpa.services.kiosk_config import DEFAULT_CONFIG
from tests.test_kiosk_station_key import SERIAL
from tests.test_kiosk_station_scans import _auth, _station
from tests.test_sites_api import login

BODY = {"serial": "kiosk-web-sync", "name": "Dock 9", "mode": "web", "version": "0.1.0"}


def _doc(**appearance) -> dict:
    doc = copy.deepcopy(DEFAULT_CONFIG)
    doc["appearance"].update(appearance)
    return doc


def _iso(dt: datetime) -> str:
    return dt.isoformat()


async def _device(db, serial=BODY["serial"]) -> Device:
    db.expire_all()
    return await db.scalar(select(Device).where(Device.serial == serial))


async def _beat(client, hdrs, **extra):
    return await client.post("/kiosk/heartbeat", headers=hdrs, json={**BODY, **extra})


# ── person heartbeat ─────────────────────────────────────────────────

async def test_reply_always_has_server_time_and_version(client, db, seeded_user):
    hdrs = await login(client)
    before = datetime.now(UTC)
    r = await _beat(client, hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    server_time = datetime.fromisoformat(body["server_time"])
    assert before - timedelta(seconds=5) <= server_time <= datetime.now(UTC) + timedelta(seconds=5)
    assert body["config_version"] == 0
    assert body["config"] is None
    assert body["scan_status"] is None and body["scan_status_label"] is None


async def test_newer_config_is_stored_and_reply_carries_new_version(client, db, seeded_user):
    hdrs = await login(client)
    stamp = datetime.now(UTC) - timedelta(minutes=1)
    r = await _beat(client, hdrs, config=_doc(flash_ms=900), config_changed_at=_iso(stamp))
    assert r.status_code == 200, r.text
    d = await _device(db)
    assert d.config["appearance"]["flash_ms"] == 900
    assert d.config_version == 1 and d.config_source == "kiosk"
    assert d.config_reported_at is not None
    body = r.json()
    assert body["config_version"] == 1
    # the stored (normalized) document comes back so the kiosk holds the
    # portal's version of it; it sends that version back as applied
    assert body["config"]["appearance"]["flash_ms"] == 900

    # a newer kiosk change replaces it
    r = await _beat(client, hdrs, config=_doc(flash_ms=1200),
                    config_changed_at=_iso(datetime.now(UTC)), config_applied_version=1)
    assert r.json()["config_version"] == 2
    d = await _device(db)
    assert d.config["appearance"]["flash_ms"] == 1200


async def test_unstamped_first_report_is_stored(client, db, seeded_user):
    hdrs = await login(client)
    r = await _beat(client, hdrs, config=_doc(flash_ms=700))
    assert r.status_code == 200, r.text
    d = await _device(db)
    assert d.config["appearance"]["flash_ms"] == 700 and d.config_version == 1


async def test_kiosk_behind_gets_the_doc(client, db, seeded_user):
    hdrs = await login(client)
    await _beat(client, hdrs)
    d = await _device(db)
    d.config = _doc(flash_ms=1500)
    d.config_version = 3
    d.config_changed_at = datetime.now(UTC)
    d.config_source = "portal"
    await db.commit()
    r = await _beat(client, hdrs, config_applied_version=2)
    body = r.json()
    assert body["config_version"] == 3
    assert body["config"]["appearance"]["flash_ms"] == 1500
    assert (await _device(db)).config_applied_version == 2
    # a kiosk that has never applied anything is behind too
    assert (await _beat(client, hdrs)).json()["config"]["appearance"]["flash_ms"] == 1500


async def test_kiosk_in_sync_gets_null_config(client, db, seeded_user):
    hdrs = await login(client)
    await _beat(client, hdrs)
    d = await _device(db)
    d.config = _doc()
    d.config_version = 4
    await db.commit()
    r = await _beat(client, hdrs, config_applied_version=4)
    assert r.json()["config_version"] == 4
    assert r.json()["config"] is None
    assert (await _device(db)).config_applied_version == 4


async def test_applied_version_recorded_on_every_beat_that_sends_it(client, db, seeded_user):
    hdrs = await login(client)
    await _beat(client, hdrs)
    d = await _device(db)
    d.config = _doc()
    d.config_version = 5
    await db.commit()
    await _beat(client, hdrs, config_applied_version=3)
    assert (await _device(db)).config_applied_version == 3
    # a beat with a full report records it too
    await _beat(client, hdrs, config=_doc(), config_changed_at=_iso(datetime.now(UTC)),
                config_applied_version=5)
    assert (await _device(db)).config_applied_version == 5
    # a beat that omits it keeps the last value
    await _beat(client, hdrs)
    assert (await _device(db)).config_applied_version == 5


async def test_applied_version_ahead_of_portal_still_gets_doc(client, db, seeded_user):
    """A kiosk claiming a version the portal never issued (a restored
    database, say) can't be in sync: it gets the document."""
    hdrs = await login(client)
    await _beat(client, hdrs)
    d = await _device(db)
    d.config = _doc(flash_ms=444)
    d.config_version = 2
    await db.commit()
    r = await _beat(client, hdrs, config_applied_version=9)
    assert r.json()["config"]["appearance"]["flash_ms"] == 444


async def test_older_report_does_not_overwrite_portal_edit(client, db, seeded_user):
    hdrs = await login(client)
    await _beat(client, hdrs)
    d = await _device(db)
    edited = datetime.now(UTC)
    d.config = _doc(flash_ms=1500)
    d.config_version = 1
    d.config_changed_at = edited
    d.config_source = "portal"
    await db.commit()
    r = await _beat(client, hdrs, config=_doc(flash_ms=200),
                    config_changed_at=_iso(edited - timedelta(hours=1)))
    assert r.json()["config"]["appearance"]["flash_ms"] == 1500
    d = await _device(db)
    assert d.config["appearance"]["flash_ms"] == 1500 and d.config_version == 1


async def test_far_future_stamp_is_judged_on_server_time(client, db, seeded_user):
    hdrs = await login(client)
    await _beat(client, hdrs, config=_doc(flash_ms=600),
                config_changed_at=_iso(datetime.now(UTC) + timedelta(days=3)))
    d = await _device(db)
    assert d.config_changed_at <= datetime.now(UTC)


async def test_oversized_config_is_422(client, db, seeded_user):
    hdrs = await login(client)
    doc = _doc()
    doc["ios"] = {"blob": "x" * (64 * 1024)}
    r = await _beat(client, hdrs, config=doc)
    assert r.status_code == 422, r.text
    assert await _device(db) is None


async def test_config_audited_without_a_person(client, db, seeded_user):
    hdrs = await login(client)
    await _beat(client, hdrs, config=_doc(flash_ms=900),
                config_changed_at=_iso(datetime.now(UTC)))
    d = await _device(db)
    (a,) = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(d.id), AuditLog.action == "config_change"))).all()
    assert a.changes["source"] == "kiosk"


async def test_scan_type_echoed_on_reply(client, db, seeded_user):
    hdrs = await login(client)
    await _beat(client, hdrs)
    d = await _device(db)
    d.scan_status = "pre_stage"
    await db.commit()
    body = (await _beat(client, hdrs)).json()
    assert body["scan_status"] == "pre_stage"
    assert body["scan_status_label"] == "Pre-Stage"


def _capture():
    statements: list[str] = []

    def listener(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    return statements, listener


async def test_heartbeat_locks_the_device_row(client, db, seeded_user):
    """The device row is read FOR UPDATE before the merge, so a portal edit
    and a heartbeat can't both write the same config version."""
    hdrs = await login(client)
    await _beat(client, hdrs)
    engine = get_engine().sync_engine
    statements, listener = _capture()
    event.listen(engine, "before_cursor_execute", listener)
    try:
        r = await _beat(client, hdrs, config=_doc(), config_changed_at=_iso(datetime.now(UTC)))
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    assert r.status_code == 200
    locks = [s for s in statements if "FROM devices" in s and "FOR UPDATE" in s]
    assert locks, statements


# ── station heartbeat ────────────────────────────────────────────────

async def _station_beat(client, key, **body):
    return await client.post("/kiosk/station/heartbeat", headers=_auth(key),
                             json={"serial": SERIAL, **body})


async def test_station_heartbeat_syncs_the_same_way(client, db, seeded_user):
    _, _, key = await _station(db)
    r = await _station_beat(client, key, config=_doc(flash_ms=800),
                            config_changed_at=_iso(datetime.now(UTC)))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "server_time" in body
    assert body["config_version"] == 1
    d = await _device(db, SERIAL)
    assert d.config["appearance"]["flash_ms"] == 800 and d.config_source == "kiosk"

    # in sync
    r = await _station_beat(client, key, config_applied_version=1)
    assert r.json()["config"] is None and r.json()["config_version"] == 1
    assert (await _device(db, SERIAL)).config_applied_version == 1

    # behind after a portal edit
    d = await _device(db, SERIAL)
    d.config = _doc(flash_ms=1900)
    d.config_version = 2
    d.config_changed_at = datetime.now(UTC)
    await db.commit()
    r = await _station_beat(client, key, config_applied_version=1)
    assert r.json()["config"]["appearance"]["flash_ms"] == 1900


async def test_station_heartbeat_echoes_scan_type(client, db, seeded_user):
    _, _, key = await _station(db)
    d = await _device(db, SERIAL)
    d.scan_status = "pre_stage"
    await db.commit()
    body = (await _station_beat(client, key)).json()
    assert body["scan_status"] == "pre_stage" and body["scan_status_label"] == "Pre-Stage"


async def test_station_oversized_config_is_422(client, db, seeded_user):
    _, _, key = await _station(db)
    doc = _doc()
    doc["alarm"]["blob"] = "x" * (64 * 1024)
    assert (await _station_beat(client, key, config=doc)).status_code == 422


async def test_station_heartbeat_locks_the_device_row(client, db, seeded_user):
    _, _, key = await _station(db)
    engine = get_engine().sync_engine
    statements, listener = _capture()
    event.listen(engine, "before_cursor_execute", listener)
    try:
        r = await _station_beat(client, key, config=_doc(),
                                config_changed_at=_iso(datetime.now(UTC)))
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    assert r.status_code == 200
    assert [s for s in statements if "FROM devices" in s and "FOR UPDATE" in s], statements
