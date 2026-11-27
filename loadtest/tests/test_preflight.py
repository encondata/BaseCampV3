import re
from dataclasses import replace

import httpx
import pytest
from conftest import FAKE_BASE_URL
from test_portal_client import EMAIL, PASSWORD, portal  # noqa: F401  (the portal fixture)

from loadtest.http import CallFailed
from loadtest.preflight import NO_SERVER_CLOCK, NOT_CHECKED, NOTIFICATIONS_DETAIL, run_checks
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


class StripCookies(httpx.AsyncBaseTransport):
    """A server that sets no cookie at all."""

    def __init__(self, inner):
        self.inner = inner

    async def handle_async_request(self, request):
        response = await self.inner.handle_async_request(request)
        body = await response.aread()
        headers = [(k, v) for k, v in response.headers.raw if k.lower() != b"set-cookie"]
        return httpx.Response(response.status_code, headers=headers, content=body)


class Switch(httpx.AsyncBaseTransport):
    """A transport whose server can be swapped after the sign-in."""

    def __init__(self, inner):
        self.inner = inner

    async def handle_async_request(self, request):
        return await self.inner.handle_async_request(request)


class Setup:
    def __init__(self, fake, clock, portal, metrics, profile):
        self.fake, self.clock, self.metrics, self.profile = fake, clock, metrics, profile
        self.portal_factory = portal
        self.move_id = fake.add_move(servers=45, containers=3, trucks=1)
        self.move = fake.moves[self.move_id]

    async def check(self, *, password=MOVE_PASSWORD, router=None, user=None,
                    transport=None, base_url=FAKE_BASE_URL, **extra):
        self.fake.add_portal_user(EMAIL, PASSWORD, **(user or {}))
        portal_client = self.portal_factory(transport=transport or self.fake.transport(),
                                            base_url=base_url)
        await self.clock.run(portal_client.login(EMAIL, PASSWORD))
        report = await self.clock.run(run_checks(
            portal=portal_client, profile=self.profile, base_url=base_url,
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
        "containers", "trucks", "route", "checkpoints", "server_ready", "clock", "rules",
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
    # miles, rounded, with a thousands separator
    assert re.fullmatch(r"Found an? [\d,]+-mile road route from Origin 1 to Destination 1 "
                        r"\(asked router\.example\.test\)\.", got["route"].detail)
    assert got["server_ready"].detail == "2 of 2 background workers running; not read-only."
    assert got["containers"].detail == "3 needed, 3 found, all empty."
    assert got["clock"].detail == "This machine's clock and the server's agree."
    assert abs(report.clock_offset) <= 0.5


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
        "clock": "Clocks agree",
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


async def test_heartbeat_failure_after_the_password_was_accepted(setup):
    setup.fake.fail("POST", "/kiosk/heartbeat", status=503, times=9)
    report = await setup.check()
    assert by_key(report)["move_password"].detail == (
        "The move password was accepted, but the kiosk could not finish signing in (the "
        "server answered 503). Check the server, then check again.")
    assert setup.fake.requests.count(("POST", "/kiosk/move-login")) == 1


async def test_password_for_a_different_move(setup):
    setup.fake.add_move(servers=0, containers=0, trucks=0, password="other-pass")
    report = await setup.check(password="other-pass")
    assert by_key(report)["move_password"].detail == (
        "That password signs in to a different move. Enter the password for Load test move 1.")
    assert not report.can_start
    assert setup.fake.requests.count(("POST", "/kiosk/move-login")) == 1


async def test_kiosk_setup_failure_for_the_first_checkpoint(setup):
    setup.profile = replace(setup.profile, stages=tuple(
        replace(s, checkpoint="no_such_status") if s.key == setup.profile.stages[0].key else s
        for s in setup.profile.stages))
    detail = by_key(await setup.check())["move_password"].detail
    assert detail.startswith("The profile's first checkpoint (no_such_status) is not an active")


async def test_password_accepted_but_move_unreadable(setup):
    setup.fake.fail("GET", r"/initiatives/.*", status=500, times=9)
    got = by_key(await setup.check())
    assert got["move_password"].status == "fail"
    assert got["move_password"].detail.startswith(
        "The move password was accepted, but this tool could not confirm it is for this move")
    assert got["move_status"].status == "fail"


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


async def test_https_with_no_cookie_kept(setup):
    transport = StripCookies(setup.fake.transport())
    report = await setup.check(transport=transport, base_url="https://fake.test")
    got = by_key(report)["sign_in_cookies"]
    assert got.status == "warn" and report.can_start
    assert got.detail == ("The server did not keep the sign-in, so devices would sign in "
                          "again about every 15 minutes.")
    assert "http" not in got.detail.replace("https", "")
    report = await setup.check(transport=transport, base_url="https://fake.test",
                               used_totp=True)
    assert only_failure(report, "sign_in_cookies") == (
        "The server did not keep the sign-in, and the portal account uses a 2FA code, so "
        "the run would stop at its first re-sign-in.")


async def test_a_web_page_instead_of_the_server_does_not_raise(setup):
    switch = Switch(setup.fake.transport())
    setup.fake.add_portal_user(EMAIL, PASSWORD)
    p = setup.portal_factory(transport=switch)
    await setup.clock.run(p.login(EMAIL, PASSWORD))
    switch.inner = httpx.MockTransport(lambda r: httpx.Response(
        200, text="<html>Welcome</html>", headers={"content-type": "text/html"}))
    report = await setup.clock.run(run_checks(
        portal=p, profile=setup.profile, base_url=FAKE_BASE_URL, move_id=setup.move_id,
        move_password=MOVE_PASSWORD, metrics=setup.metrics, clock=setup.clock,
        router_url=ROUTER, transport=switch, router_transport=osrm()))
    got = by_key(report)
    assert not report.can_start
    assert "does not understand" in got["portal_access"].detail
    assert "does not understand" in got["move_password"].detail
    assert "does not understand" in got["server_ready"].detail
    assert got["move_status"].detail.endswith("Check the server address, then check again.")


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
    assert "1 of 45 servers has no serial number" in detail
    assert "1 of 45 servers already has an RFID tag" in detail


async def test_servers_plural_forms(setup):
    items = list(setup.fake.assets.values())
    for a in items[:2]:
        a["serial_number"] = " "
    for a in items[2:5]:
        a["rfid_tag"] = "ABC"
    detail = by_key(await setup.check())["servers"].detail
    assert "2 of 45 servers have no serial number" in detail
    assert "3 of 45 servers already have an RFID tag" in detail


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
    detail = only_failure(report, "containers")
    assert detail.startswith("1 of 3 containers holds servers: Crate 1-001 (1 server).")
    assert "All containers on the move must be empty before a run." in detail


async def test_surplus_container_that_is_not_empty_still_fails(setup):
    cid = "extra-container"
    setup.fake.containers[cid] = {"id": cid, "name": "Extra", "initiative_id": setup.move_id,
                                  "site_id": None, "status": "available"}
    for a in list(setup.fake.assets.values())[:2]:
        setup.fake.container_of[a["id"]] = cid
    detail = only_failure(await setup.check(), "containers")
    assert detail.startswith("1 of 4 containers holds servers: Extra (2 servers).")


async def test_many_full_containers_are_named_up_to_five(setup):
    for i in range(7):
        cid = f"full-{i}"
        setup.fake.containers[cid] = {"id": cid, "name": f"Full {i}",
                                      "initiative_id": setup.move_id, "site_id": None,
                                      "status": "available"}
        setup.fake.container_of[list(setup.fake.assets)[i]] = cid
    detail = only_failure(await setup.check(), "containers")
    assert detail.startswith("7 of 10 containers hold servers: Full 0 (1 server)")
    assert "and 2 more" in detail


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
    assert "1 truck already left (Truck 1-01). Set it back" in detail
    assert "Add" not in detail          # one truck is enough: only the departure is wrong


async def test_enough_trucks_but_one_at_destination(setup):
    next(iter(setup.fake.trucks.values()))["status"] = "at_destination"
    detail = only_failure(await setup.check(), "trucks")
    assert detail.endswith("or use a new truck.")


async def test_two_departed_trucks_plural(setup):
    setup.fake.trucks["extra"] = {"id": "extra", "name": "Extra truck",
                                  "initiative_id": setup.move_id, "status": "in_transit",
                                  "start_site_id": None, "end_site_id": None}
    for t in setup.fake.trucks.values():
        t["status"] = "in_transit"
    detail = only_failure(await setup.check(), "trucks")
    assert "2 trucks already left (Truck 1-01, Extra truck). Set them back" in detail
    assert detail.endswith("or use new trucks.")


async def test_too_few_trucks(setup):
    setup.fake.trucks.clear()
    report = await setup.check()
    assert only_failure(report, "trucks").startswith("1 needed, 0 found.")


async def test_site_without_coordinates(setup):
    setup.fake.sites[setup.move["origin_site_id"]]["latitude"] = None
    report = await setup.check()
    detail = only_failure(report, "route")
    assert detail == ("The origin site (Origin 1) has no latitude and longitude. "
                      "Add them to the site in the portal.")
    assert report.route == []


async def test_both_sites_without_coordinates(setup):
    for key in ("origin_site_id", "destination_site_id"):
        setup.fake.sites[setup.move[key]]["longitude"] = None
    detail = only_failure(await setup.check(), "route")
    assert detail == ("The origin site (Origin 1) has no latitude and longitude. Add them to "
                      "the site in the portal. The destination site (Destination 1) has no "
                      "latitude and longitude. Add them to the site in the portal.")


async def test_origin_site_missing(setup):
    setup.move["origin_site_id"] = None
    report = await setup.check()
    assert by_key(report)["route"].detail == (
        "The move has no origin site. Set an origin site on the move in the portal.")
    assert "no origin site. Set an origin site" in by_key(report)["move_password"].detail
    assert report.route == []


async def test_destination_site_missing(setup):
    setup.move["destination_site_id"] = None
    detail = only_failure(await setup.check(), "route")
    assert detail == ("The move has no destination site. Set a destination site on the "
                      "move in the portal.")


async def test_zero_coordinates_are_real(setup):
    for key in ("origin_site_id", "destination_site_id"):
        setup.fake.sites[setup.move[key]].update(latitude=0.0, longitude=0.0)
    report = await setup.check()
    assert by_key(report)["route"].status == "pass" and report.can_start


async def test_no_route(setup):
    report = await setup.check(router=osrm("NoRoute"))
    detail = only_failure(report, "route")
    assert detail == ("The routing service found no road route between Origin 1 and "
                      "Destination 1. Check the two sites' coordinates.")
    assert report.route == []


async def test_router_unreachable_names_the_host(setup):
    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    detail = only_failure(await setup.check(router=httpx.MockTransport(boom)), "route")
    assert detail.startswith("Could not reach the routing service (router.example.test); "
                             "try again in a minute.")
    assert "NoRoute" not in detail


@pytest.mark.parametrize("answer", [httpx.Response(429), httpx.Response(200, text="<html>")])
async def test_a_router_that_answered_with_a_problem(setup, answer):
    detail = only_failure(
        await setup.check(router=httpx.MockTransport(lambda request: answer)), "route")
    assert detail == ("The routing service (router.example.test) answered with a problem; "
                      "try again in a minute.")


async def test_bad_router_address_does_not_raise(setup):
    setup.fake.add_portal_user(EMAIL, PASSWORD)
    p = setup.portal_factory(transport=setup.fake.transport())
    await setup.clock.run(p.login(EMAIL, PASSWORD))
    report = await run_checks(      # real I/O only if the address were accepted: it is not
        portal=p, profile=setup.profile, base_url=FAKE_BASE_URL, move_id=setup.move_id,
        move_password=MOVE_PASSWORD, metrics=setup.metrics, clock=setup.clock,
        router_url="http://exa mple", transport=setup.fake.transport())
    assert by_key(report)["route"].status == "fail" and not report.can_start


async def test_inactive_checkpoint(setup):
    setup.fake.inactive_asset_statuses = {"qa"}
    report = await setup.check()
    detail = only_failure(report, "checkpoints")
    assert detail == ("1 checkpoint in the profile is not an active asset status on the "
                      "server: qa. Activate it in the portal's asset statuses, or change "
                      "the profile.")
    assert "qa" not in by_key(report)["rules"].detail      # named once, on the checkpoints line


async def test_inactive_checkpoints_plural(setup):
    setup.fake.inactive_asset_statuses = {"qa", "complete"}
    detail = only_failure(await setup.check(), "checkpoints")
    assert detail.startswith("2 checkpoints in the profile are not an active asset status")
    assert "qa, complete. Activate them" in detail


async def test_read_only(setup):
    setup.fake.read_only = True
    report = await setup.check()
    assert "read-only" in only_failure(report, "server_ready")


async def test_workers_not_all_running(setup):
    setup.fake.background = {"state": "running", "running": 7, "total": 9}
    report = await setup.check()
    assert "Only 7 of 9 background workers are running" in only_failure(report, "server_ready")


async def test_no_workers_reporting(setup):
    setup.fake.background = {"state": "running", "running": 0, "total": 0}
    assert only_failure(await setup.check(), "server_ready") == (
        "No background workers are reporting. Scans would be stored and never processed. "
        "Start the workers, then check again.")


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
        "Give the account access to it, then check again.")
    assert got["containers"].detail == NOT_CHECKED and got["trucks"].detail == NOT_CHECKED
    assert got["move_status"].status == "pass"


async def test_redirect_reads_name_the_fix(setup):
    setup.fake.fail("GET", "/system/status", status=302, times=9)
    report = await setup.check()
    assert "the server address redirects. Use the address it redirects to (usually https)" \
        in by_key(report)["server_ready"].detail


async def test_a_server_error_says_check_the_server(setup):
    setup.fake.fail("GET", "/system/status", status=500, times=9)
    assert by_key(await setup.check())["server_ready"].detail == (
        "Could not read the server's status: the server answered 500. Check the server, "
        "then check again.")


@pytest.mark.parametrize("behind, status, detail", [
    (4, "pass", "This machine's clock and the server's agree."),
    (-30, "warn", "This machine's clock and the server's differ by 30 seconds. Scan delay "
                  "figures allow for it."),
    (120, "fail", "This machine's clock and the server's differ by 120 seconds. Set this "
                  "machine's clock, then check again."),
])
async def test_clock_difference(setup, behind, status, detail):
    from conftest import Skewed
    setup.fake.clock = Skewed(setup.clock, behind)
    await setup.clock.run(setup.clock.sleep(0.25))
    report = await setup.check()
    got = by_key(report)["clock"]
    assert (got.status, got.detail) == (status, detail)
    assert abs(report.clock_offset + behind) <= 0.5
    assert report.can_start is (status != "fail")


async def test_no_date_header_leaves_the_clocks_unchecked_but_never_fails(setup):
    class NoDate(httpx.AsyncBaseTransport):
        def __init__(self, inner):
            self.inner = inner

        async def handle_async_request(self, request):
            response = await self.inner.handle_async_request(request)
            body = await response.aread()
            headers = [(k, v) for k, v in response.headers.raw if k.lower() != b"date"]
            return httpx.Response(response.status_code, headers=headers, content=body)

    report = await setup.check(transport=NoDate(setup.fake.transport()))
    got = by_key(report)["clock"]
    assert (got.status, got.detail) == ("warn", NO_SERVER_CLOCK)
    assert report.clock_offset is None and report.can_start


@pytest.mark.parametrize("miles, words", [(168, "a 168-mile"), (8, "an 8-mile"),
                                          (11, "an 11-mile"), (1094, "a 1,094-mile"),
                                          (18400, "an 18,400-mile"), (110, "a 110-mile")])
def test_route_length_reads_well(miles, words):
    from loadtest.preflight import route_length
    assert route_length(miles) == words
