"""The Label Station's generation runs (edge/labels/runner.py) and what
requests them: Kiosk Setup, a sync, and a changed DPI / label kind / printer."""

import asyncio
import json

from tests.conftest import make_session
from tests.test_label_generate import MOVE, _asset, _paths, _put_cache, _seed, _template
from tests.test_sync import _mock_sync

from edge import laptop_setup
from edge.labels import generate
from edge.labels.runner import LabelRunner


def _run_row(store) -> dict:
    row = store.one("SELECT * FROM label_run WHERE id = 1")
    return dict(row) if row else {}


def _labels(store) -> dict:
    return {r["asset_id"]: dict(r) for r in store.all("SELECT * FROM station_labels")}


async def test_run_marks_running_then_idle_with_progress(app):
    store = _seed(app)
    seen = []

    def render(template_json, job):
        seen.append(_run_row(store))  # the row as each label is rendered
        return generate.render_job(template_json, job)

    runner = LabelRunner(store, render=render)
    runner.request("setup")
    await runner.run_pending()
    assert [(s["state"], s["reason"], s["total"], s["done"]) for s in seen] \
        == [("running", "setup", 2, 0), ("running", "setup", 2, 1)]
    row = _run_row(store)
    assert row["state"] == "idle" and row["done"] == 2 and row["total"] == 2
    assert row["finished_at"] and row["pending"] == 0
    assert set(_labels(store)) == {"a-1", "a-2"}
    assert runner.pending is None

    # labels exist now: an input change is an 'updates' run
    _seed(app, assets=[_asset(1, name="web99", label={**_asset(1)["label"],
                                                      "asset_name": "web99"}), _asset(2)])
    seen.clear()
    runner.request("updates")
    await runner.run_pending()
    assert [(s["reason"], s["total"]) for s in seen] == [("updates", 1)]


async def test_reason_is_setup_when_the_move_has_no_labels_yet(app):
    store = _seed(app)
    runner = LabelRunner(store)
    runner.request("updates")
    await runner.run_pending()
    assert _run_row(store)["reason"] == "setup"


async def test_no_changes_never_shows_running(app):
    store = _seed(app)
    runner = LabelRunner(store)
    runner.request("setup")
    await runner.run_pending()
    before = _run_row(store)
    states = []

    def render(template_json, job):
        states.append("rendered")
        return None, None

    runner.render = render
    runner.request("updates")
    await runner.run_pending()
    assert states == []
    assert _run_row(store) == {**before, "pending": 0}


async def test_request_during_run_runs_once_more(app):
    store = _seed(app)
    runner = LabelRunner(store)
    calls = []

    def render(template_json, job):
        calls.append(job.asset_id)
        if len(calls) == 1:
            # a sync lands mid-run: a new asset, and two more requests (coalesced)
            _seed(app, assets=[_asset(1), _asset(2), _asset(3)])
            runner.request("updates")
            runner.request("updates")
        return generate.render_job(template_json, job)

    runner.render = render
    runner.request("setup")
    await runner.run_pending()
    # the first run renders a-1, a-2 from its plan; exactly one more renders a-3
    assert calls == ["a-1", "a-2", "a-3"]
    assert set(_labels(store)) == {"a-1", "a-2", "a-3"}
    assert runner.pending is None and _run_row(store)["state"] == "idle"


async def test_setup_wins_over_updates_while_pending(app):
    runner = LabelRunner(_seed(app))
    runner.request("setup")
    runner.request("updates")
    assert runner.pending == "setup"


async def test_interrupted_run_resumes_on_start(app):
    store = _seed(app)
    first = generate.build_plan(store)
    job = first.assets[0]
    generate.apply(store, first, job, *generate.render_job(first.template_json, job))
    store.run("INSERT INTO label_run (id, state, reason, total, done, pending) "
              "VALUES (1, 'running', 'setup', 2, 1, 0)")
    wake = asyncio.Event()
    runner = LabelRunner(store, wake=wake)  # the laptop starts again
    assert runner.pending == "setup" and wake.is_set()
    rendered = []

    def render(template_json, job):
        rendered.append(job.asset_id)
        return generate.render_job(template_json, job)

    runner.render = render
    await runner.run_pending()
    assert rendered == ["a-2"]  # a-1's label was already stored
    assert _run_row(store)["state"] == "idle"
    assert set(_labels(store)) == {"a-1", "a-2"}


async def test_no_asset_data_never_prunes(app):
    store = _seed(app)
    runner = LabelRunner(store)
    runner.request("setup")
    await runner.run_pending()
    assets_path, _ = _paths()

    # a portal from before label_context: no asset data, not an empty move
    _put_cache(store, assets_path, {"initiative_id": MOVE, "assets": [_asset(1)]})
    plan = generate.build_plan(store)
    assert plan.has_asset_data is False and plan.assets == []
    assert generate.prune(store, plan) == 0
    runner.request("updates")
    await runner.run_pending()
    assert set(_labels(store)) == {"a-1", "a-2"}

    # no asset read cached at all
    store.run("DELETE FROM cache WHERE key = ?", (assets_path,))
    assert generate.build_plan(store).has_asset_data is False
    runner.request("updates")
    await runner.run_pending()
    assert set(_labels(store)) == {"a-1", "a-2"}

    # the move really has no assets: every label goes
    _seed(app, assets=[])
    plan = generate.build_plan(store)
    assert plan.has_asset_data is True and plan.assets == []
    runner.request("updates")
    await runner.run_pending()
    assert _labels(store) == {}


async def test_malformed_saved_settings_give_no_plan(app):
    store = _seed(app)
    for bad in ({"dpi": 203}, {"label_kind": "top", "dpi": "203"},
                {"label_kind": "top", "dpi": True}, {"label_kind": "side", "dpi": 203}):
        setup = laptop_setup.load(store)
        setup["label_station"] = bad
        store.run("UPDATE laptop_setup SET setup_json = ? WHERE id = 1", (json.dumps(setup),))
        assert generate.build_plan(store) is None
    # overrides stand in for missing settings (setup previews before saving)
    assert generate.build_plan(store, label_kind="top", dpi=203).template.id == "t-203"


async def test_overrides_pick_another_template(app):
    store = _seed(app, templates=[_template("t-203"), _template("t-300", dpi="300")])
    assert generate.build_plan(store).template.id == "t-203"
    assert generate.build_plan(store, dpi=300).template.id == "t-300"


async def test_sync_and_settings_changes_request_a_run(app, client, cloud):
    store = _seed(app)
    runner = app.state.label_runner
    runner.forget()

    # a sync that lands, on a Label Station
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1",
                                    expires_in=900)
    app.state.syncer.set_target(MOVE, "p-1")
    _mock_sync(cloud)
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    assert runner.pending == "updates" and app.state.label_wake.is_set()

    # a failed sync requests nothing
    runner.forget()
    cloud.routes.clear()
    cloud.get(url__regex=r"/kiosk/sync/assets.*").respond(500)
    await app.state.syncer.run()
    assert runner.pending is None

    headers = make_session(app)
    base = laptop_setup.label_station(store)
    for change, requests in [({"offset_x": 5}, False), ({"peel": True}, False),
                             ({"dpi": 300}, True), ({"label_kind": "front"}, True),
                             ({"printer": {"type": "usb", "ip": None, "model": "ZD421",
                                           "serial": None}}, True)]:
        runner.forget()
        body = {**base, **change}
        r = await client.put("/edge/label-station", headers=headers, json=body)
        assert r.status_code == 200, r.text
        assert (runner.pending is not None) is requests, change
        base = body

    # an RFID Station's sync requests nothing
    runner.forget()
    laptop_setup.save(store, {"initiative_id": MOVE}, "rfid")
    _mock_sync(cloud)
    await app.state.syncer.run()
    assert runner.pending is None


async def test_label_station_setup_requests_a_setup_run(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1",
                                    expires_in=900)
    cloud.post("/kiosk/setup").respond(200, json={"initiative_id": MOVE})
    _mock_sync(cloud)
    app.state.label_runner.forget()
    r = await client.post("/kiosk/setup", headers=make_session(app),
                          json={"initiative_id": MOVE, "station_type": "label"})
    assert r.status_code == 200
    assert app.state.label_runner.pending == "setup"


async def test_wipe_clears_label_tables(app, client):
    store = _seed(app)
    runner = app.state.label_runner
    runner.request("setup")
    await runner.run_pending()
    assert _labels(store) and _run_row(store)
    runner.request("updates")
    r = await client.post("/edge/wipe", headers=make_session(app, max_rank=60))
    assert r.status_code == 200, r.text
    assert _labels(store) == {} and _run_row(store) == {}
    assert runner.pending is None


async def test_background_label_loop_runs_a_request(app):
    import contextlib

    from edge.background import Background
    store = _seed(app)
    app.state.label_runner.forget()
    task = asyncio.create_task(Background(app.state)._label_loop())
    try:
        app.state.label_runner.request("setup")
        for _ in range(200):
            if len(_labels(store)) == 2 and _run_row(store).get("state") == "idle":
                break
            await asyncio.sleep(0.01)
        assert set(_labels(store)) == {"a-1", "a-2"}
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def test_wipe_mid_run_writes_nothing_more(app, client):
    store = _seed(app)
    runner = app.state.label_runner
    runner.forget()
    rendered = []

    def render(template_json, job):
        rendered.append(job.asset_id)
        if len(rendered) == 1:
            # Wipe lands while the first label renders (render runs in a thread;
            # this stands in for the route: tables emptied, then forget())
            for table in ("station_labels", "label_run", "laptop_setup", "cache"):
                store.run(f"DELETE FROM {table}")
            runner.forget()
        return generate.render_job(template_json, job)

    runner.render = render
    runner.request("setup")
    await runner.run_pending()
    assert rendered == ["a-1"]
    assert _labels(store) == {} and _run_row(store) == {}
    assert runner.pending is None


async def test_a_failed_run_is_retried_once_on_the_next_pass(app):
    store = _seed(app)
    wake = asyncio.Event()
    runner = LabelRunner(store, wake=wake)
    calls = []

    def render(template_json, job):
        calls.append(job.asset_id)
        raise RuntimeError("disk full")

    runner.render = render
    runner.request("setup")
    wake.clear()
    await runner.run_pending()
    assert calls == ["a-1"]  # one failed run, not a tight loop
    assert _run_row(store)["state"] == "idle"
    assert runner.pending == "updates" and not wake.is_set()  # waits for the timed pass
    assert _run_row(store)["pending"] == 1

    runner.render = generate.render_job
    await runner.run_pending()
    assert set(_labels(store)) == {"a-1", "a-2"} and runner.pending is None
