"""/edge/labels/* — the regeneration screen's status, the setup preview of
the template a choice would use, and one asset's finished label."""

import json

from tests.conftest import make_session
from tests.test_label_generate import _seed, _template

from edge import laptop_setup


async def test_routes_need_a_session(app, client):
    for path in ("/edge/labels/status", "/edge/labels/plan", "/edge/labels/asset/a-1"):
        assert (await client.get(path)).status_code == 401


async def test_status_and_asset_routes(app, client):
    headers = make_session(app)
    r = await client.get("/edge/labels/status", headers=headers)
    assert r.json() == {"state": "idle", "reason": None, "total": 0, "done": 0,
                        "ready": 0, "errors": 0}

    store = _seed(app, templates=[_template("t-203")])
    runner = app.state.label_runner
    runner.request("setup")
    await runner.run_pending()
    r = await client.get("/edge/labels/status", headers=headers)
    assert r.json() == {"state": "idle", "reason": "setup", "total": 2, "done": 2,
                        "ready": 2, "errors": 0}

    r = await client.get("/edge/labels/asset/a-1", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["asset_id"] == "a-1" and "web01" in body["zpl"] and body["error"] is None
    assert body["template_name"] == "Rack - 203DPI" and body["dpi"] == 203
    assert body["label_kind"] == "top"

    r = await client.get("/edge/labels/asset/nope", headers=headers)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "label_not_found"

    # mid-run: the stored labels may be stale
    store.run("UPDATE label_run SET state = 'running', reason = 'updates', total = 2, "
              "done = 1 WHERE id = 1")
    r = await client.get("/edge/labels/asset/a-1", headers=headers)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "labels_regenerating"
    r = await client.get("/edge/labels/status", headers=headers)
    assert r.json()["state"] == "running" and r.json()["done"] == 1

    # a label that couldn't be made counts as an error, not ready
    store.run("UPDATE label_run SET state = 'idle' WHERE id = 1")
    store.run("UPDATE station_labels SET zpl = NULL, error = 'no_template_at_dpi' "
              "WHERE asset_id = 'a-2'")
    r = await client.get("/edge/labels/status", headers=headers)
    assert r.json()["ready"] == 1 and r.json()["errors"] == 1
    r = await client.get("/edge/labels/asset/a-2", headers=headers)
    assert r.json()["zpl"] is None and r.json()["error"] == "no_template_at_dpi"


async def test_plan_route_reports_fallthrough_note(app, client):
    headers = make_session(app)
    r = await client.get("/edge/labels/plan", headers=headers)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_label_station"

    _seed(app, dpi=300, templates=[
        _template("dest-203", family="Dest", scope="destination", dpi="203"),
        _template("glob-300", family="Glob", scope="global", dpi="300", version=4),
    ])
    r = await client.get("/edge/labels/plan", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["template"] == {"id": "glob-300", "name": "Glob - 300DPI", "family": "Glob",
                                "dpi_key": "300", "version": 4}
    assert len(body["notes"]) == 1 and "Dest" in body["notes"][0]

    # setup asks before saving: the query overrides the saved DPI
    r = await client.get("/edge/labels/plan?dpi=203", headers=headers)
    assert r.json()["template"]["id"] == "dest-203" and r.json()["notes"] == []
    r = await client.get("/edge/labels/plan?kind=front", headers=headers)
    assert r.json() == {"template": None, "notes": []}

    for bad in ("dpi=abc", "dpi=0", "dpi=-3", "kind=side"):
        r = await client.get(f"/edge/labels/plan?{bad}", headers=headers)
        assert r.status_code == 422, bad


async def test_plan_route_previews_before_settings_are_saved(app, client):
    headers = make_session(app)
    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "label")
    r = await client.get("/edge/labels/plan", headers=headers)
    assert r.status_code == 404
    _seed(app)
    setup = laptop_setup.load(app.state.store)
    setup["label_station"] = None
    app.state.store.run("UPDATE laptop_setup SET setup_json = ? WHERE id = 1",
                        (json.dumps(setup),))
    r = await client.get("/edge/labels/plan?dpi=203&kind=top", headers=headers)
    assert r.status_code == 200 and r.json()["template"]["id"] == "t-203"

    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "rfid")
    r = await client.get("/edge/labels/plan?dpi=203&kind=top", headers=headers)
    assert r.status_code == 404


async def test_a_session_locked_to_another_move_is_move_locked(app, client):
    _seed(app)
    app.state.label_runner.request("setup")
    await app.state.label_runner.run_pending()
    other = make_session(app, kiosk_move={"initiative_id": "m-2", "name": "Other"})
    same = make_session(app, kiosk_move={"initiative_id": "m-1", "name": "Move 1"})
    for path in ("/edge/labels/status", "/edge/labels/plan", "/edge/labels/asset/a-1"):
        r = await client.get(path, headers=other)
        assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked", path
        r = await client.get(path, headers=same)
        assert r.status_code == 200, path

    # no setup at all: a move-locked session sees nothing either
    laptop_setup.clear(app.state.store)
    r = await client.get("/edge/labels/status", headers=same)
    assert r.status_code == 403
