"""/edge/dock: what the kiosk's Dock screen polls (dock station spec): the
overview (settings, the open pass, the newest closed passes), a pass's detail
(tags with what packing did, every read) and the settings save. Session-gated
like /edge/rfid; the views take `now` so the open pass's countdown is pinned."""

from edge.dock import state, views
from tests.conftest import make_session
from tests.fake_reader import tag_event
from tests.test_dock_grouper import at, batch, dock, group, passes, post, read, reader_time


def seed_passes(store):
    """One closed pass per status, oldest first (100 s apart): flagged with no
    crate, flagged with two, nothing, would pack (dry run), waiting to send,
    packed, refused."""
    dock(store)
    plan = [
        (False, [("AA01", 0)]),                                   # no_crate
        (False, [("AA01", 0), ("CC01", 0.5), ("CC02", 1)]),       # many_crates
        (False, [("FF99", 0)]),                                   # nothing
        (True, [("AA01", 0), ("CC01", 0.5)]),                     # would_pack
        (False, [("AA01", 0), ("CC01", 0.5)]),                    # waiting
        (False, [("AA02", 0), ("CC02", 0.5)]),                    # packed
        (False, [("AA03", 0), ("CC03", 0.5)]),                    # refused
    ]
    for n, (dry, reads) in enumerate(plan):
        state.save_settings(store, dry_run=dry)
        batch(store, [(epc, 100 * n + s) for epc, s in reads])
        group(store, 100 * n + 20)
    sent, refused = passes(store)[5], passes(store)[6]
    store.run("UPDATE dock_passes SET send_state = 'sent', packed_count = 1, moved_count = 2 "
              "WHERE id = ?", (sent["id"],))
    store.run("UPDATE dock_passes SET send_state = 'refused', refuse_code = 'move_closed', "
              "refused_count = 3 WHERE id = ?", (refused["id"],))
    return passes(store)


def add_closed(store, n):
    for i in range(n):
        store.run("INSERT INTO dock_passes (pass_id, initiative_id, opened_at, last_new_at, "
                  "last_new_received_at, last_received_at, closed_at, outcome, created_at) "
                  "VALUES (?, 'm-1', 'x', 'x', 'x', 'x', 'x', 'nothing', 'x')", (f"p-{i}",))


async def test_routes_need_a_session(app, client):
    assert (await client.get("/edge/dock")).status_code == 401
    assert (await client.get("/edge/dock/passes/1")).status_code == 401
    r = await client.put("/edge/dock/settings", json={"dry_run": False})
    assert r.status_code == 401
    assert state.settings(app.state.store) == state.DEFAULTS   # nothing was saved


async def test_routes_work_offline(app, client):
    h = make_session(app, offline=True)
    assert (await client.get("/edge/dock", headers=h)).status_code == 200
    r = await client.put("/edge/dock/settings", json={"quiet_gap_s": 9}, headers=h)
    assert r.status_code == 200 and r.json()["quiet_gap_s"] == 9


async def test_overview_with_nothing_yet(app, client):
    r = await client.get("/edge/dock", headers=make_session(app))
    assert r.status_code == 200
    assert r.json() == {"settings": {"dry_run": True, "quiet_gap_s": 5},
                        "open": None, "passes": [], "control": None}


def test_open_pass_counts_down_to_its_close(app):
    store = app.state.store
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1), ("FF99", 1), ("AA02", 1.5)], received=1)
    group(store, 2)
    [p] = passes(store)
    assert p["closed_at"] is None
    body = views.overview(store, at(3))
    assert body["passes"] == [] and body["settings"] == {"dry_run": False, "quiet_gap_s": 5}
    assert body["open"] == {
        "id": p["id"], "opened_at": p["opened_at"], "seconds_left": 8.0, "window_s": 5,
        "crate_count": 1, "asset_count": 2, "conflict": False, "added_count": 2,
        "crates": [{"epc": "CC01", "label": "Crate 1",
                    "first_read_at": "2026-10-16T14:00:01.000+00:00", "conflict": False}],
        "tags": [{"epc": "AA01", "kind": "asset", "label": "Server 1",
                  "first_read_at": "2026-10-16T14:00:00.000+00:00", "serial": "SN1",
                  "in_window": True, "crate_label": "Crate 1"},
                 {"epc": "CC01", "kind": "container", "label": "Crate 1",
                  "first_read_at": "2026-10-16T14:00:01.000+00:00", "serial": None,
                  "in_window": None, "crate_label": None},
                 {"epc": "FF99", "kind": "unknown", "label": None,
                  "first_read_at": "2026-10-16T14:00:01.000+00:00", "serial": None,
                  "in_window": None, "crate_label": None},
                 {"epc": "AA02", "kind": "asset", "label": "SN2",
                  "first_read_at": "2026-10-16T14:00:01.500+00:00", "serial": "SN2",
                  "in_window": True, "crate_label": "Crate 1"}]}
    assert views.overview(store, at(1))["open"]["seconds_left"] == 10.0   # 2W
    assert views.overview(store, at(4.5))["open"]["seconds_left"] == 6.5
    assert views.overview(store, at(11))["open"]["seconds_left"] == 0
    assert views.overview(store, at(500))["open"]["seconds_left"] == 0   # never negative


def test_seconds_left_follows_the_window_setting(app):
    store = app.state.store
    dock(store)
    read(store, "AA01", 0)
    group(store, 1)
    state.save_settings(store, quiet_gap_s=20)
    assert views.overview(store, at(5))["open"]["seconds_left"] == 35.0


def test_open_pass_counts_distinct_crates_and_assets(app):
    store = app.state.store
    dock(store)
    batch(store, [("CC01", 0), ("CC02", 0.2), ("AA01", 0.4)])
    group(store, 1)
    assert views.overview(store, at(2))["open"]["crate_count"] == 2
    assert views.overview(store, at(2))["open"]["asset_count"] == 1


async def test_overview_route_serves_the_open_pass(app, client):
    store = app.state.store
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1)])
    group(store, 2)
    body = (await client.get("/edge/dock", headers=make_session(app))).json()
    assert set(body) == {"settings", "open", "passes", "control"} and body["passes"] == []
    assert set(body["open"]) == {"id", "opened_at", "seconds_left", "window_s", "crate_count",
                                 "asset_count", "crates", "conflict", "added_count", "tags"}
    assert all(set(t) == {"epc", "kind", "label", "first_read_at", "serial", "in_window",
                          "crate_label"} for t in body["open"]["tags"])
    assert [set(c) for c in body["open"]["crates"]] == [
        {"epc", "label", "first_read_at", "conflict"}]
    assert body["open"]["seconds_left"] == 0   # the pass is long past on the real clock
    assert body["open"]["crate_count"] == 1 and body["open"]["asset_count"] == 1


def test_one_closed_pass_per_status(app):
    store = app.state.store
    rows = seed_passes(store)
    body = views.overview(store, at(1000))
    assert body["open"] is None
    assert [p["id"] for p in body["passes"]] == [r["id"] for r in reversed(rows)]   # newest first
    got = {p["status"]: p for p in body["passes"]}
    assert [p["status"] for p in body["passes"]] == [
        "refused", "packed", "waiting", "would_pack", "nothing", "flagged", "flagged"]
    keys = {"id", "opened_at", "closed_at", "status", "flag", "dry_run", "container_name",
            "asset_count", "moved_count", "refused_count", "refuse_code"}
    assert all(set(p) == keys for p in body["passes"])

    flagged = [p for p in body["passes"] if p["status"] == "flagged"]
    assert [(p["flag"], p["container_name"], p["asset_count"]) for p in flagged] == [
        ("many_crates", None, 1), ("no_crate", None, 1)]
    assert got["nothing"]["flag"] is None and got["nothing"]["asset_count"] == 0
    assert got["would_pack"] == {
        "id": rows[3]["id"], "opened_at": rows[3]["opened_at"], "closed_at": rows[3]["closed_at"],
        "status": "would_pack", "flag": None, "dry_run": True, "container_name": "Crate 1",
        "asset_count": 1, "moved_count": 0, "refused_count": 0, "refuse_code": None}
    assert got["waiting"]["dry_run"] is False and got["waiting"]["container_name"] == "Crate 1"
    assert got["packed"]["container_name"] == "Crate 2" and got["packed"]["moved_count"] == 2
    assert got["refused"]["refuse_code"] == "move_closed" and got["refused"]["refused_count"] == 3
    assert got["refused"]["container_name"] == "Crate 3"
    assert got["packed"]["closed_at"] == rows[5]["closed_at"]


def test_a_dry_run_pass_is_would_pack_whatever_its_send_state(app):
    store = app.state.store
    rows = seed_passes(store)
    store.run("UPDATE dock_passes SET send_state = 'sent' WHERE id = ?", (rows[3]["id"],))
    got = {p["id"]: p["status"] for p in views.overview(store, at(1000))["passes"]}
    assert got[rows[3]["id"]] == "would_pack"


def test_only_the_newest_fifty_closed_passes(app):
    store = app.state.store
    add_closed(store, 55)
    dock(store)
    read(store, "AA01", 10_000)
    group(store, 10_001)   # an open pass on top: not a row in the list
    body = views.overview(store, at(10_002))
    ids = [p["id"] for p in body["passes"]]
    assert ids == list(range(55, 5, -1)) and len(ids) == 50
    assert body["open"]["id"] == 56


async def test_overview_route_lists_closed_passes(app, client):
    seed_passes(app.state.store)
    body = (await client.get("/edge/dock", headers=make_session(app))).json()
    assert body["open"] is None
    assert [p["status"] for p in body["passes"]] == [
        "refused", "packed", "waiting", "would_pack", "nothing", "flagged", "flagged"]


async def test_pass_detail_has_tags_results_and_reads(app, client):
    store = app.state.store
    dock(store)
    first = post(store, [tag_event("AA01", antenna=1, peak_rssi=-52,
                                   timestamp=reader_time(0))], 0)
    second = post(store, [tag_event("AA02", antenna=2, peak_rssi=-60.5,
                                    timestamp=reader_time(0.512))], 1)
    third = post(store, [tag_event("CC01", antenna=3, peak_rssi=-48,
                                   timestamp=reader_time(1.0))], 1)
    again = post(store, [tag_event("AA01", antenna=4, peak_rssi=-70,
                                   timestamp=reader_time(3.0))], 3)
    group(store, 20)
    [p] = passes(store)
    store.run("UPDATE dock_pass_tags SET result = 'packed' WHERE pass_id = ? AND epc = 'AA01'",
              (p["id"],))
    store.run("UPDATE dock_pass_tags SET result = 'moved', moved_from = 'Crate 9' "
              "WHERE pass_id = ? AND epc = 'AA02'", (p["id"],))
    store.run("UPDATE dock_passes SET send_state = 'sent', packed_count = 2, moved_count = 1 "
              "WHERE id = ?", (p["id"],))
    r = await client.get(f"/edge/dock/passes/{p['id']}", headers=make_session(app))
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"pass", "tags", "reads"}
    assert body["pass"] == {
        "id": p["id"], "opened_at": p["opened_at"], "closed_at": p["closed_at"],
        "status": "packed", "flag": None, "dry_run": False, "container_name": "Crate 1",
        "asset_count": 2, "moved_count": 1, "refused_count": 0, "refuse_code": None}
    assert body["tags"] == [
        {"epc": "AA01", "kind": "asset", "label": "Server 1", "result": "packed",
         "moved_from": None, "reason": None},
        {"epc": "AA02", "kind": "asset", "label": "SN2", "result": "moved",
         "moved_from": "Crate 9", "reason": None},
        {"epc": "CC01", "kind": "container", "label": "Crate 1", "result": None,
         "moved_from": None, "reason": None}]
    assert body["reads"] == [
        {"id": first, "read_at": "2026-10-16T14:00:00.000+00:00", "epc": "AA01",
         "kind": "asset", "antenna": 1, "peak_rssi": -52},
        {"id": second, "read_at": "2026-10-16T14:00:00.512+00:00", "epc": "AA02",
         "kind": "asset", "antenna": 2, "peak_rssi": -60.5},
        {"id": third, "read_at": "2026-10-16T14:00:01.000+00:00", "epc": "CC01",
         "kind": "container", "antenna": 3, "peak_rssi": -48},
        {"id": again, "read_at": "2026-10-16T14:00:03.000+00:00", "epc": "AA01",
         "kind": "asset", "antenna": 4, "peak_rssi": -70}]


async def test_pass_detail_carries_a_refused_reason(app, client):
    store = app.state.store
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 0.5)])
    group(store, 20)
    [p] = passes(store)
    store.run("UPDATE dock_pass_tags SET result = 'refused', reason = 'changed_since_pass' "
              "WHERE pass_id = ? AND epc = 'AA01'", (p["id"],))
    store.run("UPDATE dock_passes SET send_state = 'sent', refused_count = 1 WHERE id = ?",
              (p["id"],))
    body = (await client.get(f"/edge/dock/passes/{p['id']}", headers=make_session(app))).json()
    [tag] = [t for t in body["tags"] if t["epc"] == "AA01"]
    assert tag["result"] == "refused" and tag["reason"] == "changed_since_pass"
    assert body["pass"]["refused_count"] == 1


async def test_pass_detail_of_a_flagged_pass(app, client):
    store = app.state.store
    dock(store)
    batch(store, [("AA01", 0), ("AA02", 0.5)])
    group(store, 20)
    [p] = passes(store)
    body = (await client.get(f"/edge/dock/passes/{p['id']}", headers=make_session(app))).json()
    assert body["pass"]["status"] == "flagged" and body["pass"]["flag"] == "no_crate"
    assert [t["epc"] for t in body["tags"]] == ["AA01", "AA02"]
    assert all(t["result"] is None for t in body["tags"]) and len(body["reads"]) == 2


async def test_pass_detail_reads_stay_with_their_pass(app, client):
    store = app.state.store
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 0.5)])
    batch(store, [("AA02", 100), ("CC02", 100.5)])
    group(store, 200)
    one, two = passes(store)
    h = make_session(app)
    first = (await client.get(f"/edge/dock/passes/{one['id']}", headers=h)).json()
    second = (await client.get(f"/edge/dock/passes/{two['id']}", headers=h)).json()
    assert [x["epc"] for x in first["reads"]] == ["AA01", "CC01"]
    assert [x["epc"] for x in second["reads"]] == ["AA02", "CC02"]
    assert [t["epc"] for t in second["tags"]] == ["AA02", "CC02"]


async def test_unknown_pass_is_404(app, client):
    store = app.state.store
    dock(store)
    read(store, "AA01", 0)
    group(store, 1)   # a pass that is still open: it has no detail yet
    [open_pass] = passes(store)
    h = make_session(app)
    for bad in (str(open_pass["id"]), "9999", "0", "-1", "abc", "1.5", "99999999999999999999"):
        r = await client.get(f"/edge/dock/passes/{bad}", headers=h)
        assert r.status_code == 404, bad
        assert r.json()["detail"]["code"] == "pass_not_found", bad


async def test_settings_save_and_overview_follow(app, client):
    h = make_session(app)
    r = await client.put("/edge/dock/settings", json={"quiet_gap_s": 8}, headers=h)
    assert r.status_code == 200 and r.json() == {"dry_run": True, "quiet_gap_s": 8}
    r = await client.put("/edge/dock/settings", json={"dry_run": False}, headers=h)
    assert r.json() == {"dry_run": False, "quiet_gap_s": 8}   # the gap is kept
    r = await client.put("/edge/dock/settings", json={"dry_run": True, "quiet_gap_s": 60},
                         headers=h)
    assert r.json() == {"dry_run": True, "quiet_gap_s": 60}
    r = await client.put("/edge/dock/settings", json={}, headers=h)
    assert r.status_code == 200 and r.json() == {"dry_run": True, "quiet_gap_s": 60}
    assert state.settings(app.state.store) == {"dry_run": True, "quiet_gap_s": 60}
    assert (await client.get("/edge/dock", headers=h)).json()["settings"] == {
        "dry_run": True, "quiet_gap_s": 60}


async def test_bad_settings_are_422_and_save_nothing(app, client):
    h = make_session(app)
    for bad in ({"dry_run": "yes"}, {"dry_run": 1}, {"quiet_gap_s": 0}, {"quiet_gap_s": 61},
                {"quiet_gap_s": "5"}, {"quiet_gap_s": True}, {"quiet_gap_s": 5.5},
                {"dry_run": False, "quiet_gap_s": 99}):
        r = await client.put("/edge/dock/settings", json=bad, headers=h)
        assert r.status_code == 422, bad
        assert r.json()["detail"]["code"] == "invalid_dock_settings", bad
    assert state.settings(app.state.store) == state.DEFAULTS
    r = await client.put("/edge/dock/settings", json=[1], headers=h)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_request"
