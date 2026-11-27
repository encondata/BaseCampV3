"""One run as one background task: fleet start, sampler and pipeline, catch-up wait,
final check, result. However the task ends, every task it started is gone and every file
it opened is closed before it reports back."""

from __future__ import annotations

import asyncio
import functools
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .actions import Actions
from .client.portal import MoveInfo, PortalClient
from .clock import Clock
from .connection import RunnerError, log, safe_error
from .events import Events, FeedLine
from .finalcheck import FinalReport, final_check
from .fleet import Fleet, FleetError
from .journal import JOURNAL_NAME, Journal
from .metrics import Metrics
from .pipeline import Pipeline, Step
from .profile import Profile
from .results import build_results, write_results
from .sampler import Sampler
from .state import RunState

ACTIVE = ("starting", "running", "finishing")
FLIGHT_WAIT = 30.0          # seconds a stop waits for calls in flight
RUNNER = "Runner"           # the feed's device name for the runner's own lines
EVENTS_LOG = "events.log"
_END_PHASE = {"completed": "done", "stopped": "stopped", "error": "error"}


class RunEvents(Events):
    """A run's feed: its own ring and events.log, and every line passed on to the hub the
    page subscribes to once."""

    def __init__(self, log_path: Path, hub: Events) -> None:
        super().__init__(log_path)
        self._hub = hub

    def feed(self, line: FeedLine) -> None:
        super().feed(line)
        self._hub.feed(line)


@dataclass
class Run:
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


async def cancel_tasks(*tasks: asyncio.Task | None) -> None:
    live = [t for t in tasks if t is not None]
    for task in live:
        task.cancel()
    await asyncio.gather(*live, return_exceptions=True)


Outcome = tuple[str, FinalReport | None, float | None]


class RunDriver:
    """Runs one run at a time. `on_phase(phase)` reports each phase change;
    `on_closed(ended)` is awaited once the run task has closed everything (`ended` is
    False when the run was cancelled before it could finish)."""

    def __init__(self, *, clock: Clock, transport: httpx.AsyncBaseTransport | None,
                 hub: Events, on_phase: Callable[[str], None],
                 on_closed: Callable[[bool], Awaitable[None]]) -> None:
        self.clock = clock
        self._transport = transport
        self._hub = hub
        self._on_phase = on_phase
        self._on_closed = on_closed
        self.phase = "idle"
        self.run: Run | None = None
        self.task: asyncio.Task | None = None
        self.result: dict | None = None
        self.error: str | None = None
        self.interrupting = False

    @property
    def active(self) -> bool:
        return self.task is not None and not self.task.done()

    def _set_phase(self, phase: str) -> None:
        self.phase = phase
        self._on_phase(phase)

    def forget_run(self) -> None:
        if not self.active:
            self.run = None

    # ── opening and launching ──────────────────────────────────────────

    def open_run(self, *, state: RunState, profile: Profile, move: MoveInfo, run_dir: Path,
                 portal: PortalClient, move_password: str, secrets: tuple[str, ...]) -> Run:
        try:
            journal = Journal(run_dir / JOURNAL_NAME)
        except OSError:
            raise RunnerError("cannot_write") from None
        try:
            events = RunEvents(run_dir / EVENTS_LOG, self._hub)
        except OSError:
            journal.close()
            raise RunnerError("cannot_write") from None
        metrics = Metrics()
        portal.metrics, portal.retry = metrics, profile.retry
        run = Run(state=state, profile=profile, move=move, run_dir=run_dir, journal=journal,
                  events=events, metrics=metrics, portal=portal, move_password=move_password,
                  secrets=secrets)
        run.idle.set()
        run.pipeline = Pipeline(profile, state, functools.partial(self._perform, run),
                                self.clock, random.Random(state.run_id.int), journal)
        return run

    def launch(self, run: Run, action: str, subject: str) -> None:
        self.run, self.error, self.result = run, None, None
        self._set_phase("starting")
        self.feed(run, action, subject)
        self.task = asyncio.create_task(self._run_task(run))

    def feed(self, run: Run, action: str, subject: str = "", ok: bool = True) -> None:
        run.events.feed(FeedLine(self.clock.now(), RUNNER, action, subject, ok, None))

    def journal(self, run: Run, entry: dict, at: float | None = None) -> None:
        entry["at"] = self.clock.now() if at is None else at
        try:
            run.journal.append(entry)
        except (OSError, ValueError) as exc:
            log(f"could not write the journal entry {entry['t']}", exc)
            return
        run.state.apply(entry)

    # ── stop, interrupt, wait ──────────────────────────────────────────

    async def stop(self) -> None:
        run, task = self.run, self.task
        if run is None or task is None or task.done() or self.phase not in ACTIVE:
            raise RunnerError("bad_phase")
        run.stop_event.set()
        if self.phase == "starting" and run.fleet is not None:
            await run.fleet.stop()
        await asyncio.wait({task})

    async def interrupt(self) -> None:
        task = self.task
        if task is not None and not task.done():
            self.interrupting = True
            try:
                task.cancel()
                await asyncio.wait({task})
            finally:
                self.interrupting = False

    async def wait(self) -> None:
        task = self.task
        if task is not None and not task.done():
            await asyncio.wait({task})

    # ── the run task ───────────────────────────────────────────────────

    async def _run_task(self, run: Run) -> None:
        outcome = None
        try:
            outcome = await self._outcome(run)
        finally:
            try:
                await self._teardown(run)
            finally:
                if outcome is not None:
                    self._finish(run, *outcome)
                elif self.interrupting and not run.finished:
                    self.journal(run, {"t": "interrupted"})
                await self._close(run, ended=outcome is not None)

    async def _outcome(self, run: Run) -> Outcome:
        try:
            return await self._drive(run)
        except Exception as exc:
            self.error = safe_error(exc)
            log("the run stopped", exc)
            return "error", None, None

    async def _drive(self, run: Run) -> Outcome:
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
        self.feed(run, "Devices ready", f"{len(run.fleet.devices)} devices")
        run.actions = Actions(profile=run.profile, state=run.state, fleet=run.fleet,
                              portal=run.portal, events=run.events, metrics=run.metrics,
                              clock=self.clock)
        run.rules = await self._rules(run)
        run.sampler = Sampler(portal=run.portal, move_id=run.state.move_id,
                              metrics=run.metrics, clock=self.clock,
                              every=run.profile.sample_seconds)
        self._set_phase("running")
        run.tasks["sampler"] = asyncio.create_task(run.sampler.run())
        run.tasks["pipeline"] = asyncio.create_task(run.pipeline.run())
        if not await self._until_stop(run, run.tasks["pipeline"]):
            return await self._stop_mid_run(run)
        run.tasks["pipeline"].result()      # an engine failure ends the run as an error
        return await self._catch_up_and_check(run)

    def _stopped_at_start(self, run: Run) -> Outcome:
        self.feed(run, "Run stopped", "while the devices were starting")
        return "stopped", None, None

    async def _until_stop(self, run: Run, task: asyncio.Task) -> bool:
        """True when `task` ended first, False when a stop came first."""
        stop = asyncio.create_task(run.stop_event.wait())
        try:
            done, _ = await asyncio.wait({task, stop}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            await cancel_tasks(stop)
        return task in done

    async def _within(self, awaitable, seconds: float) -> None:
        """Waits for `awaitable`, at most `seconds` on the run's clock."""
        waiter = asyncio.ensure_future(awaitable)
        timer = asyncio.create_task(self.clock.sleep(seconds))
        try:
            await asyncio.wait({waiter, timer}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            await cancel_tasks(waiter, timer)

    async def _perform(self, run: Run, step: Step) -> bool:
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

    async def _stop_mid_run(self, run: Run) -> Outcome:
        # A call in flight finishes and is journaled (the crew records it before its next
        # await); no new call starts.
        run.stopping = True
        if run.in_flight:
            await self._within(run.idle.wait(), FLIGHT_WAIT)
        await cancel_tasks(run.tasks.get("pipeline"), run.tasks.get("sampler"))
        await run.fleet.stop()
        self._set_phase("finishing")
        self.feed(run, "Run stopped")
        return "stopped", await self._final_check(run, stopped_early=True), None

    async def _catch_up_and_check(self, run: Run) -> Outcome:
        await cancel_tasks(run.tasks.get("sampler"))
        await run.fleet.stop()
        self._set_phase("finishing")
        self.feed(run, "Move finished; waiting for the server to catch up")
        catch = asyncio.create_task(run.sampler.wait_for_catch_up())
        run.tasks["catch_up"] = catch
        if not await self._until_stop(run, catch):
            await cancel_tasks(catch)
            self.feed(run, "Run stopped")
            return "stopped", await self._final_check(run, stopped_early=True), None
        catch_up = catch.result()
        if catch_up is not None:
            self.feed(run, "Server caught up", f"{catch_up:.0f} s")
        else:
            waiting = run.sampler.latest.get("waiting")
            self.feed(run, "Server did not catch up",
                      "the waiting count could not be read" if waiting is None
                      else f"{waiting:,} scans still waiting", ok=False)
        return "completed", await self._final_check(run, stopped_early=False), catch_up

    async def _rules(self, run: Run) -> set[str] | None:
        try:
            return await run.portal.rule_checkpoints()
        except Exception:   # noqa: BLE001 - a failed read falls back to the earlier one
            return None

    async def _final_check(self, run: Run, *, stopped_early: bool) -> FinalReport:
        self.feed(run, "Final check")
        rules = await self._rules(run)
        if rules is None:
            rules = run.rules or set()
        return await final_check(portal=run.portal, state=run.state, profile=run.profile,
                                 metrics=run.metrics, rule_checkpoints=rules,
                                 stopped_early=stopped_early)

    async def _teardown(self, run: Run) -> None:
        run.stopping = True
        await cancel_tasks(*run.tasks.values())
        if run.fleet is not None:
            await run.fleet.stop()

    def _finish(self, run: Run, reason: str, report: FinalReport | None,
                catch_up: float | None) -> None:
        run.ended_at = self.clock.now()
        db_health = run.sampler.db_health_state if run.sampler else "not_sampled"
        try:
            result = build_results(state=run.state, profile=run.profile, metrics=run.metrics,
                                   report=report, catch_up_seconds=catch_up,
                                   ended_at=run.ended_at, reason=reason, secrets=run.secrets,
                                   db_health=db_health)
            self.result = result
            write_results(run.run_dir, result)
        except (OSError, ValueError) as exc:
            log("could not save results.json", exc)
            self.error = "The result could not be saved to the run folder."
        self.journal(run, {"t": "run_finished", "reason": reason})
        run.finished = True
        if self.result is not None:
            verdict = self.result["verdict"]
            self.feed(run, "Result", verdict, ok=verdict != "Fail")
        self._set_phase(_END_PHASE[reason])

    async def _close(self, run: Run, *, ended: bool) -> None:
        if run.ended_at is None:
            run.ended_at = self.clock.now()
        try:
            run.journal.close()
        except OSError as exc:
            log("could not close the journal", exc)
        run.events.close()
        run.move_password, run.secrets = None, ()
        if not ended:
            self.phase = "idle"
        await self._on_closed(ended)
