"""The Time Clock station on the laptop (kiosk time clock station, Task 5):
a no-move Kiosk Setup that holds a station key, a people-only sync, the
display cookie a signed-in person arms the station's own screen with, and
the signed-out /edge/timeclock/* routes forwarded under the station key."""

import dataclasses
import json
import logging
import uuid
from urllib.parse import parse_qs, urlsplit

import httpx

from edge import laptop_setup, timeclock
from edge.rfid import station_key
from tests.conftest import make_session
from tests.test_laptop_setup import OUT, SETUP, paired, ready

RAW = "stationkey-timeclock-0123456789-SECRET"
PERSON = str(uuid.uuid4())
STATUS = {"person_id": PERSON, "clocked_in": True, "today_minutes": 0}
NO_MOVE = {"device_id": "d-1", "initiative_id": None, "initiative_name": None,
           "site_id": None, "site_name": None, "site_role": None, "scan_status": None,
           "scan_status_label": None}


def timeclock_setup(app, *, key=True, initiative_id=None, **fields):
    laptop_setup.save(app.state.store, {"initiative_id": initiative_id, **fields}, "timeclock")
    if key:
        station_key.store_key(app.state.store, app.state.keys, RAW)


def display(app) -> dict:
    return {"Cookie": f"{timeclock.DISPLAY_COOKIE}={timeclock.issue_display(app.state.store)}"}


async def test_station_info_public_and_flags(app, client):
    r = await client.get("/edge/timeclock/station")
    assert r.status_code == 200
    assert r.json() == {"timeclock": False, "ready": False, "paused": False, "armed": False,
                        "key_missing": False, "initiative_name": None, "site_name": None}
    timeclock_setup(app, site_name="Dock 4")
    body = (await client.get("/edge/timeclock/station")).json()
    assert body == {"timeclock": True, "ready": True, "paused": False, "armed": False,
                    "key_missing": False, "initiative_name": None, "site_name": "Dock 4"}
    assert RAW not in json.dumps(body) and app.state.identity.serial not in json.dumps(body)
    assert (await client.get("/edge/timeclock/station", headers=display(app))).json()["armed"]
    app.state.store.run("INSERT INTO station_status (id, paused) VALUES (1, ?)",
                        (station_key.NOT_REGISTERED,))
    body = (await client.get("/edge/timeclock/station")).json()
    assert body["ready"] is False and body["paused"] is True and body["key_missing"] is False
    station_key.clear(app.state.store)
    body = (await client.get("/edge/timeclock/station")).json()
    assert body["timeclock"] is True and body["ready"] is False
    assert body["key_missing"] is True and body["paused"] is False


async def test_a_label_station_is_not_a_timeclock(app, client):
    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "label")
    station_key.store_key(app.state.store, app.state.keys, RAW)
    body = (await client.get("/edge/timeclock/station")).json()
    assert body["timeclock"] is False and body["ready"] is False
    assert body["key_missing"] is False
    station_key.clear(app.state.store)
    assert (await client.get("/edge/timeclock/station")).json()["key_missing"] is False
    assert station_key.is_timeclock_setup(app.state.store) is False


async def test_arm_requires_session_and_timeclock_key(app, client):
    assert (await client.post("/edge/timeclock/arm")).status_code == 401
    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "label")
    station_key.store_key(app.state.store, app.state.keys, RAW)
    r = await client.post("/edge/timeclock/arm", headers=make_session(app))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_timeclock_station"
    station_key.clear(app.state.store)
    # a Time Clock setup whose key issue failed: the key, not the setup, is missing
    timeclock_setup(app, key=False)
    r = await client.post("/edge/timeclock/arm", headers=make_session(app))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "station_key_missing"
    timeclock_setup(app)
    r = await client.post("/edge/timeclock/arm", headers=make_session(app))
    assert r.status_code == 204
    cookie = r.headers["set-cookie"]
    token = cookie.split(";", 1)[0].split("=", 1)[1]
    assert cookie.startswith(f"{timeclock.DISPLAY_COOKIE}=") and token
    attrs = [a.strip().lower() for a in cookie.split(";")[1:]]
    assert "httponly" in attrs and "samesite=strict" in attrs
    assert "path=/edge/timeclock" in attrs and f"max-age={400 * 86400}" in attrs
    assert "secure" not in attrs                      # settings.secure_cookies is off here
    assert timeclock.is_display(app.state.store, token)
    stored = app.state.store.one("SELECT token_hash, created_at FROM timeclock_displays")
    assert stored["token_hash"] != token and stored["created_at"]
    # the client's jar sends it back on the timeclock paths
    assert (await client.get("/edge/timeclock/station")).json()["armed"] is True


async def test_arm_cookie_is_secure_when_configured(app, client):
    app.state.settings = dataclasses.replace(app.state.settings, secure_cookies=True)
    timeclock_setup(app)
    r = await client.post("/edge/timeclock/arm", headers=make_session(app))
    assert r.status_code == 204
    assert "secure" in [a.strip().lower() for a in r.headers["set-cookie"].split(";")]


async def test_display_routes_refuse_without_cookie(app, client):
    timeclock_setup(app)
    bad = {"Cookie": f"{timeclock.DISPLAY_COOKIE}=not-a-display"}
    for headers in ({}, bad, make_session(app)):
        for r in (await client.get("/edge/timeclock/people", headers=headers),
                  await client.get("/edge/timeclock/status/x", headers=headers),
                  await client.post("/edge/timeclock/clock-in", headers=headers,
                                    json={"person_id": PERSON}),
                  await client.post("/edge/timeclock/clock-out", headers=headers,
                                    json={"person_id": PERSON})):
            assert r.status_code == 403, r.text
            assert r.json()["detail"]["code"] == "not_timeclock_display"


async def test_people_from_the_cache(app, client):
    timeclock_setup(app)
    headers = display(app)
    r = await client.get("/edge/timeclock/people", headers=headers)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "people_not_synced"
    people = {"people": [{"id": PERSON, "display_name": "Jane Doe"}]}
    app.state.store.run("INSERT INTO cache (key, status, body, stored_at) "
                        "VALUES ('/kiosk/sync/people', 200, ?, 'now')", (json.dumps(people),))
    r = await client.get("/edge/timeclock/people", headers=headers)
    assert r.status_code == 200 and r.json() == people
    assert r.headers["x-edge-cache"] == "hit"


async def test_clock_in_forwards_under_station_key(app, client, cloud):
    timeclock_setup(app)
    headers = display(app)
    conflict = {"detail": {"code": "already_clocked_in", "clock_in_at": "2026-10-20T13:00:00Z"}}
    route = cloud.post("/kiosk/station/timeclock/clock-in").mock(side_effect=[
        httpx.Response(200, json=STATUS), httpx.Response(409, json=conflict)])
    r = await client.post("/edge/timeclock/clock-in", headers=headers,
                          json={"person_id": PERSON})
    assert r.status_code == 200 and r.json() == STATUS
    sent = route.calls[0].request
    assert sent.headers["authorization"] == f"Station {RAW}"
    assert json.loads(sent.content) == {"serial": app.state.identity.serial,
                                        "person_id": PERSON}
    r = await client.post("/edge/timeclock/clock-in", headers=headers,
                          json={"person_id": PERSON})
    assert r.status_code == 409 and r.json() == conflict
    assert RAW not in r.text


async def test_clock_out_and_status_forward(app, client, cloud):
    timeclock_setup(app)
    headers = display(app)
    out = cloud.post("/kiosk/station/timeclock/clock-out").respond(
        409, json={"detail": {"code": "not_clocked_in"}})
    r = await client.post("/edge/timeclock/clock-out", headers=headers,
                          json={"person_id": PERSON})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_clocked_in"
    assert json.loads(out.calls[0].request.content) == {"serial": app.state.identity.serial,
                                                        "person_id": PERSON}
    status = cloud.get(f"/kiosk/station/timeclock/{PERSON}").respond(200, json=STATUS)
    r = await client.get(f"/edge/timeclock/status/{PERSON}", headers=headers)
    assert r.status_code == 200 and r.json() == STATUS
    sent = status.calls[0].request
    assert sent.headers["authorization"] == f"Station {RAW}"
    assert parse_qs(urlsplit(str(sent.url)).query) == {"serial": [app.state.identity.serial]}


async def test_the_kiosks_zone_is_forwarded(app, client, cloud):
    """`tz` (the browser's own zone, "today" when the site has none) rides
    along: the query on the status read, the body on punches. A value that
    is not a short string is dropped, not forwarded and not an error."""
    timeclock_setup(app)
    headers = display(app)
    serial = app.state.identity.serial
    zone = "America/Chicago"
    status = cloud.get(f"/kiosk/station/timeclock/{PERSON}").respond(200, json=STATUS)
    cin = cloud.post("/kiosk/station/timeclock/clock-in").respond(200, json=STATUS)
    cout = cloud.post("/kiosk/station/timeclock/clock-out").respond(200, json=STATUS)

    r = await client.get(f"/edge/timeclock/status/{PERSON}", headers=headers,
                         params={"tz": zone})
    assert r.status_code == 200
    assert parse_qs(urlsplit(str(status.calls[-1].request.url)).query) == {
        "serial": [serial], "tz": [zone]}
    for path, route in (("clock-in", cin), ("clock-out", cout)):
        r = await client.post(f"/edge/timeclock/{path}", headers=headers,
                              json={"person_id": PERSON, "tz": zone})
        assert r.status_code == 200
        assert json.loads(route.calls[-1].request.content) == {
            "serial": serial, "person_id": PERSON, "tz": zone}

    too_long = "A" * 65
    r = await client.get(f"/edge/timeclock/status/{PERSON}", headers=headers,
                         params={"tz": too_long})
    assert r.status_code == 200
    assert parse_qs(urlsplit(str(status.calls[-1].request.url)).query) == {"serial": [serial]}
    for bad in (too_long, "", 5, None, ["UTC"]):
        r = await client.post("/edge/timeclock/clock-in", headers=headers,
                              json={"person_id": PERSON, "tz": bad})
        assert r.status_code == 200, bad
        assert json.loads(cin.calls[-1].request.content) == {
            "serial": serial, "person_id": PERSON}, bad


async def test_bad_person_and_no_key(app, client, cloud):
    timeclock_setup(app)
    headers = display(app)
    route = cloud.post("/kiosk/station/timeclock/clock-in").respond(200, json=STATUS)
    for body in ({"person_id": "x"}, {}, {"person_id": 5}):
        r = await client.post("/edge/timeclock/clock-in", headers=headers, json=body)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_person", body
    r = await client.post("/edge/timeclock/clock-in", headers=headers, content=b"nope")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_person"
    r = await client.get("/edge/timeclock/status/not-a-uuid", headers=headers)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_person"
    # the key gone from under an armed screen (station_key.clear would revoke
    # the screen too): the defensive 409
    app.state.store.run("DELETE FROM station_key")
    r = await client.post("/edge/timeclock/clock-in", headers=headers,
                          json={"person_id": PERSON})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "station_not_ready"
    assert not route.called


async def test_clock_in_offline_503(app, client, cloud):
    timeclock_setup(app)
    headers = display(app)
    cloud.post("/kiosk/station/timeclock/clock-in").mock(side_effect=httpx.ConnectError("down"))
    r = await client.post("/edge/timeclock/clock-in", headers=headers,
                          json={"person_id": PERSON})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"
    cloud.get(f"/kiosk/station/timeclock/{PERSON}").respond(502)
    r = await client.get(f"/edge/timeclock/status/{PERSON}", headers=headers)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_timeclock_sync_people_only_without_move(app, cloud):
    timeclock_setup(app)
    app.state.syncer.set_target(None, "p-1")
    people = {"people": [{"id": PERSON}]}
    route = cloud.get("/kiosk/station/sync/people").respond(200, json=people)
    other = cloud.get(url__regex=r"/kiosk/(station/)?sync/(assets|containers|client-assets|"
                                 r"label-templates|trucks).*").respond(200, json={})
    meta = await app.state.syncer.run()
    assert route.call_count == 1 and not other.called
    sent = route.calls[0].request
    assert sent.headers["authorization"] == f"Station {RAW}"
    assert parse_qs(urlsplit(str(sent.url)).query) == {"serial": [app.state.identity.serial]}
    row = app.state.store.one("SELECT body FROM cache WHERE key = '/kiosk/sync/people'")
    assert json.loads(row["body"]) == people
    assert meta["synced_at"] and meta["last_error"] is None and meta["initiative_id"] is None


async def test_timeclock_sync_names_the_move_when_set_up_with_one(app, cloud):
    timeclock_setup(app, initiative_id="m-1")
    app.state.syncer.set_target("m-1", "p-1")
    route = cloud.get("/kiosk/station/sync/people").respond(200, json={"people": []})
    await app.state.syncer.run()
    query = parse_qs(urlsplit(str(route.calls[0].request.url)).query)
    assert query == {"serial": [app.state.identity.serial], "initiative_id": ["m-1"]}


async def test_timeclock_sync_as_a_person_without_a_key(app, cloud):
    timeclock_setup(app, key=False)
    app.state.syncer.set_target(None, "p-1")
    assert (await app.state.syncer.run())["last_error"] == "needs_sign_in"
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1",
                                    expires_in=900)
    route = cloud.get("/kiosk/sync/people").respond(200, json={"people": []})
    station = cloud.get("/kiosk/station/sync/people").respond(200, json={"people": []})
    meta = await app.state.syncer.run()
    assert route.call_count == 1 and not station.called
    assert route.calls[0].request.headers["authorization"] == "Bearer a1"
    assert meta["last_error"] is None
    assert app.state.store.one("SELECT 1 FROM cache WHERE key = '/kiosk/sync/people'")


async def test_timeclock_sync_errors(app, cloud):
    timeclock_setup(app)
    app.state.syncer.set_target(None, "p-1")
    cloud.get("/kiosk/station/sync/people").mock(side_effect=httpx.ConnectError("down"))
    assert (await app.state.syncer.run())["last_error"] == "offline"
    cloud.get("/kiosk/station/sync/people").respond(403, json={"detail": {"code": "x"}})
    assert (await app.state.syncer.run())["last_error"] == "http_403:/kiosk/station/sync/people"
    assert app.state.store.one("SELECT 1 FROM cache WHERE key = '/kiosk/sync/people'") is None


async def test_setup_with_null_move_saves_and_issues_key(app, client, cloud):
    ready(app, cloud, body=NO_MOVE)
    issue = cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    r = await client.post("/kiosk/setup", headers=make_session(app),
                          json={"serial": "browser", "initiative_id": None, "site_id": None,
                                "station_type": "timeclock"})
    assert r.status_code == 200, r.text
    assert RAW not in r.text
    setup = laptop_setup.load(app.state.store)
    assert setup["station_type"] == "timeclock" and setup["initiative_id"] is None
    assert issue.call_count == 1
    assert station_key.load_key(app.state.store, app.state.keys) == RAW
    assert app.state.syncer.meta()["initiative_id"] is None   # not the text "None"
    details = [row["detail"] for row in app.state.store.all(
        "SELECT detail FROM rfid_events WHERE kind = 'scan_type_selected'")]
    assert details and "Time Clock Station" in details[-1]
    assert app.state.store.one("SELECT 1 FROM rfid_events WHERE kind = 'move_loaded'") is None


async def test_setup_event_text_unchanged_for_other_stations(app, client, cloud):
    ready(app, cloud)
    cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    await client.post("/kiosk/setup", headers=make_session(app),
                      json={**SETUP, "station_type": "label"})
    await client.post("/kiosk/setup", headers=make_session(app), json=SETUP)
    details = [row["detail"] for row in app.state.store.all(
        "SELECT detail FROM rfid_events WHERE kind = 'scan_type_selected' ORDER BY id")]
    assert details == ["Picked up · Label Station", "Picked up · Label Station"]
    assert app.state.syncer.meta()["initiative_id"] == "m-1"


async def test_clear_setup_and_wipe_drop_displays(app, client, cloud):
    store = app.state.store
    timeclock_setup(app)
    token = timeclock.issue_display(store)
    assert timeclock.is_display(store, token)
    assert not timeclock.is_display(store, None) and not timeclock.is_display(store, "")
    station_key.apply_clear_setup(store)
    assert not timeclock.is_display(store, token)

    token = timeclock.issue_display(store)
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.status_code == 200
    assert not timeclock.is_display(store, token)

    # every setup revokes armed screens, a Time Clock set up again included
    for body in ({"serial": "browser", "station_type": "timeclock"},
                 {**SETUP, "station_type": "label"}):
        ready(app, cloud, body=NO_MOVE if body.get("station_type") == "timeclock" else OUT)
        cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
        token = timeclock.issue_display(store)
        assert (await client.post("/kiosk/setup", headers=make_session(app),
                                  json=body)).status_code == 200
        assert not timeclock.is_display(store, token)

    token = timeclock.issue_display(store)
    timeclock.clear_displays(store)
    assert not timeclock.is_display(store, token)


async def test_a_timeclock_resetup_revokes_the_armed_cookie(app, client, cloud):
    ready(app, cloud, body=NO_MOVE)
    cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    body = {"serial": "browser", "station_type": "timeclock"}
    assert (await client.post("/kiosk/setup", headers=make_session(app),
                              json=body)).status_code == 200
    assert (await client.post("/edge/timeclock/arm", headers=make_session(app))).status_code \
        == 204
    people = await client.get("/edge/timeclock/people")      # the jar sends the cookie
    assert people.json()["detail"]["code"] == "people_not_synced"
    assert (await client.post("/kiosk/setup", headers=make_session(app),
                              json=body)).status_code == 200
    r = await client.get("/edge/timeclock/people")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "not_timeclock_display"
    assert (await client.get("/edge/timeclock/station")).json()["armed"] is False


async def test_a_dropped_or_replaced_key_revokes_displays(app, client, cloud):
    store = app.state.store
    timeclock_setup(app)
    headers = display(app)
    cloud.post("/kiosk/station/timeclock/clock-in").respond(
        401, json={"detail": {"code": "station_key_invalid"}})
    r = await client.post("/edge/timeclock/clock-in", headers=headers,
                          json={"person_id": PERSON})
    assert r.status_code == 401                               # passed through
    assert not station_key.has_key(store)
    r = await client.get("/edge/timeclock/people", headers=headers)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "not_timeclock_display"

    station_key.store_key(store, app.state.keys, RAW)
    headers = display(app)
    station_key.store_key(store, app.state.keys, "a-newer-key")   # replaced
    r = await client.get("/edge/timeclock/people", headers=headers)
    assert r.status_code == 403

    headers = display(app)
    station_key.clear(store)
    assert (await client.get("/edge/timeclock/people", headers=headers)).status_code == 403


async def test_arm_refuses_a_move_locked_session(app, client):
    timeclock_setup(app, initiative_id="m-1")
    locked = make_session(app, kiosk_move={"initiative_id": "m-1", "name": "Move 1"})
    r = await client.post("/edge/timeclock/arm", headers=locked)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"
    assert "set-cookie" not in r.headers
    assert app.state.store.one("SELECT 1 FROM timeclock_displays") is None


def _pending(store, sid, scan_type):
    store.run("INSERT INTO pending_rfid_scans (client_scan_id, epc, matched_kind, matched_id, "
              "scanned_at, created_at, scan_type) VALUES (?, 'E1', 'asset', 'a-1', 'now', "
              "'now', ?)", (sid, scan_type))


async def test_a_timeclock_setup_drops_the_reader_and_rejects_every_pending_scan(app, client,
                                                                                  cloud):
    await paired(app, client)
    store = app.state.store
    _pending(store, "rfid-1", None)
    _pending(store, "label-1", "barcode")
    ready(app, cloud, body=NO_MOVE)
    cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    r = await client.post("/kiosk/setup", headers=make_session(app),
                          json={"serial": "browser", "station_type": "timeclock"})
    assert r.status_code == 200, r.text
    assert store.one("SELECT * FROM rfid_pairing") is None
    rows = {row["client_scan_id"]: (row["upload_state"], row["reject_code"]) for row in
            store.all("SELECT client_scan_id, upload_state, reject_code FROM pending_rfid_scans")}
    assert rows == {"rfid-1": ("rejected", "station_changed"),
                    "label-1": ("rejected", "station_changed")}


async def test_a_label_setup_still_keeps_labeled_scans(app, client, cloud):
    store = app.state.store
    _pending(store, "rfid-1", None)
    _pending(store, "label-1", "barcode")
    ready(app, cloud)
    cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    await client.post("/kiosk/setup", headers=make_session(app),
                      json={**SETUP, "station_type": "label"})
    rows = {row["client_scan_id"]: row["upload_state"] for row in
            store.all("SELECT client_scan_id, upload_state FROM pending_rfid_scans")}
    assert rows == {"rfid-1": "rejected", "label-1": "pending"}


async def test_station_key_never_logged_on_timeclock_paths(app, client, cloud, caplog):
    caplog.set_level(logging.DEBUG)
    timeclock_setup(app)
    headers = display(app)
    app.state.syncer.set_target(None, "p-1")
    cloud.get("/kiosk/station/sync/people").respond(500, text=f"echo {RAW}")
    await app.state.syncer.run()
    cloud.get("/kiosk/station/sync/people").respond(200, json={"people": []})
    await app.state.syncer.run()
    cloud.post("/kiosk/station/timeclock/clock-in").respond(409, json={"detail": {"code": "x"}})
    cloud.post("/kiosk/station/timeclock/clock-out").respond(200, json=STATUS)
    cloud.get(f"/kiosk/station/timeclock/{PERSON}").mock(side_effect=httpx.ConnectError(RAW))
    for r in (await client.post("/edge/timeclock/clock-in", headers=headers,
                                json={"person_id": PERSON}),
              await client.post("/edge/timeclock/clock-out", headers=headers,
                                json={"person_id": PERSON}),
              await client.get(f"/edge/timeclock/status/{PERSON}", headers=headers),
              await client.get("/edge/timeclock/station")):
        assert RAW not in r.text
    cloud.get("/kiosk/station/sync/people").respond(
        401, json={"detail": {"code": "station_key_invalid"}})
    await app.state.syncer.run()
    assert caplog.records and RAW not in caplog.text
    assert RAW not in json.dumps(app.state.syncer.meta())


async def test_edge_forwards_learning_routes(app, client, cloud, caplog):
    """"Email me the link" and the admin override forward like clock-in: the
    laptop's serial (never the browser's), the person, `tz`, and the
    override's own fields; clock-in carries `learning_override_id` when it
    is a UUID. The portal's 403 refusals pass through with the key kept.
    The admin's password is never logged."""
    caplog.set_level(logging.DEBUG)
    timeclock_setup(app)
    headers = display(app)
    serial = app.state.identity.serial
    oid = str(uuid.uuid4())
    password = "Admin-Station-Pass9!"
    link = cloud.post("/kiosk/station/timeclock/learning-link").respond(
        200, json={"sent": True})
    override = cloud.post("/kiosk/station/timeclock/learning-override").mock(side_effect=[
        httpx.Response(200, json={"override_id": oid}),
        httpx.Response(403, json={"detail": {"code": "totp_required"}})])
    cin = cloud.post("/kiosk/station/timeclock/clock-in").respond(200, json=STATUS)

    r = await client.post("/edge/timeclock/learning-link", headers=headers,
                          json={"person_id": PERSON, "serial": "spoofed", "extra": 1,
                                "tz": "America/Chicago"})
    assert r.status_code == 200 and r.json() == {"sent": True}
    sent = link.calls[0].request
    assert sent.headers["authorization"] == f"Station {RAW}"
    assert json.loads(sent.content) == {"serial": serial, "person_id": PERSON,
                                        "tz": "America/Chicago"}

    body = {"person_id": PERSON, "admin_email": "ada@example.com", "admin_password": password,
            "totp_code": "123456", "reason": "other", "reason_text": "No phone signal",
            "scope": "day", "tz": "America/Chicago", "serial": "spoofed", "junk": "x"}
    r = await client.post("/edge/timeclock/learning-override", headers=headers, json=body)
    assert r.status_code == 200 and r.json() == {"override_id": oid}
    sent = override.calls[0].request
    assert sent.headers["authorization"] == f"Station {RAW}"
    assert json.loads(sent.content) == {
        "serial": serial, "person_id": PERSON, "tz": "America/Chicago",
        "admin_email": "ada@example.com", "admin_password": password, "totp_code": "123456",
        "reason": "other", "reason_text": "No phone signal", "scope": "day"}
    # the portal's refusal comes back as it is
    r = await client.post("/edge/timeclock/learning-override", headers=headers,
                          json={"person_id": PERSON, "admin_email": "ada@example.com",
                                "admin_password": password, "reason": "no_phone",
                                "scope": "punch"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "totp_required"
    assert station_key.has_key(app.state.store)       # about the admin, not the key
    assert json.loads(override.calls[1].request.content) == {
        "serial": serial, "person_id": PERSON, "admin_email": "ada@example.com",
        "admin_password": password, "reason": "no_phone", "scope": "punch"}

    r = await client.post("/edge/timeclock/clock-in", headers=headers,
                          json={"person_id": PERSON, "learning_override_id": oid})
    assert r.status_code == 200
    assert json.loads(cin.calls[-1].request.content) == {
        "serial": serial, "person_id": PERSON, "learning_override_id": oid}
    # an id that isn't a UUID is dropped; the punch is forwarded all the same
    for bad in ("not-a-uuid", 5, "", ["x"]):
        r = await client.post("/edge/timeclock/clock-in", headers=headers,
                              json={"person_id": PERSON, "learning_override_id": bad})
        assert r.status_code == 200, bad
        assert json.loads(cin.calls[-1].request.content) == {
            "serial": serial, "person_id": PERSON}, bad

    # an armed display only, and a bad person never leaves the laptop
    for path in ("learning-link", "learning-override"):
        r = await client.post(f"/edge/timeclock/{path}", json={"person_id": PERSON})
        assert r.status_code == 403 and r.json()["detail"]["code"] == "not_timeclock_display"
        r = await client.post(f"/edge/timeclock/{path}", headers=headers,
                              json={"person_id": "x"})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_person"
    assert link.call_count == 1 and override.call_count == 2
    assert password not in caplog.text and RAW not in caplog.text
