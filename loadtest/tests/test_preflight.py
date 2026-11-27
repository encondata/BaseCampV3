import httpx
import pytest
from conftest import FAKE_BASE_URL
from test_portal_client import EMAIL, PASSWORD, portal  # noqa: F401  (the portal fixture)

from loadtest.http import CallFailed
from loadtest.preflight import NOT_CHECKED, NOTIFICATIONS_DETAIL, run_checks
from loadtest.profile import load_profile, profile_path

MOVE_PASSWORD = "move-pass-1"
ROUTER = "https://router.example.test"
ORIGIN = (39.0997, -94.5786)
DESTINATION = (41.2565, -95.9345)


@pytest.fixture
def profile():
    return load_profile(profile_path("real-time"))


def osrm(code="Ok"):
    """A road with 11 points from the origin to the destination (OSRM is lng, lat)."""
    coords = [[ORIGIN[1] + (DESTINATION[1] - ORIGIN[1]) * i / 10,
               ORIGIN[0] + (DESTINATION[0] - ORIGIN[0]) * i / 10] for i in range(11)]
    body = {"code": code, "routes": [{"geometry": {"coordinates": coords}}]}
    if code != "Ok":
        body = {"code": code}
    return httpx.MockTransport(lambda request: httpx.Response(200, json=body))


class SecureCookies(httpx.AsyncBaseTransport):
    """Marks every cookie the fake sets Secure, like a server not in development mode,
    so an http:// address keeps but never sends it."""

    def __init__(self, inner):
        self.inner = inner

    async def handle_async_request(self, request):
        response = await self.inner.handle_async_request(request)
        body = await response.aread()
        headers = [(k, v + b"; Secure" if k.lower() == b"set-cookie" else v)
                   for k, v in response.headers.raw]
        return httpx.Response(response.status_code, headers=headers, content=body)


class Setup:
    def __init__(self, fake, clock, portal, metrics, profile):
        self.fake, self.clock, self.metrics, self.profile = fake, clock, metrics, profile
        self.portal_factory = portal
        self.move_id = fake.add_move(servers=45, containers=3, trucks=1)
        self.move = fake.moves[self.move_id]

    async def check(self, *, password=MOVE_PASSWORD, router=None, user=None,
                    transport=None, **extra):
        self.fake.add_portal_user(EMAIL, PASSWORD, **(user or {}))
        portal_client = self.portal_factory(transport=transport or self.fake.transport())
        await self.clock.run(portal_client.login(EMAIL, PASSWORD))
        report = await self.clock.run(run_checks(
            portal=portal_client, profile=self.profile, base_url=FAKE_BASE_URL,
            move_id=self.move_id, move_password=password, metrics=self.metrics,
            clock=self.clock, router_url=ROUTER, transport=transport or self.fake.transport(),
            router_transport=router or osrm(), **extra))
        return report


@pytest.fixture
def setup(fake, clock, portal, metrics, profile):  # noqa: F811
    return Setup(fake, clock, portal, metrics, profile)


def by_key(report):
    return {c.key: c for c in report.checks}


def only_failure(report, key):
    got = by_key(report)
    assert got[key].status == "fail", got[key]
    assert [c.key for c in report.checks if c.status == "fail"] == [key]
    assert report.can_start is False
    return got[key].detail


KEYS = ["portal_access", "move_password", "sign_in_cookies", "move_status", "servers",
        "containers", "trucks", "route", "checkpoints", "server_ready", "rules",
        "notifications"]


async def test_all_good(setup):
    report = await setup.check()
    assert [c.key for c in report.checks] == KEYS
    statuses = {c.key: c.status for c in report.checks}
    assert statuses == {k: ("warn" if k == "notifications" else "pass") for k in KEYS}
    assert report.can_start is True
    assert len(report.route) == 68
    assert report.move.id == setup.move_id and len(report.roster) == 45
    assert len(report.containers) == 3 and len(report.trucks) == 1
    got = by_key(report)
    assert got["notifications"].detail == NOTIFICATIONS_DETAIL
    assert got["route"].detail.startswith("Found a ")
    assert "km road route from Origin 1 to Destination 1 (asked router.example.test)." \
        in got["route"].detail
    assert got["server_ready"].detail == "2 of 2 background workers running; not read-only."
    assert got["containers"].detail == "3 needed, 3 found, all empty."


async def test_labels_are_exact(setup):
    report = await setup.check()
    assert {c.key: c.label for c in report.checks} == {
        "portal_access": "Portal sign-in can change trucks and read scans",
        "move_password": "Move password signs a kiosk in",
        "sign_in_cookies": "Sign-ins are kept",
        "move_status": "Move is In progress",
        "servers": "Servers have serials and no RFID tags",
        "containers": "Enough empty containers",
        "trucks": "Enough trucks, none departed",
        "route": "Road route between the sites",
        "checkpoints": "Every checkpoint is an active status",
        "server_ready": "Workers running, not read-only",
        "rules": "Status rules",
        "notifications": "Notifications"}


async def test_missing_permission(setup):
    report = await setup.check(user={"permissions": {"initiatives:view", "sites:view",
                                                      "containers:view", "trucks:view",
                                                      "assets:view"}})
    detail = by_key(report)["portal_access"].detail
    assert "change trucks" in detail and "read scans" in detail
    assert by_key(report)["portal_access"].status == "fail" and not report.can_start


async def test_wrong_move_password_signs_in_once(setup):
    report = await setup.check(password="not-the-password")
    got = by_key(report)
    assert got["move_password"].status == "fail" and not report.can_start
    assert got["move_password"].detail == "The move password was not accepted."
    assert "not-the-password" not in got["move_password"].detail
    assert got["sign_in_cookies"].detail == NOT_CHECKED
    assert setup.fake.requests.count(("POST", "/kiosk/move-login")) == 1


async def test_move_password_signs_in_once_when_good(setup):
    await setup.check()
    assert setup.fake.requests.count(("POST", "/kiosk/move-login")) == 1
    assert [d["serial"] for d in setup.fake.devices.values()] == ["LOADTEST-CHECK"]
    assert [d["name"] for d in setup.fake.devices.values()] == ["Load test – check"]


async def test_move_not_active(setup):
    setup.move["status"] = "completed"
    report = await setup.check()
    got = by_key(report)
    assert got["move_password"].detail == (
        "The server says this move cannot be signed in to (it is completed, cancelled or "
        "archived).")
    assert got["move_status"].status == "fail" and "Completed" in got["move_status"].detail


@pytest.mark.parametrize("code, text", [
    ("move_login_rate_limited", "refusing kiosk sign-ins from this address"),
    ("redirected", "The server address redirects"),
])
async def test_sign_in_failure_codes(setup, monkeypatch, code, text):
    async def refuse(self, password):
        raise CallFailed("move-login", 302 if code == "redirected" else 429, code, 0)

    monkeypatch.setattr("loadtest.preflight.KioskDevice.sign_in", refuse)
    report = await setup.check()
    assert text in by_key(report)["move_password"].detail
    assert by_key(report)["move_password"].status == "fail"


async def test_sign_in_unknown_failure_gives_status(setup):
    setup.fake.fail("POST", "/kiosk/move-login", status=503, times=9)
    report = await setup.check()
    assert by_key(report)["move_password"].detail == \
        "The kiosk sign-in failed (the server answered 503)."
    assert setup.fake.requests.count(("POST", "/kiosk/move-login")) == 1


async def test_cookies_not_kept_warns(setup):
    report = await setup.check(transport=SecureCookies(setup.fake.transport()))
    got = by_key(report)["sign_in_cookies"]
    assert got.status == "warn" and report.can_start is True
    assert got.detail == (
        "This server only keeps sign-ins over https, and this address is http. Every device "
        "would sign in again about every 15 minutes, which adds load a real move does not "
        "have. Use the server's https address.")


async def test_cookies_not_kept_with_2fa_fails(setup):
    report = await setup.check(transport=SecureCookies(setup.fake.transport()),
                               used_totp=True)
    detail = only_failure(report, "sign_in_cookies")
    assert detail == (
        "This server only keeps sign-ins over https, and this address is http. The portal "
        "account uses a 2FA code, so the run would stop at its first re-sign-in. Use the "
        "server's https address.")


async def test_move_not_in_progress(setup):
    setup.move["status"] = "planned"
    report = await setup.check()
    detail = by_key(report)["move_status"].detail
    assert by_key(report)["move_status"].status == "fail" and "Planned" in detail
    assert not report.can_start


async def test_server_with_a_tag_and_one_without_serial(setup):
    first, second = list(setup.fake.assets.values())[:2]
    first["rfid_tag"] = "ABC"
    second["serial_number"] = None
    report = await setup.check()
    detail = only_failure(report, "servers")
    assert "1 of 45 servers have no serial number" in detail
    assert "1 of 45 servers already have an RFID tag" in detail


async def test_no_servers(setup):
    setup.fake.assets.clear()
    report = await setup.check()
    assert "no servers" in by_key(report)["servers"].detail
    got = by_key(report)
    assert got["containers"].detail == NOT_CHECKED and got["trucks"].detail == NOT_CHECKED
    assert not report.can_start


async def test_too_few_containers(setup):
    del setup.fake.containers[next(iter(setup.fake.containers))]
    report = await setup.check()
    detail = only_failure(report, "containers")
    assert detail.startswith("3 needed, 2 found.") and "Add 1 more container" in detail


async def test_container_not_empty(setup):
    aid = next(iter(setup.fake.assets))
    cid = next(iter(setup.fake.containers))
    setup.fake.container_of[aid] = cid
    report = await setup.check()
    assert "1 container already holds servers" in only_failure(report, "containers")


async def test_more_containers_and_trucks_than_needed_pass(setup):
    setup.fake.add_move(servers=0, containers=5, trucks=5)  # another move's: not counted
    cid = "extra-container"
    setup.fake.containers[cid] = {"id": cid, "name": "Extra", "initiative_id": setup.move_id,
                                  "site_id": None, "status": "available"}
    tid = "extra-truck"
    setup.fake.trucks[tid] = {"id": tid, "name": "Extra truck", "initiative_id": setup.move_id,
                              "status": "created", "start_site_id": None, "end_site_id": None}
    report = await setup.check()
    got = by_key(report)
    assert got["containers"].status == "pass"
    assert got["containers"].detail == "3 needed, 4 found, all empty; 3 of 4 will be used."
    assert got["trucks"].detail == "1 needed, 2 found, none departed; 1 of 2 will be used."


async def test_truck_already_departed(setup):
    next(iter(setup.fake.trucks.values()))["status"] = "in_transit"
    report = await setup.check()
    detail = only_failure(report, "trucks")
    assert "1 truck already left (Truck 1-01)" in detail


async def test_too_few_trucks(setup):
    setup.fake.trucks.clear()
    report = await setup.check()
    assert only_failure(report, "trucks").startswith("1 needed, 0 found.")


async def test_site_without_coordinates(setup):
    setup.fake.sites[setup.move["origin_site_id"]]["latitude"] = None
    report = await setup.check()
    detail = only_failure(report, "route")
    assert "the origin site (Origin 1)" in detail and "latitude and longitude" in detail
    assert report.route == []


async def test_no_route(setup):
    report = await setup.check(router=osrm("NoRoute"))
    detail = only_failure(report, "route")
    assert "NoRoute" in detail and "router.example.test" in detail
    assert report.route == []


async def test_inactive_checkpoint(setup):
    setup.fake.inactive_asset_statuses = {"qa"}
    report = await setup.check()
    detail = only_failure(report, "checkpoints")
    assert "1 checkpoint in the profile is not an active asset status" in detail
    assert "qa" in detail


async def test_read_only(setup):
    setup.fake.read_only = True
    report = await setup.check()
    assert "read-only" in only_failure(report, "server_ready")


async def test_workers_not_all_running(setup):
    setup.fake.background = {"state": "running", "running": 7, "total": 9}
    report = await setup.check()
    assert "Only 7 of 9 background workers are running" in only_failure(report, "server_ready")


async def test_rules_warning_lists_checkpoints_with_stage_labels(setup):
    setup.fake.status_rules = [r for r in setup.fake.status_rules
                               if r["trigger_status"] not in ("on_truck", "received")]
    report = await setup.check()
    got = by_key(report)["rules"]
    assert got.status == "warn" and report.can_start is True
    assert got.detail == (
        "These checkpoints have no enabled status rule: Load truck (on_truck), Unload truck "
        "(received). Scans at these points are recorded but change no status.")


async def test_disabled_rule_counts_as_missing(setup):
    for r in setup.fake.status_rules:
        if r["trigger_status"] == "qa":
            r["enabled"] = False
    report = await setup.check()
    assert "QA (qa)" in by_key(report)["rules"].detail


async def test_server_down_fails_without_raising(setup):
    setup.fake.add_portal_user(EMAIL, PASSWORD)
    p = setup.portal_factory(transport=setup.fake.transport())
    await setup.clock.run(p.login(EMAIL, PASSWORD))
    setup.fake.down(True)
    report = await setup.clock.run(run_checks(
        portal=p, profile=setup.profile, base_url=FAKE_BASE_URL, move_id=setup.move_id,
        move_password=MOVE_PASSWORD, metrics=setup.metrics, clock=setup.clock,
        router_url=ROUTER, transport=setup.fake.transport(), router_transport=osrm()))
    got = by_key(report)
    assert report.can_start is False
    assert "could not be reached" in got["portal_access"].detail
    assert got["move_status"].status == "fail"
    assert got["containers"].detail == NOT_CHECKED and got["route"].detail == NOT_CHECKED
    assert got["sign_in_cookies"].detail == NOT_CHECKED
    assert report.move is None and report.roster == [] and report.route == []


async def test_roster_read_failure_skips_dependents(setup):
    setup.fake.fail("GET", r"/initiatives/.*/assets", status=403, times=9)
    report = await setup.check()
    got = by_key(report)
    assert got["servers"].detail == (
        "Could not read the move's servers: the portal account is not allowed to read it. "
        "Fix that, then check again.")
    assert got["containers"].detail == NOT_CHECKED and got["trucks"].detail == NOT_CHECKED
    assert got["move_status"].status == "pass"


async def test_redirect_reads_name_the_fix(setup):
    setup.fake.fail("GET", "/system/status", status=302, times=9)
    report = await setup.check()
    assert "redirects; use the address it redirects to" in by_key(report)["server_ready"].detail
