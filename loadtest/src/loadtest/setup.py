"""Creating a move on the server, the way the portal's Bulk Actions > Create a move in
steps does it, through the same routes (api/routes/move_setup.py):

1. a draft with the move's name and two sites;
2. a generated From-To list, checked by the server's import worker;
3. the containers and trucks;
4. the create, which the import worker applies in one transaction;
5. a count of the new move's servers;
6. the move password and In progress.

One set-up runs at a time, in the background. Its state is what the page draws; the
move password lives only in the running task and never reaches the state.
"""

from __future__ import annotations

import asyncio
import csv
import io
import math
import random
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .client.portal import PortalClient, SiteChoice
from .clock import Clock
from .connection import BAD_ANSWER, RunnerError
from .http import CallFailed
from .logline import log

HEADERS = [
    "Serial Number", "Asset Name", "Asset Make", "Asset Model", "RFID Tag", "Priority",
    "Disposition", "Owner", "Source Pod", "Source Rack", "Source RU", "Source Position",
    "Destination Pod", "Destination Rack", "Destination RU", "Destination Position",
    "Data 1", "Data 2", "Data 3", "Data 4", "Data 5", "Data 6", "Mgmt 1", "Mgmt 2",
    "Vendor Involvement",
]
MODELS = (("Dell", "PowerEdge R640"), ("HPE", "ProLiant DL360 Gen11"))     # one per rack
RACK_TOP = 36
# The portal wizard has no default crate type (it must be picked); this is the first of
# the server's seeded types (migration 0015), the one tests/e2e/make_move.py used.
CONTAINER_TYPE = "pelican_case"
UPLOAD_LIMIT = 20 * 1024 * 1024     # the server's own limit (imports/parsing.py MAX_BYTES)
POLL_SECONDS = 1.0
# A job that has not changed for this long is given up on: the same wait as
# tests/e2e/make_move.py, which ran against a real server.
STALL_SECONDS = 600.0
CHECK_FINAL = ("completed", "failed", "cancelled")
DRAFT_FINAL = ("completed", "failed", "preview")     # preview: the draft was reopened

STEPS = {
    "draft": "Starting the move on the server",
    "assets": "Sending the From-To list and waiting for the server to check it",
    "crates_trucks": "Adding the containers and trucks",
    "create": "Creating the move",
    "verify": "Checking that the move has every server",
    "activate": "Setting the move password and In progress",
    "done": "The move is ready",
}
NOT_ALLOWED = ("the portal account is not allowed to do this. Creating a move needs an admin "
               "account that can add moves, containers and trucks.")
REFUSALS = {
    "kiosk_password_forbidden": "the portal account is not allowed to set a move password; "
                                "that needs an admin account.",
    "kiosk_password_too_short": "the server refused its move password: it is too short.",
    "kiosk_password_contains_name": "the server refused its move password: it contains the "
                                    "move's name.",
    "kiosk_password_in_use": "the server refused its move password: another move already "
                             "uses it.",
    "name_required": "the move needs a name.",
    "site_not_found": "a site that was picked is no longer on the server. Pick the sites "
                      "again.",
    "bad_container_type": f'the server has no "{CONTAINER_TYPE}" container type. Add it to '
                          "the container types in the portal.",
    "file_too_large": "the From-To list is larger than the server accepts. Use fewer servers.",
    "client_choices_required": "some of the generated serial numbers belong to another "
                               "client's assets.",
}


def rack_units() -> list[int]:
    """Two servers, then one empty unit, up the rack; nothing above unit 36."""
    return [u for u in range(1, RACK_TOP) if u % 3 != 0]


def make_tag(rng: random.Random | None = None) -> str:
    """Six upper-case hex characters that keep one move's names apart from another's."""
    return f"{(rng or random.SystemRandom()).getrandbits(24):06X}"


@dataclass(frozen=True)
class Plan:
    name: str
    origin: SiteChoice
    destination: SiteChoice
    servers: int
    containers: int
    trucks: int
    tag: str

    def view(self) -> dict:
        return {"name": self.name, "servers": self.servers, "containers": self.containers,
                "trucks": self.trucks}

    def key(self) -> tuple:
        """What must match for a new set-up to carry on a failed one's move."""
        return (self.name, self.origin.id, self.destination.id, self.servers,
                self.containers, self.trucks)


class TooLarge(Exception):
    """The From-To would be larger than the server accepts."""


def from_to_csv(plan: Plan) -> bytes:
    """The From-To list: one row per server, 24 to a rack, one model per rack, the same
    rack and unit at both sites. No RFID tags: the run enrolls them."""
    units = rack_units()
    source = plan.origin.code or "SRC"
    destination = plan.destination.code or "DST"
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=HEADERS, lineterminator="\n")
    writer.writeheader()
    for i in range(plan.servers):
        rack, slot = divmod(i, len(units))
        make, model = MODELS[rack % len(MODELS)]
        n = i + 1
        writer.writerow({
            "Serial Number": f"LT{plan.tag}{n:05d}",
            "Asset Name": f"lt-{plan.tag.lower()}-{n:05d}",
            "Asset Make": make, "Asset Model": model,
            "Source Rack": f"{source}-R{rack + 1:03d}", "Source RU": str(units[slot]),
            "Destination Rack": f"{destination}-R{rack + 1:03d}",
            "Destination RU": str(units[slot]),
        })
        if out.tell() > UPLOAD_LIMIT:
            raise TooLarge
    return out.getvalue().encode("utf-8")


def _natural(name: str) -> list:
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name.lower())]


def site_rows(sites: list[SiteChoice]) -> list[dict]:
    """What the page's site pickers list, by name."""
    return [{"id": s.id, "name": s.name, "code": s.code,
             "has_location": s.lat is not None and s.lng is not None}
            for s in sorted(sites, key=lambda s: _natural(s.name))]


def minimums(servers: int, sizes: dict) -> tuple[int, int]:
    containers = math.ceil(servers / sizes["container_size"])
    return containers, math.ceil(containers / sizes["containers_per_truck"])


def check_inputs(*, sites: list[SiteChoice], name: str, origin_site_id: str,
                 destination_site_id: str, servers: int, containers: int, trucks: int,
                 sizes: dict | None) -> Plan:
    """The plan, or a RunnerError naming every bad field at once."""
    if not sizes:
        raise RunnerError("bad_profile", "The tool's speed profile could not be read, so it "
                          "cannot work out the containers and trucks. Check the profiles "
                          "folder, then start the tool again.")
    by_id = {s.id: s for s in sites}
    problems: list[tuple[str, str]] = []
    picked: dict[str, SiteChoice] = {}
    for field, site_id, role in (("origin_site_id", origin_site_id, "origin"),
                                 ("destination_site_id", destination_site_id, "destination")):
        site = by_id.get(site_id)
        if site is None:
            problems.append((field, f"The {role} site is not on the server. Pick it again."))
        elif site.lat is None or site.lng is None:
            problems.append((field, f"{site.name} has no latitude and longitude, so a truck "
                                    "cannot be routed to it. Add them to the site in the "
                                    "portal, or pick another site."))
        else:
            picked[field] = site
    if origin_site_id == destination_site_id and not problems:
        problems.append(("origin_site_id", "Pick two different sites: the origin and the "
                                           "destination are the same."))
        problems.append(("destination_site_id", ""))
    # the run's own need (profile.containers_needed, trucks_needed), from the servers
    need_c, need_t = minimums(servers, sizes)
    if containers < need_c:
        problems.append(("containers", f"{servers:,} servers need at least {need_c:,} "
                                       f"containers ({sizes['container_size']} servers each)."))
    if trucks < need_t:
        problems.append(("trucks", f"{need_c:,} containers need at least {need_t:,} trucks "
                                   f"({sizes['containers_per_truck']} containers each)."))
    if problems:
        fields = list(dict.fromkeys(f for f, _ in problems))
        message = " ".join(m for _, m in problems if m)
        raise RunnerError("setup_input", message, fields=fields)
    return Plan(name, picked["origin_site_id"], picked["destination_site_id"], servers,
                containers, trucks, make_tag())


# ── the steps ──────────────────────────────────────────────────────────


class StepFailed(Exception):
    """`message` is safe to show on the page."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def refusal(exc: Exception) -> str:
    """Why the server refused a call, as the end of a sentence."""
    if isinstance(exc, BAD_ANSWER):
        return "the server sent an answer this tool does not understand."
    if not isinstance(exc, CallFailed):
        raise exc
    detail = exc.detail or {}
    if exc.code == "redirected":
        return "the server address redirects. Use the address it redirects to."
    if exc.status is None:
        return "the server could not be reached."
    if exc.status == 401:
        return "the portal sign-in ended. Connect again."
    if exc.status == 403 and exc.code in (None, "forbidden"):
        return NOT_ALLOWED
    if exc.code in REFUSALS:
        return REFUSALS[exc.code]
    if exc.code == "invalid_naming" and isinstance(detail.get("message"), str):
        return f"the server said: {detail['message']}"
    reasons = detail.get("reasons")
    if isinstance(reasons, list) and reasons and all(isinstance(r, str) for r in reasons):
        return "the server said: " + " ".join(reasons)
    return f"the server answered with an error (HTTP {exc.status})."


PASSWORD_REFUSALS = ("kiosk_password_too_short", "kiosk_password_contains_name",
                     "kiosk_password_in_use")
SAME_MOVE = "the same move is used, no second one is made."
SECOND_MOVE = ("Pressing Create again would make a second move; look at this move in the "
               "portal instead.")


def activate_next(exc: Exception) -> str:
    """What to do after step 6 failed. Create with the same entries carries on this move
    (Setup keeps it until the next sign-in or run), except after a 401, which needs a new
    sign-in and so loses it."""
    code = exc.code if isinstance(exc, CallFailed) else None
    status = exc.status if isinstance(exc, CallFailed) else None
    if code in PASSWORD_REFUSALS:
        return f"Type another move password and press Create again: {SAME_MOVE}"
    if status == 401:
        return ("Set its move password and In progress on the move in the portal. Signing in "
                "again and pressing Create would make a second move.")
    if status == 403:
        return ("Set its move password and In progress on the move in the portal with an admin "
                "account. Pressing Create again with the same entries uses this same move (no "
                "second one is made), but this sign-in would be refused again.")
    return (f"Press Create again with the same entries to try once more: {SAME_MOVE} Or set "
            "its move password and In progress on the move in the portal.")


class Setup:
    """One move set-up at a time: its task and the state the snapshot shows."""

    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self._view: dict | None = None
        self._task: asyncio.Task | None = None
        # a move whose step 6 failed: {"key": Plan.key(), "move_id"}; never a password
        self._resume: dict | None = None
        self._made: str | None = None       # the running set-up's move, once it exists

    def __repr__(self) -> str:
        return f"Setup(working={self.working})"

    @property
    def working(self) -> bool:
        return self._task is not None and not self._task.done()

    def snapshot(self) -> dict | None:
        return dict(self._view) if self._view else None

    def forget(self) -> None:
        """Drops the last set-up's view and any move it could carry on (never while one
        is working)."""
        if not self.working:
            self._view = self._resume = None

    def start(self, portal: PortalClient, plan: Plan, password: str, *,
              on_done: Callable[[str, bool], Awaitable[None]]) -> None:
        """No await before the task exists: two calls at once cannot start two. When the
        last set-up failed at step 6 and `plan` has the same entries, only step 6 runs,
        on that move. `on_done(move_id, ready)` runs once the move exists on the server,
        ready or not."""
        if self.working:
            raise RunnerError("setup_working")
        resume, self._resume = self._resume, None
        move_id = resume["move_id"] if resume and resume["key"] == plan.key() else None
        step = "activate" if move_id else "draft"
        self._view = {"state": "working", "step": step, "step_label": STEPS[step],
                      "message": "", "move_id": None, **plan.view()}
        self._task = asyncio.create_task(self._run(portal, plan, password, on_done, move_id))

    async def wait(self) -> None:
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)

    async def cancel(self) -> None:
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def _step(self, key: str) -> None:
        self._view.update(step=key, step_label=STEPS[key])

    async def _run(self, portal: PortalClient, plan: Plan, password: str,
                   on_done: Callable[[str, bool], Awaitable[None]],
                   move_id: str | None) -> None:
        self._made = move_id
        try:
            if move_id is None:
                move_id = await self._steps(portal, plan)
            await self._activate(portal, plan, move_id, password)
        except StepFailed as failed:
            self._view.update(state="error", message=failed.message)
        except Exception as exc:  # noqa: BLE001 - the page gets words, the terminal the type
            log("creating the move stopped", exc)
            self._view.update(state="error", message=(
                "Creating the move stopped because of an unexpected problem in the load test "
                f"tool ({self._view['step_label'].lower()}). The terminal shows what it was. "
                f'Look for "{plan.name}" in the portal\'s moves before trying again.'))
        else:
            self._step("done")
            self._view.update(state="done", move_id=move_id)
        finally:
            del password
        if self._made is not None:
            try:
                await on_done(self._made, self._view["state"] == "done")
            except Exception as exc:  # noqa: BLE001 - the move list is a nicety
                log("the move list could not be brought up to date", exc)

    async def _activate(self, portal: PortalClient, plan: Plan, move_id: str,
                        password: str) -> None:
        """Step 6. A failure keeps the move for a set-up with the same entries."""
        self._step("activate")
        try:
            await portal.activate_move(move_id, password)
        except Exception as exc:
            if not isinstance(exc, (CallFailed, *BAD_ANSWER)):
                raise
            self._resume = {"key": plan.key(), "move_id": move_id}
            raise StepFailed(f'The move "{plan.name}" was created with {plan.servers:,} '
                             f"servers, but {refusal(exc)} It is not In progress yet. "
                             f"{activate_next(exc)}") from None

    async def _steps(self, portal: PortalClient, plan: Plan) -> str:
        """Steps 1 to 5: the move's id, with every server on it."""
        nothing = " Nothing was created."
        no_move = (" No move was created (the server removes the unfinished draft within a "
                   "day).")
        try:
            content = await asyncio.to_thread(from_to_csv, plan)
        except TooLarge:
            raise StepFailed(f"A From-To list of {plan.servers:,} servers is larger than the "
                             "server accepts (20 MB), so nothing was created. Use fewer "
                             "servers.") from None
        try:
            draft = await portal.start_move_draft(plan.name, plan.origin.id,
                                                  plan.destination.id)
        except Exception as exc:
            # never resent: an answer lost after the server made the draft leaves one behind
            unsure = isinstance(exc, CallFailed) and (exc.status is None or exc.status >= 500)
            after = (" No move was created (if the server did start one, it removes the "
                     "unfinished draft within a day)." if unsure else nothing)
            raise StepFailed(f"The server did not start the move: {refusal(exc)}{after}") \
                from None

        self._step("assets")
        try:
            await portal.upload_move_assets(draft, f"from-to-{plan.tag}.csv", content)
            check = await self._wait(lambda: portal.move_assets_check(draft), CHECK_FINAL)
        except StepFailed as failed:
            raise StepFailed(failed.message + no_move) from None
        except Exception as exc:
            raise StepFailed(f"The From-To list was not accepted: {refusal(exc)}{no_move}") \
                from None
        if check.get("status") != "completed":
            raise StepFailed("The server could not check the generated From-To list."
                             + no_move)
        summary = (check.get("results") or {}).get("summary") or {}
        bad = int(summary.get("errors") or 0) + int(summary.get("review") or 0)
        if bad:
            raise StepFailed(f"The server found problems in {bad:,} rows of the generated "
                             f"From-To list.{no_move}")

        self._step("crates_trucks")
        try:
            await portal.set_move_crates_trucks(
                draft,
                {"convention": f"CRT-{plan.tag}-xxx", "count": plan.containers, "start": 1,
                 "container_type": CONTAINER_TYPE},
                {"convention": f"TRK-{plan.tag}-xx", "count": plan.trucks, "start": 1})
        except Exception as exc:
            raise StepFailed(f"The containers and trucks were not accepted: "
                             f"{refusal(exc)}{no_move}") from None

        self._step("create")
        try:
            await portal.queue_move_create(draft)
        except Exception as exc:
            raise StepFailed(f"The server did not create the move: {refusal(exc)}{no_move}") \
                from None
        lost = (f' It may still finish: look for "{plan.name}" in the portal\'s moves. Pressing '
                "Create again would make a second move.")
        try:
            job = await self._wait(lambda: portal.move_draft(draft), DRAFT_FINAL)
        except StepFailed as failed:
            raise StepFailed(failed.message + lost) from None
        except Exception as exc:
            raise StepFailed(f"Lost touch with the server while it created the move: "
                             f"{refusal(exc)}{lost}") from None
        if job.get("status") != "completed" or not job.get("initiative_id"):
            reasons = (job.get("results") or {}).get("reasons")
            why = (" ".join(r for r in reasons if isinstance(r, str))
                   if isinstance(reasons, list) and reasons else "it did not finish.")
            raise StepFailed(f"The server could not create the move: {why}{nothing}")
        move_id = self._made = str(job["initiative_id"])

        made = f'The move "{plan.name}" was created'
        unready = f"It was not set In progress and has no move password. {SECOND_MOVE}"
        self._step("verify")
        try:
            servers = len(await portal.roster(move_id))
        except Exception as exc:
            raise StepFailed(f"{made}, but its servers could not be counted: {refusal(exc)} "
                             f"{unready}") from None
        if servers != plan.servers:
            raise StepFailed(f"{made}, but it has {servers:,} servers, not {plan.servers:,}. "
                             f"{unready}")
        return move_id

    async def _wait(self, read: Callable[[], Awaitable[dict]], final: tuple[str, ...]) -> dict:
        """Polls a server job until it ends. A server blip (unreachable, 5xx) is waited
        out; a job that has not changed for STALL_SECONDS is given up on."""
        last, since = None, self.clock.now()
        while True:
            try:
                job = await read()
            except CallFailed as exc:
                if exc.status is not None and exc.status < 500:
                    raise
                job = None
            if job is not None:
                if job.get("status") in final:
                    return job
                mark = (job.get("status"), job.get("processed_rows"))
                if mark != last:
                    last, since = mark, self.clock.now()
            if self.clock.now() - since >= STALL_SECONDS:
                raise StepFailed(f"The server stopped making progress for "
                                 f"{STALL_SECONDS / 60:.0f} minutes. Ask whoever runs the "
                                 "server to check it.")
            await self.clock.sleep(POLL_SECONDS)
