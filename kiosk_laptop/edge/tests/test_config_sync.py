"""The laptop's kiosk config, held on the edge (kiosk config phase 1, Task 6):
/edge/config for the laptop's browsers, the sync fields on the proxied person
heartbeat and on the station heartbeat, the alarm section mirrored into
alarm_settings, and sounds proxied with the edge's identity."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from edge import config_sync, laptop_setup
from edge.db import SCHEMA_STEPS, Store
from edge.rfid import alarm, reader_report, station_key
from tests.conftest import make_session

HEARTBEAT = "/kiosk/heartbeat"
STATION = "/kiosk/station/heartbeat"

DOC = {
    "schema": 1,
    "appearance": {"good_scan": {"h": 150, "s": 60, "l": 45},
                   "not_found_scan": {"h": 0, "s": 70, "l": 50},
                   "duplicate_scan": {"h": 38, "s": 92, "l": 50}, "flash_ms": 350},
    "sound": {"good": {"kind": "builtin", "id": "chime"}, "volume": 0.8},
    "checkpoints": {"enroll": "pre_stage"},
    "developer": {"dev_mode": False},
}

PORTAL = {
    **DOC,
    "appearance": {**DOC["appearance"], "flash_ms": 900},
    "alarm": {"mode": "timed", "timed_seconds": 42},
    "android_rfid": {"power": 270, "nested": {"a": [1, 2, {"b": None}]}},
    "ios": {"camera_position": "front"},
    "future_thing": {"n": 1.5},
}


def _online_as(app):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)


def _row(app):
    return dict(app.state.store.one("SELECT * FROM device_config WHERE id = 1") or {})


def _clock_known(app, offset_ms=0):
    app.state.store.run("INSERT OR IGNORE INTO device_config (id) VALUES (1)")
    app.state.store.run("UPDATE device_config SET server_offset_ms = ?", (offset_ms,))


async def _seed(app, client, doc=DOC):
    r = await client.put("/edge/config", json={"doc": doc, "seed": True},
                         headers=make_session(app))
    assert r.status_code == 200, r.text
    return r.json()


async def _edit(app, client, doc, base_version):
    return await client.put("/edge/config", json={"doc": doc, "base_version": base_version},
                            headers=make_session(app))


def _beat_reply(**extra):
    return {"registration": "ok", "clear_setup": None,
            "server_time": datetime.now(UTC).isoformat(), "config_version": 0, "config": None,
            "scan_status": None, "scan_status_label": None, **extra}


async def _person_beat(app, client, cloud, reply=None, **body):
    _online_as(app)
    route = cloud.post(HEARTBEAT).respond(200, json=reply or _beat_reply())
    r = await client.post(HEARTBEAT, headers=make_session(app),
                          json={"serial": "browser", "name": "B", "mode": "web", **body})
    assert r.status_code == 200, r.text
    return json.loads(route.calls[-1].request.content)


# ── schema ──────────────────────────────────────────────────────────

def test_schema_step_adds_device_config(tmp_path):
    store = Store(tmp_path / "edge.db")
    cols = {r["name"] for r in store.all("PRAGMA table_info(device_config)")}
    assert {"doc", "version", "changed_at", "dirty", "applied_version", "server_offset_ms",
            "reported_at"} <= cols
    assert "device_config" in SCHEMA_STEPS[-1]
    store.close()


# ── /edge/config ────────────────────────────────────────────────────

async def test_edge_config_needs_a_session(client):
    assert (await client.get("/edge/config")).status_code == 401
    assert (await client.put("/edge/config", json={"doc": DOC})).status_code == 401


async def test_edge_config_starts_empty(app, client):
    r = await client.get("/edge/config", headers=make_session(app))
    assert r.json() == {"doc": None, "version": 0, "changed_at": None}


async def test_seed_stores_once_unstamped_with_the_alarm_mirrored(app, client):
    out = await _seed(app, client)
    assert out["version"] == 1 and out["changed_at"] is None
    assert out["doc"]["alarm"] == {"mode": "until_dismissed", "timed_seconds": 10}
    assert out["doc"]["appearance"] == DOC["appearance"]
    assert _row(app)["dirty"] == 0
    # a second seed (another browser) changes nothing and gets the stored copy
    again = await _seed(app, client, {**DOC, "developer": {"dev_mode": True}})
    assert again == out


DEFAULTS = {
    "schema": 1,
    "appearance": {"good_scan": {"h": 150, "s": 60, "l": 45},
                   "not_found_scan": {"h": 0, "s": 70, "l": 50},
                   "duplicate_scan": {"h": 38, "s": 92, "l": 50}, "flash_ms": 350},
    "sound": {"good": {"kind": "builtin", "id": "chime"},
              "not_found": {"kind": "builtin", "id": "buzz"},
              "duplicate": {"kind": "builtin", "id": "double_beep"},
              "alarm": {"kind": "siren"}, "volume": 0.8},
    "checkpoints": {"enroll": "pre_stage", "container_pack": "in_container",
                    "container_unpack": "un_pack", "truck_load": "on_truck",
                    "truck_unload": "received"},
    "developer": {"dev_mode": False},
}


async def test_defaults_only_seed_gives_way_to_a_customized_seed(app, client):
    """A browser nobody customized seeded the edge (an older build): until
    that copy is reported or the portal's arrives, a customized browser's
    seed replaces it, still unstamped and not dirty."""
    first = await _seed(app, client, DEFAULTS)
    assert first["version"] == 1
    custom = {**DEFAULTS, "appearance": {**DEFAULTS["appearance"], "flash_ms": 700}}
    out = await _seed(app, client, custom)
    assert out["version"] == 2 and out["changed_at"] is None
    assert out["doc"]["appearance"]["flash_ms"] == 700
    assert _row(app)["dirty"] == 0
    # a customized copy is never replaced by another seed
    again = await _seed(app, client, {**DEFAULTS, "developer": {"dev_mode": True}})
    assert again == out


async def test_reported_defaults_seed_is_kept(app, client, cloud):
    await _seed(app, client, DEFAULTS)
    await _person_beat(app, client, cloud)                 # the first report goes out
    custom = {**DEFAULTS, "appearance": {**DEFAULTS["appearance"], "flash_ms": 700}}
    out = await _seed(app, client, custom)
    assert out["doc"]["appearance"]["flash_ms"] == 350 and out["version"] == 1


async def test_edit_round_trips_whole_and_marks_dirty(app, client):
    await _seed(app, client)
    _clock_known(app)
    edited = {**PORTAL, "developer": {"dev_mode": True}}
    r = await _edit(app, client, edited, 1)
    assert r.status_code == 200
    out = r.json()
    assert out["version"] == 2 and out["changed_at"] is not None
    got = (await client.get("/edge/config", headers=make_session(app))).json()
    assert got == out
    for key in ("android_rfid", "ios", "future_thing", "alarm"):
        assert json.dumps(got["doc"][key]) == json.dumps(PORTAL[key])
    assert _row(app)["dirty"] == 1
    # the alarm section went to alarm_settings
    assert alarm.settings(app.state.store) == {"mode": "timed", "timed_seconds": 42}


async def test_unchanged_edit_is_a_no_op(app, client):
    out = await _seed(app, client)
    r = await _edit(app, client, out["doc"], 1)
    assert r.json()["version"] == 1 and _row(app)["dirty"] == 0


async def test_stale_base_version_is_409_with_the_current_copy(app, client):
    await _seed(app, client)
    await _edit(app, client, {**DOC, "developer": {"dev_mode": True}}, 1)
    r = await _edit(app, client, DOC, 1)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "config_changed" and detail["version"] == 2
    assert detail["doc"]["developer"] == {"dev_mode": True}


async def test_bad_bodies_are_422(app, client):
    h = make_session(app)
    for body in ({"doc": []}, {"doc": "x"}, {}, {"doc": DOC, "base_version": "1"},
                 {"doc": {"schema": 1, "x": "y" * 70000}}):
        r = await client.put("/edge/config", json=body, headers=h)
        assert r.status_code == 422, body


async def test_bad_alarm_values_keep_the_previous_ones(app, client):
    await _seed(app, client)
    r = await _edit(app, client, {**DOC, "alarm": {"mode": "timed", "timed_seconds": 2}}, 1)
    assert r.status_code == 200
    assert alarm.settings(app.state.store) == {"mode": "timed", "timed_seconds": 10}
    assert r.json()["doc"]["alarm"] == {"mode": "timed", "timed_seconds": 10}


async def test_alarm_settings_edit_updates_the_config_and_marks_dirty(app, client):
    await _seed(app, client)
    _clock_known(app)
    r = await client.put("/edge/rfid/alarm/settings", json={"mode": "timed", "timed_seconds": 5},
                         headers=make_session(app))
    assert r.status_code == 200
    got = (await client.get("/edge/config", headers=make_session(app))).json()
    assert got["doc"]["alarm"] == {"mode": "timed", "timed_seconds": 5}
    assert got["version"] == 2 and got["changed_at"] is not None
    assert _row(app)["dirty"] == 1


async def test_alarm_settings_edit_before_any_config_is_held_dirty(app, client):
    await client.put("/edge/rfid/alarm/settings", json={"mode": "timed", "timed_seconds": 5},
                     headers=make_session(app))
    assert _row(app)["dirty"] == 1
    out = await _seed(app, client)
    assert out["doc"]["alarm"] == {"mode": "timed", "timed_seconds": 5}


# ── the proxied person heartbeat ────────────────────────────────────

async def test_no_config_yet_sends_only_the_applied_version(app, client, cloud):
    sent = await _person_beat(app, client, cloud)
    assert sent["config_applied_version"] is None
    assert "config" not in sent and "config_changed_at" not in sent


async def test_browser_config_fields_never_pass_through(app, client, cloud):
    sent = await _person_beat(app, client, cloud, config={"schema": 1, "evil": 1},
                              config_changed_at="2099-01-01T00:00:00Z",
                              config_applied_version=999)
    assert sent["config_applied_version"] is None and "config" not in sent


async def test_first_report_is_unstamped_then_reply_is_applied(app, client, cloud):
    seeded = await _seed(app, client)
    stored = {**PORTAL}
    sent = await _person_beat(app, client, cloud,
                              reply=_beat_reply(config=stored, config_version=1))
    assert sent["config"] == seeded["doc"] and sent["config_changed_at"] is None
    assert sent["config_applied_version"] is None
    row = _row(app)
    assert row["applied_version"] == 1 and row["reported_at"] is not None and row["dirty"] == 0
    got = (await client.get("/edge/config", headers=make_session(app))).json()
    assert got["version"] == 2
    assert json.dumps(got["doc"]) == json.dumps(stored)
    assert alarm.settings(app.state.store) == {"mode": "timed", "timed_seconds": 42}
    # the next beat carries no report, only the applied version
    sent = await _person_beat(app, client, cloud, reply=_beat_reply(config_version=1))
    assert "config" not in sent and sent["config_applied_version"] == 1


async def test_dirty_report_is_stamped_with_portal_corrected_time(app, client, cloud):
    await _seed(app, client)
    ahead = datetime.now(UTC) + timedelta(days=3)
    await _person_beat(app, client, cloud, reply=_beat_reply(server_time=ahead.isoformat()))
    offset = _row(app)["server_offset_ms"]
    assert abs(offset - 3 * 86400 * 1000) < 5000
    r = await _edit(app, client, {**DOC, "developer": {"dev_mode": True}}, 1)
    stamp = datetime.fromisoformat(r.json()["changed_at"])
    assert abs((stamp - ahead).total_seconds()) < 5
    sent = await _person_beat(app, client, cloud,
                              reply=_beat_reply(server_time=ahead.isoformat()))
    assert sent["config"]["developer"] == {"dev_mode": True}
    assert sent["config_changed_at"] == r.json()["changed_at"]
    assert _row(app)["dirty"] == 0


async def test_report_goes_out_every_60_minutes(app, client, cloud):
    await _seed(app, client)
    await _person_beat(app, client, cloud)                       # first report
    sent = await _person_beat(app, client, cloud)
    assert "config" not in sent
    old = (datetime.now(UTC) - timedelta(minutes=61)).isoformat()
    app.state.store.run("UPDATE device_config SET reported_at = ?", (old,))
    sent = await _person_beat(app, client, cloud)
    assert "config" in sent


async def test_a_change_before_the_clock_is_known_is_held_then_corrected(app, client, cloud):
    await _seed(app, client)
    r = await _edit(app, client, {**DOC, "developer": {"dev_mode": True}}, 1)
    assert r.json()["changed_at"] is None                         # no portal clock yet
    ahead = datetime.now(UTC) + timedelta(hours=5)
    sent = await _person_beat(app, client, cloud, reply=_beat_reply(server_time=ahead.isoformat()))
    assert "config" not in sent                                   # held for the clock
    row = _row(app)
    assert row["dirty"] == 1 and row["changed_at"] is not None
    assert abs((datetime.fromisoformat(row["changed_at"]) - ahead).total_seconds()) < 5
    sent = await _person_beat(app, client, cloud)
    assert sent["config_changed_at"] == row["changed_at"]


async def test_reply_while_a_local_edit_lands_keeps_the_edit_and_takes_other_sections(
        app, client, cloud):
    await _seed(app, client)
    await _person_beat(app, client, cloud)                        # first report, clock known
    _online_as(app)

    def landing(request):
        # a browser's edit lands while the beat is in flight
        config_sync.put(app.state.store, {**DOC, "developer": {"dev_mode": True}}, 1)
        return httpx.Response(200, json=_beat_reply(config=PORTAL, config_version=3))

    cloud.post(HEARTBEAT).mock(side_effect=landing)
    await client.post(HEARTBEAT, headers=make_session(app), json={"serial": "b"})
    row = _row(app)
    assert row["dirty"] == 1 and row["applied_version"] is None
    doc = json.loads(row["doc"])
    assert doc["developer"] == {"dev_mode": True}                 # the local edit
    assert doc["appearance"] == DOC["appearance"]                 # local section kept
    assert json.dumps(doc["android_rfid"]) == json.dumps(PORTAL["android_rfid"])
    assert doc["future_thing"] == PORTAL["future_thing"]


async def test_reply_below_the_applied_version_is_a_reset_and_applied(app, client, cloud):
    """Beats are serialized (config_lock), so a reply can't be from an older,
    overlapping beat: a lower version means the portal's row was recreated
    (Clear Offline, a delete, a DB revert) and restarted its versions."""
    await _seed(app, client)
    await _person_beat(app, client, cloud, reply=_beat_reply(config=PORTAL, config_version=3))
    before = _row(app)
    restarted = {**PORTAL, "developer": {"dev_mode": True}}
    sent = await _person_beat(app, client, cloud,
                              reply=_beat_reply(config=restarted, config_version=1))
    assert sent["config_applied_version"] == 3
    after = _row(app)
    assert after["applied_version"] == 1
    assert json.loads(after["doc"])["developer"] == {"dev_mode": True}
    assert after["version"] == before["version"] + 1
    sent = await _person_beat(app, client, cloud, reply=_beat_reply(config_version=1))
    assert sent["config_applied_version"] == 1


async def test_reset_reply_without_a_document_reports_on_the_next_beat(app, client, cloud):
    await _seed(app, client)
    await _person_beat(app, client, cloud, reply=_beat_reply(config=PORTAL, config_version=3))
    sent = await _person_beat(app, client, cloud, reply=_beat_reply(config_version=3))
    assert "config" not in sent
    # the row was recreated: version 0, nothing stored yet
    await _person_beat(app, client, cloud, reply=_beat_reply(config_version=0))
    assert _row(app)["applied_version"] == 0
    sent = await _person_beat(app, client, cloud, reply=_beat_reply(config_version=1))
    assert sent["config_applied_version"] == 0
    assert sent["config"]["appearance"] == PORTAL["appearance"]


async def test_same_version_reply_is_not_reapplied(app, client, cloud):
    await _seed(app, client)
    await _person_beat(app, client, cloud, reply=_beat_reply(config=PORTAL, config_version=3))
    before = _row(app)
    await _person_beat(app, client, cloud, reply=_beat_reply(
        config={**PORTAL, "developer": {"dev_mode": True}}, config_version=3))
    assert _row(app)["doc"] == before["doc"] and _row(app)["version"] == before["version"]


async def test_station_key_moves_config_sync_off_the_person_heartbeat(app, client, cloud):
    await _seed(app, client)
    station_key.store_key(app.state.store, app.state.keys, "the-key")
    sent = await _person_beat(app, client, cloud)
    for key in ("config", "config_changed_at", "config_applied_version"):
        assert key not in sent


async def test_scan_type_from_the_reply_updates_the_shared_setup(app, client, cloud):
    laptop_setup.save(app.state.store, {"initiative_id": "m-1", "scan_status": "a",
                                        "scan_status_label": "A"}, "label")
    await _person_beat(app, client, cloud,
                       reply=_beat_reply(scan_status="b", scan_status_label="B"))
    setup = laptop_setup.load(app.state.store)
    assert (setup["scan_status"], setup["scan_status_label"]) == ("b", "B")
    await _person_beat(app, client, cloud, reply=_beat_reply(scan_status="c"))
    setup = laptop_setup.load(app.state.store)
    assert (setup["scan_status"], setup["scan_status_label"]) == ("c", "c")


# ── the station heartbeat ───────────────────────────────────────────

async def test_station_heartbeat_syncs_config_with_nobody_signed_in(app, client, cloud):
    await _seed(app, client)
    laptop_setup.save(app.state.store, {"initiative_id": "i-1"}, "rfid")
    station_key.store_key(app.state.store, app.state.keys, "the-key")
    route = cloud.post(STATION).respond(200, json=_beat_reply(config=PORTAL, config_version=4))
    assert app.state.store.one("SELECT COUNT(*) AS n FROM cloud_sessions")["n"] == 0
    await reader_report.send_station_heartbeat(app.state, None)
    body = json.loads(route.calls[-1].request.content)
    assert body["config_changed_at"] is None and body["config"]["appearance"] == DOC["appearance"]
    assert body["config_applied_version"] is None
    assert _row(app)["applied_version"] == 4
    assert alarm.settings(app.state.store) == {"mode": "timed", "timed_seconds": 42}
    route = cloud.post(STATION).respond(200, json=_beat_reply(config_version=4))
    await reader_report.send_station_heartbeat(app.state, None)
    body = json.loads(route.calls[-1].request.content)
    assert "config" not in body and body["config_applied_version"] == 4


async def test_station_heartbeat_reply_scan_type_updates_the_shared_setup(app, client, cloud):
    laptop_setup.save(app.state.store, {"initiative_id": "i-1", "scan_status": "a",
                                        "scan_status_label": "A"}, "rfid")
    station_key.store_key(app.state.store, app.state.keys, "the-key")
    cloud.post(STATION).respond(200, json=_beat_reply(scan_status="rf", scan_status_label="RFID"))
    await reader_report.send_station_heartbeat(app.state, None)
    assert laptop_setup.load(app.state.store)["scan_status_label"] == "RFID"


async def test_failed_station_beat_keeps_dirty(app, client, cloud):
    await _seed(app, client)
    station_key.store_key(app.state.store, app.state.keys, "the-key")
    cloud.post(STATION).mock(side_effect=httpx.ConnectError("down"))
    await reader_report.send_station_heartbeat(app.state, None)
    assert _row(app)["reported_at"] is None


# ── sounds through the edge ─────────────────────────────────────────

def _multipart(serial="browser-serial"):
    boundary = "XyZ123"
    parts = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.mp3\"\r\n"
        f"Content-Type: audio/mpeg\r\n\r\n").encode() + b"ID3\x00\x01--binary\r\n" + (
        f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"serial\"\r\n\r\n"
        f"{serial}\r\n--{boundary}--\r\n").encode()
    return parts, f"multipart/form-data; boundary={boundary}"


def _fields(content: bytes, ctype: str) -> dict:
    from email.parser import BytesParser
    msg = BytesParser().parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + content)
    out = {}
    for part in msg.get_payload():
        out[part.get_param("name", header="content-disposition")] = part.get_payload(decode=True)
    return out


async def test_sound_upload_rewrites_the_serial_to_the_edge(app, client, cloud):
    _online_as(app)
    route = cloud.post("/kiosk/sounds").respond(201, json={"id": "s-1"})
    body, ctype = _multipart()
    r = await client.post("/kiosk/sounds", content=body,
                          headers={**make_session(app), "content-type": ctype})
    assert r.status_code == 201
    req = route.calls[-1].request
    assert req.headers["authorization"] == "Bearer a1"
    fields = _fields(req.content, req.headers["content-type"])
    assert fields["serial"].decode() == app.state.identity.serial
    assert fields["file"] == b"ID3\x00\x01--binary\r\n"


def test_multipart_serial_added_when_missing():
    from edge.routes.proxy import rewrite_multipart_serial
    boundary = "B"
    body = (b"--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a\"\r\n"
            b"Content-Type: audio/wav\r\n\r\nRIFF\r\n--B--\r\n")
    out = rewrite_multipart_serial(body, f"multipart/form-data; boundary={boundary}", "edge-1")
    fields = _fields(out, "multipart/form-data; boundary=B")
    assert fields["serial"] == b"edge-1" and fields["file"] == b"RIFF"


async def test_sound_download_uses_the_station_key_without_a_cloud_session(app, client, cloud):
    station_key.store_key(app.state.store, app.state.keys, "the-key")
    route = cloud.get(url__regex=r".*/kiosk/sounds/s-1.*").respond(
        200, content=b"RIFF", headers={"content-type": "audio/wav"})
    r = await client.get("/kiosk/sounds/s-1", headers=make_session(app, offline=True))
    assert r.status_code == 200 and r.content == b"RIFF"
    req = route.calls[-1].request
    assert req.headers["authorization"] == "Station the-key"
    assert req.url.params["serial"] == app.state.identity.serial


async def test_sound_routes_without_cloud_session_or_key_are_refused(app, client, cloud):
    r = await client.get("/kiosk/sounds/s-1", headers=make_session(app, offline=True))
    assert r.status_code == 503


@pytest.mark.parametrize("path", ["/kiosk/soundsx", "/kiosk/sounds-other/1"])
async def test_only_sound_routes_take_the_station_key(app, client, cloud, path):
    station_key.store_key(app.state.store, app.state.keys, "the-key")
    route = cloud.route(url__regex=r".*/kiosk/sound.*").respond(200, json={})
    r = await client.get(path, headers=make_session(app, offline=True))
    assert r.status_code == 503 and not route.called


async def test_sound_upload_never_uses_the_station_key(app, client, cloud):
    """Uploads go only as the person: with no usable cloud session they
    answer 503 here, the station key is never sent, and it survives."""
    station_key.store_key(app.state.store, app.state.keys, "the-key")
    route = cloud.post("/kiosk/sounds").respond(401, json={"detail": {"code": "x"}})
    body, ctype = _multipart()
    r = await client.post("/kiosk/sounds", content=body,
                          headers={**make_session(app, offline=True), "content-type": ctype})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"
    assert not route.called
    assert station_key.has_key(app.state.store)


async def test_refused_cloud_session_never_falls_back_to_the_station_key(app, client, cloud):
    station_key.store_key(app.state.store, app.state.keys, "the-key")
    _online_as(app)
    up = cloud.post("/kiosk/sounds").respond(401, json={"detail": {"code": "token_expired"}})
    down = cloud.get(url__regex=r".*/kiosk/sounds/s-1.*").respond(
        401, json={"detail": {"code": "token_expired"}})
    cloud.post("/auth/refresh").respond(401, json={"detail": {"code": "refresh_invalid"}})
    body, ctype = _multipart()
    r = await client.post("/kiosk/sounds", content=body,
                          headers={**make_session(app), "content-type": ctype})
    assert r.status_code == 503
    _online_as(app)
    r = await client.get("/kiosk/sounds/s-1", headers=make_session(app))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "cloud_sign_in_required"
    for call in [*up.calls, *down.calls]:
        assert not call.request.headers["authorization"].startswith("Station")
    assert station_key.has_key(app.state.store)


async def test_config_reply_error_never_breaks_the_browser_heartbeat(app, client, cloud,
                                                                     monkeypatch):
    await _seed(app, client)
    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "label")

    def boom(*a, **kw):
        raise RuntimeError("bad reply")

    monkeypatch.setattr(config_sync, "handle_reply", boom)
    _online_as(app)
    cloud.post(HEARTBEAT).respond(200, json=_beat_reply(clear_setup="c-1"))
    r = await client.post(HEARTBEAT, headers=make_session(app),
                          json={"serial": "browser", "name": "B", "mode": "web"})
    assert r.status_code == 200
    assert laptop_setup.load(app.state.store) is None      # Clear Setup still applied
