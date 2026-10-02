"""Kiosk station type + paired RFID reader (migration 0088): POST /kiosk/setup
accepts `station_type` ('label' | 'rfid') and `reader`; the device list and
detail payloads return `station_type` and `rfid_reader`. Spec §3."""

import os
import subprocess
import uuid
from pathlib import Path

import psycopg
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError, IntegrityError

from serversherpa.config import get_settings
from serversherpa.db.models import AuditLog, Device, Initiative
from tests.test_kiosk_setup_api import (
    SERIAL,
    _seed_initiatives,
    _seed_scan_types,
    _seed_sites,
)
from tests.test_sites_api import login
from tests.test_status_values_write import _make

API_DIR = Path(__file__).resolve().parents[1]
READER = {"ip": "10.20.30.40", "serial": "FX9600-AB12", "model": "FX9600",
          "versions": {"firmware": "3.14.1", "iotc": "2.0"}}
PW = "Crew-2026!"


async def _setup_body(db, *, sub_type="laptop"):
    device = Device(device_type="kiosk", name="Station Target", serial=SERIAL,
                    sub_type=sub_type)
    db.add(device)
    origin, dest = await _seed_sites(db)
    planned, *_ = await _seed_initiatives(db, origin_site=origin, dest_site=dest)
    active, *_ = await _seed_scan_types(db)
    await db.commit()
    return {"serial": SERIAL, "initiative_id": str(planned.id),
            "site_id": str(dest.id), "scan_status": active.key}, device.id


async def _device(db, device_id):
    db.expire_all()
    return await db.scalar(select(Device).where(Device.id == device_id))


def _code(r):
    return r.json()["detail"]["code"]


async def test_rfid_stamps_reader_columns(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    r = await client.post("/kiosk/setup", headers=hdrs,
                          json={**body, "station_type": "rfid", "reader": READER})
    assert r.status_code == 200, r.text
    d = await _device(db, device_id)
    assert d.station_type == "rfid"
    assert str(d.rfid_reader_ip) == "10.20.30.40"
    assert d.rfid_reader_serial == "FX9600-AB12"
    assert d.rfid_reader_model == "FX9600"
    assert d.rfid_reader_versions == READER["versions"]
    assert d.rfid_paired_at is not None


async def test_rfid_without_reader_is_422(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    r = await client.post("/kiosk/setup", headers=hdrs, json={**body, "station_type": "rfid"})
    assert r.status_code == 422 and _code(r) == "reader_required"
    assert (await _device(db, device_id)).station_type is None


async def test_rfid_needs_a_laptop(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db, sub_type="web")
    r = await client.post("/kiosk/setup", headers=hdrs,
                          json={**body, "station_type": "rfid", "reader": READER})
    assert r.status_code == 422 and _code(r) == "rfid_needs_laptop"
    assert (await _device(db, device_id)).station_type is None


async def test_bad_reader_shapes_are_rejected(client, db, seeded_user):
    hdrs = await login(client)
    body, _ = await _setup_body(db)
    for bad in ({**READER, "ip": "not-an-ip"}, {**READER, "ip": "::1"},
                {**READER, "serial": "x" * 65}, {**READER, "model": "x" * 65},
                {**READER, "versions": {f"k{i}": "v" for i in range(11)}},
                {**READER, "versions": {"a": "v" * 65}}):
        r = await client.post("/kiosk/setup", headers=hdrs,
                              json={**body, "station_type": "rfid", "reader": bad})
        assert r.status_code == 422, bad
    r = await client.post("/kiosk/setup", headers=hdrs, json={**body, "station_type": "toaster"})
    assert r.status_code == 422


async def test_label_clears_the_reader(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    await client.post("/kiosk/setup", headers=hdrs,
                      json={**body, "station_type": "rfid", "reader": READER})
    r = await client.post("/kiosk/setup", headers=hdrs, json={**body, "station_type": "label"})
    assert r.status_code == 200, r.text
    d = await _device(db, device_id)
    assert d.station_type == "label"
    assert d.rfid_reader_ip is None and d.rfid_reader_serial is None
    assert d.rfid_reader_model is None and d.rfid_reader_versions is None
    assert d.rfid_paired_at is None


async def test_label_with_a_reader_ignores_it_and_clears(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    await client.post("/kiosk/setup", headers=hdrs,
                      json={**body, "station_type": "rfid", "reader": READER})
    r = await client.post("/kiosk/setup", headers=hdrs, json={
        **body, "station_type": "label", "reader": {**READER, "serial": "OTHER-1"}})
    assert r.status_code == 200, r.text
    d = await _device(db, device_id)
    assert d.station_type == "label"
    assert d.rfid_reader_ip is None and d.rfid_reader_serial is None
    assert d.rfid_reader_model is None and d.rfid_reader_versions is None
    assert d.rfid_paired_at is None


async def test_omitting_both_leaves_them_untouched(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    await client.post("/kiosk/setup", headers=hdrs,
                      json={**body, "station_type": "rfid", "reader": READER})
    before = await _device(db, device_id)
    paired = before.rfid_paired_at
    r = await client.post("/kiosk/setup", headers=hdrs, json=body)
    assert r.status_code == 200, r.text
    d = await _device(db, device_id)
    assert d.station_type == "rfid" and d.rfid_reader_serial == "FX9600-AB12"
    assert d.rfid_paired_at == paired


async def test_move_locked_session_is_still_refused(client, db, seeded_user):
    admin = await _make(db, client, "admin", "station-admin@test.example.com")
    body, device_id = await _setup_body(db)
    other = Initiative(name="Other move", initiative_type="move", status="in_progress")
    db.add(other)
    await db.commit()
    mine = await db.get(Initiative, uuid.UUID(body["initiative_id"]))
    assert (await client.patch(f"/initiatives/{mine.id}", headers=admin,
                               json={"kiosk_password": PW})).status_code == 200
    r = await client.post("/kiosk/move-login", json={"password": PW})
    assert r.status_code == 200, r.text
    hdrs = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = await client.post("/kiosk/setup", headers=hdrs, json={
        **body, "initiative_id": str(other.id), "station_type": "rfid", "reader": READER})
    assert r.status_code == 403 and _code(r) == "move_locked"
    assert (await _device(db, device_id)).station_type is None


async def test_audit_row_only_when_something_changed(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    payload = {**body, "station_type": "rfid", "reader": READER}
    await client.post("/kiosk/setup", headers=hdrs, json=payload)

    async def rows():
        db.expire_all()
        return (await db.scalars(select(AuditLog).where(
            AuditLog.action == "kiosk_station_setup",
            AuditLog.entity_id == str(device_id)))).all()

    got = await rows()
    assert len(got) == 1
    changes = got[0].changes
    assert changes["station_type"] == {"from": None, "to": "rfid"}
    assert changes["rfid_reader_serial"] == {"from": None, "to": "FX9600-AB12"}
    await client.post("/kiosk/setup", headers=hdrs, json=payload)  # identical: no new row
    assert len(await rows()) == 1
    await client.post("/kiosk/setup", headers=hdrs, json={**body, "station_type": "label"})
    assert len(await rows()) == 2
    await client.post("/kiosk/setup", headers=hdrs, json=body)  # omitted: nothing
    assert len(await rows()) == 2


async def test_list_and_detail_include_the_fields(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    plain = (await client.get("/devices", headers=hdrs)).json()
    row = next(d for d in plain if d["id"] == str(device_id))
    assert row["station_type"] is None and row["rfid_reader"] is None
    await client.post("/kiosk/setup", headers=hdrs,
                      json={**body, "station_type": "rfid", "reader": READER})
    row = next(d for d in (await client.get("/devices", headers=hdrs)).json()
               if d["id"] == str(device_id))
    assert row["station_type"] == "rfid"
    rd = row["rfid_reader"]
    assert rd["ip"] == "10.20.30.40" and rd["serial"] == "FX9600-AB12"
    assert rd["model"] == "FX9600" and rd["versions"] == READER["versions"]
    assert rd["paired_at"] is not None
    # detail: a PATCH returns the same shape the list does
    admin = await _make(db, client, "admin", "station-patch@test.example.com")
    r = await client.patch(f"/devices/{device_id}", headers=admin, json={"name": "Renamed"})
    assert r.status_code == 200, r.text
    assert r.json()["station_type"] == "rfid" and r.json()["rfid_reader"]["serial"] == "FX9600-AB12"


async def test_heartbeat_leaves_them_unchanged(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    await client.post("/kiosk/setup", headers=hdrs,
                      json={**body, "station_type": "rfid", "reader": READER})
    before = await _device(db, device_id)
    paired = before.rfid_paired_at
    r = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": SERIAL, "name": "Station Target", "mode": "laptop", "version": "0.2.0"})
    assert r.status_code == 200, r.text
    d = await _device(db, device_id)
    assert d.station_type == "rfid" and str(d.rfid_reader_ip) == "10.20.30.40"
    assert d.rfid_reader_serial == "FX9600-AB12" and d.rfid_paired_at == paired


async def test_migration_0088_chain_columns_and_check(db):
    script = ScriptDirectory.from_config(Config(str(API_DIR / "alembic.ini")))
    assert len(script.get_heads()) == 1
    assert script.get_revision("0088").down_revision == "0087"
    cols = {r[0]: r[1] for r in (await db.execute(text(
        "select column_name, data_type from information_schema.columns "
        "where table_name='devices' and column_name like any "
        "(array['station_type','rfid_%'])"))).all()}
    assert cols == {"station_type": "text", "rfid_reader_ip": "inet",
                    "rfid_reader_serial": "text", "rfid_reader_model": "text",
                    "rfid_reader_versions": "jsonb",
                    "rfid_paired_at": "timestamp with time zone"}
    d = Device(device_type="kiosk", name="Bad", serial="bad-st", station_type="toaster")
    db.add(d)
    try:
        await db.flush()
        raise AssertionError("check constraint did not fire")
    except (IntegrityError, DBAPIError):
        await db.rollback()


THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_downgrade_0088"
_COLS = ("station_type", "rfid_reader_ip", "rfid_reader_serial", "rfid_reader_model",
         "rfid_reader_versions", "rfid_paired_at")


def _alembic(url, *args):
    env = {**os.environ, "SS_DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run([str(API_DIR / ".venv/bin/alembic"), *args], cwd=API_DIR,
                            env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr[-2000:]


def test_0088_downgrades_and_upgrades_again():
    """Runs on a throwaway database (never the shared test DB, whose schema
    must stay at head), same pattern as test_wiki_migration_downgrade."""
    assert THROWAWAY_DB.startswith("serversherpa_test")
    base = make_url(get_settings().database_url.get_secret_value())
    admin = base.set(drivername="postgresql", database="postgres").render_as_string(
        hide_password=False)
    url = base.set(database=THROWAWAY_DB)
    sync = url.set(drivername="postgresql").render_as_string(hide_password=False)

    def state():
        with psycopg.connect(sync, autocommit=True) as conn:
            cols = {r[0] for r in conn.execute(
                "select column_name from information_schema.columns "
                "where table_name='devices'")}
            check = conn.execute(
                "select count(*) from pg_constraint where conname='ck_devices_station_type'"
            ).fetchone()[0]
        return {c for c in _COLS if c in cols}, check

    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{THROWAWAY_DB}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{THROWAWAY_DB}"')
    try:
        _alembic(url, "upgrade", "0088")
        assert state() == (set(_COLS), 1)
        _alembic(url, "downgrade", "0087")
        assert state() == (set(), 0)
        _alembic(url, "upgrade", "0088")
        assert state() == (set(_COLS), 1)
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{THROWAWAY_DB}" WITH (FORCE)')


async def test_get_setup_reads_back_the_stamped_setup(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    r = await client.post("/kiosk/setup", headers=hdrs,
                          json={**body, "station_type": "rfid", "reader": READER})
    assert r.status_code == 200, r.text
    posted = r.json()
    r = await client.get("/kiosk/setup", headers=hdrs, params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["device_id"] == str(device_id)
    assert got["initiative_id"] == body["initiative_id"]
    assert got["initiative_name"] == posted["initiative_name"]
    assert got["site_id"] == body["site_id"] and got["site_name"] == posted["site_name"]
    assert got["scan_status"] == body["scan_status"]
    assert got["scan_status_label"] == posted["scan_status_label"]
    assert got["station_type"] == "rfid"
    assert got["reader"] == {"ip": "10.20.30.40", "serial": "FX9600-AB12",
                             "model": "FX9600"}
    assert "token" not in str(got).lower()


async def test_get_setup_unset_device_is_empty(client, db, seeded_user):
    hdrs = await login(client)
    await _setup_body(db)
    got = (await client.get("/kiosk/setup", headers=hdrs, params={"serial": SERIAL})).json()
    assert got["initiative_id"] is None and got["site_id"] is None
    assert got["station_type"] is None and got["reader"] is None


async def test_get_setup_unknown_serial_is_404(client, db, seeded_user):
    hdrs = await login(client)
    r = await client.get("/kiosk/setup", headers=hdrs, params={"serial": "nope"})
    assert r.status_code == 404 and _code(r) == "device_not_found"


async def test_get_setup_move_session_for_another_move_is_404(client, db, seeded_user):
    admin = await _make(db, client, "admin", "station-admin2@test.example.com")
    body, device_id = await _setup_body(db)
    other = Initiative(name="Other move", initiative_type="move", status="in_progress")
    db.add(other)
    await db.commit()
    mine = await db.get(Initiative, uuid.UUID(body["initiative_id"]))
    assert (await client.patch(f"/initiatives/{mine.id}", headers=admin,
                               json={"kiosk_password": PW})).status_code == 200
    r = await client.post("/kiosk/move-login", json={"password": PW})
    hdrs = {"Authorization": f"Bearer {r.json()['access_token']}"}
    # Device not yet stamped with this move: not visible to this session.
    r = await client.get("/kiosk/setup", headers=hdrs, params={"serial": SERIAL})
    assert r.status_code == 404 and _code(r) == "device_not_found"
    r = await client.post("/kiosk/setup", headers=hdrs, json=body)
    assert r.status_code == 200, r.text
    assert (await client.get("/kiosk/setup", headers=hdrs,
                             params={"serial": SERIAL})).status_code == 200
    (await _device(db, device_id)).current_initiative_id = other.id
    await db.commit()
    r = await client.get("/kiosk/setup", headers=hdrs, params={"serial": SERIAL})
    assert r.status_code == 404 and _code(r) == "device_not_found"


async def test_get_setup_needs_kiosk_view(client, db, seeded_user):
    from tests.test_auth_kiosk_login import _client_viewer
    await _setup_body(db)
    cv = await _client_viewer(db, client, "cv-setup@test.example.com")
    r = await client.get("/kiosk/setup", headers=cv, params={"serial": SERIAL})
    assert r.status_code == 403
    assert (await client.get("/kiosk/setup", params={"serial": SERIAL})).status_code == 401
