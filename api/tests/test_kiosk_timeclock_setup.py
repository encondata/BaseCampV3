"""Kiosk Setup for a Time Clock station (spec "Setup"): POST /kiosk/setup with
station_type 'timeclock' takes no scan type, and the move and site are
optional. With a move the site is the move's source or destination; with no
move it is any active site (role 'other') or none. Other station types keep
requiring a move, site and scan type. POST /kiosk/station-key accepts a
missing move for a Time Clock station only, and changing the move (None
counts) revokes the key. GET /kiosk/setup-options lists every active site."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Initiative, Site
from tests.test_kiosk_setup_api import (
    SERIAL,
    _seed_initiatives,
    _seed_scan_types,
    _seed_sites,
)
from tests.test_sites_api import login
from tests.test_status_values_write import _make

PW = "Crew-2026!"


async def _seed(db, *, sub_type="laptop"):
    """A laptop kiosk, the move's two sites plus an unrelated one, a move with
    both sites, and an active scan type. -> dict of ids/keys."""
    device = Device(device_type="kiosk", name="Time Clock Target", serial=SERIAL,
                    sub_type=sub_type)
    db.add(device)
    origin, dest = await _seed_sites(db)
    other = Site(name="Unrelated Hall")
    db.add(other)
    planned, *_ = await _seed_initiatives(db, origin_site=origin, dest_site=dest)
    active, *_ = await _seed_scan_types(db)
    await db.commit()
    return {"device_id": device.id, "move_id": planned.id, "move_name": planned.name,
            "origin_id": origin.id, "dest_id": dest.id, "dest_name": dest.name,
            "other_id": other.id, "other_name": other.name, "scan_key": active.key}


async def _device(db, device_id):
    db.expire_all()
    return await db.scalar(select(Device).where(Device.id == device_id))


def _code(r):
    return r.json()["detail"]["code"]


async def _setup(client, hdrs, *, move=None, site=None, scan=None, station_type="timeclock"):
    return await client.post("/kiosk/setup", headers=hdrs, json={
        "serial": SERIAL, "station_type": station_type,
        "initiative_id": str(move) if move else None,
        "site_id": str(site) if site else None,
        "scan_status": scan})


async def _make_key_ready(db, device_id, person_id):
    """Registered, with `person_id` signed in here, so /kiosk/station-key may issue."""
    live = await db.get(Device, device_id)
    live.token_expires_at = datetime.now(UTC) + timedelta(days=30)
    live.session_person_id = person_id
    await db.commit()


async def test_timeclock_setup_with_move(client, db, seeded_user):
    hdrs = await login(client)
    s = await _seed(db)
    r = await _setup(client, hdrs, move=s["move_id"], site=s["dest_id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["initiative_id"] == str(s["move_id"])
    assert body["initiative_name"] == s["move_name"]
    assert body["site_id"] == str(s["dest_id"])
    assert body["site_name"] == s["dest_name"]
    assert body["site_role"] == "destination"
    assert body["scan_status"] is None and body["scan_status_label"] is None
    d = await _device(db, s["device_id"])
    assert d.station_type == "timeclock"
    assert d.current_initiative_id == s["move_id"] and d.site_id == s["dest_id"]
    assert d.scan_status is None
    assert d.rfid_reader_ip is None and d.rfid_reader_serial is None
    assert d.rfid_reader_model is None and d.rfid_reader_versions is None
    assert d.rfid_paired_at is None


async def test_timeclock_setup_ignores_a_sent_scan_status(client, db, seeded_user):
    hdrs = await login(client)
    s = await _seed(db)
    r = await _setup(client, hdrs, move=s["move_id"], site=s["origin_id"],
                     scan=s["scan_key"])
    assert r.status_code == 200, r.text
    assert r.json()["site_role"] == "source" and r.json()["scan_status"] is None
    assert (await _device(db, s["device_id"])).scan_status is None


async def test_timeclock_setup_clears_an_rfid_reader(client, db, seeded_user):
    hdrs = await login(client)
    s = await _seed(db)
    live = await db.get(Device, s["device_id"])
    live.station_type = "rfid"
    live.rfid_reader_serial = "FX9600-AB12"
    live.rfid_reader_model = "FX9600"
    live.rfid_paired_at = datetime.now(UTC)
    await db.commit()
    r = await _setup(client, hdrs)
    assert r.status_code == 200, r.text
    d = await _device(db, s["device_id"])
    assert d.station_type == "timeclock"
    assert d.rfid_reader_serial is None and d.rfid_reader_model is None
    assert d.rfid_paired_at is None


async def test_timeclock_setup_with_move_rejects_foreign_site(client, db, seeded_user):
    hdrs = await login(client)
    s = await _seed(db)
    r = await _setup(client, hdrs, move=s["move_id"], site=s["other_id"])
    assert r.status_code == 422 and _code(r) == "bad_site"
    # a move needs one of its sites
    r = await _setup(client, hdrs, move=s["move_id"])
    assert r.status_code == 422 and _code(r) == "bad_site"
    assert (await _device(db, s["device_id"])).station_type is None


async def test_timeclock_setup_with_move_lacking_sites_needs_a_site(client, db, seeded_user):
    """A move with no source or destination set does not match a missing site."""
    hdrs = await login(client)
    s = await _seed(db)
    bare = Initiative(name="Bare Move", initiative_type="move", status="planned")
    db.add(bare)
    await db.commit()
    r = await _setup(client, hdrs, move=bare.id)
    assert r.status_code == 422 and _code(r) == "bad_site"
    assert (await _device(db, s["device_id"])).station_type is None


async def test_timeclock_setup_rejects_inactive_moves(client, db, seeded_user):
    hdrs = await login(client)
    s = await _seed(db)
    done = Initiative(name="Done Move", initiative_type="move", status="completed",
                      destination_site_id=s["dest_id"])
    db.add(done)
    await db.commit()
    r = await _setup(client, hdrs, move=done.id, site=s["dest_id"])
    assert r.status_code == 422 and _code(r) == "bad_initiative"
    r = await _setup(client, hdrs, move=uuid.uuid4(), site=s["dest_id"])
    assert r.status_code == 422 and _code(r) == "bad_initiative"


async def test_timeclock_setup_no_move_any_site(client, db, seeded_user):
    hdrs = await login(client)
    seeded_user_id = seeded_user.id
    s = await _seed(db)
    # stamp a move first, so the no-move setup has to clear it
    assert (await _setup(client, hdrs, move=s["move_id"],
                         site=s["dest_id"])).status_code == 200
    r = await _setup(client, hdrs, site=s["other_id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["initiative_id"] is None and body["initiative_name"] is None
    assert body["site_id"] == str(s["other_id"])
    assert body["site_name"] == s["other_name"]
    assert body["site_role"] == "other"
    assert body["scan_status"] is None and body["scan_status_label"] is None
    d = await _device(db, s["device_id"])
    assert d.current_initiative_id is None
    assert d.site_id == s["other_id"]
    assert d.station_type == "timeclock" and d.scan_status is None
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "kiosk_setup",
        AuditLog.entity_id == str(s["device_id"])))).all()
    no_move = [a for a in rows if a.changes["initiative_id"] is None]
    assert len(no_move) == 1
    assert no_move[0].changes == {"initiative_id": None, "site_id": str(s["other_id"]),
                                  "scan_status": None}
    assert no_move[0].actor_person_id == seeded_user_id


async def test_timeclock_setup_no_move_rejects_archived_or_unknown_site(client, db, seeded_user):
    hdrs = await login(client)
    s = await _seed(db)
    gone = Site(name="Closed Hall", archived_at=datetime.now(UTC))
    db.add(gone)
    await db.commit()
    r = await _setup(client, hdrs, site=gone.id)
    assert r.status_code == 422 and _code(r) == "bad_site"
    r = await _setup(client, hdrs, site=uuid.uuid4())
    assert r.status_code == 422 and _code(r) == "bad_site"
    assert (await _device(db, s["device_id"])).station_type is None


async def test_timeclock_setup_no_move_no_site(client, db, seeded_user):
    hdrs = await login(client)
    s = await _seed(db)
    assert (await _setup(client, hdrs, site=s["other_id"])).status_code == 200
    r = await _setup(client, hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["initiative_id"] is None and body["site_id"] is None
    assert body["site_name"] is None and body["site_role"] is None
    d = await _device(db, s["device_id"])
    assert d.site_id is None and d.current_initiative_id is None
    assert d.station_type == "timeclock"
    # the read-back returns the new type unchanged
    r = await client.get("/kiosk/setup", headers=hdrs, params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    assert r.json()["station_type"] == "timeclock"
    assert r.json()["initiative_id"] is None and r.json()["site_id"] is None


async def test_regular_re_setup_clears_a_timeclock_station(client, db, seeded_user):
    """A Time Clock kiosk set up again as a regular kiosk (no station type) is no
    longer a Time Clock Station: its type clears, so Kiosk Devices stops listing it."""
    hdrs = await login(client)
    s = await _seed(db)
    assert (await _setup(client, hdrs)).status_code == 200
    assert (await _device(db, s["device_id"])).station_type == "timeclock"
    r = await _setup(client, hdrs, move=s["move_id"], site=s["dest_id"],
                     scan=s["scan_key"], station_type=None)
    assert r.status_code == 200, r.text
    assert (await _device(db, s["device_id"])).station_type is None


async def test_non_timeclock_still_requires_move_site_scan(client, db, seeded_user):
    hdrs = await login(client)
    s = await _seed(db)
    for station_type in (None, "label"):
        r = await _setup(client, hdrs, site=s["dest_id"], scan=s["scan_key"],
                         station_type=station_type)
        assert r.status_code == 422 and _code(r) == "bad_initiative", station_type
        r = await _setup(client, hdrs, move=s["move_id"], scan=s["scan_key"],
                         station_type=station_type)
        assert r.status_code == 422 and _code(r) == "bad_site", station_type
    r = await _setup(client, hdrs, move=s["move_id"], site=s["dest_id"], station_type=None)
    assert r.status_code == 422 and _code(r) == "bad_scan_status"
    d = await _device(db, s["device_id"])
    assert d.current_initiative_id is None and d.station_type is None


async def test_move_password_session_cannot_set_up_no_move(client, db, seeded_user):
    admin = await _make(db, client, "admin", "tc-setup-admin@test.example.com")
    s = await _seed(db)
    assert (await client.patch(f"/initiatives/{s['move_id']}", headers=admin,
                               json={"kiosk_password": PW})).status_code == 200
    r = await client.post("/kiosk/move-login", json={"password": PW})
    assert r.status_code == 200, r.text
    hdrs = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = await _setup(client, hdrs, site=s["other_id"])
    assert r.status_code == 403 and _code(r) == "move_locked"
    r = await _setup(client, hdrs)
    assert r.status_code == 403 and _code(r) == "move_locked"
    assert (await _device(db, s["device_id"])).station_type is None
    # its own move still works
    r = await _setup(client, hdrs, move=s["move_id"], site=s["dest_id"])
    assert r.status_code == 200, r.text


async def test_station_key_issue_without_move_for_timeclock(client, db, seeded_user):
    hdrs = await login(client)
    uid = seeded_user.id
    s = await _seed(db)
    assert (await _setup(client, hdrs)).status_code == 200
    await _make_key_ready(db, s["device_id"], uid)
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 200, r.text
    assert r.json()["key"]
    d = await _device(db, s["device_id"])
    assert d.station_key_hash is not None and d.station_key_initiative_id is None
    # a Label Station with no move is still refused
    d.station_type = "label"
    d.station_key_hash = None
    await db.commit()
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 409 and _code(r) == "not_rfid_station"


async def test_change_move_none_to_some_revokes_key(client, db, seeded_user):
    hdrs = await login(client)
    uid = seeded_user.id
    s = await _seed(db)
    assert (await _setup(client, hdrs)).status_code == 200
    await _make_key_ready(db, s["device_id"], uid)
    assert (await client.post("/kiosk/station-key", headers=hdrs,
                              json={"serial": SERIAL})).status_code == 200
    # re-setup with no move again keeps the key
    assert (await _setup(client, hdrs, site=s["other_id"])).status_code == 200
    assert (await _device(db, s["device_id"])).station_key_hash is not None
    r = await _setup(client, hdrs, move=s["move_id"], site=s["dest_id"])
    assert r.status_code == 200, r.text
    d = await _device(db, s["device_id"])
    assert d.station_key_hash is None and d.station_key_initiative_id is None
    revokes = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "station_key_revoke",
        AuditLog.entity_id == str(s["device_id"])))).all()
    assert [a.changes for a in revokes] == [{"reason": "move_change"}]


async def test_change_move_some_to_none_revokes_key(client, db, seeded_user):
    hdrs = await login(client)
    uid = seeded_user.id
    s = await _seed(db)
    assert (await _setup(client, hdrs, move=s["move_id"],
                         site=s["dest_id"])).status_code == 200
    await _make_key_ready(db, s["device_id"], uid)
    assert (await client.post("/kiosk/station-key", headers=hdrs,
                              json={"serial": SERIAL})).status_code == 200
    assert (await _setup(client, hdrs)).status_code == 200
    d = await _device(db, s["device_id"])
    assert d.station_key_hash is None
    revokes = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "station_key_revoke",
        AuditLog.entity_id == str(s["device_id"])))).all()
    assert [a.changes for a in revokes] == [{"reason": "move_change"}]


async def test_setup_options_lists_sites(client, db, seeded_user):
    hdrs = await login(client)
    zeta = Site(name="Site 10 Zeta")
    alpha = Site(name="Site 9 Alpha")
    gone = Site(name="Site 1 Archived", archived_at=datetime.now(UTC))
    db.add_all([zeta, alpha, gone])
    await db.commit()
    r = await client.get("/kiosk/setup-options", headers=hdrs)
    assert r.status_code == 200, r.text
    sites = r.json()["sites"]
    active_names = {n for (n,) in (await db.execute(
        select(Site.name).where(Site.archived_at.is_(None)))).all()}
    assert {x["name"] for x in sites} == active_names
    assert "Site 1 Archived" not in {x["name"] for x in sites}
    by_name = {x["name"]: x["id"] for x in sites}
    assert by_name["Site 9 Alpha"] == str(alpha.id)
    names = [x["name"] for x in sites]
    # natural order: 9 before 10
    assert names.index("Site 9 Alpha") < names.index("Site 10 Zeta")
