import asyncio
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


async def test_a_resent_unpack_or_unload_can_count_as_done_on_the_first_try(
        fake, clock, device, metrics):
    """A continued run resends an unpack and an unload that landed before the tool died:
    the server's "already done" answers count as success, with no retry counted."""
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="un_pack", site="destination")
    asset = assets_of(fake, move_id)[0]
    crate = next(c for c in fake.containers.values() if c["initiative_id"] == move_id)
    truck = next(t for t in fake.trucks.values() if t["initiative_id"] == move_id)
    unpack = make_scan(clock, move_id, site_id, asset["serial_number"], "un_pack", "barcode")
    unload = make_scan(clock, move_id, site_id, crate["name"], "un_pack", "barcode")
    assert await clock.run(d.unpack(container_id=crate["id"], asset_id=asset["id"],
                                    scan=unpack, already_done_first=True)) is True
    assert await clock.run(d.unload(truck_id=truck["id"], container_id=crate["id"],
                                    scan=unload, already_done_first=True)) is True
    for name in ("unpack", "unload"):
        row = metrics.calls()[name]
        assert (row["count"], row["retries"], row["failures"]) == (1, 0, 0), name
    assert "scans_retried" not in metrics.counters()


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
    assert metrics.counters()["scans_retried"] == 1


async def test_failed_call_returns_false_and_notes_retried_scans(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    fake.fail("POST", r"/kiosk/scans", times=3)
    scans = [make_scan(clock, move_id, site_id, f"SN{i}", "qa", "barcode") for i in range(2)]
    assert await clock.run(d.send_scans(scans)) == 0
    assert metrics.calls()["scans"]["failures"] == 1
    assert metrics.counters()["scans_retried"] == 2


# ── tokens (Review Focus 3) ───────────────────────────────────────────


async def test_kiosk_device_reports_its_refresh_cookie(fake, clock, device):
    fake.add_move(servers=1, containers=0, trucks=0)
    d = device("handheld")
    assert not d.has_refresh_cookie
    await clock.run(d.sign_in(PASSWORD))
    assert d.has_refresh_cookie
    for cookie in d._client.cookies.jar:
        cookie.secure = True
    assert not d.has_refresh_cookie


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


async def test_refresh_due_at_the_end_of_the_sign_in_signs_in_again_instead(
        fake, clock, device, metrics):
    # The real server refuses a refresh that arrives as the sign-in ends (session_expired),
    # and a refresh can never outlive it. Seen on the real server: a refresh sent a few
    # milliseconds before the deadline reached the server after it.
    fake.token_seconds, fake.session_seconds = 90, 150
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    start = clock.now()
    await clock.run(clock.sleep(start + 117 - clock.now()))
    scan = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 1        # refreshes: token due at 147
    assert count(fake, "POST", "/auth/refresh") == 1
    await clock.run(clock.sleep(start + 147.5 - clock.now()))
    scan = make_scan(clock, move_id, site_id, "SN2", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 1
    assert count(fake, "POST", "/auth/refresh") == 1         # no refresh 2.5 s from the end
    assert count(fake, "POST", "/kiosk/move-login") == 2
    assert metrics.failed_calls() == 0


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
    assert metrics.failed_calls() == 0       # the new sign-in carried the call
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


# ── refused sign-ins ──────────────────────────────────────────────────


async def test_wrong_move_password_raises_with_its_code(fake, clock, device, metrics):
    fake.add_move(servers=1, containers=1, trucks=1)
    d = device("handheld")
    wrong = "not-the-move-password"
    try:
        await clock.run(d.sign_in(wrong))
    except CallFailed as exc:
        assert (exc.call, exc.status, exc.code) == ("move-login", 401, "invalid_move_password")
        assert wrong not in str(exc) and wrong not in repr(exc.args)
    else:
        raise AssertionError("expected CallFailed")
    assert count(fake, "POST", "/kiosk/move-login") == 1      # a refused password is not retried
    assert metrics.calls()["move-login"]["failures"] == 1


async def test_move_inactive_mid_run_returns_short_count(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    await clock.run(clock.sleep(25 * 3600))            # the sign-in has ended
    fake.moves[move_id]["status"] = "completed"
    scan = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 0
    assert metrics.calls()["move-login"]["failures"] == 1     # refused: move_not_active
    assert metrics.calls()["scans"]["failures"] == 1
    assert ("POST", "/kiosk/scans") not in fake.requests
    fake.moves[move_id]["status"] = "in_progress"       # a later sign-in that works clears it
    assert await clock.run(d.send_scans([scan])) == 1


# ── follow-up 2 ───────────────────────────────────────────────────────


async def test_retries_before_a_401_carry_into_the_redo(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="un_pack")
    asset = assets_of(fake, move_id)[0]
    crate = next(c for c in fake.containers.values() if c["initiative_id"] == move_id)
    fake.container_of[asset["id"]] = crate["id"]
    path = r"/kiosk/containers/.*/assets"
    fake.fail("POST", path, after_effect=True)          # lands, answer lost
    fake.fail("POST", path, status=401)                   # then the token is refused
    scan = make_scan(clock, move_id, site_id, asset["serial_number"], "un_pack", "barcode")
    assert await clock.run(d.unpack(container_id=crate["id"], asset_id=asset["id"],
                                    scan=scan)) is True
    assert count(fake, "POST", "/auth/refresh") == 1
    assert count(fake, "POST", f"/kiosk/containers/{crate['id']}/assets") == 3
    row = metrics.calls()["unpack"]
    assert (row["count"], row["retries"], row["failures"]) == (1, 1, 0)
    assert metrics.counters()["scans_retried"] == 1


async def test_plain_401_redo_is_not_a_retry(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    fake.fail("POST", r"/kiosk/scans", status=401)
    scan = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 1
    assert "scans_retried" not in metrics.counters()
    assert metrics.calls()["scans"]["retries"] == 0


async def test_station_without_key_sends_nothing(fake, clock, device, metrics):
    d = device("rfid_station")
    move_id = fake.add_move(servers=1, containers=1, trucks=1)
    site_id = fake.moves[move_id]["origin_site_id"]
    await clock.run(d.sign_in(PASSWORD))
    fake.fail("POST", r"/kiosk/station-key", status=409)
    try:
        await clock.run(d.setup(initiative_id=move_id, site_id=site_id,
                                scan_status="rfid_1_cage_exit"))
    except CallFailed as exc:
        assert exc.call == "station-key"
    else:
        raise AssertionError("expected CallFailed")
    assert not d.has_key
    tags = [make_scan(clock, move_id, site_id, f"{i:024d}", "rfid_1_cage_exit")
            for i in range(3)]
    assert await clock.run(d.send_scans(tags)) == 0
    assert metrics.counters()["scans_not_sent"] == 3
    assert ("POST", "/kiosk/scans") not in fake.requests
    assert ("POST", "/kiosk/station/scans") not in fake.requests


async def test_station_heartbeat_carries_the_reader_snapshot(fake, clock, device):
    d = device("rfid_station", n=3)
    await ready(fake, clock, d, status="rfid_1_cage_exit")
    await clock.run(d.heartbeat())
    reader = fake.fixed_readers["LOADTEST-READER-3"]
    assert (reader["make"], reader["model"], reader["ip"]) == ("Zebra", "FX9600", "10.254.0.3")
    assert (reader["antennas_connected"], reader["antennas_total"]) == (4, 4)
    assert reader["reading"] is True and reader["reachable"] is True
    assert reader["tags_24h"] == 0 and reader["via_kiosk_serial"] == d.serial
    assert fake.dropped_reader_reports == 0


async def test_fake_drops_a_bad_reader_report_without_failing_the_beat(fake, clock, device):
    d = device("rfid_station")
    await ready(fake, clock, d, status="rfid_1_cage_exit")
    r = await clock.run(d._client.post(
        "/kiosk/station/heartbeat", headers=d._station(),
        json={"serial": d.serial, "reader": {"serial": "LOADTEST-READER-1", "ip": "nope"}}))
    assert r.status_code == 200
    assert fake.fixed_readers == {} and fake.dropped_reader_reports == 1


async def test_failed_sync_download_raises_call_failed(fake, clock, device):
    d = device("handheld")
    move_id, _ = await ready(fake, clock, d)
    fake.fail("GET", r"/kiosk/sync/trucks", status=404)
    try:
        await clock.run(d.sync(move_id))
    except CallFailed as exc:
        assert (exc.call, exc.status) == ("sync", 404)
    else:
        raise AssertionError("expected CallFailed")
    assert ("GET", "/kiosk/sync/label-templates") not in fake.requests


async def test_failed_sign_in_adds_no_latency_sample(fake, clock, device, metrics):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    await clock.run(clock.sleep(25 * 3600))
    fake.down(True)
    scan = make_scan(clock, move_id, site_id, "SN1", "qa", "barcode")
    assert await clock.run(d.send_scans([scan])) == 0
    row = metrics.calls()["scans"]
    assert (row["count"], row["failures"], row["median_ms"]) == (1, 1, None)


async def test_two_calls_racing_an_expiring_token_refresh_once(fake, clock, device):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    await clock.run(clock.sleep(20 * 60))
    a, b = (make_scan(clock, move_id, site_id, f"SN{i}", "qa", "barcode") for i in range(2))

    async def both():
        return await asyncio.gather(d.send_scans([a]), d.send_scans([b]))

    assert await clock.run(both()) == [1, 1]
    assert count(fake, "POST", "/auth/refresh") == 1
    assert count(fake, "POST", "/kiosk/move-login") == 1


async def test_refresh_margin_is_sixty_seconds(fake, clock, device):
    fake.token_seconds = 900
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    await clock.run(clock.sleep(900 - 61))            # 61 s left: no refresh
    assert await clock.run(d.send_scans([make_scan(clock, move_id, site_id, "SN1", "qa",
                                                   "barcode")])) == 1
    assert count(fake, "POST", "/auth/refresh") == 0
    await clock.run(clock.sleep(2))                   # 59 s left: refresh first
    assert await clock.run(d.send_scans([make_scan(clock, move_id, site_id, "SN2", "qa",
                                                   "barcode")])) == 1
    assert count(fake, "POST", "/auth/refresh") == 1
    assert fake.requests[-2:] == [("POST", "/auth/refresh"), ("POST", "/kiosk/scans")]


async def test_process_scans_replay_duplicates_or_not(fake, clock, device):
    d = device("handheld")
    move_id, site_id = await ready(fake, clock, d, status="qa")
    serials = [a["serial_number"] for a in assets_of(fake, move_id)]
    first = make_scan(clock, move_id, site_id, serials[0], "qa", "barcode")
    second = make_scan(clock, move_id, site_id, serials[1], "qa", "barcode")
    for scan, duplicate in ((first, True), (second, False)):
        assert await clock.run(d.send_scans([scan])) == 1
        assert await clock.run(d.send_scans([scan])) == 1      # raw row still there: no-op
        assert sum(r["client_scan_id"] == str(scan.client_scan_id) for r in fake.raw_scans) == 1
        fake.process_scans(duplicate_on_replay=duplicate)
        assert await clock.run(d.send_scans([scan])) == 1      # replay after processing
        fake.process_scans(duplicate_on_replay=duplicate)
    rows = [p["client_scan_id"] for p in fake.processed_scans]
    assert rows.count(str(first.client_scan_id)) == 2
    assert rows.count(str(second.client_scan_id)) == 1
    assert fake.assets[fake.processed_scans[0]["asset_id"]]["asset_status"] == "qa"


async def test_person_scans_ignore_move_inactive_station_scans_do_not(fake, clock, device):
    hand, station = device("handheld"), device("rfid_station")
    move_id, site_id = await ready(fake, clock, hand, status="qa")
    await clock.run(station.sign_in(PASSWORD))
    await clock.run(station.setup(initiative_id=move_id, site_id=site_id,
                                  scan_status="rfid_1_cage_exit"))
    fake.moves[move_id]["status"] = "completed"
    assert await clock.run(hand.send_scans([make_scan(clock, move_id, site_id, "SN1", "qa",
                                                      "barcode")])) == 1
    tag = make_scan(clock, move_id, site_id, "0" * 24, "rfid_1_cage_exit")
    r = await clock.run(station._client.post(
        "/kiosk/station/scans", headers=station._station(),
        json={"serial": station.serial, "scans": [station._scan_row(tag)]}))
    assert r.json()["rejected"] == [{"client_scan_id": str(tag.client_scan_id),
                                     "code": "move_inactive"}]


async def test_off_move_kept_for_rfid_station_only(fake, clock, device):
    rfid, label = device("rfid_station"), device("label_station")
    move_id, site_id = await ready(fake, clock, rfid, status="rfid_1_cage_exit")
    await clock.run(label.sign_in(PASSWORD))
    await clock.run(label.setup(initiative_id=move_id, site_id=site_id, scan_status="labeled"))
    for d, value, kind in ((rfid, "1" * 24, "rfid"), (label, "SN-OFF", "barcode")):
        row = {**d._scan_row(make_scan(clock, move_id, site_id, value, "labeled", kind)),
               "off_move": True}
        r = await clock.run(d._client.post("/kiosk/station/scans", headers=d._station(),
                                           json={"serial": d.serial, "scans": [row]}))
        assert len(r.json()["accepted"]) == 1
    by_value = {r["scanned_value"]: r["off_move"] for r in fake.raw_scans}
    assert by_value == {"1" * 24: True, "SN-OFF": False}


async def test_close_forgets_the_password_token_and_station_key(fake, clock, device):
    d = device("rfid_station", n=3)
    await ready(fake, clock, d, status="rfid_1_cage_exit")
    assert d.has_key and d._password and d._token
    await d.close()
    assert (d._password, d._token, d._key) == (None, None, None)
    assert not d.has_key
