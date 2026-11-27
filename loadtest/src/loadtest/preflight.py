"""The readiness check: what the page shows before a run may start.

Each check is pass, fail or warn. `detail` is written for the product owner: it says
what was found and, when something is wrong, what to fix. `run_checks` never raises for
a server problem; a read that fails turns the check that needed it into a fail, and the
checks that depend on it say they were not checked.
"""

from __future__ import annotations

from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

import httpx

from .client.kiosk import NO_RETRY, KioskDevice
from .client.portal import (
    ContainerInfo,
    MoveInfo,
    PortalClient,
    RosterRow,
    SiteInfo,
    TruckInfo,
)
from .clock import Clock
from .http import CallFailed
from .metrics import Metrics
from .profile import Profile, containers_needed, trucks_needed
from .route import NoRoute, RouteError, fetch_route, line_km, points_along

Status = Literal["pass", "fail", "warn"]

CHECK_SERIAL = "LOADTEST-CHECK"
CHECK_NAME = "Load test – check"
NOT_CHECKED = "Not checked: fix the lines above first."
DEPARTED = ("in_transit", "at_destination")
NAMED_MAX = 5
NOTIFICATIONS_DETAIL = (
    "This run changes truck statuses and fires status rules, so the server sends its "
    "normal notifications to anyone watching this move, its trucks or its sites.")
HTTPS_ONLY = "This server only keeps sign-ins over https, and this address is http."
# What a server answer that is not what the tool expects raises while it is read.
BAD_ANSWER = (CallFailed, ValueError, KeyError, TypeError)
NOT_UNDERSTOOD = "the server sent an answer this tool does not understand"
CLOCKS_AGREE_SECONDS = 5      # a difference up to this passes
CLOCKS_FAIL_SECONDS = 60      # this much or more fails: the history check allows 60 s
CLOCKS = "This machine's clock and the server's"
NO_SERVER_CLOCK = ("The server did not say what time it is, so the clocks were not compared. "
                   "Scan delay figures use this machine's clock.")

SIGN_IN_FAILURES = {
    "invalid_move_password": "The move password was not accepted.",
    "move_not_active": ("The server says this move cannot be signed in to (it is completed, "
                        "cancelled or archived)."),
    "move_login_rate_limited": (
        "The server is refusing kiosk sign-ins from this address for a few minutes after too "
        "many wrong passwords. Wait, then check again."),
    "redirected": "The server address redirects. Use the address it redirects to (usually https).",
}


@dataclass(frozen=True)
class Check:
    key: str
    label: str
    status: Status
    detail: str


@dataclass(frozen=True)
class CheckReport:
    checks: list[Check]
    can_start: bool
    move: MoveInfo | None
    roster: list[RosterRow]
    containers: list[ContainerInfo]
    trucks: list[TruckInfo]
    route: list[tuple[float, float]]    # trip.updates points, empty when not found
    clock_offset: float | None = None   # server minus this machine, seconds; None: unread


def _n(count: int, word: str) -> str:
    return f"{count:,} {word}{'' if count == 1 else 's'}"


def _has(count: int) -> str:
    return "has" if count == 1 else "have"


def _named(names: list[str]) -> str:
    more = len(names) - NAMED_MAX
    return ", ".join(names[:NAMED_MAX]) + (f" and {more:,} more" if more > 0 else "")


def _answered(exc: CallFailed) -> str:
    if exc.status is None:
        return "the server could not be reached"
    return f"the server answered {exc.status}"


def _unreadable(what: str, exc: Exception) -> str:
    """Why a read failed, and what to do about it."""
    if not isinstance(exc, CallFailed):
        reason, fix = NOT_UNDERSTOOD, "Check the server address, then check again."
    elif exc.code == "redirected":
        reason = "the server address redirects"
        fix = "Use the address it redirects to (usually https), then check again."
    elif exc.status is None:
        reason = "the server could not be reached"
        fix = "Check the server address and that the server is running, then check again."
    elif exc.status == 401:
        reason = "the portal sign-in was refused"
        fix = "Check the portal account, then check again."
    elif exc.status == 403:
        reason = "the portal account is not allowed to read it"
        fix = "Give the account access to it, then check again."
    elif exc.status == 404:
        reason = "the server has no such record"
        fix = "Check the move and the server address, then check again."
    else:
        reason = f"the server answered {exc.status}"
        fix = "Check the server, then check again."
    return f"Could not read {what}: {reason}. {fix}"


async def _read(call: Awaitable) -> tuple[object, Exception | None]:
    try:
        return await call, None
    except BAD_ANSWER as exc:
        return None, exc


def _coordinates(site: SiteInfo | None) -> tuple[float, float] | None:
    if site is None or site.lat is None or site.lng is None:
        return None
    return (site.lat, site.lng)


def sign_in_failure(exc: Exception, then: str = "check again") -> str:
    """A refused or failed first sign-in (the password step or the heartbeat after it).
    `then` is what the user does once it is fixed."""
    if not isinstance(exc, CallFailed):
        return f"The kiosk sign-in failed: {NOT_UNDERSTOOD}. Check the server address."
    if exc.call == "heartbeat":
        return ("The move password was accepted, but the kiosk could not finish signing in "
                f"({_answered(exc)}). Check the server, then {then}.")
    return SIGN_IN_FAILURES.get(exc.code or "") or (
        f"The kiosk sign-in failed ({_answered(exc)}).")


def setup_failure(exc: Exception, move: MoveInfo, checkpoint: str,
                  then: str = "check again") -> str:
    """The move-bound kiosk setup that proves the password is for this move. `then` is
    what the user does once it is fixed."""
    if not isinstance(exc, CallFailed):
        return f"The kiosk could not be set up: {NOT_UNDERSTOOD}. Check the server address."
    if exc.code == "move_locked":
        return f"That password signs in to a different move. Enter the password for {move.name}."
    if exc.code == "bad_scan_status":
        return (f"The profile's first checkpoint ({checkpoint}) is not an active asset status, "
                "so the kiosk could not be set up. The checkpoints line below lists what to "
                "fix.")
    if exc.code == "bad_initiative":
        return "The server will not set up a kiosk for this move (it is completed or cancelled)."
    if exc.code == "bad_site":
        return "The server does not accept the move's origin site for a kiosk. Check the move."
    return ("The move password was accepted, but the kiosk could not be set up for this move "
            f"({_answered(exc)}). Check the server, then {then}.")


async def run_checks(*, portal: PortalClient, profile: Profile, base_url: str, move_id: str,
                     move_password: str, metrics: Metrics, clock: Clock, router_url: str,
                     transport: httpx.AsyncBaseTransport | None = None,
                     router_transport: httpx.AsyncBaseTransport | None = None,
                     used_totp: bool = False) -> CheckReport:
    checks: list[Check] = []

    def add(key: str, label: str, status: Status, detail: str) -> None:
        checks.append(Check(key, label, status, detail))

    stages = [s for s in profile.stages if s.checkpoint]
    checkpoints = list(dict.fromkeys(s.checkpoint for s in stages))

    # ── portal_access ──
    label = "Portal sign-in can change trucks and read scans"
    wanted = (("trucks", "change", "change trucks"), ("scans", "view", "read scans"),
              ("initiatives", "view", "read the move"))
    lacking: list[str] = []
    unreadable: Exception | None = None
    for resource, action, words in wanted:
        allowed, exc = await _read(portal.can(resource, action))
        if exc is not None:
            unreadable = exc
            break
        if not allowed:
            lacking.append(words)
    if unreadable is not None:
        add("portal_access", label, "fail",
            _unreadable("what the portal account is allowed to do", unreadable))
    elif lacking:
        add("portal_access", label, "fail",
            f"The portal account is not allowed to {', '.join(lacking)}. Give it a role "
            "with those permissions, or sign in with a different account.")
    else:
        add("portal_access", label, "pass",
            "The portal account can change trucks and read scans and the move.")

    # ── move_password and sign_in_cookies: one throwaway kiosk sign-in ──
    # The move is read first: the kiosk setup after the sign-in proves the password is
    # for this move, and needs the move's name and origin site.
    move, move_error = await _read(portal.move(move_id))
    label = "Move password signs a kiosk in"
    device = KioskDevice(
        base_url=base_url, serial=CHECK_SERIAL, name=CHECK_NAME, kind="handheld",
        metrics=metrics, clock=clock, retry=NO_RETRY,
        timeout=profile.request_timeout_seconds, transport=transport)
    signed_in = False
    device_keeps_cookie = False
    password_detail: tuple[Status, str]
    try:
        try:
            await device.sign_in(move_password)
        except BAD_ANSWER as exc:
            password_detail = ("fail", sign_in_failure(exc))
        else:
            signed_in = True
            device_keeps_cookie = device.has_refresh_cookie
            if move is None:
                password_detail = ("fail", (
                    "The move password was accepted, but this tool could not confirm it is "
                    "for this move, because the move could not be read (see the move line). "
                    "Fix that, then check again."))
            elif move.origin is None:
                password_detail = ("fail", (
                    "The move password was accepted, but this tool could not confirm it is "
                    "for this move, because the move has no origin site. Set an origin site "
                    "on the move, then check again."))
            elif not checkpoints:
                password_detail = ("pass", f"The move password signed a kiosk in to {move.name}.")
            else:
                try:
                    await device.setup(initiative_id=move.id, site_id=move.origin.id,
                                       scan_status=checkpoints[0])
                except BAD_ANSWER as exc:
                    password_detail = ("fail", setup_failure(exc, move, checkpoints[0]))
                else:
                    password_detail = (
                        "pass", f"The move password signed a kiosk in to {move.name}.")
    finally:
        await device.close()
    add("move_password", label, *password_detail)

    label = "Sign-ins are kept"
    secure_address = urlparse(base_url).scheme == "https"
    if not signed_in:
        add("sign_in_cookies", label, "fail", NOT_CHECKED)
    elif portal.has_refresh_cookie and device_keeps_cookie:
        add("sign_in_cookies", label, "pass",
            "The server keeps sign-ins, so devices sign in once and then refresh quietly.")
    elif used_totp:
        add("sign_in_cookies", label, "fail",
            f"{HTTPS_ONLY} The portal account uses a 2FA code, so the run would stop at its "
            "first re-sign-in. Use the server's https address." if not secure_address else
            "The server did not keep the sign-in, and the portal account uses a 2FA code, so "
            "the run would stop at its first re-sign-in.")
    else:
        add("sign_in_cookies", label, "warn",
            f"{HTTPS_ONLY} Every device would sign in again about every 15 minutes, which "
            "adds load a real move does not have. Use the server's https address."
            if not secure_address else
            "The server did not keep the sign-in, so devices would sign in again about every "
            "15 minutes.")

    # ── move_status ──
    label = "Move is In progress"
    if move_error is not None:
        add("move_status", label, "fail", _unreadable("the move", move_error))
    elif move.status == "in_progress":
        add("move_status", label, "pass", f'The move "{move.name}" is In progress.')
    else:
        add("move_status", label, "fail",
            f"The move is {move.status.replace('_', ' ').capitalize()}, not In progress. "
            "Set it to In progress in the portal first.")

    # ── servers ──
    label = "Servers have serials and no RFID tags"
    roster, exc = await _read(portal.roster(move_id))
    roster_ok = exc is None and bool(roster)
    if exc is not None:
        roster = []
        add("servers", label, "fail", _unreadable("the move's servers", exc))
    elif not roster:
        add("servers", label, "fail",
            "The move has no servers. Add the servers to the move in the portal first.")
    else:
        total = len(roster)
        no_serial = sum(1 for r in roster if not (r.serial or "").strip())
        tagged = sum(1 for r in roster if r.rfid_tag)
        problems = []
        if no_serial:
            problems.append(f"{no_serial:,} of {_n(total, 'server')} {_has(no_serial)} no "
                            "serial number. Add the serial numbers in the portal.")
        if tagged:
            problems.append(f"{tagged:,} of {_n(total, 'server')} already {_has(tagged)} an "
                            "RFID tag. The run enrolls tags itself, so use servers without "
                            "tags.")
        if problems:
            add("servers", label, "fail", " ".join(problems))
        else:
            add("servers", label, "pass",
                f"{_n(total, 'server')}, every one with a serial number and none with an "
                "RFID tag.")
    need_containers = containers_needed(profile, len(roster))
    need_trucks = trucks_needed(profile, need_containers)

    # ── containers ──
    label = "Enough empty containers"
    containers: list[ContainerInfo] = []
    if not roster_ok:
        add("containers", label, "fail", NOT_CHECKED)
    else:
        found, exc = await _read(portal.containers(move_id))
        if exc is not None:
            add("containers", label, "fail", _unreadable("the move's containers", exc))
        else:
            containers = found
            full = [c for c in containers if c.asset_count > 0]
            count = f"{need_containers:,} needed, {len(containers):,} found"
            problems = []
            if len(containers) < need_containers:
                short = need_containers - len(containers)
                problems.append(f"{count}. Add {_n(short, 'more container')} to the move.")
            if full:
                names = [f"{c.name} ({_n(c.asset_count, 'server')})" for c in full]
                problems.append(
                    f"{len(full):,} of {_n(len(containers), 'container')} "
                    f"{'holds' if len(full) == 1 else 'hold'} servers: {_named(names)}. "
                    "All containers on the move must be empty before a run. Take the "
                    "servers out of them in the portal first.")
            if problems:
                add("containers", label, "fail", " ".join(problems))
            elif len(containers) > need_containers:
                add("containers", label, "pass",
                    f"{count}, all empty; {need_containers:,} of {len(containers):,} will "
                    "be used.")
            else:
                add("containers", label, "pass", f"{count}, all empty.")

    # ── trucks ──
    label = "Enough trucks, none departed"
    trucks: list[TruckInfo] = []
    if not roster_ok:
        add("trucks", label, "fail", NOT_CHECKED)
    else:
        found, exc = await _read(portal.trucks(move_id))
        if exc is not None:
            add("trucks", label, "fail", _unreadable("the move's trucks", exc))
        else:
            trucks = found
            gone = [t.name for t in trucks if t.status in DEPARTED]
            count = f"{need_trucks:,} needed, {len(trucks):,} found"
            problems = []
            if len(trucks) < need_trucks:
                problems.append(f"{count}. Add {_n(need_trucks - len(trucks), 'more truck')} "
                                "to the move.")
            if gone:
                one = len(gone) == 1
                problems.append(
                    f"{_n(len(gone), 'truck')} already left ({_named(gone)}). Set "
                    f"{'it' if one else 'them'} back to a status before departure, or use "
                    f"{'a new truck' if one else 'new trucks'}.")
            if problems:
                add("trucks", label, "fail", " ".join(problems))
            elif len(trucks) > need_trucks:
                add("trucks", label, "pass",
                    f"{count}, none departed; {need_trucks:,} of {len(trucks):,} will be used.")
            else:
                add("trucks", label, "pass", f"{count}, none departed.")

    # ── route ──
    label = "Road route between the sites"
    route: list[tuple[float, float]] = []
    if move is None:
        add("route", label, "fail", NOT_CHECKED)
    else:
        host = urlparse(router_url).hostname or router_url
        problems = []
        for role, site in (("origin", move.origin), ("destination", move.destination)):
            if site is None:
                problems.append(f"The move has no {role} site. Set {'an' if role == 'origin' else 'a'} "
                                f"{role} site on the move in the portal.")
            elif _coordinates(site) is None:
                problems.append(f"The {role} site ({site.name}) has no latitude and "
                                "longitude. Add them to the site in the portal.")
        if problems:
            add("route", label, "fail", " ".join(problems))
        else:
            where = f"{move.origin.name} and {move.destination.name}"
            try:
                line = await fetch_route(
                    _coordinates(move.origin), _coordinates(move.destination),
                    router_url=router_url, transport=router_transport)
            except NoRoute:
                add("route", label, "fail",
                    f"The routing service found no road route between {where}. Check the "
                    "two sites' coordinates.")
            except RouteError as err:
                add("route", label, "fail",
                    f"The routing service ({host}) answered with a problem; try again in a "
                    "minute." if err.answered else
                    f"Could not reach the routing service ({host}); try again in a minute.")
            except (httpx.HTTPError, httpx.InvalidURL):
                add("route", label, "fail",
                    f"Could not reach the routing service ({host}); try again in a minute, "
                    "or check its address.")
            else:
                route = points_along(line, profile.trip.updates)
                add("route", label, "pass",
                    f"Found a {line_km(line):,.0f} km road route from {move.origin.name} to "
                    f"{move.destination.name} (asked {host}).")

    # ── checkpoints ──
    label = "Every checkpoint is an active status"
    active, exc = await _read(portal.asset_statuses())
    unknown: set[str] = set()      # checkpoints the checkpoints line already reports
    if exc is not None:
        add("checkpoints", label, "fail", _unreadable("the asset statuses", exc))
    else:
        missing = [c for c in checkpoints if c not in active]
        unknown = set(missing)
        if missing:
            one = len(missing) == 1
            add("checkpoints", label, "fail",
                f"{_n(len(missing), 'checkpoint')} in the profile "
                f"{'is' if one else 'are'} not an active asset status on the server: "
                f"{', '.join(missing)}. Activate {'it' if one else 'them'} in the portal's "
                "asset statuses, or change the profile.")
        elif not checkpoints:
            add("checkpoints", label, "pass", "The profile has no checkpoints to check.")
        else:
            add("checkpoints", label, "pass",
                "The profile's one checkpoint is an active asset status."
                if len(checkpoints) == 1 else
                f"All {len(checkpoints):,} checkpoints are active asset statuses.")

    # ── server_ready ──
    label = "Workers running, not read-only"
    status, exc = await _read(portal.system_status())
    if exc is not None:
        add("server_ready", label, "fail", _unreadable("the server's status", exc))
    else:
        problems = []
        if status.read_only:
            problems.append("The server is read-only, so scans and truck updates would be "
                            "refused. Turn read-only mode off first.")
        if status.workers_total == 0:
            problems.append("No background workers are reporting. Scans would be stored and "
                            "never processed. Start the workers, then check again.")
        elif status.workers_running < status.workers_total:
            problems.append(
                f"Only {status.workers_running:,} of {status.workers_total:,} background "
                "workers are running, so scans would pile up unprocessed. Start the "
                "workers first.")
        if problems:
            add("server_ready", label, "fail", " ".join(problems))
        else:
            add("server_ready", label, "pass",
                f"{status.workers_running:,} of {status.workers_total:,} background workers "
                "running; not read-only.")

    # ── clock ──
    label = "Clocks agree"
    offset = await portal.clock_offset()
    if offset is None:
        add("clock", label, "warn", NO_SERVER_CLOCK)
    else:
        apart = round(abs(offset))
        if apart <= CLOCKS_AGREE_SECONDS:
            add("clock", label, "pass", f"{CLOCKS} agree.")
        elif apart < CLOCKS_FAIL_SECONDS:
            add("clock", label, "warn", f"{CLOCKS} differ by {apart:,} seconds. Scan delay "
                                        "figures allow for it.")
        else:
            add("clock", label, "fail", f"{CLOCKS} differ by {apart:,} seconds. Set this "
                                        "machine's clock, then check again.")

    # ── rules ──
    label = "Status rules"
    ruled, exc = await _read(portal.rule_checkpoints())
    if exc is not None:
        add("rules", label, "fail", _unreadable("the status rules", exc))
    else:
        bare = [f"{s.label} ({s.checkpoint})" for s in stages
                if s.checkpoint not in ruled and s.checkpoint not in unknown]
        if bare:
            add("rules", label, "warn",
                f"These checkpoints have no enabled status rule: {', '.join(bare)}. "
                "Scans at these points are recorded but change no status.")
        else:
            add("rules", label, "pass", "Every checkpoint has an enabled status rule.")

    add("notifications", "Notifications", "warn", NOTIFICATIONS_DETAIL)

    return CheckReport(
        checks=checks, can_start=all(c.status != "fail" for c in checks),
        move=None if move_error is not None else move,
        roster=roster, containers=containers, trucks=trucks, route=route,
        clock_offset=offset)
