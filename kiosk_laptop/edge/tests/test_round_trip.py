"""The whole offline round trip, as the kiosk drives it: an offline sign-in
keeps working after the internet returns (never 401, so the kiosk does not
sign the person out), and their queued work goes up as them once they sign
in online again."""

import json

import httpx
from tests.conftest import session_out

from edge import outbox

LOGIN = {"email": "jane@example.com", "password": "CorrectHorse9!"}
ASSETS = "/kiosk/sync/assets?initiative_id=m-1"
DOWN = httpx.ConnectError("down")


def _scan(n: int) -> dict:
    return {"client_scan_id": f"00000000-0000-4000-8000-{n:012d}", "scanned_value": f"A{n}",
            "scan_type": "barcode", "scanned_at": "2026-10-01T12:00:00Z"}


def _cloud_up(cloud, access_token: str, refresh: str) -> None:
    cloud.get("/system/status").respond(200, json={})
    cloud.post("/auth/login").respond(
        200, json=session_out(access_token=access_token),
        headers={"set-cookie": f"ss_refresh={refresh}; HttpOnly; Path=/auth"})
    cloud.post("/auth/logout").respond(204)
    cloud.get(ASSETS).respond(200, json={"assets": ["a-1"]})
    cloud.post("/kiosk/heartbeat").respond(200, json={"registration": "ok"})


def _cloud_down(cloud) -> None:
    # same patterns as _cloud_up, so respx replaces those routes' answers
    cloud.get("/system/status").mock(side_effect=DOWN)
    cloud.post("/auth/login").mock(side_effect=DOWN)
    cloud.post("/auth/logout").mock(side_effect=DOWN)
    cloud.get(ASSETS).mock(side_effect=DOWN)
    cloud.post("/kiosk/heartbeat").mock(side_effect=DOWN)


def _auth(resp: httpx.Response) -> dict:
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def test_offline_sign_in_survives_reconnect_and_drains_as_its_owner(app, client, cloud):
    st = app.state

    # 1. Online sign-in (caches the verifier and a sync read), then sign out.
    _cloud_up(cloud, access_token="cloud-a1", refresh="cloud-r1")
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 200
    assert (await client.get(ASSETS, headers=_auth(r))).status_code == 200
    assert (await client.post("/auth/logout")).status_code == 204
    await st.outbox.drain_once()                    # nothing queued: the cloud session ends
    assert st.upstream.has_session("p-1") is False

    # 2. Cloud down: offline sign-in works, a scan queues, the heartbeat is edge_offline.
    _cloud_down(cloud)
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 200
    hdrs = _auth(r)
    r = await client.post("/kiosk/scans", json={"serial": "x", "scans": [_scan(1)]}, headers=hdrs)
    assert r.status_code == 200 and r.json()["accepted"] == [_scan(1)["client_scan_id"]]
    r = await client.post("/kiosk/heartbeat", json={"serial": "x"}, headers=hdrs)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"

    # 3. Cloud back: the offline session keeps working — no 401 anywhere.
    _cloud_up(cloud, access_token="cloud-a2", refresh="cloud-r2")
    assert await st.upstream.probe() is True
    r = await client.post("/kiosk/heartbeat", json={"serial": "x"}, headers=hdrs)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"
    r = await client.get(ASSETS, headers=hdrs)
    assert r.status_code == 200 and r.headers["x-edge-cache"] == "hit"
    assert r.json() == {"assets": ["a-1"]}
    r = await client.post("/kiosk/scans", json={"serial": "x", "scans": [_scan(2)]}, headers=hdrs)
    assert r.status_code == 200
    r = await client.post("/kiosk/assets/a-1/rfid", json={"rfid_tag": "E2"}, headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "cloud_sign_in_required"
    await st.outbox.drain_once()
    assert outbox.counts(st.store)["needs_sign_in"] == 2

    # 4. Signing in online again releases the queue, and it drains as that person.
    scans = cloud.post("/kiosk/scans").mock(side_effect=lambda req: httpx.Response(
        200, json={"accepted": [s["client_scan_id"] for s in json.loads(req.content)["scans"]],
                   "rejected": []}))
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 200
    assert outbox.counts(st.store)["queued"] == 2
    assert await st.outbox.drain_once() == 2
    assert scans.call_count == 1
    sent = scans.calls[0].request
    assert sent.headers["authorization"] == "Bearer cloud-a2"
    assert [s["client_scan_id"] for s in json.loads(sent.content)["scans"]] == \
        [_scan(1)["client_scan_id"], _scan(2)["client_scan_id"]]
    assert outbox.counts(st.store)["sent"] == 2
