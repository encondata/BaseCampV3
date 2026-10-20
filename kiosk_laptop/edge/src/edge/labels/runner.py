"""The Label Station's generation runs (edge/labels/generate.py does the
work): a request — Kiosk Setup's step 5, a sync, a changed DPI / label kind /
printer — sets a pending flag, and the background label loop runs it.

Nothing runs between a Label Station setup and setup step 5 confirming
its settings (laptop_setup.label_confirmed): the confirming PUT
/edge/label-station requests the 'setup' run.

A run that has labels to render records its progress in the one
`label_run` row (`state` 'running', `total`, `done`), which the kiosk shows
as the yellow regeneration screen; a run with nothing to render never
touches the row, so a sync that changed no label shows nothing. Requests
coalesce: one arriving during a run runs once more after it.

A row still 'running' at start-up is a run the laptop stopped part-way
(each label row is replaced only when its new version is ready): it is
requested again with the same reason, so the next pass finishes it."""

import asyncio
import logging
from collections.abc import Callable
from typing import Literal

from edge import laptop_setup
from edge.db import Store, now_iso
from edge.labels import generate

log = logging.getLogger("edge.labels")

Reason = Literal["setup", "updates"]


class LabelRunner:
    def __init__(self, store: Store, *, render: Callable = generate.render_job,
                 wake: asyncio.Event | None = None) -> None:
        self.store = store
        self.render = render
        self.wake = wake
        self._pending: Reason | None = None
        # bumped by forget(): a run that started before a wipe writes nothing more
        self._generation = 0
        self._retry = False  # a failed run: requested again after this pass, without a wake
        row = store.one("SELECT state, reason, pending FROM label_run WHERE id = 1")
        if row is not None and (row["state"] == "running" or row["pending"]):
            reason = row["reason"] if row["reason"] in ("setup", "updates") else "updates"
            store.run("UPDATE label_run SET state = 'idle' WHERE id = 1")
            self.request(reason)

    @property
    def pending(self) -> Reason | None:
        return self._pending

    def request(self, reason: Reason, *, wake: bool = True) -> None:
        """Ask for a run; 'setup' wins over 'updates' while both wait.
        `wake=False` leaves it for the label loop's next timed pass."""
        if self._pending != "setup":
            self._pending = reason
        self.store.run("INSERT INTO label_run (id, pending) VALUES (1, 1) "
                       "ON CONFLICT (id) DO UPDATE SET pending = 1")
        if wake and self.wake is not None:
            self.wake.set()

    def request_if_label_station(self, reason: Reason = "updates") -> None:
        setup = laptop_setup.load(self.store)
        if setup and setup.get("station_type") == "label":
            self.request(reason)

    def forget(self) -> None:
        """Wipe emptied the tables: nothing is pending any more, and a run in
        progress stops without writing another row."""
        self._pending = None
        self._retry = False
        self._generation += 1

    def running(self) -> bool:
        row = self.store.one("SELECT state FROM label_run WHERE id = 1")
        return row is not None and row["state"] == "running"

    async def run_pending(self) -> None:
        while self._pending is not None:
            reason, self._pending = self._pending, None
            self.store.run("UPDATE label_run SET pending = 0 WHERE id = 1")
            await self._run(reason)
        if self._retry:
            # one retry per failure, on the loop's next timed pass (never at once)
            self._retry = False
            self.request("updates", wake=False)

    async def _run(self, reason: Reason) -> None:
        generation = self._generation
        if not laptop_setup.label_confirmed(laptop_setup.load(self.store)):
            return  # set up again, settings not yet confirmed by setup step 5
        plan = generate.build_plan(self.store)
        if plan is None or not plan.has_asset_data:
            return  # not a Label Station, or nothing synced to build from
        changed = generate.changed_jobs(self.store, plan)
        if not changed:
            generate.prune(self.store, plan)
            return
        if reason != "setup" and not self._has_labels(plan):
            reason = "setup"
        if plan.template_json is not None and \
                generate.template_schema(plan.template_json) > generate.SUPPORTED_SCHEMA:
            # every label of it is stored as template_unsupported (the
            # status's `unsupported` count); the station says to update
            log.warning("label template %s is design schema %d; this edge prints up to %d",
                        plan.template.id, generate.template_schema(plan.template_json),
                        generate.SUPPORTED_SCHEMA)
        self.store.run(
            "INSERT INTO label_run (id, state, reason, total, done, started_at, finished_at) "
            "VALUES (1, 'running', ?, ?, 0, ?, NULL) ON CONFLICT (id) DO UPDATE SET "
            "state = 'running', reason = excluded.reason, total = excluded.total, done = 0, "
            "started_at = excluded.started_at, finished_at = NULL",
            (reason, len(changed), now_iso()))
        try:
            for done, job in enumerate(changed, start=1):
                zpl, error = await asyncio.to_thread(self.render, plan.template_json, job)
                if self._generation != generation:
                    return  # wiped mid-run: the tables are empty and stay so
                generate.apply(self.store, plan, job, zpl, error)
                self.store.run("UPDATE label_run SET done = ? WHERE id = 1", (done,))
            if self._generation != generation:
                return
            generate.prune(self.store, plan)
        except Exception:
            # never leave the station stuck behind the regeneration screen;
            # one retry is requested, paced by the label loop's wait (a
            # cancel at shutdown stays 'running', so the next start finishes it)
            log.exception("label run failed")
            if self._generation == generation:
                self._retry = True
        if self._generation != generation:
            return
        self.store.run("UPDATE label_run SET state = 'idle', finished_at = ? WHERE id = 1",
                       (now_iso(),))

    def _has_labels(self, plan: generate.Plan) -> bool:
        ids = {r["asset_id"] for r in self.store.all("SELECT asset_id FROM station_labels")}
        return any(job.asset_id in ids for job in plan.assets)
