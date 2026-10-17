"""The portal-issued RFID station key (spec §3): stored encrypted with
edge.key, issued after an RFID Kiosk Setup, retried in the background,
cleared by a Label setup, and never logged or returned."""

import json
import logging

import httpx

from edge import laptop_setup
from edge.background import Background
from edge.rfid import station_key
from tests.conftest import make_session
from tests.test_laptop_setup import paired, ready, setup

RAW = "stationkey-0123456789abcdef-SECRET"


def _rfid_setup(app, initiative="m-1"):
    laptop_setup.save(app.state.store, {"initiative_id": initiative}, "rfid")


async def _no_sync():
    return {}


def test_key_stored_encrypted(app):
    store, keys = app.state.store, app.state.keys
    assert station_key.load_key(store, keys) is None
    station_key.store_key(store, keys, RAW)
    row = store.one("SELECT key_enc, stored_at FROM station_key WHERE id = 1")
    assert RAW not in row["key_enc"] and row["stored_at"]
    assert station_key.load_key(store, keys) == RAW
    station_key.store_key(store, keys, "second-key")             # replaced, still one row
    assert station_key.load_key(store, keys) == "second-key"
    assert store.one("SELECT COUNT(*) AS n FROM station_key")["n"] == 1
    station_key.clear(store)
    assert station_key.load_key(store, keys) is None


def test_unreadable_key_is_dropped(app):
    store = app.state.store
    store.run("INSERT INTO station_key (id, key_enc, stored_at) VALUES (1, 'garbage', 'now')")
    assert station_key.load_key(store, app.state.keys) is None
    assert store.one("SELECT 1 FROM station_key") is None


async def test_rfid_setup_issues_key(app, client, cloud):
    await paired(app, client)
    ready(app, cloud)
    route = cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    r = await setup(client, app, station_type="rfid")
    assert r.status_code == 200
    assert RAW not in r.text
    assert route.call_count == 1
    sent = route.calls[0].request
    assert json.loads(sent.content) == {"serial": app.state.identity.serial}
    assert sent.headers["authorization"] == "Bearer a1"
    assert station_key.load_key(app.state.store, app.state.keys) == RAW


async def test_rfid_setup_replaces_an_old_key_even_when_issue_fails(app, client, cloud):
    await paired(app, client)
    ready(app, cloud)
    station_key.store_key(app.state.store, app.state.keys, "old-move-key")
    cloud.post("/kiosk/station-key").respond(409, json={"detail": {"code": "kiosk_not_registered"}})
    assert (await setup(client, app, station_type="rfid")).status_code == 200
    assert station_key.load_key(app.state.store, app.state.keys) is None


async def test_rfid_setup_offline_issue_still_answers_200(app, client, cloud):
    await paired(app, client)
    ready(app, cloud)
    cloud.post("/kiosk/station-key").mock(side_effect=httpx.ConnectError("down"))
    assert (await setup(client, app, station_type="rfid")).status_code == 200
    assert station_key.load_key(app.state.store, app.state.keys) is None


async def test_failed_rfid_setup_issues_nothing(app, client, cloud):
    await paired(app, client)
    ready(app, cloud, status=400, body={"detail": "no"})
    route = cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    assert (await setup(client, app, station_type="rfid")).status_code == 400
    assert not route.called


async def test_label_setup_clears_key(app, client, cloud):
    ready(app, cloud)
    station_key.store_key(app.state.store, app.state.keys, RAW)
    route = cloud.post("/kiosk/station-key").respond(200, json={"key": "other"})
    assert (await setup(client, app, station_type="label")).status_code == 200
    assert station_key.load_key(app.state.store, app.state.keys) is None
    assert not route.called


async def test_issue_without_rfid_setup_stores_nothing(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "label")
    cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    assert await station_key.issue(app.state, "p-1") is False
    assert station_key.load_key(app.state.store, app.state.keys) is None


async def test_issue_never_raises(app, cloud):
    _rfid_setup(app)
    assert await station_key.issue(app.state, "p-nobody") is False      # no cloud session
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    cloud.post("/kiosk/station-key").respond(200, content=b"<html>proxy</html>")
    assert await station_key.issue(app.state, "p-1") is False
    cloud.post("/kiosk/station-key").respond(200, json={"key": ""})
    assert await station_key.issue(app.state, "p-1") is False
    cloud.post("/kiosk/station-key").mock(side_effect=RuntimeError("boom"))
    assert await station_key.issue(app.state, "p-1") is False


async def test_issue_failure_retried_by_background(app, cloud, monkeypatch):
    cloud.get("/system/status").respond(200, json={})
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    make_session(app, person_id="p-1")
    _rfid_setup(app)
    monkeypatch.setattr(app.state.syncer, "run", _no_sync)
    route = cloud.post("/kiosk/station-key").mock(side_effect=[
        httpx.Response(409, json={"detail": {"code": "kiosk_not_registered"}}),
        httpx.Response(200, json={"key": RAW}),
    ])
    bg = Background(app.state)
    await bg.tick(now=1000.0)
    assert route.call_count == 1
    assert station_key.load_key(app.state.store, app.state.keys) is None
    await bg.tick(now=1030.0)                    # at most once a minute
    assert route.call_count == 1
    await bg.tick(now=1061.0)
    assert route.call_count == 2
    assert station_key.load_key(app.state.store, app.state.keys) == RAW
    await bg.tick(now=1200.0)                    # a stored key: no more attempts
    assert route.call_count == 2


async def test_background_retry_needs_rfid_setup_and_a_cloud_session(app, cloud, monkeypatch):
    cloud.get("/system/status").respond(200, json={})
    monkeypatch.setattr(app.state.syncer, "run", _no_sync)
    route = cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    bg = Background(app.state)
    _rfid_setup(app)
    await bg.tick(now=1000.0)                    # nobody with a cloud session
    assert not route.called
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    make_session(app, person_id="p-1")
    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "label")
    await bg.tick(now=2000.0)                    # a Label Station needs no key
    assert not route.called
    _rfid_setup(app)
    await bg.tick(now=3000.0)
    assert route.call_count == 1


async def test_background_retry_skipped_offline(app, cloud, monkeypatch):
    cloud.get("/system/status").mock(side_effect=httpx.ConnectError("down"))
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    _rfid_setup(app)
    route = cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    await Background(app.state).tick(now=1000.0)
    assert not route.called


async def test_station_request_adds_the_station_header(app, cloud):
    route = cloud.get("/kiosk/station/sync/people").respond(200, json={})
    assert await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people") \
        is None
    assert not route.called
    station_key.store_key(app.state.store, app.state.keys, RAW)
    resp = await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people",
                                             params={"serial": "s"})
    assert resp.status_code == 200
    assert route.calls[0].request.headers["authorization"] == f"Station {RAW}"


async def test_key_never_logged(app, client, cloud, caplog):
    caplog.set_level(logging.DEBUG)
    await paired(app, client)
    ready(app, cloud)
    cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    r = await setup(client, app, station_type="rfid")
    assert r.status_code == 200 and RAW not in r.text
    # a failed station call logs its status only
    cloud.get(url__regex=r"/kiosk/station/sync/.*").respond(
        401, json={"detail": {"code": "station_key_invalid"}})
    await station_key.station_request(app.state, "GET", "/kiosk/station/sync/assets")
    cloud.post("/kiosk/station-key").respond(500, text=f"echo {RAW}")
    await station_key.issue(app.state, "p-1")
    status = await client.get("/edge/status", headers=make_session(app))
    setup_body = await client.get("/edge/setup", headers=make_session(app))
    events = await client.get("/edge/rfid/events", headers=make_session(app))
    for text in (caplog.text, status.text, setup_body.text, events.text,
                 json.dumps(app.state.syncer.meta())):
        assert RAW not in text


# ── fix round: serialized issue, stale answers, 401 drops the key ──

async def test_concurrent_issues_make_one_call(app, cloud):
    import asyncio
    _rfid_setup(app)
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    answers = iter(["key-one", "key-two"])

    async def slow(request):
        await asyncio.sleep(0.01)
        return httpx.Response(200, json={"key": next(answers)})
    route = cloud.post("/kiosk/station-key").mock(side_effect=slow)
    results = await asyncio.gather(station_key.issue(app.state, "p-1"),
                                   station_key.issue(app.state, "p-1"))
    assert route.call_count == 1 and results == [True, True]
    assert station_key.load_key(app.state.store, app.state.keys) == "key-one"


async def test_stale_move_answer_is_discarded(app, cloud):
    _rfid_setup(app, "m-A")
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)

    def moved_on(request):
        _rfid_setup(app, "m-B")             # the laptop was set up for move B meanwhile
        return httpx.Response(200, json={"key": "move-a-key"})
    cloud.post("/kiosk/station-key").mock(side_effect=moved_on)
    assert await station_key.issue(app.state, "p-1") is False
    assert station_key.load_key(app.state.store, app.state.keys) is None


async def test_station_401_drops_the_key(app, cloud):
    station_key.store_key(app.state.store, app.state.keys, RAW)
    cloud.get("/kiosk/station/sync/people").respond(
        401, json={"detail": {"code": "station_key_invalid"}})
    resp = await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
    assert resp.status_code == 401
    assert station_key.load_key(app.state.store, app.state.keys) is None


async def test_station_401_keeps_a_key_replaced_meanwhile(app, cloud):
    station_key.store_key(app.state.store, app.state.keys, "old-key")

    def replaced(request):
        station_key.store_key(app.state.store, app.state.keys, "new-key")
        return httpx.Response(401, json={"detail": {"code": "station_key_invalid"}})
    cloud.get("/kiosk/station/sync/people").mock(side_effect=replaced)
    await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
    assert station_key.load_key(app.state.store, app.state.keys) == "new-key"


async def test_station_sync_401_drops_key_then_retry_reissues(app, cloud, monkeypatch):
    store = app.state.store
    _rfid_setup(app)
    station_key.store_key(store, app.state.keys, RAW)
    app.state.syncer.set_target("m-1", None)
    cloud.get(url__regex=r"/kiosk/station/sync/.*").respond(
        401, json={"detail": {"code": "station_key_revoked"}})
    meta = await app.state.syncer.run()
    assert meta["last_error"].startswith("http_401:") and RAW not in json.dumps(meta)
    assert station_key.needs_key(store)
    cloud.get("/system/status").respond(200, json={})
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    make_session(app, person_id="p-1")
    monkeypatch.setattr(app.state.syncer, "run", _no_sync)
    cloud.post("/kiosk/station-key").respond(200, json={"key": "fresh"})
    await Background(app.state).tick(now=1000.0)
    assert station_key.load_key(store, app.state.keys) == "fresh"


async def test_background_skips_an_ending_cloud_session(app, cloud, monkeypatch):
    cloud.get("/system/status").respond(200, json={})
    monkeypatch.setattr(app.state.syncer, "run", _no_sync)
    _rfid_setup(app)
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    up.mark_ending("p-1")
    # the logout can't reach the cloud, so the session stays ending through the tick
    cloud.post("/auth/logout").mock(side_effect=httpx.ConnectError("down"))
    route = cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    await Background(app.state).tick(now=1000.0)
    assert up.ending_people() == ["p-1"]
    assert not route.called


async def test_not_signed_in_here_logs_at_info(app, cloud, caplog):
    caplog.set_level(logging.DEBUG, logger="edge.rfid.station_key")
    _rfid_setup(app)
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    cloud.post("/kiosk/station-key").respond(403, json={"detail": {"code": "not_signed_in_here"}})
    assert await station_key.issue(app.state, "p-1") is False
    recs = [r for r in caplog.records if r.name == "edge.rfid.station_key"]
    assert recs and all(r.levelno == logging.INFO for r in recs)


async def test_station_401_with_clear_setup_clears_the_laptop(app, cloud):
    _rfid_setup(app)
    station_key.store_key(app.state.store, app.state.keys, RAW)
    cloud.get("/kiosk/station/sync/people").respond(
        401, json={"detail": {"code": "station_key_invalid", "clear_setup": "c-1"}})
    resp = await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
    assert resp.status_code == 401
    assert station_key.load_key(app.state.store, app.state.keys) is None
    assert laptop_setup.load(app.state.store) is None


async def test_station_sync_401_with_clear_setup_clears_the_laptop(app, cloud):
    _rfid_setup(app)
    station_key.store_key(app.state.store, app.state.keys, RAW)
    app.state.syncer.set_target("m-1", None)
    cloud.get(url__regex=r".*/kiosk/station/sync/.*").respond(
        401, json={"detail": {"code": "station_key_invalid", "clear_setup": "c-1"}})
    meta = await app.state.syncer.run()
    assert meta["last_error"].startswith("http_401")
    assert not station_key.has_key(app.state.store)
    assert laptop_setup.load(app.state.store) is None


async def test_label_setup_rejects_leftover_pending_scans(app, client, cloud):
    from tests.test_rfid_uploader import add_scans, rows
    store = app.state.store
    ready(app, cloud)
    station_key.store_key(store, app.state.keys, RAW)
    pending = add_scans(store, 2)
    [accepted] = add_scans(store, 1, upload_state="accepted", was_accepted=1)
    [rejected] = add_scans(store, 1, upload_state="rejected", reject_code="move_locked")
    assert (await setup(client, app, station_type="label")).status_code == 200
    after = rows(store)
    for sid in pending:
        assert after[sid]["upload_state"] == "rejected"
        assert after[sid]["reject_code"] == "station_changed"
    assert after[accepted]["upload_state"] == "accepted" and after[accepted]["reject_code"] is None
    assert after[rejected]["reject_code"] == "move_locked"


async def test_rfid_setup_keeps_pending_scans(app, client, cloud):
    from tests.test_rfid_uploader import add_scans, rows
    await paired(app, client)
    ready(app, cloud)
    cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    [sid] = add_scans(app.state.store, 1)
    assert (await setup(client, app, station_type="rfid")).status_code == 200
    assert rows(app.state.store)[sid]["upload_state"] == "pending"


async def test_stale_401_with_clear_setup_keeps_a_newer_setup_and_key(app, cloud):
    """A request in flight under an old key: the laptop was set up again
    meanwhile (new key), so its stale refusal clears nothing."""
    _rfid_setup(app)
    station_key.store_key(app.state.store, app.state.keys, "old-key")

    def replaced(request):
        _rfid_setup(app, "m-2")
        station_key.store_key(app.state.store, app.state.keys, "new-key")
        return httpx.Response(401, json={"detail": {"code": "station_key_invalid",
                                                    "clear_setup": "c-1"}})
    cloud.get("/kiosk/station/sync/people").mock(side_effect=replaced)
    await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
    assert station_key.load_key(app.state.store, app.state.keys) == "new-key"
    assert laptop_setup.load(app.state.store)["initiative_id"] == "m-2"


# ── a lapsed kiosk registration pauses uploads (station-key telemetry spec §4) ──

PAUSED_DETAIL = ("This laptop's kiosk registration has expired. "
                 "Sign in here or renew it on Kiosk Devices.")
NOT_REGISTERED = {"detail": {"code": "kiosk_not_registered"}}


def _station_events(store, title):
    return [r for r in store.all("SELECT kind, title, detail FROM rfid_events ORDER BY id")
            if r["title"] == title]


async def test_not_registered_403_keeps_key_and_records_one_event(app, cloud):
    store = app.state.store
    station_key.store_key(store, app.state.keys, RAW)
    cloud.get("/kiosk/station/sync/people").respond(403, json=NOT_REGISTERED)
    for _ in range(2):
        resp = await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
        assert resp.status_code == 403
    assert station_key.load_key(store, app.state.keys) == RAW
    paused = _station_events(store, "Uploads paused")
    assert len(paused) == 1
    assert paused[0]["kind"] == "station" and paused[0]["detail"] == PAUSED_DETAIL
    assert station_key.is_paused(store) is True


async def test_200_after_pause_records_resumed_once(app, cloud):
    store = app.state.store
    station_key.store_key(store, app.state.keys, RAW)
    cloud.get("/kiosk/station/sync/people").respond(403, json=NOT_REGISTERED)
    await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
    cloud.post("/kiosk/station/heartbeat").respond(200, json={})
    for _ in range(2):            # a 200 from any station route resumes
        await station_key.station_request(app.state, "POST", "/kiosk/station/heartbeat",
                                          json={})
    resumed = _station_events(store, "Uploads resumed")
    assert len(resumed) == 1 and resumed[0]["kind"] == "station"
    assert station_key.is_paused(store) is False
    assert len(_station_events(store, "Uploads paused")) == 1


async def test_200_without_pause_records_nothing(app, cloud):
    store = app.state.store
    station_key.store_key(store, app.state.keys, RAW)
    cloud.get("/kiosk/station/sync/people").respond(200, json={})
    await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
    assert store.all("SELECT 1 FROM rfid_events") == []
    assert station_key.is_paused(store) is False


async def test_pause_survives_restart(app, settings, cloud):
    from edge.app import create_app
    store = app.state.store
    station_key.store_key(store, app.state.keys, RAW)
    cloud.get("/kiosk/station/sync/people").respond(403, json=NOT_REGISTERED)
    await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
    await app.state.upstream.aclose()
    store.close()
    again = create_app(settings)                 # a fresh edge over the same data dir
    try:
        assert station_key.is_paused(again.state.store) is True
        await station_key.station_request(again.state, "GET", "/kiosk/station/sync/people")
        assert len(_station_events(again.state.store, "Uploads paused")) == 1
        assert station_key.load_key(again.state.store, again.state.keys) == RAW
    finally:
        await again.state.upstream.aclose()
        again.state.store.close()


async def test_other_403_is_not_a_pause(app, cloud):
    store = app.state.store
    station_key.store_key(store, app.state.keys, RAW)
    cloud.get("/kiosk/station/sync/people").respond(
        403, json={"detail": {"code": "move_locked"}})
    await station_key.station_request(app.state, "GET", "/kiosk/station/sync/people")
    assert station_key.is_paused(store) is False
    assert store.all("SELECT 1 FROM rfid_events") == []
    assert station_key.load_key(store, app.state.keys) == RAW
