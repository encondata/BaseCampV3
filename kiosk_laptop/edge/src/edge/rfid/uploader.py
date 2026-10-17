"""Pending RFID scans -> the portal (rfid scan processing spec §4).

Every 5 s (and right after the processor inserts) the oldest due `pending`
rows, at most 50, go to `POST /kiosk/station/scans` under the station key,
with no person session needed. One batch at a time. A resend reuses each
row's `client_scan_id`, so the portal never stores a scan twice.

Answers:
- 200: accepted ids are `accepted` (`was_accepted`, `accepted_at`); rejected
  ids are `rejected` with their code and never retried. A `clear_setup` in
  the reply applies Clear Setup as the heartbeat does (drops the shared
  setup and the key), which stops uploading.
- no key, 401 (the key is dropped by `station_key`), 423 read-only mode:
  no attempt is spent; 401 and 423 back off 60 s.
- anything else (network error, timeout, 5xx, 429, other 4xx): a failed
  attempt, retried after GAPS[attempt] (30 s ... 10 min, then 30 min).

Before sending rows that already failed 5 times (their next gap is 30 min),
the uploader probes `GET /system/status`: no 200 means no internet, so the
rows wait (`waiting_for_internet = 1`) and are probed again every 30 s
without spending attempts.

`last_error` is a short code or an exception type name, never anything that
could carry the key."""

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import httpx

from edge.db import Store, iso
from edge.rfid import station_key
from edge.upstream import CloudOffline

log = logging.getLogger("edge.rfid.uploader")

PATH = "/kiosk/station/scans"
BATCH = 50
INTERVAL_S = 5.0
GAPS = (30, 60, 120, 300, 600, 1800)
PROBE_AFTER = 5          # attempts after which a send waits for a probe
WAIT_S = 30              # probe interval while waiting for internet
PAUSE_S = 60             # 401 / 423: no attempt spent
NO_KEY = "no_station_key"
_SAFE_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")


def _code(resp: httpx.Response) -> str:
    try:
        code = resp.json()["detail"]["code"]
    except (ValueError, KeyError, TypeError):
        code = None
    if isinstance(code, str) and _SAFE_CODE.fullmatch(code):
        return code
    return f"http_{resp.status_code}"


async def probe_200(upstream) -> bool:
    """The internet probe: `GET /system/status` answering 200."""
    try:
        resp = await upstream.request("GET", "/system/status")
    except CloudOffline:
        return False
    except Exception as exc:  # noqa: BLE001
        log.info("internet probe failed: %s", type(exc).__name__)
        return False
    return resp.status_code == 200


def counts(store: Store) -> dict[str, int]:
    """The `rfid_uploads` block of /edge/status."""
    row = store.one(
        "SELECT COALESCE(SUM(upload_state = 'pending'), 0) AS pending, "
        "COALESCE(SUM(upload_state = 'pending' AND waiting_for_internet = 1), 0) AS waiting, "
        "COALESCE(SUM(upload_state = 'accepted'), 0) AS accepted, "
        "COALESCE(SUM(upload_state = 'rejected'), 0) AS rejected FROM pending_rfid_scans")
    return {"pending": row["pending"], "waiting_for_internet": row["waiting"],
            "accepted": row["accepted"], "rejected": row["rejected"]}


def _scan(row) -> dict:
    scan = {
        "client_scan_id": row["client_scan_id"],
        "scanned_value": row["epc"],
        "scan_type": "rfid",
        "scanned_at": row["scanned_at"],
        "site_id": row["site_id"],
        "initiative_id": row["initiative_id"],
        "scan_status": row["scan_status"],
        "off_move": bool(row["off_move"]),
    }
    if row["matched_kind"] == "asset":
        scan["asset_id"] = row["matched_id"]
    return scan


class Uploader:
    def __init__(self, store: Store, st, *, clock: Callable[[], float] = time.time,
                 probe: Callable[[], Awaitable[bool]] | None = None) -> None:
        self.store = store
        self.st = st
        self.clock = clock
        self.probe = probe or (lambda: probe_200(st.upstream))
        self.lock = asyncio.Lock()
        self.last_ok = False  # the last batch got a 200: a backlog may go on at once

    def _at(self, offset: float = 0) -> str:
        return iso(datetime.fromtimestamp(self.clock() + offset, UTC))

    def due_rows(self, limit: int = BATCH) -> list:
        return self.store.all(
            "SELECT * FROM pending_rfid_scans WHERE upload_state = 'pending' "
            "AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?",
            (self._at(), limit))

    def _update(self, sql: str, params: tuple, ids: list) -> None:
        if not ids:
            return
        marks = ",".join("?" * len(ids))
        self.store.run(f"{sql} WHERE id IN ({marks})", (*params, *ids))

    async def drain_once(self) -> int:
        """Send at most one batch; the number of scans sent (0 when nothing
        went out: nothing due, no key, or waiting for internet)."""
        async with self.lock:
            self.last_ok = False
            return await self._drain()

    async def _drain(self) -> int:
        rows = self.due_rows()
        if not rows:
            return 0
        if not station_key.has_key(self.store):
            self._update("UPDATE pending_rfid_scans SET last_error = ?", (NO_KEY,),
                         [r["id"] for r in rows])
            return 0
        late = [r["id"] for r in rows if r["attempts"] >= PROBE_AFTER]
        if late:
            if await self.probe():
                self._update("UPDATE pending_rfid_scans SET waiting_for_internet = 0", (), late)
            else:
                self._update("UPDATE pending_rfid_scans SET waiting_for_internet = 1, "
                             "next_attempt_at = ?", (self._at(WAIT_S),), late)
                rows = [r for r in rows if r["attempts"] < PROBE_AFTER]
                if not rows:
                    return 0
        ids = [r["id"] for r in rows]
        body = {"serial": self.st.identity.serial, "scans": [_scan(r) for r in rows]}
        try:
            resp = await station_key.station_request(self.st, "POST", PATH, json=body)
        except CloudOffline:
            self._failed(rows, "CloudOffline")
            return len(rows)
        except Exception as exc:  # noqa: BLE001 — a background caller must never break
            self._failed(rows, type(exc).__name__)
            return len(rows)
        if resp is None:  # the key went away between the check and the send
            self._update("UPDATE pending_rfid_scans SET last_error = ?", (NO_KEY,), ids)
            return 0
        if resp.status_code in (401, 423):
            code = _code(resp)
            self._update("UPDATE pending_rfid_scans SET last_error = ?, next_attempt_at = ?",
                         (code, self._at(PAUSE_S)), ids)
            log.info("rfid upload paused: portal answered %s", resp.status_code)
            return 0
        if resp.status_code != 200:
            self._failed(rows, _code(resp))
            return len(rows)
        try:
            data = resp.json()
            accepted = {str(x) for x in data.get("accepted") or []}
            rejected = {str(x["client_scan_id"]): str(x.get("code") or "rejected")
                        for x in data.get("rejected") or []}
            clear = data.get("clear_setup")
        except (ValueError, AttributeError, KeyError, TypeError):
            self._failed(rows, "bad_answer")
            return len(rows)
        self._apply(rows, accepted, rejected)
        self.last_ok = not clear
        if clear:
            station_key.apply_clear_setup(self.store)
            log.info("clear setup received with an rfid upload: setup and station key dropped")
        return len(rows)

    def _apply(self, rows: list, accepted: set[str], rejected: dict[str, str]) -> None:
        now = self._at()
        unanswered = []
        with self.store.tx() as c:
            for r in rows:
                sid = r["client_scan_id"]
                if sid in accepted:
                    c.execute("UPDATE pending_rfid_scans SET upload_state = 'accepted', "
                              "was_accepted = 1, accepted_at = ?, last_error = NULL, "
                              "waiting_for_internet = 0, next_attempt_at = NULL WHERE id = ?",
                              (now, r["id"]))
                elif sid in rejected:
                    code = rejected[sid]
                    code = code if _SAFE_CODE.fullmatch(code) else "rejected"
                    c.execute("UPDATE pending_rfid_scans SET upload_state = 'rejected', "
                              "reject_code = ?, waiting_for_internet = 0, "
                              "next_attempt_at = NULL WHERE id = ?", (code, r["id"]))
                else:
                    unanswered.append(r)
        if unanswered:
            self._failed(unanswered, "not_answered")

    def _failed(self, rows: list, error: str) -> None:
        log.info("rfid upload of %d scans failed: %s", len(rows), error)
        with self.store.tx() as c:
            for r in rows:
                attempts = r["attempts"] + 1
                gap = GAPS[min(attempts, len(GAPS)) - 1]
                c.execute("UPDATE pending_rfid_scans SET attempts = ?, next_attempt_at = ?, "
                          "last_error = ?, waiting_for_internet = 0 WHERE id = ?",
                          (attempts, self._at(gap), error, r["id"]))
