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
    "create": "Creating the move (the server's import worker does this; a big move takes a "
              "while)",
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


class Setup:
    """One move set-up at a time: its task and the state the snapshot shows."""

    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self._view: dict | None = None
        self._task: asyncio.Task | None = None

    def __repr__(self) -> str:
        return f"Setup(working={self.working})"

    @property
    def working(self) -> bool:
        return self._task is not None and not self._task.done()

    def snapshot(self) -> dict | None:
        return dict(self._view) if self._view else None

    def forget(self) -> None:
        """Drops the last set-up's view (never one that is still working)."""
        if not self.working:
            self._view = None

    def start(self, portal: PortalClient, plan: Plan, password: str, *,
              on_done: Callable[[str], Awaitable[None]]) -> None:
        """No await before the task exists: two calls at once cannot start two."""
        if self.working:
            raise RunnerError("setup_working")
        self._view = {"state": "working", "step": "draft", "step_label": STEPS["draft"],
                      "message": "", "move_id": None, **plan.view()}
        self._task = asyncio.create_task(self._run(portal, plan, password, on_done))

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
                   on_done: Callable[[str], Awaitable[None]]) -> None:
        try:
            move_id = await self._steps(portal, plan, password)
            del password
            await on_done(move_id)
        except StepFailed as failed:
            self._view.update(state="error", message=failed.message)
            return
        except Exception as exc:  # noqa: BLE001 - the page gets words, the terminal the type
            log("creating the move stopped", exc)
            self._view.update(state="error", message=(
                "Creating the move stopped because of an unexpected problem in the load test "
                f"tool ({self._view['step_label'].lower()}). The terminal shows what it was. "
                f'Look for "{plan.name}" in the portal\'s moves before trying again.'))
            return
        self._step("done")
        self._view.update(state="done", move_id=move_id)

    async def _steps(self, portal: PortalClient, plan: Plan, password: str) -> str:
        nothing = " Nothing was created."
        no_move = (" No move was created (the server removes the unfinished draft within a "
                   "day).")
        try:
            content = from_to_csv(plan)
        except TooLarge:
            raise StepFailed(f"A From-To list of {plan.servers:,} servers is larger than the "
                             "server accepts (20 MB), so nothing was created. Use fewer "
                             "servers.") from None
        try:
            draft = await portal.start_move_draft(plan.name, plan.origin.id,
                                                  plan.destination.id)
        except Exception as exc:
            raise StepFailed(f"The server did not start the move: {refusal(exc)}{nothing}") \
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
        lost = (f' It may still finish: look for "{plan.name}" in the portal\'s moves before '
                "trying again.")
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
        move_id = str(job["initiative_id"])

        made = f'The move "{plan.name}" was created'
        self._step("verify")
        try:
            servers = len(await portal.roster(move_id))
        except Exception as exc:
            raise StepFailed(f"{made}, but its servers could not be counted: {refusal(exc)} "
                             "It was not set In progress and has no move password. Check it "
                             "in the portal.") from None
        if servers != plan.servers:
            raise StepFailed(f"{made}, but it has {servers:,} servers, not {plan.servers:,}. "
                             "It was not set In progress and has no move password. Check it "
                             "in the portal.")

        self._step("activate")
        try:
            await portal.activate_move(move_id, password)
        except Exception as exc:
            raise StepFailed(f"{made} with {plan.servers:,} servers, but {refusal(exc)} It is "
                             "not In progress yet: set its move password and In progress on "
                             "the move in the portal.") from None
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
                raise StepFailed(f"The server did not move on for {STALL_SECONDS / 60:.0f} "
                                 "minutes. Check that its import worker is running.")
            await self.clock.sleep(POLL_SECONDS)
