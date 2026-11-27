"""The final check: the end state on the server against what the run sent, and the verdict.

Two kinds of scan are counted apart and never added together:

- **Server scans:** one per server per stage whose step landed and that has a
  checkpoint. Each is checked in that server's scan history.
- **Container scans:** the truck load and unload scans. The server stores one per
  crate and lists it in no server's history, and no portal read lists the processed
  scans of one container, so they are counted as sent and covered only by the
  backlog reaching zero.

Findings are written for the product owner: plain words, counts, the first few
serials or names.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass, field
from typing import Literal, TypeVar

from .actions import truck_label
from .client.portal import AssetScan, PortalClient
from .metrics import Metrics, percentile
from .profile import Profile, StageSpec
from .state import RunState, Server

T = TypeVar("T")

DEVICE_PREFIX = "Load test"
CLOCK_SKEW_SECONDS = 60.0   # a history row this long before the run started still counts
SHOWN = 3                   # serials or names listed in a finding before "and N more"
SERVER_KINDS = ("each", "cart", "pack", "unpack")
TRUCK_DONE = "at_destination"
# Scans whose `scanned_at` the server stamps itself; the others carry the device's (this
# machine's) clock, while `processed_at` is always the server's.
SERVER_STAMPED = ("enroll", "pack", "unpack")
# A measured clock difference smaller than this is within the measurement's own error
# (the server's Date header has whole seconds), so it is not applied.
CLOCK_NOISE_SECONDS = 2.0
STOPPED = "Run was stopped before it finished."


@dataclass(frozen=True)
class Finding:
    level: Literal["fail", "warn"]
    text: str


@dataclass(frozen=True)
class FinalReport:
    verdict: Literal["Pass", "Pass with warnings", "Fail"]
    findings: list[Finding]
    scans_sent: int            # server scans expected
    scans_processed: int       # expected server scans found at least once
    scans_twice: int           # extra rows beyond the one expected
    scans_missing: int
    container_scans_sent: int
    container_scans_checked: bool
    delay_ms: dict = field(default_factory=dict)   # median, p95, max; None when no rows


# ── wording ────────────────────────────────────────────────────────────


def _n(count: int, one: str, many: str) -> str:
    return f"{count:,} {one if count == 1 else many}"


def _listed(items: list[str]) -> str:
    """"A", "A and B", "A, B and C", "A, B, C and 9 more"."""
    if len(items) > SHOWN:
        return f"{', '.join(items[:SHOWN])} and {len(items) - SHOWN:,} more"
    if len(items) == 1:
        return items[0]
    return f"{', '.join(items[:-1])} and {items[-1]}"


def _sns(servers: list[Server]) -> str:
    return _listed([f"SN {s.serial}" for s in sorted(servers, key=lambda s: s.serial)])


def _could_not_read(what: str, check: str, plural: bool = False) -> Finding:
    verb = "were" if plural else "was"
    return Finding("fail", f"Could not read {what}, so {check} {verb} not done.")


# ── helpers ────────────────────────────────────────────────────────────


def _delays(values: list[float]) -> dict:
    if not values:
        return {"median": None, "p95": None, "max": None}
    ordered = sorted(values)
    return {"median": round(percentile(ordered, 0.5), 1),
            "p95": round(percentile(ordered, 0.95), 1), "max": round(ordered[-1], 1)}


async def _read(call: Awaitable[T]) -> tuple[bool, T | None]:
    """(True, answer), or (False, None) when the read failed in any way but a cancel."""
    try:
        return True, await call
    except Exception:  # noqa: BLE001 - CallFailed, or a malformed answer (ValueError, ...)
        return False, None


def server_stages(profile: Profile) -> list[StageSpec]:
    """The stages that store one scan per server under a checkpoint."""
    return [s for s in profile.stages if s.kind in SERVER_KINDS and s.checkpoint]


def container_scans_sent(state: RunState) -> int:
    """One per container put on a truck, plus one per container taken off."""
    return sum((c.truck_id is not None) + c.unloaded for c in state.containers.values())


# ── the check ──────────────────────────────────────────────────────────


async def final_check(*, portal: PortalClient, state: RunState, profile: Profile,
                      metrics: Metrics, rule_checkpoints: set[str], stopped_early: bool,
                      concurrency: int = 8, extra_findings: Sequence[Finding] = ()
                      ) -> FinalReport:
    """Raises only asyncio.CancelledError: a failed read is a finding. `extra_findings`
    (the runner's own, such as a catch-up wait ended early) count toward the verdict."""
    failed_calls = metrics.failed_calls()   # before this check's own reads
    stages = server_stages(profile)
    servers = list(state.servers.values())
    findings: list[Finding] = []
    if stopped_early:
        findings.append(Finding("fail", STOPPED))
    if failed_calls:
        findings.append(Finding(
            "fail", f"{_n(failed_calls, 'call', 'calls')} failed for good (see the call table)."))

    # steps that did not land: their scan is not expected
    for spec in stages:
        failed = [s for s in servers if s.done.get(spec.key) is False]
        if failed:
            findings.append(Finding("fail", f"The {spec.label} step failed for "
                                            f"{_n(len(failed), 'server', 'servers')}: "
                                            f"{_sns(failed)}."))

    findings += _trip_step_findings(state)

    # scan histories
    gate = asyncio.Semaphore(max(1, concurrency))

    async def history(server: Server) -> tuple[bool, list[AssetScan] | None]:
        async with gate:
            return await _read(portal.asset_scans(server.id))

    histories = await asyncio.gather(*(history(s) for s in servers))
    since = state.started_at - CLOCK_SKEW_SECONDS          # on this machine's clock
    offset = state.clock_offset or 0.0                     # the server's clock minus ours
    shift = offset if abs(offset) >= CLOCK_NOISE_SECONDS else 0.0
    on_server = {spec.checkpoint for spec in stages if spec.action in SERVER_STAMPED}
    unread: list[Server] = []
    # checkpoint -> [(server, scans missing)], one entry per server short of that checkpoint
    missing: dict[str, list[tuple[Server, int]]] = {}
    sent = processed = twice = 0
    delays: list[float] = []

    def scanned_here(r: AssetScan) -> float:
        """When the scan was made, on this machine's clock."""
        return r.scanned_at.timestamp() - (shift if r.status in on_server else 0.0)

    def delay_ms(r: AssetScan) -> float:
        """Scanned to processed; where the two clocks mix, less their difference. A
        measured difference a little off must never make a delay negative."""
        mixed = 0.0 if r.status in on_server else shift
        return max(0.0, ((r.processed_at - r.scanned_at).total_seconds() - mixed) * 1000)

    for server, (ok, rows) in zip(servers, histories):
        try:
            ours = [r for r in rows if r.device_id.startswith(DEVICE_PREFIX)
                    and scanned_here(r) >= since] if ok else None
            row_delays = [delay_ms(r) for r in ours or ()]
        except (AttributeError, TypeError, ValueError):   # a malformed history row
            ours = None
        if ours is None:
            unread.append(server)
            continue
        delays += row_delays
        found = Counter(r.status for r in ours)
        # one scan per landed stage; stages sharing a checkpoint each expect one
        expected = Counter(spec.checkpoint for spec in stages if server.done.get(spec.key))
        for checkpoint, want in expected.items():
            got = found.get(checkpoint, 0)
            sent += want
            processed += min(got, want)
            twice += max(0, got - want)
            if got < want:
                missing.setdefault(checkpoint, []).append((server, want - got))
    if unread:
        many = len(unread) != 1
        findings.append(Finding(
            "fail", f"Could not read the scan history of {_n(len(unread), 'server', 'servers')} "
                    f"({_sns(unread)}), so {'their' if many else 'its'} scans were not checked."))
    for checkpoint in dict.fromkeys(spec.checkpoint for spec in stages):
        gone = missing.get(checkpoint)
        if not gone:
            continue
        count = sum(n for _, n in gone)
        labels = " or ".join(dict.fromkeys(spec.label for spec in stages
                                           if spec.checkpoint == checkpoint))
        where = f"{labels} ({checkpoint}) for {_sns([srv for srv, _ in gone])}"
        if stopped_early:
            text = (f"{_n(count, 'scan', 'scans')} had not been processed yet when the run "
                    f"was stopped: {where}.")
        else:
            was = "was" if count == 1 else "were"
            text = (f"{_n(count, 'scan', 'scans')} {was} never processed by the BaseCamp "
                    f"server: {where}.")
        findings.append(Finding("fail", text))
    if not stopped_early:
        findings += _unfinished_findings(servers, stages)
    findings += await _roster_findings(portal, state, profile, stages, rule_checkpoints,
                                       stopped_early)
    if not stopped_early:
        findings += await _container_findings(portal, state)
        findings += await _truck_findings(portal, state)

    if twice:
        was = "was" if twice == 1 else "were"
        findings.append(Finding("warn", f"{_n(twice, 'scan', 'scans')} {was} processed twice "
                                        "after a retry."))
    findings += _location_findings(state, metrics)
    findings += list(extra_findings)

    levels = {f.level for f in findings}
    verdict = "Fail" if "fail" in levels else "Pass with warnings" if levels else "Pass"
    return FinalReport(verdict=verdict, findings=findings, scans_sent=sent,
                       scans_processed=processed, scans_twice=twice,
                       scans_missing=sum(n for gone in missing.values() for _, n in gone),
                       container_scans_sent=container_scans_sent(state),
                       container_scans_checked=False, delay_ms=_delays(delays))


def _trip_step_findings(state: RunState) -> list[Finding]:
    """Truck and trip steps whose call did not land, read from the journaled state."""
    containers = sorted(state.containers.values(), key=lambda c: c.name)
    trucks = sorted(state.trucks.values(), key=lambda t: t.name)
    out: list[Finding] = []

    def failed(what: str, names: list[str], one: str, many: str) -> None:
        if names:
            out.append(Finding("fail", f"{what} failed for {_n(len(names), one, many)}: "
                                       f"{_listed(names)}."))

    failed("Loading", [c.name for c in containers if c.load_failed], "container", "containers")
    failed("Unloading", [c.name for c in containers if c.unload_failed],
           "container", "containers")
    failed("Departure", [truck_label(t.name) for t in trucks if t.depart_failed],
           "truck", "trucks")
    lost = [(truck_label(t.name), len(t.failed_locations)) for t in trucks if t.failed_locations]
    if lost:
        total = _n(sum(n for _, n in lost), "truck location update", "truck location updates")
        if len(lost) == 1:
            out.append(Finding("fail", f"{total} failed for {lost[0][0]}."))
        else:
            out.append(Finding("fail", f"{total} failed for {_n(len(lost), 'truck', 'trucks')}: "
                                       f"{_listed([f'{name} ({n:,})' for name, n in lost])}."))
    failed("Arrival", [truck_label(t.name) for t in trucks if t.arrive_failed], "truck", "trucks")
    return out


def _unfinished_findings(servers: list[Server], stages: list[StageSpec]) -> list[Finding]:
    """A run that was not stopped: servers that never got to a stage, grouped by the first
    stage each one is missing (for example a crate whose load failed is never unpacked)."""
    stuck: dict[str, list[Server]] = {}
    for server in servers:
        first = next((spec for spec in stages if spec.key not in server.done), None)
        if first is not None:
            stuck.setdefault(first.key, []).append(server)
    out = []
    for spec in stages:
        group = stuck.get(spec.key)
        if group:
            out.append(Finding("fail", f"{_n(len(group), 'server', 'servers')} never reached "
                                       f"{spec.label}: {_sns(group)}."))
    return out


async def _roster_findings(portal: PortalClient, state: RunState, profile: Profile,
                           stages: list[StageSpec], rule_checkpoints: set[str],
                           stopped_early: bool) -> list[Finding]:
    """Tags (servers whose enroll step landed) and, unless stopped early, move statuses."""
    last = stages[-1] if stages else None
    check_status = not stopped_early and last is not None and last.checkpoint in rule_checkpoints
    skipped = ([Finding("warn", "Move status not checked: no enabled rule for the "
                                f"{last.label} checkpoint.")]
               if not stopped_early and last is not None and not check_status else [])
    ok, rows = await _read(portal.roster(state.move_id))
    if not ok:
        check = "the tag and move status checks" if check_status else "the tag check"
        return [_could_not_read("the move's roster", check, plural=check_status), *skipped]
    by_id = {r.asset_id: r for r in rows}
    out: list[Finding] = []
    absent = [s for s in state.servers.values() if s.id not in by_id]
    if absent:
        are = "is" if len(absent) == 1 else "are"
        out.append(Finding("fail", f"{_n(len(absent), 'server', 'servers')} {are} not on the "
                                   f"move's roster: {_sns(absent)}."))
    on_roster = [s for s in state.servers.values() if s.id in by_id]
    enroll = [spec.key for spec in profile.stages if spec.action == "enroll"]
    wrong_tag = [s for s in on_roster if any(s.done.get(k) for k in enroll)
                 and (by_id[s.id].rfid_tag or "").upper() != s.tag.upper()]
    if wrong_tag:
        one = len(wrong_tag) == 1
        out.append(Finding("fail", f"{_n(len(wrong_tag), 'server', 'servers')} "
                                   f"{'does' if one else 'do'} not have the tag the run gave "
                                   f"{'it' if one else 'them'}: {_sns(wrong_tag)}."))
    if check_status:
        wrong = sorted((s for s in on_roster if by_id[s.id].status != profile.final_status),
                       key=lambda s: s.serial)
        if wrong:
            items = [f"SN {s.serial} ({by_id[s.id].status or 'no status'})" for s in wrong]
            out.append(Finding(
                "fail", f"{_n(len(wrong), 'server', 'servers')} did not reach the move status "
                        f"{profile.final_status}: {_listed(items)}."))
    return out + skipped


async def _container_findings(portal: PortalClient, state: RunState) -> list[Finding]:
    ok, rows = await _read(portal.containers(state.move_id))
    if not ok:
        return [_could_not_read("the containers", "the container check")]
    ours = sorted((c for c in rows if c.id in state.containers), key=lambda c: c.name)
    out: list[Finding] = []
    seen = {c.id for c in rows}
    gone = sorted(c.name for c in state.containers.values() if c.id not in seen)
    if gone:
        one = len(gone) == 1
        out.append(Finding("fail", f"{_n(len(gone), 'container', 'containers')} the run used "
                                   f"{'is' if one else 'are'} no longer on the move (or "
                                   f"{'was' if one else 'were'} archived): {_listed(gone)}."))
    full = [c.name for c in ours if c.asset_count != 0]
    if full:
        are = "is" if len(full) == 1 else "are"
        out.append(Finding("fail", f"{_n(len(full), 'container', 'containers')} {are} not "
                                   f"empty: {_listed(full)}."))
    loaded = [c.name for c in ours if c.truck_id is not None]
    if loaded:
        are = "is" if len(loaded) == 1 else "are"
        out.append(Finding("fail", f"{_n(len(loaded), 'container', 'containers')} {are} still "
                                   f"on a truck: {_listed(loaded)}."))
    return out


async def _truck_findings(portal: PortalClient, state: RunState) -> list[Finding]:
    ok, rows = await _read(portal.trucks(state.move_id))
    if not ok:
        return [_could_not_read("the trucks", "the truck check")]
    out: list[Finding] = []
    seen = {t.id for t in rows}
    gone = sorted(t.name for t in state.trucks.values() if t.id not in seen)
    if gone:
        are = "is" if len(gone) == 1 else "are"
        out.append(Finding("fail", f"{_n(len(gone), 'truck', 'trucks')} the run used {are} no "
                                   f"longer on the move: {_listed(gone)}."))
    away = sorted((t for t in rows if t.id in state.trucks and t.status != TRUCK_DONE),
                  key=lambda t: t.name)
    if away:
        are = "is" if len(away) == 1 else "are"
        out.append(Finding("fail", f"{_n(len(away), 'truck', 'trucks')} {are} not at the "
                                   f"destination: "
                                   f"{_listed([f'{t.name} ({t.status})' for t in away])}."))
    return out


def _location_findings(state: RunState, metrics: Metrics) -> list[Finding]:
    skipped = sum(t.updates_skipped for t in state.trucks.values())
    retried = metrics.counters().get("locations_retried", 0)
    parts = []
    if skipped:
        parts.append(f"{skipped:,} skipped while the runner was down")
    if retried:
        it = "it" if retried == 1 else "each"
        parts.append(f"{retried:,} retried ({it} may have left a duplicate point)")
    if not parts:
        return []
    return [Finding("warn", f"Truck location updates: {', '.join(parts)}.")]
