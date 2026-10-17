"""The "Asset Not Part Of Move" alarm on the edge: raised from fresh off-move
matches, held in alarm_open, served and dismissed by /edge/rfid/alarm."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from edge.app import create_app
from edge.db import Store, iso
from edge.rfid import alarm, processing
from tests.conftest import make_session
from tests.test_rfid_processing import MOVE, SETUP, read, seed

NOW = datetime(2026, 10, 16, 14, 0, 5, tzinfo=UTC)
FRESH = iso(NOW - timedelta(seconds=5))


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "edge.db")
    yield s
    s.close()


def as_station(store, station_type="rfid"):
    store.run("UPDATE laptop_setup SET setup_json = ? WHERE id = 1",
              (json.dumps({**SETUP, "initiative_id": MOVE, "station_type": station_type}),))


def client_asset(n, **kw):
    item = {"id": f"x-{n}", "asset_id": f"A-{n}", "name": f"Server {n}",
            "rfid": f"EE{n:02d}", "serial_number": f"SN{n}", "make": "Dell",
            "model": "R740", "initiative_id": "m-2", "initiative_name": "Dallas move"}
    item.update(kw)
    return item


def station_seed(store, *client):
    seed(store, client=list(client))
    as_station(store)


def open_rows(store):
    return [dict(r) for r in store.all("SELECT * FROM alarm_open ORDER BY id")]


def alarm_events(store):
    return [dict(r) for r in store.all(
        "SELECT kind, title, detail FROM rfid_events WHERE kind = 'alarm' ORDER BY id")]


def run(store, now=NOW):
    return processing.process(store, now=now)


def test_fresh_off_move_read_raises_alarm(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=FRESH)
    assert run(store).inserted == 1
    rows = open_rows(store)
    assert len(rows) == 1
    row = rows[0]
    assert (row["asset_id"], row["make_model"], row["name"], row["serial"], row["rfid"]) \
        == ("x-1", "Dell R740", "Server 1", "SN1", "EE01")
    assert row["raised_at"] == iso(NOW)
    assert alarm_events(store) == [
        {"kind": "alarm", "title": "Asset Not Part Of Move", "detail": "Server 1"}]


def test_stale_off_move_read_uploads_but_never_alarms(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=iso(NOW - timedelta(seconds=31)))
    assert run(store).inserted == 1
    assert store.one("SELECT off_move FROM pending_rfid_scans")["off_move"] == 1
    assert open_rows(store) == []
    assert store.all("SELECT * FROM alarm_last") == []
    assert alarm_events(store) == []


def test_exactly_thirty_seconds_is_fresh(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=iso(NOW - timedelta(seconds=30)))
    run(store)
    assert len(open_rows(store)) == 1


def test_on_move_asset_never_alarms(store):
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}], client=[client_asset(1, rfid="AA01")])
    as_station(store)
    read(store, "AA01", received_at=FRESH)
    assert run(store).inserted == 1
    assert open_rows(store) == [] and alarm_events(store) == []


def test_not_an_rfid_station_never_alarms(store):
    seed(store, client=[client_asset(1)])
    as_station(store, "label")
    read(store, "EE01", received_at=FRESH)
    assert run(store).inserted == 1
    assert open_rows(store) == [] and store.all("SELECT * FROM alarm_last") == []


def test_recheck_matches_never_alarm(store):
    station_seed(store)
    read(store, "EE01", received_at=FRESH)
    run(store)                                     # unmatched: nothing to alarm yet
    station_seed(store, client_asset(1))
    assert processing.recheck_unmatched(store, now=NOW) == 1
    assert store.one("SELECT off_move FROM pending_rfid_scans")["off_move"] == 1
    assert open_rows(store) == [] and store.all("SELECT * FROM alarm_last") == []
    assert alarm_events(store) == []


def test_repeat_inside_an_hour_is_silent(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=FRESH)
    run(store)
    store.run("DELETE FROM alarm_open")
    later = NOW + timedelta(minutes=59)
    read(store, "EE01", received_at=iso(later))
    assert run(store, later).inserted == 1         # still uploaded
    assert open_rows(store) == []
    assert len(alarm_events(store)) == 1


def test_repeat_after_an_hour_alarms_again(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=FRESH)
    run(store)
    first = open_rows(store)[0]["id"]
    later = NOW + timedelta(hours=1, seconds=1)
    read(store, "EE01", received_at=iso(later))
    run(store, later)
    rows = open_rows(store)
    assert len(rows) == 1                          # one row per asset, refreshed
    assert rows[0]["raised_at"] == iso(later) and rows[0]["id"] > first
    assert store.one("SELECT alarmed_at FROM alarm_last")["alarmed_at"] == iso(later)
    assert len(alarm_events(store)) == 2


def test_reread_inside_the_hour_does_not_extend_the_window(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=FRESH)
    run(store)
    mid = NOW + timedelta(minutes=50)
    read(store, "EE01", received_at=iso(mid))
    run(store, mid)
    assert store.one("SELECT alarmed_at FROM alarm_last")["alarmed_at"] == iso(NOW)
    later = NOW + timedelta(hours=1, seconds=1)    # an hour after the FIRST alarm
    read(store, "EE01", received_at=iso(later))
    run(store, later)
    assert len(alarm_events(store)) == 2


def test_same_asset_twice_in_one_pass_alarms_once(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=FRESH)
    read(store, "EE01", received_at=FRESH)
    assert run(store).inserted == 2
    assert len(open_rows(store)) == 1
    assert len(alarm_events(store)) == 1


def test_two_assets_one_pass_one_event_listing_both(store):
    station_seed(store, client_asset(1), client_asset(2, name=None))
    read(store, "EE01", received_at=FRESH)
    read(store, "EE02", received_at=FRESH)
    run(store)
    assert [r["asset_id"] for r in open_rows(store)] == ["x-1", "x-2"]
    assert alarm_events(store) == [
        {"kind": "alarm", "title": "Asset Not Part Of Move", "detail": "Server 1, SN2"}]


def test_event_detail_caps_at_five_and_n_more(store):
    items = [client_asset(n) for n in range(1, 8)]
    items[2] = client_asset(3, name=None, serial_number=None)   # labeled by RFID
    station_seed(store, *items)
    for n in range(1, 8):
        read(store, f"EE{n:02d}", received_at=FRESH)
    run(store)
    assert len(open_rows(store)) == 7
    assert alarm_events(store)[0]["detail"] == \
        "Server 1, Server 2, EE03, Server 4, Server 5 and 2 more"


def test_record_event_skips_an_empty_raise(store):
    alarm.record_event(store, [])
    assert alarm_events(store) == []


def test_dismiss_up_to_keeps_newer_rows(store):
    station_seed(store, client_asset(1), client_asset(2))
    read(store, "EE01", received_at=FRESH)
    run(store)
    shown = alarm.open_alarm(store, NOW)
    assert shown["latest_id"] == open_rows(store)[0]["id"]
    read(store, "EE02", received_at=FRESH)       # raised after the screen's last poll
    run(store)
    assert alarm.dismiss(store, shown["latest_id"]) == 1
    left = alarm.open_alarm(store, NOW)
    assert [a["name"] for a in left["alarms"]] == ["Server 2"]
    assert left["latest_id"] > shown["latest_id"]


def test_timed_mode_expires_on_the_edge(store):
    alarm.save_settings(store, "timed", 10)
    station_seed(store, client_asset(1), client_asset(2))
    read(store, "EE01", received_at=FRESH)
    run(store)
    t2 = NOW + timedelta(seconds=4)
    read(store, "EE02", received_at=iso(t2))
    run(store, t2)
    out = alarm.open_alarm(store, NOW + timedelta(seconds=12))
    assert out["mode"] == "timed" and out["timed_seconds"] == 10
    assert out["expires_at"] == iso(t2 + timedelta(seconds=10))   # newest raise + 10 s
    assert len(out["alarms"]) == 2
    out = alarm.open_alarm(store, t2 + timedelta(seconds=10))     # at expiry: still up
    assert len(out["alarms"]) == 2
    out = alarm.open_alarm(store, t2 + timedelta(seconds=11))
    assert out["alarms"] == [] and out["latest_id"] is None and out["expires_at"] is None
    assert open_rows(store) == []


def test_until_dismissed_never_expires(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=FRESH)
    run(store)
    out = alarm.open_alarm(store, NOW + timedelta(days=2))
    assert len(out["alarms"]) == 1 and out["expires_at"] is None


# ---------------------------------------------------------------- routes

def _api_seed(app, *client):
    store = app.state.store
    seed(store, client=list(client))
    as_station(store)
    read(store, "EE01", received_at=iso(datetime.now(UTC)))
    processing.process(store)


async def test_alarm_routes(app, client):
    _api_seed(app, client_asset(1))
    h = make_session(app)
    r = await client.get("/edge/rfid/alarm", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"mode", "timed_seconds", "alarms", "latest_id", "expires_at"}
    assert body["mode"] == "until_dismissed" and body["expires_at"] is None
    [one] = body["alarms"]
    assert set(one) == {"id", "make_model", "name", "serial", "rfid", "raised_at"}
    assert one["make_model"] == "Dell R740" and one["id"] == body["latest_id"]
    r = await client.post("/edge/rfid/alarm/dismiss", json={"up_to_id": body["latest_id"]},
                          headers=h)
    assert r.status_code == 200 and r.json() == {"dismissed": 1}
    assert (await client.get("/edge/rfid/alarm", headers=h)).json()["alarms"] == []


async def test_alarm_routes_need_a_session(app, client):
    assert (await client.get("/edge/rfid/alarm")).status_code == 401
    assert (await client.post("/edge/rfid/alarm/dismiss", json={"up_to_id": 1})).status_code \
        == 401
    assert (await client.get("/edge/rfid/alarm/settings")).status_code == 401
    r = await client.put("/edge/rfid/alarm/settings",
                         json={"mode": "timed", "timed_seconds": 5})
    assert r.status_code == 401


async def test_alarm_routes_work_offline(app, client):
    _api_seed(app, client_asset(1))
    h = make_session(app, offline=True)
    body = (await client.get("/edge/rfid/alarm", headers=h)).json()
    r = await client.post("/edge/rfid/alarm/dismiss", json={"up_to_id": body["latest_id"]},
                          headers=h)
    assert r.json() == {"dismissed": 1}


async def test_dismiss_rejects_a_bad_body(app, client):
    h = make_session(app)
    for bad in ({}, {"up_to_id": "3"}, {"up_to_id": True}, [1]):
        r = await client.post("/edge/rfid/alarm/dismiss", json=bad, headers=h)
        assert r.status_code == 422, bad


async def test_settings_defaults_save_and_validation(app, client):
    h = make_session(app)
    r = await client.get("/edge/rfid/alarm/settings", headers=h)
    assert r.status_code == 200
    assert r.json() == {"mode": "until_dismissed", "timed_seconds": 10}
    r = await client.put("/edge/rfid/alarm/settings",
                         json={"mode": "timed", "timed_seconds": 3}, headers=h)
    assert r.status_code == 200 and r.json() == {"mode": "timed", "timed_seconds": 3}
    r = await client.put("/edge/rfid/alarm/settings",
                         json={"mode": "timed", "timed_seconds": 600}, headers=h)
    assert r.status_code == 200
    for bad in ({"mode": "timed", "timed_seconds": 2},
                {"mode": "timed", "timed_seconds": 601},
                {"mode": "forever", "timed_seconds": 10},
                {"mode": "timed", "timed_seconds": "10"},
                {"mode": "timed", "timed_seconds": True},
                {"mode": "timed"}):
        r = await client.put("/edge/rfid/alarm/settings", json=bad, headers=h)
        assert r.status_code == 422, bad
    r = await client.get("/edge/rfid/alarm/settings", headers=h)
    assert r.json() == {"mode": "timed", "timed_seconds": 600}
    assert (await client.get("/edge/rfid/alarm", headers=h)).json()["timed_seconds"] == 600
    with pytest.raises(ValueError):
        alarm.save_settings(app.state.store, "until_dismissed", 2)


async def test_alarm_route_empty_on_label_station(app, client):
    _api_seed(app, client_asset(1))
    store = app.state.store
    store.run("INSERT INTO alarm_open (asset_id, raised_at) VALUES ('x-9', ?)",
              (iso(datetime.now(UTC)),))
    as_station(store, "label")
    body = (await client.get("/edge/rfid/alarm", headers=make_session(app))).json()
    assert body["alarms"] == [] and body["latest_id"] is None and body["expires_at"] is None
    store.run("DELETE FROM laptop_setup")          # no setup at all: also empty
    body = (await client.get("/edge/rfid/alarm", headers=make_session(app))).json()
    assert body["alarms"] == []


def test_unassigned_client_asset_alarms_and_missing_make_model_is_null(store):
    unassigned = client_asset(1, initiative_id=None, initiative_name=None)
    old_portal = {"id": "x-2", "asset_id": "A-2", "name": "Switch", "rfid": "EE02",
                  "serial_number": "SN2", "initiative_id": "m-2",
                  "initiative_name": "Dallas move"}               # no make / model keys
    model_only = client_asset(3, make=None)
    station_seed(store, unassigned, old_portal, model_only)
    for epc in ("EE01", "EE02", "EE03"):
        read(store, epc, received_at=FRESH)
    assert run(store).inserted == 3
    rows = {r["asset_id"]: r for r in open_rows(store)}
    assert rows["x-1"]["make_model"] == "Dell R740"
    assert rows["x-2"]["make_model"] is None and rows["x-2"]["name"] == "Switch"
    assert rows["x-3"]["make_model"] == "R740"
    scan = store.one("SELECT off_move, off_move_initiative_id FROM pending_rfid_scans "
                     "WHERE matched_id = 'x-1'")
    assert scan["off_move"] == 1 and scan["off_move_initiative_id"] is None
    shown = alarm.open_alarm(store, NOW)
    assert [a["make_model"] for a in shown["alarms"]] == ["Dell R740", None, "R740"]


async def test_alarm_state_survives_a_restart(settings, cloud):
    first = create_app(settings)
    _api_seed(first, client_asset(1))
    alarm.save_settings(first.state.store, "timed", 600)
    first.state.store.close()
    again = create_app(settings)
    transport = httpx.ASGITransport(app=again)
    async with httpx.AsyncClient(transport=transport, base_url="http://edge.test") as c:
        body = (await c.get("/edge/rfid/alarm", headers=make_session(again))).json()
        assert body["mode"] == "timed" and body["timed_seconds"] == 600
        assert [a["name"] for a in body["alarms"]] == ["Server 1"]
    assert again.state.store.one("SELECT COUNT(*) AS n FROM alarm_last")["n"] == 1
    again.state.store.close()


async def test_wipe_clears_open_alarms_but_keeps_settings(app, client):
    _api_seed(app, client_asset(1))
    store = app.state.store
    alarm.save_settings(store, "timed", 20)
    store.run("UPDATE pending_rfid_scans SET upload_state = 'accepted'")
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.status_code == 200
    assert open_rows(store) == [] and store.all("SELECT * FROM alarm_last") == []
    assert alarm.settings(store) == {"mode": "timed", "timed_seconds": 20}


# ------------------------------------------------- stale timed rows on raise

def test_timed_raise_drops_rows_already_expired_when_no_screen_polled(store):
    alarm.save_settings(store, "timed", 10)
    station_seed(store, client_asset(1), client_asset(2))
    read(store, "EE01", received_at=FRESH)
    run(store)                                     # raised at NOW, nobody polls
    later = NOW + timedelta(seconds=60)
    read(store, "EE02", received_at=iso(later))
    run(store, later)
    assert [r["name"] for r in open_rows(store)] == ["Server 2"]
    out = alarm.open_alarm(store, later)
    assert [a["name"] for a in out["alarms"]] == ["Server 2"]


def test_timed_raise_keeps_rows_still_inside_the_window(store):
    alarm.save_settings(store, "timed", 10)
    station_seed(store, client_asset(1), client_asset(2))
    read(store, "EE01", received_at=FRESH)
    run(store)
    t2 = NOW + timedelta(seconds=10)               # exactly at expiry: still up
    read(store, "EE02", received_at=iso(t2))
    run(store, t2)
    assert [r["name"] for r in open_rows(store)] == ["Server 1", "Server 2"]


def test_until_dismissed_raise_keeps_old_rows(store):
    station_seed(store, client_asset(1), client_asset(2))
    read(store, "EE01", received_at=FRESH)
    run(store)
    later = NOW + timedelta(minutes=5)
    read(store, "EE02", received_at=iso(later))
    run(store, later)
    assert [r["name"] for r in open_rows(store)] == ["Server 1", "Server 2"]


# ------------------------------------------------- setup move change / clear

def _alarm_state(store):
    return (len(open_rows(store)), len(store.all("SELECT * FROM alarm_last")))


def _raised(store):
    station_seed(store, client_asset(1))
    read(store, "EE01", received_at=FRESH)
    run(store)
    assert _alarm_state(store) == (1, 1)


def test_saving_setup_for_another_move_clears_alarms(store):
    from edge import laptop_setup
    _raised(store)
    laptop_setup.save(store, {**SETUP, "initiative_id": "m-other"}, "label")
    assert _alarm_state(store) == (0, 0)


def test_saving_setup_for_the_same_move_keeps_alarms(store):
    from edge import laptop_setup
    _raised(store)
    laptop_setup.save(store, {**SETUP, "initiative_id": MOVE}, "label")
    assert _alarm_state(store) == (1, 1)


def test_clear_setup_clears_alarms_but_keeps_settings(store):
    from edge.rfid import station_key
    alarm.save_settings(store, "timed", 20)
    _raised(store)
    station_key.apply_clear_setup(store)
    assert _alarm_state(store) == (0, 0)
    assert alarm.settings(store) == {"mode": "timed", "timed_seconds": 20}
