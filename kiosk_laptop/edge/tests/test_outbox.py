import json
from datetime import UTC, datetime, timedelta

import httpx

from edge import outbox
from edge.db import iso
from tests.conftest import make_session


def _scan(n):
    return {"client_scan_id": f"00000000-0000-4000-8000-{n:012d}", "scanned_value": f"A{n}",
            "scan_type": "barcode", "scanned_at": "2026-10-01T12:00:00Z"}


async def test_scans_route_accepts_and_queues(app, client):
    hdrs = make_session(app)
    body = {"serial": "browser-serial", "scans": [_scan(1), _scan(2)]}
    r = await client.post("/kiosk/scans", json=body, headers=hdrs)
    assert r.status_code == 200
    assert r.json() == {"accepted": [_scan(1)["client_scan_id"], _scan(2)["client_scan_id"]],
                        "rejected": []}
    assert outbox.counts(app.state.store)["queued"] == 2
    # the same scan twice is still one row (idempotent on client_scan_id)
    await client.post("/kiosk/scans", json=body, headers=hdrs)
    assert outbox.counts(app.state.store)["queued"] == 2


async def test_scans_route_needs_a_session(client):
    r = await client.post("/kiosk/scans", json={"serial": "s", "scans": [_scan(1)]})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "not_authenticated"


async def test_printer_event_queued(app, client):
    r = await client.post("/kiosk/printer-events", json={"serial": "s", "event": "printed"},
                          headers=make_session(app))
    assert r.status_code == 204
    assert outbox.counts(app.state.store)["queued"] == 1


async def test_drain_sends_as_owner_with_edge_serial_in_batches(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(i) for i in range(150)])
    route = cloud.post("/kiosk/scans").mock(side_effect=lambda req: httpx.Response(
        200, json={"accepted": [s["client_scan_id"] for s in json.loads(req.content)["scans"]],
                   "rejected": []}))
    sent = await app.state.outbox.drain_once()
    assert sent == 150
    assert [len(json.loads(c.request.content)["scans"]) for c in route.calls] == [100, 50]
    first = json.loads(route.calls[0].request.content)
    assert first["serial"] == app.state.identity.serial
    assert route.calls[0].request.headers["authorization"] == "Bearer a1"
    assert outbox.counts(store)["sent"] == 150


async def test_rejected_codes_are_kept_not_retried(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1), _scan(2)])
    cloud.post("/kiosk/scans").respond(200, json={
        "accepted": [_scan(1)["client_scan_id"]],
        "rejected": [{"client_scan_id": _scan(2)["client_scan_id"], "code": "move_locked"}]})
    await app.state.outbox.drain_once()
    c = outbox.counts(store)
    assert c["sent"] == 1 and c["rejected"] == 1
    row = store.one("SELECT last_error FROM outbox WHERE status='rejected'")
    assert row["last_error"] == "move_locked"


async def test_offline_leaves_rows_queued_without_spending_attempts(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").mock(side_effect=httpx.ConnectError("down"))
    assert await app.state.outbox.drain_once() == 0
    row = store.one("SELECT status, attempts FROM outbox")
    assert (row["status"], row["attempts"]) == ("queued", 0)


async def test_no_cloud_session_waits_for_sign_in_then_releases(app, cloud):
    store = app.state.store
    outbox.enqueue_scans(store, "p-2", "Sam Lee", [_scan(1), _scan(2)])
    await app.state.outbox.drain_once()
    assert outbox.counts(store)["needs_sign_in"] == 2
    assert outbox.waiting(store) == [{"person_name": "Sam Lee", "count": 2}]
    assert outbox.release_waiting(store, "p-2") == 2
    assert outbox.counts(store)["queued"] == 2


def _due_in_s(row) -> float:
    return (datetime.fromisoformat(row["next_attempt_at"]) - datetime.now(UTC)).total_seconds()


async def test_transient_answers_back_off_then_keep_retrying_forever(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    for status in (500, 408, 423, 429):
        store.run("UPDATE outbox SET status='queued', attempts=0, "
                  "next_attempt_at='2000-01-01T00:00:00+00:00'")
        cloud.post("/kiosk/scans").respond(status)
        await app.state.outbox.drain_once()
        row = store.one("SELECT status, attempts, next_attempt_at FROM outbox")
        assert row["status"] == "queued" and row["attempts"] == 1, status
        # far past the ladder: still queued, retried every last step
        store.run("UPDATE outbox SET attempts = ?, next_attempt_at = '2000-01-01T00:00:00+00:00'",
                  (len(outbox.BACKOFF_S) + 20,))
        await app.state.outbox.drain_once()
        row = store.one("SELECT status, next_attempt_at FROM outbox")
        assert row["status"] == "queued", status
        assert 880 < _due_in_s(row) <= outbox.BACKOFF_S[-1]
    assert outbox.counts(store)["failed"] == 0


async def test_non_transient_4xx_fails_at_once(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").respond(422, json={"detail": {"code": "validation_error"}})
    await app.state.outbox.drain_once()
    row = store.one("SELECT status, attempts, last_error FROM outbox")
    assert (row["status"], row["last_error"]) == ("failed", "validation_error")
    assert outbox.retry_failed(store) == 1
    assert outbox.counts(store)["queued"] == 1


async def test_malformed_answers_end_failed_after_the_ladder(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").respond(200, content=b"not json")
    store.run("UPDATE outbox SET attempts = ?", (len(outbox.BACKOFF_S),))
    await app.state.outbox.drain_once()
    row = store.one("SELECT status, last_error FROM outbox")
    assert (row["status"], row["last_error"]) == ("failed", "bad_response")


async def test_printer_events_drain_as_owner_with_edge_serial(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_printer_event(store, "p-1", "Jane Doe", {"serial": "browser", "event": "x"})
    outbox.enqueue_printer_event(store, "p-1", "Jane Doe", {"serial": "browser", "event": "y"})
    route = cloud.post("/kiosk/printer-events").respond(204)
    assert await app.state.outbox.drain_once() == 2
    assert route.call_count == 2           # one event per request, in order
    bodies = [json.loads(c.request.content) for c in route.calls]
    assert [b["event"] for b in bodies] == ["x", "y"]
    assert all(b["serial"] == app.state.identity.serial for b in bodies)
    assert route.calls[0].request.headers["authorization"] == "Bearer a1"
    assert outbox.counts(store)["sent"] == 2


async def test_two_peoples_scans_never_share_a_batch(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    up.save_session("p-2", refresh_token="r2", access_token="a2", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1), _scan(2)])
    outbox.enqueue_scans(store, "p-2", "Sam Lee", [_scan(3)])
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(4)])
    route = cloud.post("/kiosk/scans").mock(side_effect=lambda req: httpx.Response(
        200, json={"accepted": [s["client_scan_id"] for s in json.loads(req.content)["scans"]],
                   "rejected": []}))
    assert await app.state.outbox.drain_once() == 4
    batches = [(c.request.headers["authorization"],
                [s["scanned_value"] for s in json.loads(c.request.content)["scans"]])
               for c in route.calls]
    assert batches == [("Bearer a1", ["A1", "A2"]), ("Bearer a2", ["A3"]), ("Bearer a1", ["A4"])]


async def test_unhealthy_cloud_spends_no_attempts(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").respond(503)
    assert await app.state.outbox.drain_once() == 0
    row = store.one("SELECT status, attempts FROM outbox")
    assert (row["status"], row["attempts"]) == ("queued", 0)


async def test_sent_rows_older_than_a_week_are_pruned(app, cloud):
    store = app.state.store
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1), _scan(2), _scan(3)])
    old = iso(datetime.now(UTC) - timedelta(days=8))
    store.run("UPDATE outbox SET status='sent', created_at=? WHERE id IN (1, 2)", (old,))
    store.run("UPDATE outbox SET status='rejected' WHERE id = 2")
    store.run("UPDATE outbox SET status='sent' WHERE id = 3")
    await app.state.outbox.drain_once()
    left = [(r["id"], r["status"]) for r in store.all("SELECT id, status FROM outbox ORDER BY id")]
    assert left == [(2, "rejected"), (3, "sent")]


async def test_requeue_sending_on_startup(app):
    store = app.state.store
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    store.run("UPDATE outbox SET status='sending'")
    outbox.requeue_sending(store)
    assert outbox.counts(store)["queued"] == 1


async def test_ending_session_logged_out_after_its_rows_drain(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    up.mark_ending("p-1")
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").respond(200, json={"accepted": [_scan(1)["client_scan_id"]],
                                                  "rejected": []})
    logout = cloud.post("/auth/logout").respond(204)
    await app.state.outbox.drain_once()
    assert logout.called and up.has_session("p-1") is False


async def test_backoff_keeps_later_batches_behind(app, cloud, monkeypatch):
    monkeypatch.setattr(outbox, "SCAN_BATCH", 2)
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(i) for i in range(4)])
    route = cloud.post("/kiosk/scans").respond(500)
    assert await app.state.outbox.drain_once() == 0
    assert route.call_count == 1
    assert outbox.counts(store)["queued"] == 4


async def test_non_json_200_backs_off_as_bad_response(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").respond(200, content=b"not json")
    await app.state.outbox.drain_once()
    row = store.one("SELECT status, attempts, last_error FROM outbox")
    assert (row["status"], row["attempts"], row["last_error"]) == ("queued", 1, "bad_response")


async def test_unacknowledged_scan_backs_off(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1), _scan(2)])
    cloud.post("/kiosk/scans").respond(200, json={"accepted": [_scan(1)["client_scan_id"]],
                                                  "rejected": []})
    assert await app.state.outbox.drain_once() == 1
    row = store.one("SELECT status, attempts, last_error FROM outbox WHERE status='queued'")
    assert (row["attempts"], row["last_error"]) == (1, "not_acknowledged")
    assert outbox.counts(store)["sent"] == 1


async def test_non_json_body_is_422(app, client):
    r = await client.post("/kiosk/scans", content=b"nope", headers=make_session(app))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_scans"


async def test_no_logout_while_rows_queued_and_offline(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    up.mark_ending("p-1")
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").mock(side_effect=httpx.ConnectError("down"))
    logout = cloud.post("/auth/logout").respond(204)
    await app.state.outbox.drain_once()
    assert not logout.called and "p-1" in up.ending_people()
