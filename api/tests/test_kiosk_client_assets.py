"""GET /kiosk/sync/client-assets (the move's client's assets NOT on this move)
and the read-only station sync routes. Spec §2.1 / §3.2."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, Client, Device, Initiative, InitiativeAsset)
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
                            "make", "model", "initiative_id", "initiative_name"}
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
    # a-shared is also on the selected move, so it is never an off-move asset.
    assert got == [("a-done", "F Done")]


async def _get(client, initiative_id):
    hdrs = await login(client)
    r = await client.get(f"/kiosk/sync/client-assets?initiative_id={initiative_id}",
                         headers=hdrs)
    assert r.status_code == 200, r.text
    return r.json()["assets"]


async def test_client_assets_include_make_and_model(client, db, seeded_user):
    cx = Client(name="Client MM")
    db.add(cx)
    await db.flush()
    sel, other = _move("MM Sel", cx.id), _move("MM Other", cx.id)
    db.add_all([sel, other])
    m = AssetModel(make="Dell", model="R740")
    db.add(m)
    await db.flush()
    with_model = Asset(name="mm-with", serial_number="MM-1", model_id=m.id)
    without = Asset(name="mm-without", serial_number="MM-2")
    db.add_all([with_model, without])
    await db.flush()
    db.add_all([InitiativeAsset(initiative_id=other.id, asset_id=with_model.id),
                InitiativeAsset(initiative_id=other.id, asset_id=without.id)])
    await db.commit()
    rows = {a["name"]: a for a in await _get(client, sel.id)}
    assert rows["mm-with"]["make"] == "Dell" and rows["mm-with"]["model"] == "R740"
    assert rows["mm-without"]["make"] is None and rows["mm-without"]["model"] is None


async def _unassigned_seed(db):
    from datetime import UTC, datetime
    cx, cy = Client(name="Client U"), Client(name="Client U2")
    db.add_all([cx, cy])
    await db.flush()
    sel, done = _move("U Sel", cx.id), Initiative(
        name="U Done", initiative_type="move", status="completed", client_id=cx.id)
    db.add_all([sel, done])
    m = AssetModel(make="HPE", model="DL380")
    db.add(m)
    await db.flush()
    a = {
        "u-free": Asset(name="u-free", serial_number="U-1", rfid_tag="R-U1",
                        client_id=cx.id, model_id=m.id),
        "u-other-client": Asset(name="u-other-client", serial_number="U-2",
                                client_id=cy.id),
        "u-archived": Asset(name="u-archived", serial_number="U-3", client_id=cx.id,
                            archived_at=datetime.now(UTC)),
        "u-on-sel": Asset(name="u-on-sel", serial_number="U-4", client_id=cx.id),
        "u-done": Asset(name="u-done", serial_number="U-5", client_id=cx.id),
    }
    db.add_all(a.values())
    await db.flush()
    db.add_all([InitiativeAsset(initiative_id=sel.id, asset_id=a["u-on-sel"].id),
                InitiativeAsset(initiative_id=done.id, asset_id=a["u-done"].id)])
    await db.commit()
    return sel.id, a


async def test_client_assets_include_unassigned_client_assets(client, db, seeded_user):
    sel, a = await _unassigned_seed(db)
    rows = await _get(client, sel)
    free = [r for r in rows if r["name"] == "u-free"]
    assert len(free) == 1
    assert free[0]["id"] == str(a["u-free"].id)
    assert free[0]["initiative_id"] is None and free[0]["initiative_name"] is None
    assert free[0]["make"] == "HPE" and free[0]["model"] == "DL380"
    assert free[0]["rfid"] == "R-U1" and free[0]["serial_number"] == "U-1"
    # The client's completed move is still listed, once, with its move.
    done = [r for r in rows if r["name"] == "u-done"]
    assert [(r["initiative_name"]) for r in done] == ["U Done"]


async def test_unassigned_asset_of_another_client_is_not_listed(client, db, seeded_user):
    sel, _ = await _unassigned_seed(db)
    assert "u-other-client" not in {r["name"] for r in await _get(client, sel)}


async def test_archived_unassigned_asset_is_not_listed(client, db, seeded_user):
    sel, _ = await _unassigned_seed(db)
    assert "u-archived" not in {r["name"] for r in await _get(client, sel)}


async def test_asset_on_the_selected_move_is_never_listed_even_if_also_unassigned_shaped(
        client, db, seeded_user):
    sel, _ = await _unassigned_seed(db)
    assert "u-on-sel" not in {r["name"] for r in await _get(client, sel)}
