"""The upstream queue. The browser's own outbox sends scans to the edge,
which accepts them at once and owns getting them to the cloud: in order,
batched (≤100, the cloud's limit), as the person whose session took them.
Offline is not a failure — rows stay queued and no attempt is spent. A
cloud rejection code is final (shown, never retried); 5xx/408/423/429 back
off along BACKOFF_S and end `failed` (operator: Retry failed); a person
with no usable cloud session parks their rows as `needs_sign_in` until they
sign in online again (release_waiting)."""

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from edge.db import Store, iso, now_iso
from edge.sessions import has_live_session
from edge.upstream import CloudOffline, Upstream

KIND_SCAN = "scan"
KIND_PRINTER = "printer_event"
BACKOFF_S = (5, 15, 60, 300, 900)
SCAN_BATCH = 100
STATUSES = ("queued", "sending", "sent", "rejected", "failed", "needs_sign_in")
PENDING = ("queued", "sending", "needs_sign_in", "failed")
TRANSIENT = {408, 423, 429}


def _insert(store: Store, kind: str, person_id: str, person_name: str, payload: dict,
            dedupe_key: str | None) -> None:
    now = now_iso()
    store.run(
        "INSERT OR IGNORE INTO outbox (kind, person_id, person_name, payload, next_attempt_at, "
        "created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (kind, person_id, person_name, json.dumps(payload), now, now, dedupe_key))


def enqueue_scans(store: Store, person_id: str, person_name: str, scans: list[dict]) -> None:
    for scan in scans:
        _insert(store, KIND_SCAN, person_id, person_name, scan,
                f"scan:{scan['client_scan_id']}")


def enqueue_printer_event(store: Store, person_id: str, person_name: str,
                          payload: dict) -> None:
    _insert(store, KIND_PRINTER, person_id, person_name, payload, None)


def release_waiting(store: Store, person_id: str) -> int:
    return store.run("UPDATE outbox SET status = 'queued', next_attempt_at = ? "
                     "WHERE person_id = ? AND status = 'needs_sign_in'", (now_iso(), person_id))


def retry_failed(store: Store) -> int:
    return store.run("UPDATE outbox SET status = 'queued', attempts = 0, next_attempt_at = ? "
                     "WHERE status IN ('failed', 'needs_sign_in')", (now_iso(),))


def requeue_sending(store: Store) -> None:
    store.run("UPDATE outbox SET status = 'queued' WHERE status = 'sending'")


def counts(store: Store) -> dict[str, int]:
    out = dict.fromkeys(STATUSES, 0)
    for row in store.all("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status"):
        out[row["status"]] = row["n"]
    return out


def waiting(store: Store) -> list[dict]:
    return [{"person_name": r["person_name"], "count": r["n"]} for r in store.all(
        "SELECT person_name, COUNT(*) AS n FROM outbox WHERE status = 'needs_sign_in' "
        "GROUP BY person_id, person_name ORDER BY person_name")]


def pending_count(store: Store) -> int:
    marks = ",".join("?" * len(PENDING))
    return store.one(f"SELECT COUNT(*) AS n FROM outbox WHERE status IN ({marks})",
                     PENDING)["n"]


def _code(resp) -> str:
    try:
        return resp.json()["detail"]["code"]
    except (ValueError, KeyError, TypeError):
        return f"http_{resp.status_code}"


class OutboxWorker:
    def __init__(self, store: Store, upstream: Upstream, serial_getter: Callable[[], str]) -> None:
        self.store = store
        self.upstream = upstream
        self.serial = serial_getter

    def _due_group(self) -> list:
        rows = self.store.all("SELECT * FROM outbox WHERE status = 'queued' AND "
                              "next_attempt_at <= ? ORDER BY id LIMIT ?", (now_iso(), SCAN_BATCH))
        if not rows:
            return []
        first = rows[0]
        if first["kind"] != KIND_SCAN:
            return [first]
        group = []
        for row in rows:
            if row["kind"] != KIND_SCAN or row["person_id"] != first["person_id"]:
                break
            group.append(row)
        return group

    def _set(self, ids: list[int], status: str, error: str | None = None) -> None:
        marks = ",".join("?" * len(ids))
        self.store.run(f"UPDATE outbox SET status = ?, last_error = ? WHERE id IN ({marks})",
                       (status, error, *ids))

    def _back_off(self, rows: list, error: str) -> None:
        for row in rows:
            attempts = row["attempts"] + 1
            if attempts > len(BACKOFF_S):
                self._set([row["id"]], "failed", error)
                continue
            due = iso(datetime.now(UTC) + timedelta(seconds=BACKOFF_S[attempts - 1]))
            self.store.run("UPDATE outbox SET status = 'queued', attempts = ?, "
                           "next_attempt_at = ?, last_error = ? WHERE id = ?",
                           (attempts, due, error, row["id"]))

    async def _send(self, rows: list):
        first = rows[0]
        if first["kind"] == KIND_SCAN:
            body = {"serial": self.serial(), "scans": [json.loads(r["payload"]) for r in rows]}
            return await self.upstream.as_person(first["person_id"], "POST", "/kiosk/scans",
                                                 json=body)
        body = {**json.loads(first["payload"]), "serial": self.serial()}
        return await self.upstream.as_person(first["person_id"], "POST",
                                             "/kiosk/printer-events", json=body)

    async def drain_once(self) -> int:
        sent = 0
        while group := self._due_group():
            ids = [r["id"] for r in group]
            self._set(ids, "sending")
            try:
                resp = await self._send(group)
            except CloudOffline:
                self._set(ids, "queued")
                break
            if resp is None:
                self._set(ids, "needs_sign_in")
                continue
            if resp.status_code in (200, 204):
                rejected = {}
                if group[0]["kind"] == KIND_SCAN and resp.status_code == 200:
                    rejected = {r["client_scan_id"]: r["code"]
                                for r in resp.json().get("rejected", [])}
                for row in group:
                    scan_id = json.loads(row["payload"]).get("client_scan_id")
                    if scan_id in rejected:
                        self._set([row["id"]], "rejected", rejected[scan_id])
                    else:
                        self._set([row["id"]], "sent")
                        sent += 1
            elif resp.status_code >= 500 or resp.status_code in TRANSIENT:
                self._back_off(group, _code(resp))
            else:
                self._set(ids, "failed", _code(resp))
        await self._end_sessions()
        return sent

    async def _end_sessions(self) -> None:
        for person_id in self.upstream.ending_people():
            busy = self.store.one("SELECT 1 FROM outbox WHERE person_id = ? AND status IN "
                                  "('queued', 'sending')", (person_id,))
            if busy is None and not has_live_session(self.store, person_id):
                await self.upstream.end_session(person_id)
