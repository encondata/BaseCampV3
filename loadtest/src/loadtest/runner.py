"""The one object the page talks to: the phase machine and the public API.

`Connection` holds the portal sign-in, `RunDriver` owns the run task, `UnfinishedRuns`
reads runs left unfinished on disk, and `snapshot.py` builds what the page draws.
Passwords live in memory only while they are needed and never reach the snapshot, the
journal, the feed or the result.
"""

from __future__ import annotations

import asyncio
import random
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx

from .clock import Clock, RealClock
from .connection import MESSAGES, Connection, RunnerError, normalize_server, sign_in_error
from .events import Events, FeedLine
from .ids import make_tags
from .journal import load_state, start_entry
from .metrics import Metrics
from .preflight import CheckReport, run_checks
from .profile import (
    Profile,
    ProfileError,
    containers_needed,
    load_profile,
    profile_from_raw,
    profile_path,
    trucks_needed,
)
from .route import DEFAULT_ROUTER
from .run_driver import ACTIVE, RunDriver
from .snapshot import build_snapshot
from .state import Container, RunState, Server, Truck
from .unfinished import UnfinishedRuns, last_at

__all__ = ["MESSAGES", "Phase", "Runner", "RunnerError"]

Phase = Literal["idle", "connected", "checked", "starting", "running", "finishing", "done",
                "stopped", "error"]


def _natural(name: str) -> list:
    """"Crate 2" before "Crate 10"."""
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name.lower())]


def _duration(seconds: float) -> str:
    whole = max(0, int(round(seconds)))
    hours, rest = divmod(whole, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours} h {minutes:02d} min"
    if minutes:
        return f"{minutes} min {secs:02d} s"
    return f"{secs} s"


class Runner:
    def __init__(self, *, runs_dir: Path, clock: Clock | None = None,
                 router_url: str | None = None,
                 transport: httpx.AsyncBaseTransport | None = None,
                 router_transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.runs_dir = Path(runs_dir)
        self.clock = clock or RealClock()
        self.router_url = router_url or DEFAULT_ROUTER
        self._transport = transport
        self._router_transport = router_transport
        self.phase: Phase = "idle"
        self._hub = Events(None)        # lives as long as the runner; the page subscribes here
        self.events: Events = self._hub
        self._busy = False              # a connect, check or continue is under way
        self._conn = Connection(clock=self.clock, transport=transport)
        self._report: CheckReport | None = None
        self._profile: Profile | None = None
        self._move_password: str | None = None
        self._unfinished = UnfinishedRuns(self.runs_dir, self.clock)
        self._driver = RunDriver(clock=self.clock, transport=transport, hub=self._hub,
                                 on_phase=self._on_phase, on_closed=self._on_run_closed)

    @property
    def error(self) -> str | None:
        return self._driver.error

    def _on_phase(self, phase: Phase) -> None:
        self.phase = phase

    async def _on_run_closed(self, ended: bool) -> None:
        self._unfinished.forget_cache()
        self._move_password = None
        self._report = None
        if not ended:
            self.phase = "idle"
        await self._conn.forget()

    # ── the feed ───────────────────────────────────────────────────────

    def subscribe(self) -> asyncio.Queue[FeedLine]:
        return self._hub.subscribe()

    def unsubscribe(self, q: asyncio.Queue[FeedLine]) -> None:
        self._hub.unsubscribe(q)

    def recent(self) -> list[FeedLine]:
        """The current (or last) run's newest lines."""
        return self.events.recent()

    # ── guards ─────────────────────────────────────────────────────────

    def _require_free(self) -> None:
        if self._busy or self._driver.active or self.phase in ACTIVE:
            raise RunnerError("bad_phase")

    async def _reset(self) -> None:
        """Drops the sign-in, the check and the last run's view (not its result)."""
        await self._conn.forget()
        self._report = self._profile = self._move_password = None
        self._driver.forget_run()
        if self.phase not in ACTIVE:
            self.phase = "idle"

    # ── connect and check ──────────────────────────────────────────────

    async def connect(self, server: str, email: str, password: str,
                      totp_code: str | None = None) -> dict:
        self._require_free()
        self._busy = True
        try:
            url = normalize_server(server)
            await self._reset()
            if not await self._conn.sign_in(url, email, password, totp_code):
                return {"status": "totp_required"}
            try:
                moves = await self._conn.portal.moves()
            except Exception as exc:
                await self._reset()
                raise sign_in_error(exc, "password_refused") from None
            self.phase = "connected"
            moves = sorted(moves, key=lambda m: m.status != "in_progress")
            return {"status": "ok",
                    "moves": [{"id": m.id, "name": m.name, "status": m.status} for m in moves]}
        finally:
            self._busy = False

    async def check(self, move_id: str, move_password: str,
                    speed: Literal["real-time", "fast"]) -> CheckReport:
        if self._busy or self.phase not in ("connected", "checked") or not self._conn.connected:
            raise RunnerError("bad_phase")
        self._busy = True
        try:
            try:
                profile = load_profile(profile_path(speed))
            except ProfileError as err:
                raise RunnerError("bad_profile", str(err)) from None
            self.phase, self._report = "connected", None
            portal = self._conn.portal
            metrics = Metrics()
            portal.metrics, portal.retry = metrics, profile.retry
            report = await run_checks(
                portal=portal, profile=profile, base_url=self._conn.server, move_id=move_id,
                move_password=move_password, metrics=metrics, clock=self.clock,
                router_url=self.router_url, transport=self._transport,
                router_transport=self._router_transport, used_totp=self._conn.used_totp)
            self._report, self._profile, self._move_password = report, profile, move_password
            if report.can_start:
                self.phase = "checked"
            return report
        finally:
            self._busy = False

    # ── start ──────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Returns once the run task exists. No await before the phase changes, so two
        calls at once start one run."""
        if self._busy or self._driver.active or self.phase not in ("connected", "checked"):
            raise RunnerError("bad_phase")
        report, profile = self._report, self._profile
        if self.phase != "checked" or report is None or not report.can_start:
            raise RunnerError("not_ready")
        state = self._new_state(report, profile)
        older = self._unfinished.find()
        if older is not None:       # starting anew gives up the older run
            self._unfinished.mark_finished(older, "discarded")
        run = self._open(state, profile, report.move, self._new_run_dir(), self._move_password)
        try:
            run.journal.append(start_entry(state))
        except (OSError, ValueError):
            run.journal.close()
            run.events.close()
            raise RunnerError("cannot_write") from None
        self._launch(run, "Run started",
                     f"{len(state.servers):,} servers, {len(state.containers):,} containers, "
                     f"{len(state.trucks):,} trucks, {profile.name}")

    def _new_state(self, report: CheckReport, profile: Profile) -> RunState:
        run_id = uuid.uuid4()
        roster = sorted(report.roster, key=lambda r: r.serial or "")
        tags = make_tags(random.Random(run_id.int), len(roster))
        need_c = containers_needed(profile, len(roster))
        crates = sorted((c for c in report.containers if c.asset_count == 0),
                        key=lambda c: _natural(c.name))[:need_c]
        trucks = sorted(report.trucks, key=lambda t: _natural(t.name))[
            :trucks_needed(profile, need_c)]
        move = report.move
        return RunState(
            run_id=run_id, server_url=self._conn.server, move_id=move.id, move_name=move.name,
            profile_name=profile.name, profile_raw=profile.raw,
            origin_site_id=move.origin.id, destination_site_id=move.destination.id,
            route=list(report.route), started_at=self.clock.now(),
            servers={r.asset_id: Server(r.asset_id, r.serial or "", tag)
                     for r, tag in zip(roster, tags)},
            containers={c.id: Container(c.id, c.name) for c in crates},
            trucks={t.id: Truck(t.id, t.name) for t in trucks})

    def _new_run_dir(self) -> Path:
        stamp = datetime.fromtimestamp(self.clock.now(), UTC).strftime("%Y-%m-%d_%H-%M-%SZ")
        try:
            self.runs_dir.mkdir(parents=True, exist_ok=True)
            for n in range(1, 1000):
                path = self.runs_dir / (stamp if n == 1 else f"{stamp}-{n}")
                try:
                    path.mkdir()
                except FileExistsError:
                    continue
                return path
        except OSError:
            pass
        raise RunnerError("cannot_write")

    def _open(self, state, profile, move, run_dir, move_password):
        return self._driver.open_run(
            state=state, profile=profile, move=move, run_dir=run_dir, portal=self._conn.portal,
            move_password=move_password,
            secrets=tuple(s for s in (self._conn.password, move_password) if s))

    def _launch(self, run, action: str, subject: str) -> None:
        self.events = run.events
        self._unfinished.forget_cache()
        self._driver.launch(run, action, subject)

    # ── stop, shutdown, wait ───────────────────────────────────────────

    async def stop(self) -> None:
        """Ends the run now; returns once its result is written (phase `stopped`)."""
        await self._driver.stop()

    async def shutdown(self) -> None:
        """For the web app's shutdown: an active run is interrupted, not stopped, so it
        can be continued the next time the tool starts."""
        await self._driver.interrupt()
        if not self._busy:
            await self._reset()

    async def wait(self) -> None:
        """Returns when the current run task has ended."""
        await self._driver.wait()

    # ── unfinished runs ────────────────────────────────────────────────

    def unfinished(self) -> dict | None:
        """The newest unfinished run on disk; None while a run is active here."""
        if self._driver.active:
            return None
        return self._unfinished.summary()

    async def discard_unfinished(self) -> None:
        self._require_free()
        path = self._unfinished.find()
        if path is None:
            raise RunnerError("no_unfinished_run")
        self._unfinished.mark_finished(path, "discarded")

    async def continue_run(self, password: str, move_password: str, email: str,
                           totp_code: str | None = None) -> dict:
        self._require_free()
        path = self._unfinished.find()
        if path is None:
            raise RunnerError("no_unfinished_run")
        try:
            state = load_state(path)
            profile = profile_from_raw(state.profile_raw, name=state.profile_name)
        except ProfileError as err:
            raise RunnerError("bad_profile", str(err)) from None
        except (OSError, ValueError, KeyError, TypeError):
            raise RunnerError("bad_journal") from None
        self._busy = True
        try:
            await self._reset()
            if not await self._conn.sign_in(state.server_url, email, password, totp_code):
                return {"status": "totp_required"}
            try:
                move = await self._conn.read_move(state.move_id)
                await self._conn.verify_move_password(state.server_url, move_password, profile)
                run = self._open(state, profile, move, path.parent, move_password)
            except BaseException:
                await self._reset()
                raise
        finally:
            self._busy = False
        if not any(resumed is None for _, resumed in state.interruptions):
            self._driver.journal(run, {"t": "interrupted"}, at=last_at(path) or state.started_at)
        self._driver.journal(run, {"t": "resumed"})
        now = self.clock.now()
        down = now - min((s for s, r in state.interruptions if r == now), default=now)
        self._launch(run, "Run continued", f"after {_duration(down)} down")
        return {"status": "ok"}

    # ── what the page reads ────────────────────────────────────────────

    def result(self) -> dict | None:
        return self._driver.result

    def snapshot(self) -> dict:
        return build_snapshot(
            phase=self.phase, error=self.error, connection=self._conn, run=self._driver.run,
            report=self._report, check_profile=self._profile, result=self._driver.result,
            feed_write_errors=self.events.write_errors, unfinished=self.unfinished(),
            now=self.clock.now())
