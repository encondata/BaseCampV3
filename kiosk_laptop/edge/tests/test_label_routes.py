"""/edge/labels/* — the regeneration screen's status, the setup preview of
the template a choice would use, and one asset's finished label."""

import json

from tests.conftest import make_session
from tests.test_label_generate import _seed, _template, _vegas

from edge import laptop_setup


async def test_routes_need_a_session(app, client):
    for path in ("/edge/labels/status", "/edge/labels/plan", "/edge/labels/asset/a-1"):
        assert (await client.get(path)).status_code == 401


async def test_status_and_asset_routes(app, client):
    headers = make_session(app)
    r = await client.get("/edge/labels/status", headers=headers)
    assert r.json() == {"state": "idle", "reason": None, "total": 0, "done": 0,
                        "ready": 0, "errors": 0, "unsupported": 0}

    store = _seed(app, templates=[_template("t-203")])
    runner = app.state.label_runner
    runner.request("setup")
    await runner.run_pending()
    r = await client.get("/edge/labels/status", headers=headers)
    assert r.json() == {"state": "idle", "reason": "setup", "total": 2, "done": 2,
                        "ready": 2, "errors": 0, "unsupported": 0}

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


async def test_unsupported_templates_are_counted_and_each_label_says_so(app, client):
    """`unsupported` counts the templates (not labels) this laptop's edge
    is too old to print; their labels are errors with that reason."""
    headers = make_session(app)
    newer = {"schema": 3, "elements": []}
    _seed(app, templates=[{**_template("t-203", design=newer), "schema_version": 3}])
    runner = app.state.label_runner
    runner.request("setup")
    await runner.run_pending()
    r = await client.get("/edge/labels/status", headers=headers)
    body = r.json()
    assert (body["ready"], body["errors"], body["unsupported"]) == (0, 2, 1)
    r = await client.get("/edge/labels/asset/a-1", headers=headers)
    assert r.status_code == 200
    assert r.json()["zpl"] is None and r.json()["error"] == "template_unsupported"

    # the move's template is replaced with one this edge knows
    _seed(app, templates=[_template("t-203", version=2)])
    runner.request("updates")
    await runner.run_pending()
    body = (await client.get("/edge/labels/status", headers=headers)).json()
    assert (body["ready"], body["errors"], body["unsupported"]) == (2, 0, 0)


async def test_plan_route_names_the_fonts_the_template_prints_with(app, client):
    """The station checks the plan template's fonts: a code template's from
    its code, a builder design's from its text elements (its `code` is "")."""
    headers = make_session(app)
    _seed(app, templates=[_template("c-203", kind="code",
                                    code="^XA^A@N,30,30,E:ROBOTO_R.TTF^FDx^FS"
                                         "^CW1,E:OSWALD_B.TTF^XZ")])
    r = await client.get("/edge/labels/plan", headers=headers)
    assert r.json()["fonts"] == ["OSWALD_B.TTF", "ROBOTO_R.TTF"]

    _seed(app, dpi=300, templates=[_vegas()])
    r = await client.get("/edge/labels/plan", headers=headers)
    assert r.json()["template"]["id"] == "v-300" and r.json()["fonts"] == ["TT0003M_.TTF"]

    r = await client.get("/edge/labels/plan?dpi=203", headers=headers)
    assert r.json()["template"] is None and r.json()["fonts"] == []


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
    assert r.json() == {"template": None, "notes": [], "fonts": []}

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


# ── POST /edge/labels/printed ───────────────────────────────────────

PRINTED = {"asset_id": "a-1", "scanned_value": "SN1",
           "scanned_at": "2026-10-19T14:05:06.250Z"}


async def _label_setup(app, station="label"):
    """A Label Station on m-1 (site s-1) with labels made for a-1 and a-2
    (asset ids 101 / 102, serials SN1 / SN2)."""
    _seed(app)
    app.state.label_runner.request("setup")
    await app.state.label_runner.run_pending()
    laptop_setup.save(app.state.store, {"initiative_id": "m-1", "site_id": "s-1",
                                        "scan_status": "received"}, station)


def _queued(app):
    return app.state.store.one("SELECT COUNT(*) AS n FROM pending_rfid_scans")["n"]


async def test_printed_queues_a_labeled_barcode_scan(app, client):
    await _label_setup(app)
    wake = app.state.rfid_upload_wake
    wake.clear()
    r = await client.post("/edge/labels/printed", headers=make_session(app), json=PRINTED)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["queued"] is True and set(body) == {"queued", "client_scan_id"}
    row = app.state.store.one("SELECT * FROM pending_rfid_scans")
    assert row["client_scan_id"] == body["client_scan_id"]
    assert (row["scan_type"], row["matched_kind"], row["matched_id"], row["epc"]) == (
        "barcode", "asset", "a-1", "SN1")
    assert (row["scan_status"], row["initiative_id"], row["site_id"]) == (
        "labeled", "m-1", "s-1")
    assert row["raw_read_id"] is None and row["upload_state"] == "pending"
    assert row["off_move"] == 0 and row["attempts"] == 0
    assert row["scanned_at"] == "2026-10-19T14:05:06+00:00"
    assert wake.is_set()
    # a second label is its own scan (raw_read_id NULL is never a duplicate)
    r = await client.post("/edge/labels/printed", headers=make_session(app), json=PRINTED)
    assert r.status_code == 200 and r.json()["client_scan_id"] != body["client_scan_id"]
    assert app.state.store.one("SELECT COUNT(*) AS n FROM pending_rfid_scans")["n"] == 2


async def test_printed_needs_a_label_station(app, client):
    headers = make_session(app)
    assert (await client.post("/edge/labels/printed", json=PRINTED)).status_code == 401
    r = await client.post("/edge/labels/printed", headers=headers, json=PRINTED)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_label_station"
    await _label_setup(app, "rfid")
    r = await client.post("/edge/labels/printed", headers=headers, json=PRINTED)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_label_station"
    assert app.state.store.one("SELECT COUNT(*) AS n FROM pending_rfid_scans")["n"] == 0


async def test_printed_is_move_locked(app, client):
    await _label_setup(app)
    other = make_session(app, kiosk_move={"initiative_id": "m-2", "name": "Other"})
    r = await client.post("/edge/labels/printed", headers=other, json=PRINTED)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"
    same = make_session(app, kiosk_move={"initiative_id": "m-1", "name": "Move 1"})
    assert (await client.post("/edge/labels/printed", headers=same,
                              json=PRINTED)).status_code == 200


async def test_printed_refuses_bad_bodies(app, client):
    await _label_setup(app)
    headers = make_session(app)
    for bad in ({**PRINTED, "asset_id": ""}, {**PRINTED, "asset_id": 5},
                {**PRINTED, "scanned_value": ""}, {**PRINTED, "scanned_value": "x" * 1000},
                {**PRINTED, "scanned_at": "yesterday"}, {**PRINTED, "scanned_at": None},
                {k: v for k, v in PRINTED.items() if k != "asset_id"}, ["nope"]):
        r = await client.post("/edge/labels/printed", headers=headers, json=bad)
        assert r.status_code == 422, bad
    assert app.state.store.one("SELECT COUNT(*) AS n FROM pending_rfid_scans")["n"] == 0


async def test_printed_matches_asset_id_or_serial_ignoring_case_and_spaces(app, client):
    await _label_setup(app)
    headers = make_session(app)
    for value in ("101", " 101 ", "sn1", "  Sn1\t"):
        r = await client.post("/edge/labels/printed", headers=headers,
                              json={**PRINTED, "scanned_value": value})
        assert r.status_code == 200, (value, r.text)
    assert _queued(app) == 4
    assert app.state.store.one("SELECT epc FROM pending_rfid_scans ORDER BY id DESC")["epc"] \
        == "  Sn1\t"                                     # stored as scanned


async def test_printed_needs_a_finished_label_for_the_asset(app, client):
    await _label_setup(app)
    headers = make_session(app)
    for asset in ("a-9", "' OR 1=1 --"):                  # not on this station
        r = await client.post("/edge/labels/printed", headers=headers,
                              json={**PRINTED, "asset_id": asset})
        assert r.status_code == 409 and r.json()["detail"]["code"] == "label_not_found"
    app.state.store.run("UPDATE station_labels SET zpl = NULL, error = 'x' WHERE asset_id = 'a-1'")
    r = await client.post("/edge/labels/printed", headers=headers, json=PRINTED)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "label_not_found"
    assert _queued(app) == 0


async def test_printed_value_must_be_that_assets(app, client):
    await _label_setup(app)
    headers = make_session(app)
    for value in ("SN2", "102", "SN", "SN11", "a-1", "anything"):   # another asset's, or none
        r = await client.post("/edge/labels/printed", headers=headers,
                              json={**PRINTED, "scanned_value": value})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "scan_value_mismatch", value
    # a label exists but the synced move no longer lists the asset
    from tests.test_label_generate import _paths, _put_cache
    _put_cache(app.state.store, _paths()[0], {"assets": []})
    r = await client.post("/edge/labels/printed", headers=headers, json=PRINTED)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "scan_value_mismatch"
    assert _queued(app) == 0
