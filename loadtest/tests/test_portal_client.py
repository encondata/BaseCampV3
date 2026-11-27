from datetime import UTC, datetime

import pytest
from conftest import FAKE_BASE_URL

from loadtest.client.portal import (
    AssetScan,
    ContainerInfo,
    MoveInfo,
    PortalClient,
    RosterRow,
    SiteInfo,
    SystemStatus,
    TotpEnrollRequired,
    TruckInfo,
)
from loadtest.http import CallFailed

EMAIL = "ops@example.test"
PASSWORD = "portal-pass-1"


@pytest.fixture
async def portal(fake, clock, metrics, retry):
    made: list[PortalClient] = []

    def make(**overrides):
        kwargs = {"base_url": FAKE_BASE_URL, "metrics": metrics, "clock": clock,
                  "retry": retry, "timeout": 10.0, "transport": fake.transport()}
        kwargs.update(overrides)
        p = PortalClient(**kwargs)
        made.append(p)
        return p

    yield make
    for p in made:
        await p.close()


async def signed_in(fake, clock, portal, **user):
    fake.add_portal_user(EMAIL, PASSWORD, **user)
    p = portal()
    assert await clock.run(p.login(EMAIL, PASSWORD)) == "ok"
    return p


def count(fake, method, path):
    return sum(1 for r in fake.requests if r == (method, path))


# ── sign-in ───────────────────────────────────────────────────────────


async def test_login_ok(fake, clock, portal, metrics):
    p = await signed_in(fake, clock, portal)
    assert p.has_refresh_cookie
    assert metrics.calls()["portal-login"]["count"] == 1


async def test_login_with_code_sends_challenge_and_remember(fake, clock, portal):
    fake.add_portal_user(EMAIL, PASSWORD, totp="verify", code="123456")
    p = portal()
    assert await clock.run(p.login(EMAIL, PASSWORD)) == "totp_required"
    await clock.run(p.verify_totp("123456"))
    assert fake.totp_verifications == [{"challenge_header": True, "remember": True}]
    assert await clock.run(p.can("trucks", "change")) is True


async def test_wrong_code_raises_with_its_code(fake, clock, portal):
    fake.add_portal_user(EMAIL, PASSWORD, totp="verify", code="123456")
    p = portal()
    await clock.run(p.login(EMAIL, PASSWORD))
    with pytest.raises(CallFailed) as caught:
        await clock.run(p.verify_totp("654321"))
    assert (caught.value.status, caught.value.code) == (401, "totp_invalid")
    assert "654321" not in str(caught.value) and "654321" not in repr(caught.value.args)


async def test_enroll_challenge_raises(fake, clock, portal):
    fake.add_portal_user(EMAIL, PASSWORD, totp="enroll")
    p = portal()
    with pytest.raises(TotpEnrollRequired):
        await clock.run(p.login(EMAIL, PASSWORD))


async def test_wrong_password_raises_without_the_password(fake, clock, portal, metrics):
    fake.add_portal_user(EMAIL, PASSWORD)
    p = portal()
    with pytest.raises(CallFailed) as caught:
        await clock.run(p.login(EMAIL, "not-the-password"))
    exc = caught.value
    assert (exc.call, exc.status, exc.code) == ("portal-login", 401, "invalid_credentials")
    assert "not-the-password" not in str(exc) and "not-the-password" not in repr(exc.args)
    assert "not-the-password" not in repr(p)
    assert count(fake, "POST", "/auth/login") == 1
    assert metrics.calls()["portal-login"]["failures"] == 1


# ── tokens (Review Focus 3) ───────────────────────────────────────────


async def test_stale_token_refreshes(fake, clock, portal, metrics):
    p = await signed_in(fake, clock, portal)
    await clock.run(clock.sleep(20 * 60))
    fake.add_move(servers=1, containers=0, trucks=0)
    assert len(await clock.run(p.moves())) == 1
    assert count(fake, "POST", "/auth/refresh") == 1
    assert count(fake, "POST", "/auth/login") == 1
    assert metrics.calls()["portal-refresh"]["failures"] == 0


async def test_ended_sign_in_signs_in_again_without_a_code(fake, clock, portal):
    fake.add_portal_user(EMAIL, PASSWORD, totp="verify", code="123456")
    p = portal()
    await clock.run(p.login(EMAIL, PASSWORD))
    await clock.run(p.verify_totp("123456"))
    fake.add_move(servers=1, containers=0, trucks=0)
    await clock.run(clock.sleep(25 * 3600))
    assert len(await clock.run(p.moves())) == 1
    assert count(fake, "POST", "/auth/login") == 2
    assert count(fake, "POST", "/auth/totp/verify") == 1      # ss_trust skipped the code
    assert count(fake, "POST", "/auth/refresh") == 0


async def test_ended_sign_in_that_asks_for_a_code_fails(fake, clock, portal):
    fake.add_portal_user(EMAIL, PASSWORD, totp="verify", code="123456")
    p = portal()
    await clock.run(p.login(EMAIL, PASSWORD))
    await clock.run(p.verify_totp("123456"))
    p._client.cookies.delete("ss_trust")                     # the browser forgot it
    await clock.run(clock.sleep(25 * 3600))
    with pytest.raises(CallFailed) as caught:
        await clock.run(p.moves())
    assert caught.value.code == "totp_required"


async def test_server_401_refreshes_and_redoes_once(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    fake._access.clear()
    await clock.run(p.moves())
    assert count(fake, "POST", "/auth/refresh") == 1
    assert count(fake, "GET", "/initiatives") == 2


async def test_without_a_refresh_cookie_it_signs_in_again_instead(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    p._client.cookies.delete("ss_portal_refresh")            # an https-only cookie over http
    assert not p.has_refresh_cookie
    await clock.run(clock.sleep(20 * 60))
    await clock.run(p.moves())
    assert count(fake, "POST", "/auth/refresh") == 0
    assert count(fake, "POST", "/auth/login") == 2


async def test_secure_cookie_over_http_is_not_a_refresh_cookie(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    for cookie in p._client.cookies.jar:
        cookie.secure = True                                  # as the real server sets it
    assert not p.has_refresh_cookie


async def test_secure_cookie_over_https_is_a_refresh_cookie(fake, clock, portal):
    fake.add_portal_user(EMAIL, PASSWORD)
    p = portal(base_url="https://fake.test")
    await clock.run(p.login(EMAIL, PASSWORD))
    for cookie in p._client.cookies.jar:
        cookie.secure = True
    assert p.has_refresh_cookie
    await clock.run(clock.sleep(20 * 60))
    fake.add_move(servers=1, containers=0, trucks=0)
    await clock.run(p.moves())
    assert count(fake, "POST", "/auth/refresh") == 1


# ── reads ─────────────────────────────────────────────────────────────


async def test_can_reads_the_sign_ins_permissions_once(fake, clock, portal):
    p = await signed_in(fake, clock, portal, permissions={"trucks:view", "scans:view"})
    assert await clock.run(p.can("trucks", "view")) is True
    assert await clock.run(p.can("trucks", "change")) is False
    assert await clock.run(p.can("nothing", "view")) is False
    assert count(fake, "GET", "/auth/me") == 1


async def test_moves_lists_unarchived_moves(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    keep = fake.add_move(servers=1, containers=0, trucks=0)
    archived = fake.add_move(servers=1, containers=0, trucks=0)
    project = fake.add_move(servers=1, containers=0, trucks=0, status="planning")
    fake.moves[archived]["archived_at"] = "2026-11-01T00:00:00+00:00"
    fake.moves[project]["initiative_type"] = "project"
    moves = await clock.run(p.moves())
    assert [m.id for m in moves] == [keep]
    move = moves[0]
    assert isinstance(move, MoveInfo) and move.status == "in_progress"
    assert move.origin == SiteInfo(fake.moves[keep]["origin_site_id"], "Origin 1", None, None)


async def test_move_has_both_sites_coordinates(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    move_id = fake.add_move(servers=1, containers=0, trucks=0)
    move = await clock.run(p.move(move_id))
    m = fake.moves[move_id]
    assert move == MoveInfo(
        move_id, "Load test move 1", "in_progress",
        SiteInfo(m["origin_site_id"], "Origin 1", 39.0997, -94.5786),
        SiteInfo(m["destination_site_id"], "Destination 1", 41.2565, -95.9345))


async def test_roster_containers_trucks(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    move_id = fake.add_move(servers=3, containers=2, trucks=1)
    assets = [a for a in fake.assets.values() if a["initiative_id"] == move_id]
    crates = [c for c in fake.containers.values() if c["initiative_id"] == move_id]
    truck = next(t for t in fake.trucks.values() if t["initiative_id"] == move_id)
    assets[0]["rfid_tag"] = "E2801170000002000000ABCD"
    assets[0]["asset_status"] = "labeled"
    fake.container_of[assets[0]["id"]] = crates[0]["id"]
    fake.truck_of[crates[0]["id"]] = truck["id"]

    roster = await clock.run(p.roster(move_id))
    assert RosterRow(assets[0]["id"], assets[0]["serial_number"], "E2801170000002000000ABCD",
                     "labeled") in roster
    assert RosterRow(assets[1]["id"], assets[1]["serial_number"], None,
                     "loaded_in_system") in roster
    assert len(roster) == 3

    containers = {c.id: c for c in await clock.run(p.containers(move_id))}
    assert containers[crates[0]["id"]] == ContainerInfo(crates[0]["id"], crates[0]["name"], 1,
                                                        truck["id"])
    assert containers[crates[1]["id"]] == ContainerInfo(crates[1]["id"], crates[1]["name"], 0,
                                                        None)
    assert await clock.run(p.trucks(move_id)) == [TruckInfo(truck["id"], truck["name"],
                                                            "created", 1)]


async def test_rule_checkpoints_and_asset_statuses(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    fake.status_rules = [
        {**fake.status_rules[0], "trigger_status": "labeled"},
        {**fake.status_rules[0], "trigger_status": "qa", "enabled": False},
        {**fake.status_rules[0], "trigger_status": "on_truck",
         "trigger_match_type": "container"},
    ]
    assert await clock.run(p.rule_checkpoints()) == {"labeled"}
    fake.inactive_asset_statuses = {"qa"}
    statuses = await clock.run(p.asset_statuses())
    assert "labeled" in statuses and "qa" not in statuses


async def test_system_status(fake, clock, portal, metrics):
    p = await signed_in(fake, clock, portal)
    fake.read_only = True
    assert await clock.run(p.system_status()) == SystemStatus(True, 2, 2)
    fake.background = None
    assert await clock.run(p.system_status()) == SystemStatus(True, 0, 0)
    assert metrics.calls()["system-status"]["count"] == 2


async def test_waiting_scans_counts_load_test_devices_only(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    base = {"scanned_value": "SN1", "scan_type": "barcode", "status": "qa",
            "scan_status": "qa", "scanned_at": "2026-11-27T10:00:00+00:00",
            "operator_id": None, "site_id": None, "initiative_id": None,
            "source": "kiosk", "client_scan_id": None}
    for name in ("Load test – Enroll 1", "Load test – RFID 2", "Dock reader", "Enroll 3"):
        fake._insert_raw({**base, "device_id": name})
    assert await clock.run(p.waiting_scans()) == 2


async def test_asset_totals_and_scans(fake, clock, portal):
    p = await signed_in(fake, clock, portal)
    move_id = fake.add_move(servers=2, containers=0, trucks=0)
    asset = next(a for a in fake.assets.values() if a["initiative_id"] == move_id)
    fake._insert_raw({"scanned_value": asset["serial_number"], "scan_type": "barcode",
                      "status": "qa", "scan_status": "qa",
                      "scanned_at": "2026-11-27T10:00:00+00:00",
                      "device_id": "Load test – Enroll 1", "operator_id": None,
                      "site_id": None, "initiative_id": move_id, "source": "kiosk",
                      "client_scan_id": None})
    fake.process_scans()
    assert await clock.run(p.asset_totals(move_id)) == {"qa": 1, "loaded_in_system": 1}
    scans = await clock.run(p.asset_scans(asset["id"]))
    assert scans == [AssetScan("qa", datetime.fromisoformat("2026-11-27T10:00:00+00:00"),
                               datetime.fromtimestamp(clock.now(), UTC),
                               "Load test – Enroll 1")]


async def test_db_health(fake, clock, portal, metrics):
    p = await signed_in(fake, clock, portal)
    health = await clock.run(p.db_health())
    assert health["connections"] == 12 and health["max_connections"] == 100
    assert health["connection_groups"][0]["count"] == 10


async def test_db_health_is_none_when_not_allowed(fake, clock, portal, metrics):
    p = await signed_in(fake, clock, portal, permissions={"trucks:view"})
    assert await clock.run(p.db_health()) is None
    assert metrics.failed_calls() == 0                         # a background metric


async def test_read_without_permission_fails(fake, clock, portal):
    p = await signed_in(fake, clock, portal, permissions={"trucks:view"})
    with pytest.raises(CallFailed) as caught:
        await clock.run(p.moves())
    assert (caught.value.status, caught.value.code) == (403, "forbidden")


# ── truck calls ───────────────────────────────────────────────────────


async def test_set_truck_status_then_trucks_shows_it(fake, clock, portal, metrics):
    p = await signed_in(fake, clock, portal)
    move_id = fake.add_move(servers=1, containers=0, trucks=1)
    truck = next(t for t in fake.trucks.values() if t["initiative_id"] == move_id)
    assert await clock.run(p.set_truck_status(truck["id"], "in_transit")) is True
    assert [t.status for t in await clock.run(p.trucks(move_id))] == ["in_transit"]
    assert await clock.run(p.set_truck_status(truck["id"], "flying")) is False
    assert metrics.calls()["truck-status"]["failures"] == 1


async def test_add_truck_location_stores_canonical_lat_lng(fake, clock, portal, metrics):
    p = await signed_in(fake, clock, portal)
    move_id = fake.add_move(servers=1, containers=0, trucks=1)
    truck = next(t for t in fake.trucks.values() if t["initiative_id"] == move_id)
    assert await clock.run(p.add_truck_location(truck["id"], 32.7767, -96.797)) is True
    row = fake.truck_updates[-1]
    assert (row["lat"], row["lng"], row["location"]) == (32.7767, -96.797,
                                                         "32.776700, -96.797000")
    assert row["source"] == "loadtest"
    assert "locations_retried" not in metrics.counters()


async def test_retried_truck_location_is_counted(fake, clock, portal, metrics):
    p = await signed_in(fake, clock, portal)
    move_id = fake.add_move(servers=1, containers=0, trucks=1)
    truck = next(t for t in fake.trucks.values() if t["initiative_id"] == move_id)
    fake.fail("POST", r"/trucks/[^/]+/updates")
    assert await clock.run(p.add_truck_location(truck["id"], 33.0, -90.0)) is True
    assert metrics.counters()["locations_retried"] == 1
    assert metrics.calls()["truck-location"]["retries"] == 1
