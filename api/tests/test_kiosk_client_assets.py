"""GET /kiosk/sync/client-assets (assets on the move's client's OTHER moves)
and the read-only station sync routes. Spec §2.1 / §3.2."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import Asset, Client, Device, Initiative, InitiativeAsset
from serversherpa.services import move_password as mp_svc
from serversherpa.services import station_keys
from tests.test_kiosk_station_key import PW, SERIAL, _device
from tests.test_sites_api import login


def _move(name, client_id=None):
    return Initiative(name=name, initiative_type="move", status="in_progress",
                      client_id=client_id)


async def _seed(db):
    """Client X: selected move + other moves; client Y: one move; one clientless move."""
    cx, cy = Client(name="Client X"), Client(name="Client Y")
    db.add_all([cx, cy])
    await db.flush()
    sel, other, other2 = _move("Sel", cx.id), _move("X Other", cx.id), _move("X Other 2", cx.id)
    ymove, loose = _move("Y Move", cy.id), _move("Loose")
    db.add_all([sel, other, other2, ymove, loose])
    await db.flush()
    a_sel = Asset(name="on-selected", serial_number="S-SEL", rfid_tag="R-SEL")
    a_x = Asset(name="x-asset", serial_number="S-X", rfid_tag="R-X")
    a_y = Asset(name="y-asset", serial_number="S-Y", rfid_tag="R-Y")
    a_loose = Asset(name="loose-asset", serial_number="S-L")
    db.add_all([a_sel, a_x, a_y, a_loose])
    await db.flush()
    db.add_all([
        InitiativeAsset(initiative_id=sel.id, asset_id=a_sel.id),
        InitiativeAsset(initiative_id=other.id, asset_id=a_x.id),
        InitiativeAsset(initiative_id=other2.id, asset_id=a_x.id),   # two moves
        InitiativeAsset(initiative_id=ymove.id, asset_id=a_y.id),
        InitiativeAsset(initiative_id=loose.id, asset_id=a_loose.id),
    ])
    await db.commit()
    return dict(sel=sel.id, cx=cx.id, loose=loose.id, a_x=a_x.id)


async def test_client_assets_only_the_moves_client(client, db, seeded_user):
    s = await _seed(db)
    hdrs = await login(client)
    r = await client.get(f"/kiosk/sync/client-assets?initiative_id={s['sel']}", headers=hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["initiative_id"] == str(s["sel"])
    assert body["client_id"] == str(s["cx"])
    rows = body["assets"]
    assert [(a["name"], a["initiative_name"]) for a in rows] == [
        ("x-asset", "X Other"), ("x-asset", "X Other 2")]
    assert set(rows[0]) == {"id", "asset_id", "name", "rfid", "serial_number",
                            "initiative_id", "initiative_name"}
    assert rows[0]["id"] == str(s["a_x"])
    assert rows[0]["rfid"] == "R-X" and rows[0]["serial_number"] == "S-X"
    text = r.text
    assert "y-asset" not in text and "on-selected" not in text and "loose-asset" not in text


async def test_client_assets_no_client_is_empty(client, db, seeded_user):
    s = await _seed(db)
    hdrs = await login(client)
    r = await client.get(f"/kiosk/sync/client-assets?initiative_id={s['loose']}", headers=hdrs)
    assert r.status_code == 200
    assert r.json()["assets"] == [] and r.json()["client_id"] is None


async def test_client_assets_unknown_move_404(client, db, seeded_user):
    hdrs = await login(client)
    r = await client.get(f"/kiosk/sync/client-assets?initiative_id={uuid.uuid4()}", headers=hdrs)
    assert r.status_code == 404


async def test_client_assets_move_password_scope(client, db, seeded_user):
    s = await _seed(db)
    live = await db.get(Initiative, s["sel"])
    await mp_svc.set_password(db, live, PW, actor_id=seeded_user.id)
    await db.commit()
    lr = await client.post("/kiosk/move-login", json={"password": PW})
    assert lr.status_code == 200, lr.text
    hdrs = {"Authorization": f"Bearer {lr.json()['access_token']}"}
    ok = await client.get(f"/kiosk/sync/client-assets?initiative_id={s['sel']}", headers=hdrs)
    assert ok.status_code == 200
    bad = await client.get(f"/kiosk/sync/client-assets?initiative_id={s['loose']}", headers=hdrs)
    assert bad.status_code == 403 and bad.json()["detail"]["code"] == "move_locked"


async def _station(db):
    s = await _seed(db)
    device, _ = await _device(db, move_name="Sel Station")
    live = await db.get(Device, device.id)
    live.current_initiative_id = s["sel"]
    key = await station_keys.issue(db, live, actor_id=None, via="password")
    await db.commit()
    return s, key


def _auth(key):
    return {"Authorization": f"Station {key}"}


async def test_station_sync_current_move_only(client, db, seeded_user):
    s, key = await _station(db)
    q = f"serial={SERIAL}&initiative_id={s['sel']}"
    for path in ("assets", "containers", "client-assets"):
        r = await client.get(f"/kiosk/station/sync/{path}?{q}", headers=_auth(key))
        assert r.status_code == 200, (path, r.text)
    r = await client.get(f"/kiosk/station/sync/people?{q}", headers=_auth(key))
    assert r.status_code == 200, r.text
    assert (await client.get(f"/kiosk/station/sync/client-assets?{q}",
                             headers=_auth(key))).json()["assets"][0]["name"] == "x-asset"
    other = f"serial={SERIAL}&initiative_id={s['loose']}"
    for path in ("assets", "containers", "people", "client-assets"):
        r = await client.get(f"/kiosk/station/sync/{path}?{other}", headers=_auth(key))
        assert r.status_code == 403, (path, r.text)
        assert r.json()["detail"]["code"] == "move_locked"


async def test_station_sync_key_move_not_just_current_move(client, db, seeded_user):
    """Setup moved to another move without re-issue: the key still covers the old one."""
    s, key = await _station(db)
    live = (await db.scalars(select(Device).where(
        Device.serial == SERIAL))).one()
    key_move = live.station_key_initiative_id
    live.current_initiative_id = s["loose"]
    await db.commit()
    r = await client.get(
        f"/kiosk/station/sync/assets?serial={SERIAL}&initiative_id={s['loose']}",
        headers=_auth(key))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"
    ok = await client.get(
        f"/kiosk/station/sync/assets?serial={SERIAL}&initiative_id={key_move}",
        headers=_auth(key))
    assert ok.status_code == 200


async def test_station_sync_needs_key(client, db, seeded_user):
    s, key = await _station(db)
    q = f"serial={SERIAL}&initiative_id={s['sel']}"
    for path in ("assets", "containers", "people", "client-assets"):
        none = await client.get(f"/kiosk/station/sync/{path}?{q}")
        assert none.status_code == 401
        assert none.json()["detail"]["code"] == "station_key_invalid"
        bad = await client.get(f"/kiosk/station/sync/{path}?{q}", headers=_auth("nope"))
        assert bad.status_code == 401


async def test_client_assets_filters_and_overlap(client, db, seeded_user):
    from datetime import UTC, datetime
    cx = Client(name="Client Filter")
    db.add(cx)
    await db.flush()
    sel = _move("F Sel", cx.id)
    project = Initiative(name="F Project", initiative_type="project",
                         status="in_progress", client_id=cx.id)
    event = Initiative(name="F Event", initiative_type="event",
                       status="in_progress", client_id=cx.id)
    arch_move = _move("F Archived", cx.id)
    arch_move.archived_at = datetime.now(UTC)
    done = Initiative(name="F Done", initiative_type="move", status="completed",
                      client_id=cx.id)
    other = _move("F Other", cx.id)
    db.add_all([sel, project, event, arch_move, done, other])
    await db.flush()
    names = ["a-project", "a-event", "a-archmove", "a-archasset", "a-done", "a-shared"]
    a = {n: Asset(name=n, serial_number="F-" + n) for n in names}
    a["a-archasset"].archived_at = datetime.now(UTC)
    db.add_all(a.values())
    await db.flush()
    for mv, n in [(project, "a-project"), (event, "a-event"), (arch_move, "a-archmove"),
                  (other, "a-archasset"), (done, "a-done"), (sel, "a-shared"),
                  (other, "a-shared")]:
        db.add(InitiativeAsset(initiative_id=mv.id, asset_id=a[n].id))
    await db.commit()
    hdrs = await login(client)
    r = await client.get(f"/kiosk/sync/client-assets?initiative_id={sel.id}", headers=hdrs)
    got = sorted((x["name"], x["initiative_name"]) for x in r.json()["assets"])
    assert got == [("a-done", "F Done"), ("a-shared", "F Other")]
