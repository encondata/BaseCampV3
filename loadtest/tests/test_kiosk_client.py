import uuid
from datetime import UTC, datetime

from loadtest.client.kiosk import ScanOut
from loadtest.http import CallFailed

PASSWORD = "move-pass-1"


def make_scan(clock, move_id, site_id, value, status, scan_type="rfid") -> ScanOut:
    return ScanOut(client_scan_id=uuid.uuid4(), scanned_value=value, scan_type=scan_type,
                   scanned_at=datetime.fromtimestamp(clock.now(), UTC), scan_status=status,
                   site_id=site_id, initiative_id=move_id)


async def ready(fake, clock, d, *, status="pre_stage", servers=5, containers=2, trucks=1,
                site="origin"):
    move_id = fake.add_move(servers=servers, containers=containers, trucks=trucks)
    site_id = fake.moves[move_id][f"{site}_site_id"]
    await clock.run(d.sign_in(PASSWORD))
    await clock.run(d.setup(initiative_id=move_id, site_id=site_id, scan_status=status))
    return move_id, site_id


def assets_of(fake, move_id):
    return [a for a in fake.assets.values() if a["initiative_id"] == move_id]


def count(fake, method, path):
    return sum(1 for r in fake.requests if r == (method, path))


# ── sign-in and setup ─────────────────────────────────────────────────


async def test_handheld_sign_in_and_setup(fake, clock, device):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d)
    row = fake.devices["LOADTEST-ENROLL-1"]
    assert row["mode"] == "web"
    assert row["current_initiative_id"] == move_id
    assert row["site_id"] == fake.moves[move_id]["origin_site_id"] == site_id
    assert row["scan_status"] == "pre_stage"
    assert row["session_login_method"] == "password"
    assert row["raw_info"] == {"loadtest": True} and row["version"] == "loadtest"
    assert row["station_type"] is None and row["station_key_hash"] is None
    assert (d.initiative_id, d.site_id, d.scan_status) == (move_id, site_id, "pre_stage")
    assert fake.requests[:3] == [("POST", "/kiosk/move-login"), ("POST", "/kiosk/heartbeat"),
                                 ("POST", "/kiosk/setup")]


async def test_rfid_station_setup_holds_key_and_uploads_with_it(fake, clock, device, metrics):
    d = device("rfid_station", n=2)
    move_id, site_id = await ready(fake, clock, d, status="rfid_1_cage_exit")
    row = fake.devices["LOADTEST-RFID-2"]
    assert row["mode"] == "laptop" and row["sub_type"] == "laptop"
    assert row["station_type"] == "rfid"
    assert (row["rfid_reader_ip"], row["rfid_reader_serial"], row["rfid_reader_model"],
            row["rfid_reader_versions"]) == ("10.254.0.2", "LOADTEST-READER-2", "FX9600", {})
    assert row["station_key_hash"] and d.has_key
    assert ("POST", "/kiosk/station-key") in fake.requests

    tag = "E28011700000020F1A2B3C4D"
    sent = await clock.run(d.send_scans([make_scan(clock, move_id, site_id, tag,
                                                   "rfid_1_cage_exit")]))
    assert sent == 1
    assert [s for m, p, s in fake.auth_schemes if p == "/kiosk/station/scans"] == ["Station"]
    assert ("POST", "/kiosk/scans") not in fake.requests
    assert fake.raw_scans[-1]["status"] == "rfid_1_cage_exit"
    assert metrics.calls()["station-scans"]["count"] == 1


async def test_label_station_scans_land_as_labeled(fake, clock, device):
    d = device("label_station")
    move_id, site_id = await ready(fake, clock, d, status="labeled")
    serial = assets_of(fake, move_id)[0]["serial_number"]
    scan = make_scan(clock, move_id, site_id, serial, "rfid_2_loading_dock", "barcode")
    assert await clock.run(d.send_scans([scan])) == 1
    raw = fake.raw_scans[-1]
    assert (raw["status"], raw["scan_status"], raw["scan_type"]) == ("labeled", "labeled",
                                                                     "barcode")
    assert raw["client_scan_id"] == str(scan.client_scan_id)


async def test_label_station_heartbeat_sends_nothing_rfid_station_uses_key(fake, clock, device,
                                                                          metrics):
    label, rfid = device("label_station"), device("rfid_station")
    move_id, site_id = await ready(fake, clock, label, status="labeled")
    await clock.run(rfid.sign_in(PASSWORD))
    await clock.run(rfid.setup(initiative_id=move_id, site_id=site_id,
                               scan_status="rfid_1_cage_exit"))
    before = len(fake.requests)
    await clock.run(label.heartbeat())
    assert len(fake.requests) == before
    await clock.run(rfid.heartbeat())
    assert fake.auth_schemes[-1] == ("POST", "/kiosk/station/heartbeat", "Station")
    assert metrics.calls()["station-heartbeat"]["failures"] == 0


async def test_handheld_heartbeat_is_not_a_sign_in(fake, clock, device, metrics):
    d = device("handheld")
    await ready(fake, clock, d)
    fake.devices[d.serial]["session_login_method"] = "marker"
    await clock.run(d.heartbeat())
    assert fake.requests[-1] == ("POST", "/kiosk/heartbeat")
    assert fake.devices[d.serial]["session_login_method"] == "marker"
    assert metrics.calls()["heartbeat"]["failures"] == 0


# ── scan-bearing calls ────────────────────────────────────────────────


async def test_enroll_writes_tag_and_one_raw_scan(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d)
    asset = assets_of(fake, move_id)[0]
    tag = "E28011700000020F1A2B3C4D"
    scan = make_scan(clock, move_id, site_id, tag, "pre_stage")
    assert await clock.run(d.enroll(asset_id=asset["id"], tag=tag, scan=scan)) is True
    assert asset["rfid_tag"] == tag
    rows = [r for r in fake.raw_scans if r["client_scan_id"] == str(scan.client_scan_id)]
    assert len(rows) == 1 and rows[0]["status"] == "pre_stage"
    assert metrics.calls()["enroll"]["count"] == 1


async def test_enroll_rfid_in_use_returns_false(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d)
    a, b = assets_of(fake, move_id)[:2]
    tag = "E28011700000020F1A2B3C4D"
    assert await clock.run(d.enroll(asset_id=a["id"], tag=tag,
                                    scan=make_scan(clock, move_id, site_id, tag, "pre_stage")))
    assert not await clock.run(d.enroll(asset_id=b["id"], tag=tag,
                                        scan=make_scan(clock, move_id, site_id, tag,
                                                       "pre_stage")))
    assert metrics.calls()["enroll"]["failures"] == 1


async def test_send_scans_splits_by_route_limit(fake, clock, device):
    hand, station = device("handheld"), device("rfid_station")
    move_id, site_id = await ready(fake, clock, hand, status="qa", servers=1)
    await clock.run(station.sign_in(PASSWORD))
    await clock.run(station.setup(initiative_id=move_id, site_id=site_id,
                                  scan_status="rfid_1_cage_exit"))
    barcodes = [make_scan(clock, move_id, site_id, f"SN{i}", "qa", "barcode") for i in range(120)]
    assert await clock.run(hand.send_scans(barcodes)) == 120
    assert count(fake, "POST", "/kiosk/scans") == 2
    tags = [make_scan(clock, move_id, site_id, f"{i:024d}", "rfid_1_cage_exit")
            for i in range(120)]
    assert await clock.run(station.send_scans(tags)) == 120
    assert count(fake, "POST", "/kiosk/station/scans") == 3


async def test_rejected_row_lowers_count(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    good = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    bad = make_scan(clock, move_id, site_id, "SN2", "no_such_status", "barcode")
    assert await clock.run(d.send_scans([good, bad])) == 1
    assert metrics.counters()["scans_rejected"] == 1
    assert [r["client_scan_id"] for r in fake.raw_scans] == [str(good.client_scan_id)]


async def test_pack_unpack_load_unload_change_membership(fake, clock, device):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="in_container")
    asset = assets_of(fake, move_id)[0]
    crate = next(c for c in fake.containers.values() if c["initiative_id"] == move_id)
    truck = next(t for t in fake.trucks.values() if t["initiative_id"] == move_id)

    def s(value, status):
        return make_scan(clock, move_id, site_id, value, status, "barcode")

    assert await clock.run(d.pack(container_id=crate["id"], asset_id=asset["id"],
                                  scan=s(asset["serial_number"], "in_container")))
    assert fake.container_of[asset["id"]] == crate["id"]
    assert await clock.run(d.load(truck_id=truck["id"], container_id=crate["id"],
                                  scan=s(crate["name"], "on_truck")))
    assert fake.truck_of[crate["id"]] == truck["id"]
    assert await clock.run(d.unload(truck_id=truck["id"], container_id=crate["id"],
                                    scan=s(crate["name"], "received")))
    assert crate["id"] not in fake.truck_of
    assert await clock.run(d.unpack(container_id=crate["id"], asset_id=asset["id"],
                                    scan=s(asset["serial_number"], "un_pack")))
    assert asset["id"] not in fake.container_of
    assert len(fake.raw_scans) == 4


async def test_repeated_unpack_without_retry_is_a_failure(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="un_pack")
    asset = assets_of(fake, move_id)[0]
    crate = next(c for c in fake.containers.values() if c["initiative_id"] == move_id)
    scan = make_scan(clock, move_id, site_id, asset["serial_number"], "un_pack", "barcode")
    assert not await clock.run(d.unpack(container_id=crate["id"], asset_id=asset["id"],
                                        scan=scan))
    assert metrics.calls()["unpack"]["failures"] == 1


async def test_unpack_lost_answer_counts_as_done(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="un_pack")
    asset = assets_of(fake, move_id)[0]
    crate = next(c for c in fake.containers.values() if c["initiative_id"] == move_id)
    fake.container_of[asset["id"]] = crate["id"]
    fake.fail("POST", r"/kiosk/containers/.*/assets", after_effect=True)
    scan = make_scan(clock, move_id, site_id, asset["serial_number"], "un_pack", "barcode")
    assert await clock.run(d.unpack(container_id=crate["id"], asset_id=asset["id"],
                                    scan=scan)) is True
    assert asset["id"] not in fake.container_of
    assert count(fake, "POST", f"/kiosk/containers/{crate['id']}/assets") == 2
    row = metrics.calls()["unpack"]
    assert (row["count"], row["retries"], row["failures"]) == (1, 1, 0)
    assert metrics.counters()["scans_retried"] == 1
    assert d.retried_scan_ids == {scan.client_scan_id}
    assert sum(r["client_scan_id"] == str(scan.client_scan_id) for r in fake.raw_scans) == 1


async def test_unload_lost_answer_counts_as_done(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="received", site="destination")
    crate = next(c for c in fake.containers.values() if c["initiative_id"] == move_id)
    truck = next(t for t in fake.trucks.values() if t["initiative_id"] == move_id)
    fake.truck_of[crate["id"]] = truck["id"]
    fake.fail("POST", r"/kiosk/trucks/.*/containers", after_effect=True)
    scan = make_scan(clock, move_id, site_id, crate["name"], "received", "barcode")
    assert await clock.run(d.unload(truck_id=truck["id"], container_id=crate["id"],
                                    scan=scan)) is True
    assert crate["id"] not in fake.truck_of
    assert metrics.calls()["unload"]["failures"] == 0
    assert d.retried_scan_ids == {scan.client_scan_id}


async def test_failed_call_returns_false_and_notes_retried_scans(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    fake.fail("POST", r"/kiosk/scans", times=3)
    scans = [make_scan(clock, move_id, site_id, f"SN{i}", "qa", "barcode") for i in range(2)]
    assert await clock.run(d.send_scans(scans)) == 0
    assert metrics.calls()["scans"]["failures"] == 1
    assert metrics.counters()["scans_retried"] == 2
    assert d.retried_scan_ids == {s.client_scan_id for s in scans}


# ── tokens (Review Focus 3) ───────────────────────────────────────────


async def test_stale_token_refreshes_once(fake, clock, device, metrics):
    fake.token_seconds = 900
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    await clock.run(clock.sleep(20 * 60))
    scan = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 1
    assert count(fake, "POST", "/auth/refresh") == 1
    assert count(fake, "POST", "/kiosk/move-login") == 1
    assert metrics.calls()["refresh"]["failures"] == 0


async def test_server_401_refreshes_and_redoes_once(fake, clock, device):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    fake._access.clear()                     # the server forgot every access token
    scan = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 1
    assert count(fake, "POST", "/auth/refresh") == 1
    assert count(fake, "POST", "/kiosk/scans") == 2


async def test_ended_sign_in_signs_in_again(fake, clock, device):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    await clock.run(clock.sleep(25 * 3600))
    scan = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 1
    assert count(fake, "POST", "/kiosk/move-login") == 2
    assert count(fake, "POST", "/auth/refresh") == 0
    beats = [i for i, r in enumerate(fake.requests) if r == ("POST", "/kiosk/heartbeat")]
    assert len(beats) == 2                   # the second sign-in sent its own beat


async def test_lost_refresh_answer_is_never_replayed(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    await clock.run(clock.sleep(20 * 60))
    fake.fail("POST", r"/auth/refresh", after_effect=True)
    scan = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 1
    assert count(fake, "POST", "/auth/refresh") == 1
    assert count(fake, "POST", "/kiosk/move-login") == 2
    assert metrics.calls()["refresh"]["failures"] == 1
    assert metrics.calls()["scans"]["failures"] == 0
    # the old cookie was never replayed, so no sign-in was revoked
    assert not any(r.family.revoked for r in fake._refresh.values())


async def test_cookie_replay_revokes_sign_in(fake, clock, device):
    """The fake's own rule the client must avoid: an old refresh cookie ends the sign-in."""
    d = device("handheld")
    await ready(fake, clock, d)
    old = d._client.cookies.get("ss_refresh")
    first = await clock.run(d._client.post("/auth/refresh", params={"client": "kiosk"}))
    assert first.status_code == 200
    d._client.cookies.set("ss_refresh", old, domain="fake.test", path="/auth")
    replay = await clock.run(d._client.post("/auth/refresh", params={"client": "kiosk"}))
    assert replay.status_code == 401
    assert replay.json()["detail"]["code"] == "session_reuse_detected"


# ── sync and heartbeat ────────────────────────────────────────────────


async def test_sync_makes_the_run_sync_calls(fake, clock, device):
    d = device("handheld")
    move_id, _ = await ready(fake, clock, d, servers=3, containers=2, trucks=1)
    before = len(fake.requests)
    data = await clock.run(d.sync(move_id))
    assert set(fake.requests[before:]) == {
        ("GET", "/kiosk/sync/assets"), ("GET", "/kiosk/sync/people"),
        ("GET", "/kiosk/sync/containers"), ("GET", "/kiosk/sync/trucks"),
        ("GET", "/kiosk/sync/label-templates"),
    }
    assert (len(data.assets), len(data.containers), len(data.trucks)) == (3, 2, 1)
    assert {"id", "serial_number", "rfid", "container_id"} <= set(data.assets[0])


async def test_heartbeat_while_down_returns_and_records_failure(fake, clock, device, metrics):
    d = device("handheld")
    await ready(fake, clock, d)
    fake.down(True)
    await clock.run(d.heartbeat())
    fake.down(False)
    row = metrics.calls()["heartbeat"]
    assert row["failures"] == 1
    assert metrics.failed_calls() == 0       # background: not part of the verdict


# ── secrets ───────────────────────────────────────────────────────────


async def test_repr_hides_secrets(fake, clock, device):
    d = device("rfid_station")
    await ready(fake, clock, d, status="rfid_1_cage_exit")
    text = repr(d)
    assert d._token and d._key
    for secret in (d._token, d._key, PASSWORD, d._client.cookies.get("ss_refresh")):
        assert secret not in text
    assert d.serial in text


async def test_down_server_failure_text_has_no_secrets(fake, clock, device):
    d = device("handheld")
    await ready(fake, clock, d, status="qa")
    fake.down(True)
    try:
        await clock.run(d._bearer_call("POST", "/kiosk/scans", name="scans", json={}))
    except CallFailed as exc:
        assert d._token not in str(exc) and PASSWORD not in str(exc)
        assert d._token not in repr(exc.args)
    else:
        raise AssertionError("expected CallFailed")
