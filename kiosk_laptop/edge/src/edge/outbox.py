"""The upstream queue. The browser's own outbox sends scans to the edge,
which accepts them at once and owns getting them to the cloud: in order,
batched (≤100, the cloud's limit), as the person whose session took them.
Offline (including an unhealthy cloud, see upstream.py) is not a failure —
rows stay queued and no attempt is spent. A cloud rejection code is final
(shown, never retried). Transient answers (5xx, 408, 423, 429) back off
along BACKOFF_S and then keep retrying at its last step forever. `failed`
(operator: Retry failed) is only for a non-transient 4xx, or a malformed
answer that is still malformed at the end of the ladder. A person with no
usable cloud session parks their rows as `needs_sign_in` until they sign
in online again (release_waiting). Sent rows are pruned after a week."""

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
SENT_KEEP_DAYS = 7


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
        # A row is eligible only if the same person has no EARLIER row still
        # waiting (queued/sending but not yet due): back-off must not let later
        # scans overtake. `failed` rows do not block.
        now = now_iso()
        rows = self.store.all(
            "SELECT * FROM outbox o WHERE o.status = 'queued' AND o.next_attempt_at <= ? "
            "AND NOT EXISTS (SELECT 1 FROM outbox e WHERE e.person_id = o.person_id "
            "AND e.id < o.id AND e.status IN ('queued', 'sending') AND e.next_attempt_at > ?) "
            "ORDER BY o.id LIMIT ?", (now, now, SCAN_BATCH))
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

    def _back_off(self, rows: list, error: str, *, forever: bool = False) -> None:
        """Next attempt along BACKOFF_S. A transient answer (`forever`) stays
        at the last step indefinitely; a malformed one ends `failed`."""
        for row in rows:
            attempts = row["attempts"] + 1
            if attempts > len(BACKOFF_S) and not forever:
                self._set([row["id"]], "failed", error)
                continue
            step = BACKOFF_S[min(attempts, len(BACKOFF_S)) - 1]
            due = iso(datetime.now(UTC) + timedelta(seconds=step))
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
            except Exception:
                self._back_off(group, "bad_response")
                continue
            if resp is None:
                self._set(ids, "needs_sign_in")
                continue
            try:
                sent += self._handle(group, resp)
            except Exception:
                self._back_off(group, "bad_response")
        await self._end_sessions()
        self._prune_sent()
        return sent

    def _prune_sent(self) -> None:
        cutoff = iso(datetime.now(UTC) - timedelta(days=SENT_KEEP_DAYS))
        self.store.run("DELETE FROM outbox WHERE status = 'sent' AND created_at < ?", (cutoff,))

    def _handle(self, group: list, resp) -> int:
        """Apply one response to its rows; returns rows sent. May raise on a
        malformed body — the caller backs the whole group off."""
        ids = [r["id"] for r in group]
        if resp.status_code in (200, 204):
            if group[0]["kind"] != KIND_SCAN:
                self._set(ids, "sent")
                return len(ids)
            body = resp.json()
            # the cloud answers canonical (lower-case) UUIDs
            accepted = {str(a).lower() for a in body["accepted"]}
            rejected = {str(r["client_scan_id"]).lower(): r["code"]
                        for r in body.get("rejected", [])}
            sent = 0
            unacked = []
            for row in group:
                scan_id = str(json.loads(row["payload"]).get("client_scan_id")).lower()
                if scan_id in rejected:
                    self._set([row["id"]], "rejected", rejected[scan_id])
                elif scan_id in accepted:
                    self._set([row["id"]], "sent")
                    sent += 1
                else:
                    unacked.append(row)
            if unacked:
                self._back_off(unacked, "not_acknowledged")
            return sent
        if resp.status_code >= 500 or resp.status_code in TRANSIENT:
            self._back_off(group, _code(resp), forever=True)
        else:
            self._set(ids, "failed", _code(resp))
        return 0

    async def _end_sessions(self) -> None:
        for person_id in self.upstream.ending_people():
            busy = self.store.one("SELECT 1 FROM outbox WHERE person_id = ? AND status IN "
                                  "('queued', 'sending')", (person_id,))
            if busy is None and not has_live_session(self.store, person_id):
                await self.upstream.end_session(person_id)
