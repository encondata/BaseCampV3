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
from .route import RouteError, _km, fetch_route, points_along

Status = Literal["pass", "fail", "warn"]

CHECK_SERIAL = "LOADTEST-CHECK"
CHECK_NAME = "Load test – check"
NOT_CHECKED = "Not checked: fix the lines above first."
DEPARTED = ("in_transit", "at_destination")
NOTIFICATIONS_DETAIL = (
    "This run changes truck statuses and fires status rules, so the server sends its "
    "normal notifications to anyone watching this move, its trucks or its sites.")
HTTPS_ONLY = "This server only keeps sign-ins over https, and this address is http."

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


def _n(count: int, word: str) -> str:
    return f"{count:,} {word}{'' if count == 1 else 's'}"


def _why(exc: CallFailed) -> str:
    if exc.code == "redirected":
        return "the server address redirects; use the address it redirects to (usually https)"
    if exc.status is None:
        return "the server could not be reached"
    if exc.status == 401:
        return "the portal sign-in was refused"
    if exc.status == 403:
        return "the portal account is not allowed to read it"
    if exc.status == 404:
        return "the server has no such record"
    return f"the server answered {exc.status}"


def _unreadable(what: str, exc: CallFailed) -> str:
    return f"Could not read {what}: {_why(exc)}. Fix that, then check again."


async def _read(call: Awaitable) -> tuple[object, CallFailed | None]:
    try:
        return await call, None
    except CallFailed as exc:
        return None, exc


def _coordinates(site: SiteInfo | None) -> tuple[float, float] | None:
    if site is None or site.lat is None or site.lng is None:
        return None
    return (site.lat, site.lng)


def _line_km(line: list[tuple[float, float]]) -> float:
    return sum(_km(a, b) for a, b in zip(line, line[1:], strict=False))


async def run_checks(*, portal: PortalClient, profile: Profile, base_url: str, move_id: str,
                     move_password: str, metrics: Metrics, clock: Clock, router_url: str,
                     transport: httpx.AsyncBaseTransport | None = None,
                     router_transport: httpx.AsyncBaseTransport | None = None,
                     used_totp: bool = False) -> CheckReport:
    checks: list[Check] = []

    def add(key: str, label: str, status: Status, detail: str) -> None:
        checks.append(Check(key, label, status, detail))

    # ── portal_access ──
    label = "Portal sign-in can change trucks and read scans"
    wanted = (("trucks", "change", "change trucks"), ("scans", "view", "read scans"),
              ("initiatives", "view", "read the move"))
    lacking: list[str] = []
    unreadable: CallFailed | None = None
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
    label = "Move password signs a kiosk in"
    device = KioskDevice(
        base_url=base_url, serial=CHECK_SERIAL, name=CHECK_NAME, kind="handheld",
        metrics=metrics, clock=clock, retry=NO_RETRY,
        timeout=profile.request_timeout_seconds, transport=transport)
    signed_in = False
    device_keeps_cookie = False
    try:
        try:
            await device.sign_in(move_password)
            signed_in = True
            device_keeps_cookie = device.has_refresh_cookie
        except CallFailed as exc:
            add("move_password", label, "fail", SIGN_IN_FAILURES.get(exc.code or "") or (
                f"The kiosk sign-in failed (the server answered {exc.status})."
                if exc.status is not None else
                "The kiosk sign-in failed (the server could not be reached)."))
    finally:
        await device.close()
    if signed_in:
        add("move_password", label, "pass", "The move password signed a kiosk in.")

    label = "Sign-ins are kept"
    if not signed_in:
        add("sign_in_cookies", label, "fail", NOT_CHECKED)
    elif portal.has_refresh_cookie and device_keeps_cookie:
        add("sign_in_cookies", label, "pass",
            "The server keeps sign-ins, so devices sign in once and then refresh quietly.")
    elif used_totp:
        add("sign_in_cookies", label, "fail",
            f"{HTTPS_ONLY} The portal account uses a 2FA code, so the run would stop at its "
            "first re-sign-in. Use the server's https address.")
    else:
        add("sign_in_cookies", label, "warn",
            f"{HTTPS_ONLY} Every device would sign in again about every 15 minutes, which "
            "adds load a real move does not have. Use the server's https address.")

    # ── move_status ──
    label = "Move is In progress"
    move, exc = await _read(portal.move(move_id))
    if exc is not None:
        add("move_status", label, "fail", _unreadable("the move", exc))
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
            problems.append(f"{no_serial:,} of {_n(total, 'server')} have no serial number. "
                            "Add their serial numbers in the portal.")
        if tagged:
            problems.append(f"{tagged:,} of {_n(total, 'server')} already have an RFID tag. "
                            "The run enrolls tags itself, so use servers without tags.")
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
            full = sum(1 for c in containers if c.asset_count > 0)
            count = f"{need_containers:,} needed, {len(containers):,} found"
            problems = []
            if len(containers) < need_containers:
                short = need_containers - len(containers)
                problems.append(f"{count}. Add {_n(short, 'more container')} to the move.")
            if full:
                problems.append(
                    f"{_n(full, 'container')} already hold{'s' if full == 1 else ''} servers. "
                    "Empty them (unpack the servers) or use empty containers.")
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
                problems.append(
                    f"{_n(len(gone), 'truck')} already left ({', '.join(gone[:5])}"
                    f"{f' and {len(gone) - 5} more' if len(gone) > 5 else ''}). "
                    "Set them back to a status before departure, or use new trucks.")
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
        sites = (("origin", move.origin), ("destination", move.destination))
        missing = [f"the {role} site" + (f" ({site.name})" if site and site.name else "")
                   for role, site in sites if _coordinates(site) is None]
        if missing:
            add("route", label, "fail",
                f"The road route needs a latitude and longitude for both sites, and "
                f"{' and '.join(missing)} has none. Add them to the site in the portal.")
        else:
            start, end = _coordinates(move.origin), _coordinates(move.destination)
            try:
                line = await fetch_route(start, end, router_url=router_url,
                                         transport=router_transport)
            except RouteError as err:
                add("route", label, "fail",
                    f"Could not get a road route from {move.origin.name} to "
                    f"{move.destination.name}. {err} Asked {host}. Try again in a minute, or "
                    "point the tool at a different routing service.")
            else:
                route = points_along(line, profile.trip.updates)
                add("route", label, "pass",
                    f"Found a {_line_km(line):,.0f} km road route from {move.origin.name} to "
                    f"{move.destination.name} (asked {host}).")

    # ── checkpoints ──
    label = "Every checkpoint is an active status"
    stages = [s for s in profile.stages if s.checkpoint]
    checkpoints = list(dict.fromkeys(s.checkpoint for s in stages))
    active, exc = await _read(portal.asset_statuses())
    if exc is not None:
        add("checkpoints", label, "fail", _unreadable("the asset statuses", exc))
    else:
        missing = [c for c in checkpoints if c not in active]
        if missing:
            add("checkpoints", label, "fail",
                f"{_n(len(missing), 'checkpoint')} in the profile "
                f"{'is' if len(missing) == 1 else 'are'} not an active asset status on the "
                f"server: {', '.join(missing)}. Activate them in the portal's asset "
                "statuses, or change the profile.")
        else:
            add("checkpoints", label, "pass",
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
        if status.workers_running < status.workers_total:
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

    # ── rules ──
    label = "Status rules"
    ruled, exc = await _read(portal.rule_checkpoints())
    if exc is not None:
        add("rules", label, "fail", _unreadable("the status rules", exc))
    else:
        bare = [f"{s.label} ({s.checkpoint})" for s in stages if s.checkpoint not in ruled]
        if bare:
            add("rules", label, "warn",
                f"These checkpoints have no enabled status rule: {', '.join(bare)}. "
                "Scans at these points are recorded but change no status.")
        else:
            add("rules", label, "pass", "Every checkpoint has an enabled status rule.")

    add("notifications", "Notifications", "warn", NOTIFICATIONS_DETAIL)

    return CheckReport(
        checks=checks, can_start=all(c.status != "fail" for c in checks), move=move,
        roster=roster, containers=containers, trucks=trucks, route=route)
