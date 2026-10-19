"""The Label Station's generation runs (edge/labels/generate.py does the
work): a request — Kiosk Setup, a sync, a changed DPI / label kind /
printer — sets a pending flag, and the background label loop runs it.

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
        row = store.one("SELECT state, reason, pending FROM label_run WHERE id = 1")
        if row is not None and (row["state"] == "running" or row["pending"]):
            reason = row["reason"] if row["reason"] in ("setup", "updates") else "updates"
            store.run("UPDATE label_run SET state = 'idle' WHERE id = 1")
            self.request(reason)

    @property
    def pending(self) -> Reason | None:
        return self._pending

    def request(self, reason: Reason) -> None:
        """Ask for a run; 'setup' wins over 'updates' while both wait."""
        if self._pending != "setup":
            self._pending = reason
        self.store.run("INSERT INTO label_run (id, pending) VALUES (1, 1) "
                       "ON CONFLICT (id) DO UPDATE SET pending = 1")
        if self.wake is not None:
            self.wake.set()

    def request_if_label_station(self, reason: Reason = "updates") -> None:
        setup = laptop_setup.load(self.store)
        if setup and setup.get("station_type") == "label":
            self.request(reason)

    def forget(self) -> None:
        """Wipe emptied the tables: nothing is pending any more."""
        self._pending = None

    def running(self) -> bool:
        row = self.store.one("SELECT state FROM label_run WHERE id = 1")
        return row is not None and row["state"] == "running"

    async def run_pending(self) -> None:
        while self._pending is not None:
            reason, self._pending = self._pending, None
            self.store.run("UPDATE label_run SET pending = 0 WHERE id = 1")
            await self._run(reason)

    async def _run(self, reason: Reason) -> None:
        plan = generate.build_plan(self.store)
        if plan is None or not plan.has_asset_data:
            return  # not a Label Station, or nothing synced to build from
        changed = generate.changed_jobs(self.store, plan)
        if not changed:
            generate.prune(self.store, plan)
            return
        if reason != "setup" and not self._has_labels(plan):
            reason = "setup"
        self.store.run(
            "INSERT INTO label_run (id, state, reason, total, done, started_at, finished_at) "
            "VALUES (1, 'running', ?, ?, 0, ?, NULL) ON CONFLICT (id) DO UPDATE SET "
            "state = 'running', reason = excluded.reason, total = excluded.total, done = 0, "
            "started_at = excluded.started_at, finished_at = NULL",
            (reason, len(changed), now_iso()))
        try:
            for done, job in enumerate(changed, start=1):
                zpl, error = await asyncio.to_thread(self.render, plan.template_json, job)
                generate.apply(self.store, plan, job, zpl, error)
                self.store.run("UPDATE label_run SET done = ? WHERE id = 1", (done,))
            generate.prune(self.store, plan)
        except Exception:
            # never leave the station stuck behind the regeneration screen;
            # the next request tries again (a cancel at shutdown stays
            # 'running', so the next start finishes the run)
            log.exception("label run failed")
        self.store.run("UPDATE label_run SET state = 'idle', finished_at = ? WHERE id = 1",
                       (now_iso(),))

    def _has_labels(self, plan: generate.Plan) -> bool:
        ids = {r["asset_id"] for r in self.store.all("SELECT asset_id FROM station_labels")}
        return any(job.asset_id in ids for job in plan.assets)
