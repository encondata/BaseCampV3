"""A move-password session is locked to its move: it can't approve (or
deny) a phone pairing, a pairing approved by the move's kiosk identity
never mints a session, revoking a move's sessions catches an unlocked
identity session too, and every kiosk route that names a move, an asset,
a container or a truck refuses another move with 403 `move_locked`.
Person-login kiosk sessions are unaffected."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.orm import joinedload

from serversherpa.db.models import (
    Asset, AuditLog, AuthSession, Container, Device, Initiative, InitiativeAsset,
    KioskPairRequest, Person, Site, StatusValue, Truck, UserAccount,
)
from serversherpa.services import auth as auth_service
from serversherpa.services import move_password as svc
from tests.test_status_values_write import _make

PW = "Crew-2026!"
SERIAL = "kiosk-move-lock-1"
CHECKPOINT = "lock_test_checkpoint"


async def _admin(db, client):
    return await _make(db, client, "admin", "lock-admin@test.example.com")


async def _move(db, name):
    init = Initiative(name=name, initiative_type="move", status="in_progress")
    db.add(init)
    await db.commit()
    return init


async def _move_session(client, password=PW):
    r = await client.post("/kiosk/move-login", json={"password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _person_kiosk_session(client):
    r = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!", "client": "kiosk"})
    assert r.status_code == 200, r.text
    assert r.json().get("kiosk_move") is None
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _code(r):
    return r.json()["detail"]["code"]


# ── pairing ──────────────────────────────────────────────────────────

async def test_move_session_cannot_approve_or_deny_a_pairing(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db, "Pairing move")
    assert (await client.patch(f"/initiatives/{init.id}", headers=admin,
                               json={"kiosk_password": PW})).status_code == 200
    hdrs = await _move_session(client)
    pair = (await client.post("/kiosk/pair", json={"serial": "kiosk-web-lock", "name": "X"})).json()
    r = await client.post(f"/kiosk/pair/{pair['code']}/approve", headers=hdrs)
    assert r.status_code == 403 and _code(r) == "move_locked"
    r = await client.post(f"/kiosk/pair/{pair['code']}/deny", headers=hdrs)
    assert r.status_code == 403 and _code(r) == "move_locked"
    row = await db.scalar(select(KioskPairRequest).where(KioskPairRequest.code == pair["code"]))
    assert row.status == "pending" and row.approved_by is None
    poll = await client.post(f"/kiosk/pair/{pair['code']}/poll",
                             json={"poll_token": pair["poll_token"]})
    assert poll.json()["status"] == "pending"


async def test_pairing_approved_by_the_kiosk_identity_is_denied(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db, "Identity move")
    await client.patch(f"/initiatives/{init.id}", headers=admin, json={"kiosk_password": PW})
    await db.refresh(init)
    identity = init.kiosk_person_id
    pair = (await client.post("/kiosk/pair", json={"serial": "kiosk-web-lock2", "name": "Y"})).json()
    # an approval that got stored anyway (not through _decide)
    await db.execute(update(KioskPairRequest).where(KioskPairRequest.code == pair["code"])
                     .values(status="approved", approved_by=identity))
    await db.commit()
    poll = await client.post(f"/kiosk/pair/{pair['code']}/poll",
                             json={"poll_token": pair["poll_token"]})
    assert poll.status_code == 200 and poll.json()["status"] == "denied"
    assert poll.json().get("session") is None
    db.expire_all()
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "kiosk_pair_claim_denied", AuditLog.entity_id == pair["code"]))
    assert row.changes["reason"] == "kiosk_identity"
    assert await db.scalar(select(AuthSession.id).where(AuthSession.person_id == identity)) is None


async def test_revoke_move_sessions_catches_an_unlocked_identity_session(db, seeded_user):
    init = Initiative(name="Revoke move", initiative_type="move", status="planned")
    db.add(init)
    await db.flush()
    await svc.set_password(db, init, PW, actor_id=seeded_user.id)
    account = await svc.ensure_kiosk_identity(db, init)
    await db.commit()
    stray = await auth_service.start_session(
        db, account, ip=None, user_agent=None, client="kiosk", audit_action="login_pair")
    await db.commit()
    assert (await db.get(AuthSession, stray.session_id)).initiative_id is None
    # someone else's session is untouched
    alice = await db.get(UserAccount, seeded_user.id, options=[joinedload(UserAccount.person)])
    other = await auth_service.start_session(
        db, alice, ip=None, user_agent=None, client="kiosk", audit_action="login")
    await db.commit()
    assert await svc.revoke_move_sessions(db, init.id) == 1
    await db.commit()
    db.expire_all()
    assert (await db.get(AuthSession, stray.session_id)).revoked_at is not None
    assert (await db.get(AuthSession, other.session_id)).revoked_at is None


# ── kiosk routes ─────────────────────────────────────────────────────

async def _world(db, client):
    """Two moves, A (with the password) and B, each with a roster asset, a
    container and a truck; a kiosk set up for A; a worker to punch."""
    admin = await _admin(db, client)
    site = Site(name="Lock Hall")
    a = Initiative(name="Lock Move A", initiative_type="move", status="in_progress")
    b = Initiative(name="Lock Move B", initiative_type="move", status="in_progress")
    db.add_all([site, a, b, StatusValue(record_type="asset", key=CHECKPOINT, label="Lock CP",
                                        color="#123456", sort_order=1, is_active=True)])
    await db.flush()
    for record_type, key, label in (("container", "available", "Available"),
                                    ("truck", "in_transit", "In Transit")):
        if await db.scalar(select(StatusValue).where(
                StatusValue.record_type == record_type, StatusValue.key == key)) is None:
            db.add(StatusValue(record_type=record_type, key=key, label=label,
                               color="#2e7d32", sort_order=0, is_active=True))
    w = {}
    for tag, move in (("a", a), ("b", b)):
        asset = Asset(name=f"Lock asset {tag}", serial_number=f"SN-LOCK-{tag}")
        crate = Container(name=f"LOCK-CRATE-{tag}", status="available", initiative_id=move.id)
        truck = Truck(name=f"LOCK-TRUCK-{tag}", status="in_transit", initiative_id=move.id)
        db.add_all([asset, crate, truck])
        await db.flush()
        db.add(InitiativeAsset(initiative_id=move.id, asset_id=asset.id))
        w[tag] = {"move": move, "asset": asset, "crate": crate, "truck": truck}
    db.add(Device(device_type="kiosk", name="Lock kiosk", serial=SERIAL, site_id=site.id,
                  current_initiative_id=a.id, scan_status=CHECKPOINT))
    worker_a = Person(first_name="Punch", last_name="Alpha")
    worker_b = Person(first_name="Punch", last_name="Bravo")
    db.add_all([worker_a, worker_b])
    await db.commit()
    r = await client.patch(f"/initiatives/{a.id}", headers=admin, json={"kiosk_password": PW})
    assert r.status_code == 200, r.text
    w["worker_a"], w["worker_b"] = worker_a, worker_b
    return w


def _scan_body(**kw):
    return {"client_scan_id": str(uuid.uuid4()), "scanned_value": "EPC-LOCK",
            "scan_type": "rfid", "scanned_at": datetime.now(UTC).isoformat(), **kw}


def _write_body(move_id, **kw):
    return {"serial": SERIAL, "scan_status": CHECKPOINT, "client_scan_id": str(uuid.uuid4()),
            "initiative_id": str(move_id), **kw}


async def _rfid(client, hdrs, asset, move, tag):
    return await client.post(f"/kiosk/assets/{asset.id}/rfid", headers=hdrs,
                             json=_write_body(move.id, rfid_tag=tag))


async def _pack(client, hdrs, crate, asset, move):
    return await client.post(f"/kiosk/containers/{crate.id}/assets", headers=hdrs, json=_write_body(
        move.id, asset_id=str(asset.id), action="pack", scanned_value=asset.serial_number,
        scan_type="barcode"))


async def _load(client, hdrs, truck, crate, move):
    return await client.post(f"/kiosk/trucks/{truck.id}/containers", headers=hdrs, json=_write_body(
        move.id, container_id=str(crate.id), action="load", scanned_value=crate.name,
        scan_type="barcode"))


async def _clock_in(client, hdrs, person, move):
    return await client.post("/kiosk/timeclock/clock-in", headers=hdrs, json={
        "serial": SERIAL, "person_id": str(person.id), "initiative_id": str(move.id)})


async def test_move_session_is_locked_to_its_move(client, db, seeded_user):
    w = await _world(db, client)
    a, b = w["a"], w["b"]
    hdrs = await _move_session(client)

    def locked(r):
        assert r.status_code == 403 and _code(r) == "move_locked", r.text

    def ok(r):
        assert r.status_code == 200, r.text

    for kind in ("assets", "containers", "trucks"):
        locked(await client.get(f"/kiosk/sync/{kind}?initiative_id={b['move'].id}", headers=hdrs))
        ok(await client.get(f"/kiosk/sync/{kind}?initiative_id={a['move'].id}", headers=hdrs))
    # people stay unrestricted: workers not on the move still clock in
    ok(await client.get("/kiosk/sync/people", headers=hdrs))

    # scans: rejected one by one (the rest of the batch still lands)
    own, other, fallback = (_scan_body(initiative_id=str(a["move"].id)),
                            _scan_body(initiative_id=str(b["move"].id)), _scan_body())
    r = await client.post("/kiosk/scans", headers=hdrs,
                          json={"serial": SERIAL, "scans": [own, other, fallback]})
    ok(r)
    assert set(r.json()["accepted"]) == {own["client_scan_id"], fallback["client_scan_id"]}
    assert r.json()["rejected"] == [{"client_scan_id": other["client_scan_id"],
                                     "code": "move_locked"}]

    # RFID enroll: another move's asset, or another move in the body
    locked(await _rfid(client, hdrs, b["asset"], a["move"], "LOCKB1"))
    locked(await _rfid(client, hdrs, a["asset"], b["move"], "LOCKA1"))
    ok(await _rfid(client, hdrs, a["asset"], a["move"], "LOCKA1"))

    # containers: another move's crate, an asset off the roster, another move in the body
    locked(await _pack(client, hdrs, b["crate"], a["asset"], a["move"]))
    locked(await _pack(client, hdrs, a["crate"], b["asset"], a["move"]))
    locked(await _pack(client, hdrs, a["crate"], a["asset"], b["move"]))
    ok(await _pack(client, hdrs, a["crate"], a["asset"], a["move"]))

    # trucks: another move's truck or crate, another move in the body
    locked(await _load(client, hdrs, b["truck"], a["crate"], a["move"]))
    locked(await _load(client, hdrs, a["truck"], b["crate"], a["move"]))
    locked(await _load(client, hdrs, a["truck"], a["crate"], b["move"]))
    ok(await _load(client, hdrs, a["truck"], a["crate"], a["move"]))

    # timeclock: clock in on another move; clock out a shift another move opened
    locked(await _clock_in(client, hdrs, w["worker_a"], b["move"]))
    ok(await _clock_in(client, hdrs, w["worker_a"], a["move"]))
    ok(await client.post("/kiosk/timeclock/clock-out", headers=hdrs,
                         json={"serial": SERIAL, "person_id": str(w["worker_a"].id)}))
    person_hdrs = await _person_kiosk_session(client)
    ok(await _clock_in(client, person_hdrs, w["worker_b"], b["move"]))
    locked(await client.post("/kiosk/timeclock/clock-out", headers=hdrs,
                             json={"serial": SERIAL, "person_id": str(w["worker_b"].id)}))


async def test_person_kiosk_session_reaches_every_move(client, db, seeded_user):
    w = await _world(db, client)
    a, b = w["a"], w["b"]
    hdrs = await _person_kiosk_session(client)
    for kind in ("assets", "containers", "trucks"):
        for side in (a, b):
            r = await client.get(f"/kiosk/sync/{kind}?initiative_id={side['move'].id}", headers=hdrs)
            assert r.status_code == 200, r.text
    scans = [_scan_body(initiative_id=str(a["move"].id)), _scan_body(initiative_id=str(b["move"].id))]
    r = await client.post("/kiosk/scans", headers=hdrs, json={"serial": SERIAL, "scans": scans})
    assert r.status_code == 200 and r.json()["rejected"] == []
    for side, tag in ((a, "PERSA1"), (b, "PERSB1")):
        assert (await _rfid(client, hdrs, side["asset"], side["move"], tag)).status_code == 200
        assert (await _pack(client, hdrs, side["crate"], side["asset"], side["move"])).status_code == 200
        assert (await _load(client, hdrs, side["truck"], side["crate"], side["move"])).status_code == 200
    assert (await _clock_in(client, hdrs, w["worker_a"], a["move"])).status_code == 200
    assert (await _clock_in(client, hdrs, w["worker_b"], b["move"])).status_code == 200
