"""Kiosk config sync on both check-ins: POST /kiosk/heartbeat (person
session, kiosk:view) and POST /kiosk/station/heartbeat (station key). A beat
may carry the kiosk's whole config (`config` + `config_changed_at`) and the
version it last applied (`config_applied_version`); the reply carries the
server time, the portal's config version, the whole document only when the
kiosk is behind, and the device's scan type."""

import copy
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import event, select

from serversherpa.db.engine import get_engine
from serversherpa.db.models import AuditLog, Device
from serversherpa.services.kiosk_config import DEFAULT_CONFIG
from tests.test_kiosk_station_key import SERIAL
from tests.test_kiosk_station_scans import _auth, _station
from tests.test_sites_api import login as portal_login
from tests.test_status_values_write import PW, _make

BODY = {"serial": "kiosk-web-sync", "name": "Dock 9", "mode": "web", "version": "0.1.0"}


async def login(client, email="alice@test.example.com", pw="CorrectHorse9!"):
    """A kiosk sign-in session (client="kiosk"): config sync over the person
    heartbeat serves only kiosk sessions, bound to one serial."""
    r = await client.post("/auth/login", json={"email": email, "password": pw,
                                               "client": "kiosk"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _kiosk_worker(db, client, email):
    await _make(db, client, "worker", email)
    return await login(client, email=email, pw=PW)


async def _session_serial(db, hdrs):
    """The kiosk_serial on the session behind `hdrs` (via its JWT sid)."""
    import jwt

    from serversherpa.db.models import AuthSession

    token = hdrs["Authorization"].removeprefix("Bearer ")
    sid = jwt.decode(token, options={"verify_signature": False})["sid"]
    db.expire_all()
    return (await db.get(AuthSession, uuid.UUID(sid))).kiosk_serial


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
    from serversherpa.services.kiosk_config import apply_portal_edit

    uid = seeded_user.id
    hdrs = await login(client)
    await _beat(client, hdrs, config=_doc(flash_ms=600),
                config_changed_at=_iso(datetime.now(UTC) + timedelta(days=3)))
    d = await _device(db)
    assert d.config_changed_at <= datetime.now(UTC)
    assert d.config["appearance"]["flash_ms"] == 600
    # a portal edit made after that beat replaces the doc: the kiosk's clock
    # being days ahead did not lock the portal out
    await apply_portal_edit(db, d, _doc(flash_ms=1700), actor_id=uid,
                            now=datetime.now(UTC))
    await db.commit()
    d = await _device(db)
    assert d.config["appearance"]["flash_ms"] == 1700
    assert d.config_source == "portal" and d.config_version == 2
    # and the kiosk, still behind, is sent the portal's doc
    r = await _beat(client, hdrs, config_applied_version=1)
    assert r.json()["config"]["appearance"]["flash_ms"] == 1700
    # an older-stamped kiosk report doesn't overwrite the portal edit
    r = await _beat(client, hdrs, config=_doc(flash_ms=300),
                    config_changed_at=_iso(datetime.now(UTC) - timedelta(minutes=5)))
    assert r.json()["config"]["appearance"]["flash_ms"] == 1700
    # nor does an unstamped one
    r = await _beat(client, hdrs, config=_doc(flash_ms=301))
    assert r.json()["config"]["appearance"]["flash_ms"] == 1700
    d = await _device(db)
    assert d.config["appearance"]["flash_ms"] == 1700 and d.config_version == 2


async def test_oversized_config_is_422(client, db, seeded_user):
    hdrs = await login(client)
    doc = _doc()
    doc["ios"] = {"blob": "x" * (64 * 1024)}
    r = await _beat(client, hdrs, config=doc)
    assert r.status_code == 422, r.text
    assert await _device(db) is None


async def test_config_audited_with_the_signed_in_person(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    await _beat(client, hdrs, config=_doc(flash_ms=900),
                config_changed_at=_iso(datetime.now(UTC)))
    d = await _device(db)
    (a,) = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(d.id), AuditLog.action == "config_change"))).all()
    assert a.changes["source"] == "kiosk"
    # the person signed in at the kiosk made the report
    assert a.actor_person_id == uid
    assert d.config_changed_by == uid


async def test_session_bound_to_another_kiosk_gets_nothing(client, db, seeded_user):
    """A second person's kiosk session, bound to kiosk A, that sends a
    sign-in beat naming kiosk B gets no config and no scan fields, and B's
    config is unchanged."""
    hdrs = await login(client)
    await _beat(client, hdrs, config=_doc(flash_ms=900),
                config_changed_at=_iso(datetime.now(UTC)))
    b = await _device(db)
    b.scan_status = "pre_stage"
    await db.commit()
    assert b.config_version == 1
    other = await _kiosk_worker(db, client, "other@test.example.com")
    a_beat = await client.post("/kiosk/heartbeat", headers=other, json={
        **BODY, "serial": "kiosk-web-A", "name": "Dock A"})
    assert a_beat.status_code == 200
    assert await _session_serial(db, other) == "kiosk-web-A"
    r = await client.post("/kiosk/heartbeat", headers=other, json={
        **BODY, "sign_in": True, "config": _doc(flash_ms=1999),
        "config_changed_at": _iso(datetime.now(UTC) + timedelta(seconds=1)),
        "config_applied_version": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["config"] is None and body["config_version"] == 1
    assert body["scan_status"] is None and body["scan_status_label"] is None
    b = await _device(db)
    assert b.config["appearance"]["flash_ms"] == 900 and b.config_version == 1
    assert b.config_applied_version is None
    # the binding never moves
    assert await _session_serial(db, other) == "kiosk-web-A"


async def test_unbound_kiosk_session_binds_on_first_beat(client, db, seeded_user):
    hdrs = await login(client)
    assert await _session_serial(db, hdrs) is None
    r = await _beat(client, hdrs, config=_doc(flash_ms=900),
                    config_changed_at=_iso(datetime.now(UTC)))
    assert r.json()["config_version"] == 1
    assert await _session_serial(db, hdrs) == BODY["serial"]
    assert (await _device(db)).config["appearance"]["flash_ms"] == 900


async def test_binding_survives_token_refresh(client, db, seeded_user):
    r = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!", "client": "kiosk"})
    hdrs = {"Authorization": f"Bearer {r.json()['access_token']}"}
    await _beat(client, hdrs)
    refreshed = await client.post("/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    new = {"Authorization": f"Bearer {refreshed.json()['access_token']}"}
    assert await _session_serial(db, new) == BODY["serial"]


async def test_portal_session_never_syncs(client, db, seeded_user):
    hdrs = await portal_login(client)
    r = await _beat(client, hdrs, sign_in=True, config=_doc(flash_ms=900),
                    config_changed_at=_iso(datetime.now(UTC)), config_applied_version=0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["config"] is None and body["config_version"] == 0
    assert body["scan_status"] is None
    d = await _device(db)
    assert d.config is None and d.config_reported_at is None
    assert d.config_applied_version is None
    assert await _session_serial(db, hdrs) is None


async def test_station_keyed_device_ignores_person_heartbeat_config(client, db, seeded_user):
    """A device holding a station key syncs config only on the station
    route; its own signed-in kiosk session still gets the scan type."""
    _, _, _key = await _station(db, person_id=seeded_user.id)
    hdrs = await login(client)
    d = await _device(db, SERIAL)
    d.config = _doc(flash_ms=1234)
    d.config_version = 2
    d.scan_status = "pre_stage"
    await db.commit()
    r = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": SERIAL, "name": "Station 1", "mode": "laptop", "sign_in": True,
        "config": _doc(flash_ms=555), "config_changed_at": _iso(datetime.now(UTC)),
        "config_applied_version": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["config"] is None and body["config_version"] == 2
    assert body["scan_status"] == "pre_stage" and body["scan_status_label"] == "Pre-Stage"
    d = await _device(db, SERIAL)
    assert d.config["appearance"]["flash_ms"] == 1234 and d.config_version == 2
    assert d.config_applied_version is None and d.config_reported_at is None


async def test_applied_version_is_clamped_to_config_version(client, db, seeded_user):
    hdrs = await login(client)
    await _beat(client, hdrs)
    d = await _device(db)
    d.config = _doc()
    d.config_version = 2
    await db.commit()
    await _beat(client, hdrs, config_applied_version=9)
    assert (await _device(db)).config_applied_version == 2


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


async def test_station_route_rechecks_the_key_after_the_locked_read(client, db, seeded_user,
                                                                     monkeypatch):
    """A key revoked (or a device repurposed) between the key check and the
    locked re-read is refused with 401, never synced."""
    import serversherpa.api.routes.kiosk as kiosk_routes

    _, _, key = await _station(db)
    real = kiosk_routes.station_device

    async def revoke_after_verify(request, session, serial):
        device = await real(request, session, serial)
        from sqlalchemy import update
        await session.execute(update(Device).where(Device.id == device.id)
                              .values(station_key_hash=None))
        return device

    monkeypatch.setattr(kiosk_routes, "station_device", revoke_after_verify)
    r = await _station_beat(client, key, config=_doc(flash_ms=800),
                            config_changed_at=_iso(datetime.now(UTC)))
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "station_key_invalid"
    assert (await _device(db, SERIAL)).config is None


async def test_station_report_has_no_actor(client, db, seeded_user):
    _, _, key = await _station(db)
    await _station_beat(client, key, config=_doc(flash_ms=800),
                        config_changed_at=_iso(datetime.now(UTC)))
    d = await _device(db, SERIAL)
    (a,) = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(d.id), AuditLog.action == "config_change"))).all()
    assert a.actor_person_id is None
