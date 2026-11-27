"""The one object that owns a run, from "connect" to "result".

The web page only calls these methods and draws `snapshot()`. A run is one background
task that owns everything it starts (fleet, sampler, pipeline, catch-up wait, final
check); however it ends, every task it started is gone and every file it opened is
closed. Passwords live in memory only while they are needed and never reach the
snapshot, the journal, the feed or the result.
"""

from __future__ import annotations

import asyncio
import functools
import json
import random
import re
import sys
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx

from .actions import Actions
from .client.kiosk import NO_RETRY, KioskDevice
from .client.portal import MoveInfo, PortalClient, TotpEnrollRequired
from .clock import Clock, RealClock
from .events import Events, FeedLine
from .finalcheck import FinalReport, final_check
from .fleet import Fleet, FleetError
from .http import CallFailed
from .ids import make_tags
from .journal import JOURNAL_NAME, Journal, find_unfinished, load_state, start_entry
from .metrics import Metrics
from .pipeline import Pipeline, Step
from .preflight import CHECK_NAME, CHECK_SERIAL, SIGN_IN_FAILURES, CheckReport, run_checks
from .profile import (
    Profile,
    ProfileError,
    RetrySpec,
    containers_needed,
    load_profile,
    profile_from_raw,
    profile_path,
    trucks_needed,
)
from .results import build_results, write_results
from .route import DEFAULT_ROUTER
from .sampler import Sampler
from .state import Container, RunState, Server, Truck

Phase = Literal["idle", "connected", "checked", "starting", "running", "finishing", "done",
                "stopped", "error"]
ACTIVE = ("starting", "running", "finishing")
CONNECT_RETRY = RetrySpec(attempts=3, backoff_seconds=(1.0, 2.0))
CONNECT_TIMEOUT = 30.0
FLIGHT_WAIT = 30.0          # seconds a stop waits for calls in flight
RUNNER = "Runner"           # the feed's device name for the runner's own lines
EVENTS_LOG = "events.log"
_END_PHASE: dict[str, Phase] = {"completed": "done", "stopped": "stopped", "error": "error"}

MESSAGES = {
    "bad_phase": "That cannot be done right now.",
    "bad_server": "Enter the server's address, like https://api.example.com",
    "redirected": "The server address redirects. Use the address it redirects to (usually https).",
    "unreachable": "The server could not be reached. Check the address and that the server is "
                   "running.",
    "bad_answer": "The server sent an answer this tool does not understand. Check the server "
                  "address.",
    "password_refused": "The email or password was not accepted.",
    "code_refused": "The 2FA code was not accepted.",
    "totp_enroll": "This account still has to set up 2FA. Finish that in the portal, then "
                   "connect again.",
    "not_ready": "Run the readiness check first; Start needs every line to pass.",
    "no_unfinished_run": "There is no unfinished run to continue.",
    "bad_journal": "The unfinished run's journal could not be read, so it cannot be continued.",
    "cannot_write": "The run folder could not be written. Check that the disk has room and the "
                    "runs folder can be written.",
    "move_unreadable": "The run's move could not be read from the server.",
}
BAD_ANSWER = (ValueError, KeyError, TypeError)


class RunnerError(Exception):
    """`message` is safe to show on the page."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        self.message = message if message is not None else MESSAGES[code]
        super().__init__(code, self.message)


class _RunEvents(Events):
    """A run's feed: its own ring and events.log, and every line passed on to the hub the
    page subscribes to once."""

    def __init__(self, log_path: Path, hub: Events) -> None:
        super().__init__(log_path)
        self._hub = hub

    def feed(self, line: FeedLine) -> None:
        super().feed(line)
        self._hub.feed(line)


@dataclass
class _Run:
    state: RunState
    profile: Profile
    move: MoveInfo
    run_dir: Path
    journal: Journal
    events: Events
    metrics: Metrics
    portal: PortalClient
    move_password: str | None
    secrets: tuple[str, ...]
    pipeline: Pipeline | None = None
    actions: Actions | None = None
    fleet: Fleet | None = None
    sampler: Sampler | None = None
    rules: set[str] | None = None
    tasks: dict[str, asyncio.Task] = field(default_factory=dict)
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    stopping: bool = False      # no new step may start a call
    in_flight: int = 0
    idle: asyncio.Event = field(default_factory=asyncio.Event)
    finished: bool = False      # run_finished journaled
    ended_at: float | None = None


# ── small helpers ──────────────────────────────────────────────────────


def normalize_server(server: str) -> str:
    text = (server or "").strip().rstrip("/")
    parts = urlsplit(text)
    try:
        parts.port
    except ValueError:
        raise RunnerError("bad_server") from None
    if (parts.scheme not in ("http", "https") or not parts.hostname
            or parts.username is not None or parts.password is not None
            or "?" in text or "#" in text):
        raise RunnerError("bad_server")
    return text


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


def _sign_in_error(exc: Exception, refused: str) -> RunnerError:
    if isinstance(exc, TotpEnrollRequired):
        return RunnerError("totp_enroll")
    if isinstance(exc, CallFailed):
        if exc.code == "redirected":
            return RunnerError("redirected")
        if exc.status is None:
            return RunnerError("unreachable")
        if 400 <= exc.status < 500 and exc.status != 429:
            return RunnerError("sign_in_failed", MESSAGES[refused])
        return RunnerError("sign_in_failed",
                           f"The server refused the sign-in (HTTP {exc.status}).")
    return RunnerError("bad_answer")


def _leaf(exc: BaseException) -> BaseException:
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return exc


def _safe_error(exc: BaseException) -> str:
    leaf = _leaf(exc)
    if isinstance(leaf, FleetError):
        return str(leaf)
    return f"The run stopped because of an unexpected problem: {type(leaf).__name__}."


def _log(what: str, exc: BaseException | None = None) -> None:
    """One line on stderr: never the exception text, which could quote a request."""
    where = ""
    if exc is not None:
        leaf = _leaf(exc)
        frames = traceback.extract_tb(leaf.__traceback__)
        where = f" ({type(leaf).__name__} at {frames[-1].filename}:{frames[-1].lineno})" \
            if frames else f" ({type(leaf).__name__})"
    print(f"loadtest: {what}{where}", file=sys.stderr)


def _last_at(path: Path) -> float | None:
    """The `at` of the journal's last readable entry."""
    last = None
    for raw in path.read_bytes().split(b"\n"):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("at"), (int, float)):
            last = float(entry["at"])
    return last


def _report_dict(report: CheckReport, profile: Profile) -> dict:
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


async def _cancel(*tasks: asyncio.Task | None) -> None:
    live = [t for t in tasks if t is not None]
    for task in live:
        task.cancel()
    await asyncio.gather(*live, return_exceptions=True)


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
        self.error: str | None = None
        self._hub = Events(None)        # lives as long as the runner; the page subscribes here
        self.events: Events = self._hub
        self._busy = False              # a connect, check or continue is under way
        self._interrupting = False
        # the portal sign-in
        self._portal: PortalClient | None = None
        self._server: str | None = None
        self._email: str | None = None
        self._password: str | None = None
        self._used_totp = False
        self._needs_totp = False
        # the last readiness check
        self._report: CheckReport | None = None
        self._profile: Profile | None = None
        self._move_password: str | None = None
        # the run
        self._run: _Run | None = None
        self._task: asyncio.Task | None = None
        self._result: dict | None = None
        self._unfinished_cache: tuple[tuple, dict | None] | None = None
        self._logged_journals: set[str] = set()

    # ── the feed ───────────────────────────────────────────────────────

    def subscribe(self) -> asyncio.Queue[FeedLine]:
        return self._hub.subscribe()

    def unsubscribe(self, q: asyncio.Queue[FeedLine]) -> None:
        self._hub.unsubscribe(q)

    def recent(self) -> list[FeedLine]:
        """The current (or last) run's newest lines."""
        return self.events.recent()

    def _feed(self, run: _Run, action: str, subject: str = "", ok: bool = True) -> None:
        run.events.feed(FeedLine(self.clock.now(), RUNNER, action, subject, ok, None))

    # ── guards ─────────────────────────────────────────────────────────

    def _active(self) -> bool:
        return self._task is not None and not self._task.done()

    def _require_free(self) -> None:
        if self._busy or self._active() or self.phase in ACTIVE:
            raise RunnerError("bad_phase")

    # ── connect ────────────────────────────────────────────────────────

    async def connect(self, server: str, email: str, password: str,
                      totp_code: str | None = None) -> dict:
        self._require_free()
        self._busy = True
        try:
            url = normalize_server(server)
            await self._forget_connection()
            outcome = await self._sign_in(url, email, password, totp_code)
            if outcome is None:
                return {"status": "totp_required"}
            try:
                moves = await self._portal.moves()
            except Exception as exc:
                await self._forget_connection()
                raise _sign_in_error(exc, "password_refused") from None
            self.phase = "connected"
            moves = sorted(moves, key=lambda m: m.status != "in_progress")
            return {"status": "ok",
                    "moves": [{"id": m.id, "name": m.name, "status": m.status} for m in moves]}
        finally:
            self._busy = False

    async def _sign_in(self, url: str, email: str, password: str,
                       totp_code: str | None) -> str | None:
        """Signs the portal in and keeps it; None when the server asks for a 2FA code."""
        portal = PortalClient(base_url=url, metrics=Metrics(), clock=self.clock,
                              retry=CONNECT_RETRY, timeout=CONNECT_TIMEOUT,
                              transport=self._transport)
        used_totp = False
        try:
            try:
                outcome = await portal.login(email, password)
            except Exception as exc:
                raise _sign_in_error(exc, "password_refused") from None
            if outcome == "totp_required":
                code = (totp_code or "").strip()
                if not code:
                    await portal.close()
                    self._needs_totp = True
                    return None
                try:
                    await portal.verify_totp(code)
                except Exception as exc:
                    raise _sign_in_error(exc, "code_refused") from None
                used_totp = True
        except BaseException:
            await portal.close()
            raise
        self._portal, self._server, self._email, self._password = portal, url, email, password
        self._used_totp, self._needs_totp = used_totp, False
        return "ok"

    async def _forget_connection(self) -> None:
        portal, self._portal = self._portal, None
        if portal is not None:
            await portal.close()
        self._server = self._email = self._password = self._move_password = None
        self._report = self._profile = None
        self._used_totp = self._needs_totp = False
        self._run = None
        if self.phase not in ACTIVE:
            self.phase = "idle"

    # ── check ──────────────────────────────────────────────────────────

    async def check(self, move_id: str, move_password: str,
                    speed: Literal["real-time", "fast"]) -> CheckReport:
        if self._busy or self.phase not in ("connected", "checked") or self._portal is None:
            raise RunnerError("bad_phase")
        self._busy = True
        try:
            try:
                profile = load_profile(profile_path(speed))
            except ProfileError as err:
                raise RunnerError("bad_profile", str(err)) from None
            self.phase, self._report = "connected", None
            metrics = Metrics()
            self._portal.metrics, self._portal.retry = metrics, profile.retry
            report = await run_checks(
                portal=self._portal, profile=profile, base_url=self._server, move_id=move_id,
                move_password=move_password, metrics=metrics, clock=self.clock,
                router_url=self.router_url, transport=self._transport,
                router_transport=self._router_transport, used_totp=self._used_totp)
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
        if self._busy or self._active() or self.phase not in ("connected", "checked"):
            raise RunnerError("bad_phase")
        report, profile = self._report, self._profile
        if self.phase != "checked" or report is None or not report.can_start:
            raise RunnerError("not_ready")
        state = self._new_state(report, profile)
        older = find_unfinished(self.runs_dir)
        if older is not None:       # starting anew gives up the older run
            self._mark_finished(older, "discarded")
        run_dir = self._new_run_dir()
        run = self._open_run(state, profile, report.move, run_dir, self._move_password)
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
            run_id=run_id, server_url=self._server, move_id=move.id, move_name=move.name,
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

    def _open_run(self, state: RunState, profile: Profile, move: MoveInfo, run_dir: Path,
                  move_password: str) -> _Run:
        try:
            journal = Journal(run_dir / JOURNAL_NAME)
        except OSError:
            raise RunnerError("cannot_write") from None
        try:
            events = _RunEvents(run_dir / EVENTS_LOG, self._hub)
        except OSError:
            journal.close()
            raise RunnerError("cannot_write") from None
        metrics = Metrics()
        self._portal.metrics, self._portal.retry = metrics, profile.retry
        run = _Run(state=state, profile=profile, move=move, run_dir=run_dir, journal=journal,
                   events=events, metrics=metrics, portal=self._portal,
                   move_password=move_password,
                   secrets=tuple(s for s in (self._password, move_password) if s))
        run.idle.set()
        run.pipeline = Pipeline(profile, state, functools.partial(self._perform, run),
                                self.clock, random.Random(state.run_id.int), journal)
        return run

    def _launch(self, run: _Run, action: str, subject: str) -> None:
        self._run, self.events = run, run.events
        self.phase, self.error, self._result = "starting", None, None
        self._unfinished_cache = None
        self._feed(run, action, subject)
        self._task = asyncio.create_task(self._run_task(run))

    # ── the run task ───────────────────────────────────────────────────

    async def _run_task(self, run: _Run) -> None:
        outcome = None
        try:
            outcome = await self._outcome(run)
        finally:
            try:
                await self._teardown(run)
            finally:
                if outcome is not None:
                    self._finish(run, *outcome)
                elif self._interrupting and not run.finished:
                    self._journal(run, {"t": "interrupted"})
                await self._close(run, ended=outcome is not None)

    async def _outcome(self, run: _Run) -> tuple[str, FinalReport | None, float | None]:
        try:
            return await self._drive(run)
        except Exception as exc:
            self.error = _safe_error(exc)
            _log("the run stopped", exc)
            return "error", None, None

    async def _drive(self, run: _Run) -> tuple[str, FinalReport | None, float | None]:
        if run.stop_event.is_set():
            return self._stopped_at_start(run)
        run.fleet = Fleet(profile=run.profile, base_url=run.state.server_url, move=run.move,
                          metrics=run.metrics, clock=self.clock, events=run.events,
                          transport=self._transport, rng=random.Random(run.state.run_id.int))
        try:
            await run.fleet.start(run.move_password)
        except FleetError:
            if run.stop_event.is_set():
                return self._stopped_at_start(run)
            raise
        if run.stop_event.is_set():
            return self._stopped_at_start(run)
        self._feed(run, "Devices ready", f"{len(run.fleet.devices)} devices")
        run.actions = Actions(profile=run.profile, state=run.state, fleet=run.fleet,
                              portal=run.portal, events=run.events, metrics=run.metrics,
                              clock=self.clock)
        run.rules = await self._rules(run)
        run.sampler = Sampler(portal=run.portal, move_id=run.state.move_id,
                              metrics=run.metrics, clock=self.clock,
                              every=run.profile.sample_seconds)
        self.phase = "running"
        run.tasks["sampler"] = asyncio.create_task(run.sampler.run())
        run.tasks["pipeline"] = asyncio.create_task(run.pipeline.run())
        if not await self._until_stop(run, run.tasks["pipeline"]):
            return await self._stop_mid_run(run)
        run.tasks["pipeline"].result()      # an engine failure ends the run as an error
        return await self._catch_up_and_check(run)

    def _stopped_at_start(self, run: _Run) -> tuple[str, None, None]:
        self._feed(run, "Run stopped", "while the devices were starting")
        return "stopped", None, None

    async def _until_stop(self, run: _Run, task: asyncio.Task) -> bool:
        """True when `task` ended first, False when a stop came first."""
        stop = asyncio.create_task(run.stop_event.wait())
        try:
            done, _ = await asyncio.wait({task, stop}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            await _cancel(stop)
        return task in done

    async def _within(self, awaitable, seconds: float) -> None:
        """Waits for `awaitable`, at most `seconds` on the run's clock."""
        waiter = asyncio.ensure_future(awaitable)
        timer = asyncio.create_task(self.clock.sleep(seconds))
        try:
            await asyncio.wait({waiter, timer}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            await _cancel(waiter, timer)

    async def _perform(self, run: _Run, step: Step) -> bool:
        """Every step's call, counted while in flight so a stop can wait for them."""
        if run.stopping:
            raise asyncio.CancelledError()
        run.in_flight += 1
        run.idle.clear()
        try:
            return await run.actions.perform(step)
        finally:
            run.in_flight -= 1
            if run.in_flight == 0:
                run.idle.set()

    async def _stop_mid_run(self, run: _Run) -> tuple[str, FinalReport, None]:
        # A call in flight finishes and is journaled (the crew records it before its next
        # await); no new call starts.
        run.stopping = True
        if run.in_flight:
            await self._within(run.idle.wait(), FLIGHT_WAIT)
        await _cancel(run.tasks.get("pipeline"), run.tasks.get("sampler"))
        await run.fleet.stop()
        self.phase = "finishing"
        self._feed(run, "Run stopped")
        return "stopped", await self._final_check(run, stopped_early=True), None

    async def _catch_up_and_check(self, run: _Run) -> tuple[str, FinalReport, float | None]:
        await _cancel(run.tasks.get("sampler"))
        await run.fleet.stop()
        self.phase = "finishing"
        self._feed(run, "Move finished; waiting for the server to catch up")
        catch = asyncio.create_task(run.sampler.wait_for_catch_up())
        run.tasks["catch_up"] = catch
        if not await self._until_stop(run, catch):
            await _cancel(catch)
            self._feed(run, "Run stopped")
            return "stopped", await self._final_check(run, stopped_early=True), None
        catch_up = catch.result()
        if catch_up is not None:
            self._feed(run, "Server caught up", f"{catch_up:.0f} s")
        else:
            waiting = run.sampler.latest.get("waiting")
            self._feed(run, "Server did not catch up",
                       "the waiting count could not be read" if waiting is None
                       else f"{waiting:,} scans still waiting", ok=False)
        return "completed", await self._final_check(run, stopped_early=False), catch_up

    async def _rules(self, run: _Run) -> set[str] | None:
        try:
            return await run.portal.rule_checkpoints()
        except Exception:   # noqa: BLE001 - a failed read falls back to the earlier one
            return None

    async def _final_check(self, run: _Run, *, stopped_early: bool) -> FinalReport:
        self._feed(run, "Final check")
        rules = await self._rules(run)
        if rules is None:
            rules = run.rules or set()
        return await final_check(portal=run.portal, state=run.state, profile=run.profile,
                                 metrics=run.metrics, rule_checkpoints=rules,
                                 stopped_early=stopped_early)

    async def _teardown(self, run: _Run) -> None:
        run.stopping = True
        await _cancel(*run.tasks.values())
        if run.fleet is not None:
            await run.fleet.stop()

    def _journal(self, run: _Run, entry: dict, at: float | None = None) -> None:
        entry["at"] = self.clock.now() if at is None else at
        try:
            run.journal.append(entry)
        except (OSError, ValueError) as exc:
            _log(f"could not write the journal entry {entry['t']}", exc)
            return
        run.state.apply(entry)

    def _finish(self, run: _Run, reason: str, report: FinalReport | None,
                catch_up: float | None) -> None:
        run.ended_at = self.clock.now()
        db_health = run.sampler.db_health_state if run.sampler else "not_sampled"
        try:
            result = build_results(state=run.state, profile=run.profile, metrics=run.metrics,
                                   report=report, catch_up_seconds=catch_up,
                                   ended_at=run.ended_at, reason=reason, secrets=run.secrets,
                                   db_health=db_health)
            self._result = result
            write_results(run.run_dir, result)
        except (OSError, ValueError) as exc:
            _log("could not save results.json", exc)
            self.error = "The result could not be saved to the run folder."
        self._journal(run, {"t": "run_finished", "reason": reason})
        run.finished = True
        if self._result is not None:
            verdict = self._result["verdict"]
            self._feed(run, "Result", verdict, ok=verdict != "Fail")
        self.phase = _END_PHASE[reason]

    async def _close(self, run: _Run, *, ended: bool) -> None:
        if run.ended_at is None:
            run.ended_at = self.clock.now()
        try:
            run.journal.close()
        except OSError as exc:
            _log("could not close the journal", exc)
        run.events.close()
        run.move_password, run.secrets = None, ()
        self._unfinished_cache = None
        portal, self._portal = self._portal, None
        self._password = self._move_password = None
        self._report = None
        if not ended:
            self.phase = "idle"
        if portal is not None:
            await portal.close()

    # ── stop, shutdown, wait ───────────────────────────────────────────

    async def stop(self) -> None:
        """Ends the run now; returns once its result is written (phase `stopped`)."""
        run, task = self._run, self._task
        if run is None or task is None or task.done() or self.phase not in ACTIVE:
            raise RunnerError("bad_phase")
        run.stop_event.set()
        if self.phase == "starting" and run.fleet is not None:
            await run.fleet.stop()
        await asyncio.wait({task})

    async def shutdown(self) -> None:
        """For the web app's shutdown: an active run is interrupted, not stopped, so it
        can be continued the next time the tool starts."""
        task = self._task
        if task is not None and not task.done():
            self._interrupting = True
            try:
                task.cancel()
                await asyncio.wait({task})
            finally:
                self._interrupting = False
        if not self._busy:
            await self._forget_connection()

    async def wait(self) -> None:
        """Returns when the current run task has ended."""
        task = self._task
        if task is not None and not task.done():
            await asyncio.wait({task})

    # ── unfinished runs ────────────────────────────────────────────────

    def unfinished(self) -> dict | None:
        """The newest unfinished run on disk; None while a run is active here."""
        if self._active():
            return None
        try:
            path = find_unfinished(self.runs_dir)
            if path is None:
                return None
            stat = path.stat()
        except OSError:
            return None
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if self._unfinished_cache is not None and self._unfinished_cache[0] == key:
            return self._unfinished_cache[1]
        try:
            state = load_state(path)
            last = state.profile_raw["stage"][-1]["key"]
            summary = {
                "run_dir": str(path.parent), "server": state.server_url,
                "move_name": state.move_name, "speed": state.profile_name,
                "started_at": state.started_at, "servers": len(state.servers),
                "done": sum(last in s.done for s in state.servers.values()),
            }
        except Exception as exc:   # noqa: BLE001 - a damaged journal is reported as none
            if str(path) not in self._logged_journals:
                self._logged_journals.add(str(path))
                _log(f"could not read the unfinished run's journal {path}", exc)
            summary = None
        self._unfinished_cache = (key, summary)
        return summary

    def _mark_finished(self, path: Path, reason: str) -> None:
        try:
            journal = Journal(path)
            try:
                journal.append({"t": "run_finished", "reason": reason, "at": self.clock.now()})
            finally:
                journal.close()
        except OSError:
            raise RunnerError("cannot_write") from None
        self._unfinished_cache = None

    async def discard_unfinished(self) -> None:
        self._require_free()
        path = find_unfinished(self.runs_dir)
        if path is None:
            raise RunnerError("no_unfinished_run")
        self._mark_finished(path, "discarded")

    async def continue_run(self, password: str, move_password: str, email: str,
                           totp_code: str | None = None) -> dict:
        self._require_free()
        path = find_unfinished(self.runs_dir)
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
            await self._forget_connection()
            if await self._sign_in(state.server_url, email, password, totp_code) is None:
                return {"status": "totp_required"}
            try:
                move = await self._read_move(state.move_id)
                await self._verify_move_password(state.server_url, move_password, profile)
                run = self._open_run(state, profile, move, path.parent, move_password)
            except BaseException:
                await self._forget_connection()
                raise
        finally:
            self._busy = False
        if not any(resumed is None for _, resumed in state.interruptions):
            self._journal(run, {"t": "interrupted"}, at=_last_at(path) or state.started_at)
        self._journal(run, {"t": "resumed"})
        now = self.clock.now()
        down = now - min((s for s, r in state.interruptions if r == now), default=now)
        self._launch(run, "Run continued", f"after {_duration(down)} down")
        return {"status": "ok"}

    async def _read_move(self, move_id: str) -> MoveInfo:
        try:
            return await self._portal.move(move_id)
        except CallFailed as exc:
            if exc.code == "redirected":
                raise RunnerError("redirected") from None
            if exc.status is None:
                raise RunnerError("unreachable") from None
            raise RunnerError("move_unreadable",
                              f"{MESSAGES['move_unreadable'][:-1]} (HTTP {exc.status}).") from None
        except BAD_ANSWER:
            raise RunnerError("bad_answer") from None

    async def _verify_move_password(self, url: str, move_password: str,
                                    profile: Profile) -> None:
        """One kiosk sign-in, the way every device of the fleet signs in."""
        device = KioskDevice(base_url=url, serial=CHECK_SERIAL, name=CHECK_NAME,
                             kind="handheld", metrics=Metrics(), clock=self.clock,
                             retry=NO_RETRY, timeout=profile.request_timeout_seconds,
                             transport=self._transport)
        try:
            await device.sign_in(move_password)
        except CallFailed as exc:
            if exc.status is None and exc.code is None:
                raise RunnerError("unreachable") from None
            raise RunnerError("move_password", SIGN_IN_FAILURES.get(exc.code or "") or (
                f"The kiosk sign-in failed (HTTP {exc.status}).")) from None
        except BAD_ANSWER:
            raise RunnerError("bad_answer") from None
        finally:
            await device.close()

    # ── what the page reads ────────────────────────────────────────────

    def result(self) -> dict | None:
        return self._result

    def snapshot(self) -> dict:
        run = self._run
        state = run.state if run else None
        profile = run.profile if run else self._profile
        report = self._report
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
            end = run.ended_at if run.ended_at is not None else self.clock.now()
            elapsed = round(max(0.0, end - state.started_at), 1)
        return {
            "phase": self.phase,
            "error": self.error,
            "connected": ({"server": self._server, "email": self._email}
                          if self._portal is not None else None),
            "needs_totp": self._needs_totp,
            "move": move,
            "speed": profile.name if profile else None,
            "started_at": state.started_at if state else None,
            "elapsed": elapsed,
            "overall": self._overall(state, profile, servers),
            "stages": self._stages(run, profile, servers, need_c, need_t),
            "trucks": self._trucks(state, profile),
            "server": {"waiting": latest.get("waiting"),
                       "waiting_peak": latest.get("waiting_peak", 0),
                       "workers": latest.get("workers"),
                       "failed_calls": run.metrics.failed_calls() if run else 0},
            "verdict": self._result["verdict"] if run and self._result else None,
            "counters": run.metrics.counters() if run else {},
            "feed_write_errors": self.events.write_errors,
            "run_dir": str(run.run_dir) if run else None,
            "check": _report_dict(report, self._profile) if report and self._profile else None,
            "unfinished": self.unfinished(),
        }

    @staticmethod
    def _overall(state: RunState | None, profile: Profile | None, servers: int) -> dict:
        if state is None or profile is None:
            return {"done": 0, "total": servers}
        last = profile.stages[-1].key
        return {"done": sum(last in s.done for s in state.servers.values()), "total": servers}

    @staticmethod
    def _stages(run: _Run | None, profile: Profile | None, servers: int, containers: int,
                trucks: int) -> list[dict]:
        if run is not None and run.pipeline is not None:
            return [asdict(p) for p in run.pipeline.progress()]
        if profile is None:
            return []
        totals = {"truck_load": containers, "truck_unload": containers, "trip": trucks}
        return [{"key": s.key, "label": s.label, "done": 0, "total": totals.get(s.kind, servers)}
                for s in profile.stages]

    @staticmethod
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
