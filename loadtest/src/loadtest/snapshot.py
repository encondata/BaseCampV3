"""Everything the page draws, as one JSON-ready dict. Never a secret."""

from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING

from .preflight import CheckReport
from .profile import Profile, containers_needed, device_count, trucks_needed
from .state import RunState

if TYPE_CHECKING:
    from .connection import Connection
    from .run_driver import Run


def report_dict(report: CheckReport, profile: Profile) -> dict:
    need_c = containers_needed(profile, len(report.roster))
    return {
        "can_start": report.can_start,
        "checks": [asdict(c) for c in report.checks],
        "move": (None if report.move is None else
                 {"id": report.move.id, "name": report.move.name, "status": report.move.status}),
        "servers": len(report.roster),
        "containers_needed": need_c,
        "containers_found": len(report.containers),
        "trucks_needed": trucks_needed(profile, need_c),
        "trucks_found": len(report.trucks),
    }


def build_snapshot(*, phase: str, error: str | None, connection: Connection,
                   run: Run | None, report: CheckReport | None, check_profile: Profile | None,
                   selected: dict | None, result: dict | None, feed_write_errors: int, unfinished: dict | None,
                   now: float) -> dict:
    state = run.state if run else None
    profile = run.profile if run else check_profile
    servers = (len(state.servers) if state else len(report.roster) if report else 0)
    need_c = (len(state.containers) if state else
              containers_needed(profile, servers) if profile and report else 0)
    need_t = (len(state.trucks) if state else
              trucks_needed(profile, need_c) if profile and report else 0)
    move = None
    if state:
        move = {"name": state.move_name, "servers": servers, "containers": need_c,
                "trucks": need_t}
    elif report and report.move:
        move = {"name": report.move.name, "servers": servers, "containers": need_c,
                "trucks": need_t}
    latest = run.sampler.latest if run and run.sampler else {}
    elapsed = None
    if state:
        end = run.ended_at if run.ended_at is not None else now
        elapsed = round(max(0.0, end - state.started_at), 1)
    return {
        "phase": phase,
        "error": error,
        "connected": ({"server": connection.server, "email": connection.email}
                      if connection.connected else None),
        "needs_totp": connection.needs_totp,
        # the moves connect listed, while that sign-in is the page's (connected, checked)
        "moves": ([dict(m) for m in connection.moves]
                  if connection.connected and phase in ("connected", "checked") else []),
        "selected": dict(selected) if selected else None,
        "devices": device_count(profile) if profile else None,
        "move": move,
        "speed": profile.name if profile else None,
        "started_at": state.started_at if state else None,
        "elapsed": elapsed,
        "overall": _overall(state, profile, servers),
        "stages": _stages(run, profile, servers, need_c, need_t),
        "trucks": _trucks(state, profile),
        "server": {"waiting": latest.get("waiting"),
                   "waiting_peak": latest.get("waiting_peak", 0),
                   "workers": latest.get("workers"),
                   "failed_calls": run.metrics.failed_calls() if run else 0},
        "verdict": result["verdict"] if run and result else None,
        "counters": run.metrics.counters() if run else {},
        "feed_write_errors": feed_write_errors,
        "run_dir": str(run.run_dir) if run else None,
        "check": report_dict(report, check_profile) if report and check_profile else None,
        "unfinished": unfinished,
    }


def _overall(state: RunState | None, profile: Profile | None, servers: int) -> dict:
    if state is None or profile is None:
        return {"done": 0, "total": servers}
    last = profile.stages[-1].key
    return {"done": sum(last in s.done for s in state.servers.values()), "total": servers}


def _stages(run: Run | None, profile: Profile | None, servers: int, containers: int,
            trucks: int) -> list[dict]:
    if run is not None and run.pipeline is not None:
        return [asdict(p) for p in run.pipeline.progress()]
    if profile is None:
        return []
    totals = {"truck_load": containers, "truck_unload": containers, "trip": trucks}
    return [{"key": s.key, "label": s.label, "done": 0, "total": totals.get(s.kind, servers)}
            for s in profile.stages]


def _trucks(state: RunState | None, profile: Profile | None) -> dict:
    if state is None or profile is None:
        return {"loaded": 0, "on_road": 0, "arrived": 0, "furthest": None}
    trucks = list(state.trucks.values())
    on_road = [t for t in trucks if t.departed_at is not None and not t.arrived]
    furthest = max(on_road, key=lambda t: t.updates_sent, default=None)
    return {
        "loaded": sum(bool(t.container_ids) for t in trucks),
        "on_road": len(on_road),
        "arrived": sum(t.arrived for t in trucks),
        "furthest": None if furthest is None else {
            "name": furthest.name,
            "percent": round(100 * furthest.updates_sent / profile.trip.updates)},
    }
