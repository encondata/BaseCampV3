"""POST /kiosk/station/dock/passes: a Dock Station laptop packs one closed pass
into its one crate under its station key, in one transaction, idempotent on
the laptop's own pass id. Membership only (no `raw_scans`); one
`kiosk_container_pack` audit row per asset that changed crate, with the
kiosk's name and no person. Spec:
docs/superpowers/specs/2026-11-05-dock-station-design.md"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy import func, select

from serversherpa.db.models import (
    Asset, AuditLog, Container, ContainerAsset, Device, DockPass, Initiative,
    InitiativeAsset, RawScan,
)
from serversherpa.services import station_keys
from tests.test_kiosk_dock_station import _dock_station
from tests.test_kiosk_station_key import SERIAL, _code, _device
from tests.test_kiosk_station_scans import _auth, _station
from tests.test_system_admin_api import _admin

T_CLOSE = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)   # when the test passes closed


async def _seed(db):
    """A keyed Dock laptop on a move with two crates and three roster assets."""
    device, move, key = await _dock_station(db)
    a = Container(name="DOCK-CRATE-A", initiative_id=move.id)
    b = Container(name="DOCK-CRATE-B", initiative_id=move.id)
    assets = [Asset(name=f"Dock Asset {i}", serial_number=f"SN-DOCK-{i}")
              for i in (1, 2, 3)]
    db.add_all([a, b, *assets])
    await db.flush()
    db.add_all([InitiativeAsset(initiative_id=move.id, asset_id=x.id) for x in assets])
    await db.commit()
    for x in (a, b, *assets):
        db.expunge(x)   # keep ids readable after the tests' expire_all()
    return SimpleNamespace(device=device, move=move, key=key, a=a, b=b, assets=assets)


def _body(crate, assets, *, pass_id=None, closed_at=T_CLOSE, serial=SERIAL):
    return {"serial": serial, "pass_id": str(pass_id or uuid.uuid4()),
            "container_id": str(getattr(crate, "id", crate)),
            "closed_at": closed_at if isinstance(closed_at, str) else closed_at.isoformat(),
            "asset_ids": [str(getattr(x, "id", x)) for x in assets]}


async def _send(client, key, body):
    return await client.post("/kiosk/station/dock/passes", headers=_auth(key), json=body)


async def _holder(db, asset):
    asset_id = getattr(asset, "id", asset)
    db.expire_all()
    return await db.scalar(select(ContainerAsset).where(ContainerAsset.asset_id == asset_id))


async def _packs(db):
    db.expire_all()
    return (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_container_pack"))).all()


async def _count(db, model):
    db.expire_all()
    return await db.scalar(select(func.count()).select_from(model))


async def _put(db, crate, asset, added_at):
    db.add(ContainerAsset(container_id=crate.id, asset_id=asset.id, added_at=added_at))
    await db.commit()


async def test_pass_packs_assets_into_crate(client, db, seeded_user):
    s = await _seed(db)
    one, two, _ = s.assets
    scans = await _count(db, RawScan)
    body = _body(s.a, [one, two])
    r = await _send(client, s.key, body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["pass_id"] == body["pass_id"]
    assert out["container"] == {"id": str(s.a.id), "name": "DOCK-CRATE-A"}
    assert out["assets"] == [
        {"asset_id": str(one.id), "result": "packed", "moved_from": None, "reason": None},
        {"asset_id": str(two.id), "result": "packed", "moved_from": None, "reason": None}]
    assert out["replayed"] is False and out["clear_setup"] is None

    for asset in (one, two):
        row = await _holder(db, asset)
        assert row.container_id == s.a.id and row.added_at == T_CLOSE
        assert row.added_by is None
    audits = await _packs(db)
    assert sorted(x.changes["asset_id"] for x in audits) == sorted([str(one.id), str(two.id)])
    for row in audits:
        assert row.actor_person_id is None
        assert row.entity_type == "container" and row.entity_id == str(s.a.id)
        assert row.changes["device"] == s.device.name
        assert row.changes["via"] == "dock_pass"
        assert row.changes["pass_id"] == body["pass_id"]
        assert row.changes["from_container"] is None
    assert await _count(db, RawScan) == scans

    stored = await db.get(DockPass, uuid.UUID(body["pass_id"]))
    assert stored.device_id == s.device.id and stored.container_id == s.a.id
    assert stored.closed_at == T_CLOSE
    assert stored.reply["assets"] == out["assets"]
    assert (await db.get(Device, s.device.id)).last_seen_at is not None


async def test_pass_moves_asset_from_other_crate(client, db, seeded_user):
    s = await _seed(db)
    one = s.assets[0]
    await _put(db, s.b, one, T_CLOSE - timedelta(hours=1))
    r = await _send(client, s.key, _body(s.a, [one]))
    assert r.status_code == 200, r.text
    [res] = r.json()["assets"]
    assert res["result"] == "moved"
    assert res["moved_from"] == {"id": str(s.b.id), "name": "DOCK-CRATE-B"}
    row = await _holder(db, one)
    assert row.container_id == s.a.id and row.added_at == T_CLOSE
    [audit] = await _packs(db)
    assert audit.changes["from_container"] == "DOCK-CRATE-B"


async def test_pass_already_there_is_noop(client, db, seeded_user):
    s = await _seed(db)
    one = s.assets[0]
    first = await _send(client, s.key, _body(s.a, [one]))
    assert first.json()["assets"][0]["result"] == "packed"
    audits = len(await _packs(db))
    again = await _send(client, s.key, _body(s.a, [one]))
    assert again.status_code == 200, again.text
    assert again.json()["assets"] == [
        {"asset_id": str(one.id), "result": "already_there", "moved_from": None,
         "reason": None}]
    assert again.json()["replayed"] is False
    assert len(await _packs(db)) == audits
    assert (await _holder(db, one)).container_id == s.a.id


async def test_pass_replay_returns_stored_reply(client, db, seeded_user):
    s = await _seed(db)
    body = _body(s.a, s.assets[:2])
    first = await _send(client, s.key, body)
    assert first.status_code == 200, first.text
    audits = len(await _packs(db))
    second = await _send(client, s.key, body)
    assert second.status_code == 200, second.text
    assert second.json()["assets"] == first.json()["assets"]
    assert [x["result"] for x in second.json()["assets"]] == ["packed", "packed"]
    assert second.json()["container"] == first.json()["container"]
    assert first.json()["replayed"] is False and second.json()["replayed"] is True
    assert len(await _packs(db)) == audits
    assert await _count(db, DockPass) == 1


async def test_pass_racing_twins_pack_once(client, db, seeded_user):
    """Two sends of one pass at once: the second waits on the pass id, then
    replays the first's answer instead of packing again."""
    s = await _seed(db)
    body = _body(s.a, s.assets)
    replies = await asyncio.gather(_send(client, s.key, body), _send(client, s.key, body))
    assert [r.status_code for r in replies] == [200, 200], [r.text for r in replies]
    out = sorted((r.json() for r in replies), key=lambda x: x["replayed"])
    assert [x["replayed"] for x in out] == [False, True]
    assert out[0]["assets"] == out[1]["assets"]
    assert len(await _packs(db)) == 3
    assert await _count(db, DockPass) == 1


async def test_pass_refuses_newer_membership(client, db, seeded_user):
    s = await _seed(db)
    one, two, three = s.assets
    later = T_CLOSE + timedelta(minutes=1)
    await _put(db, s.b, one, later)
    await _put(db, s.a, two, later)
    r = await _send(client, s.key, _body(s.a, [one, two, three]))
    assert r.status_code == 200, r.text
    assert r.json()["assets"] == [
        {"asset_id": str(one.id), "result": "refused", "moved_from": None,
         "reason": "changed_since_pass"},
        {"asset_id": str(two.id), "result": "already_there", "moved_from": None,
         "reason": None},
        {"asset_id": str(three.id), "result": "packed", "moved_from": None,
         "reason": None}]
    assert (await _holder(db, one)).container_id == s.b.id
    assert (await _holder(db, two)).added_at == later
    assert [x.changes["asset_id"] for x in await _packs(db)] == [str(three.id)]


async def test_pass_asset_refusals(client, db, seeded_user):
    s = await _seed(db)
    one, two, _ = s.assets
    off = Asset(name="Not On The Move", serial_number="SN-DOCK-OFF")
    db.add(off)
    (await db.get(Asset, two.id)).archived_at = datetime.now(UTC)
    await db.commit()
    off = off.id
    gone = uuid.uuid4()
    r = await _send(client, s.key, _body(s.a, [one, off, two, one, gone]))
    assert r.status_code == 200, r.text
    assert [(x["asset_id"], x["result"], x["reason"]) for x in r.json()["assets"]] == [
        (str(one.id), "packed", None),
        (str(off), "refused", "not_on_move"),
        (str(two.id), "refused", "asset_not_found"),
        (str(gone), "refused", "asset_not_found")]
    assert await _holder(db, off) is None and await _holder(db, two) is None
    assert len(await _packs(db)) == 1


async def test_pass_future_closed_at_is_clamped(client, db, seeded_user):
    s = await _seed(db)
    one = s.assets[0]
    r = await _send(client, s.key, _body(
        s.a, [one], closed_at=datetime.now(UTC) + timedelta(hours=1)))
    assert r.status_code == 200, r.text
    assert r.json()["assets"][0]["result"] == "packed"
    assert (await _holder(db, one)).added_at <= datetime.now(UTC)


async def test_pass_naive_closed_at_reads_as_utc(client, db, seeded_user):
    s = await _seed(db)
    one = s.assets[0]
    naive = T_CLOSE.replace(tzinfo=None).isoformat()
    r = await _send(client, s.key, _body(s.a, [one], closed_at=naive))
    assert r.status_code == 200, r.text
    assert (await _holder(db, one)).added_at == T_CLOSE


async def _nothing_written(db):
    assert await _count(db, DockPass) == 0
    assert await _count(db, ContainerAsset) == 0
    assert await _packs(db) == []


async def test_pass_container_checks(client, db, seeded_user):
    s = await _seed(db)
    one = s.assets[0]

    r = await _send(client, s.key, _body(uuid.uuid4(), [one]))
    assert r.status_code == 404 and _code(r) == "container_not_found"
    await _nothing_written(db)

    (await db.get(Container, s.b.id)).archived_at = datetime.now(UTC)
    await db.commit()
    r = await _send(client, s.key, _body(s.b, [one]))
    assert r.status_code == 404 and _code(r) == "container_not_found"
    await _nothing_written(db)

    elsewhere = Initiative(name="Another Dock Move", initiative_type="move",
                           status="in_progress")
    db.add(elsewhere)
    await db.flush()
    theirs = Container(name="NOT-OUR-CRATE", initiative_id=elsewhere.id)
    db.add(theirs)
    await db.commit()
    r = await _send(client, s.key, _body(theirs.id, [one]))
    assert r.status_code == 403 and _code(r) == "move_locked"
    await _nothing_written(db)

    (await db.get(Initiative, s.move.id)).status = "completed"
    await db.commit()
    r = await _send(client, s.key, _body(s.a, [one]))
    assert r.status_code == 409 and _code(r) == "move_inactive"
    await _nothing_written(db)


async def test_pass_needs_a_dock_key(client, db, seeded_user):
    _, move, key = await _station(db)
    crate = Container(name="RFID-CRATE", initiative_id=move.id)
    db.add(crate)
    await db.commit()
    r = await _send(client, key, _body(crate.id, [uuid.uuid4()]))
    assert r.status_code == 403 and _code(r) == "wrong_station_type"
    assert await _count(db, DockPass) == 0
    assert await station_keys.verify(db, SERIAL, key) is not None


async def test_pass_blocked_in_read_only_mode(client, db, seeded_user):
    s = await _seed(db)
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    r = await _send(client, s.key, _body(s.a, s.assets))
    assert r.status_code == 423 and _code(r) == "read_only_mode"
    await _nothing_written(db)


async def test_pass_id_from_another_device_is_409(client, db, seeded_user):
    s = await _seed(db)
    one, two, _ = s.assets
    other, _ = await _device(db, move_name="Unused Move", serial="dock-station-2",
                             name="Dock 2", station_type="dock",
                             current_initiative_id=s.move.id)
    other_key = await station_keys.issue(db, await db.get(Device, other.id),
                                         actor_id=None, via="password")
    await db.commit()
    body = _body(s.a, [one])
    assert (await _send(client, s.key, body)).status_code == 200
    audits = len(await _packs(db))

    r = await _send(client, other_key, {**body, "serial": "dock-station-2",
                                        "asset_ids": [str(two.id)]})
    assert r.status_code == 409 and _code(r) == "pass_conflict"
    assert await _holder(db, two) is None
    assert len(await _packs(db)) == audits
    stored = await db.get(DockPass, uuid.UUID(body["pass_id"]))
    assert stored.device_id == s.device.id


async def test_pass_reply_carries_clear_setup(client, db, seeded_user):
    s = await _seed(db)
    rid = uuid.uuid4()
    (await db.get(Device, s.device.id)).setup_clear_id = rid
    await db.commit()
    r = await _send(client, s.key, _body(s.a, s.assets[:1]))
    assert r.status_code == 200, r.text
    assert r.json()["clear_setup"] == str(rid)
