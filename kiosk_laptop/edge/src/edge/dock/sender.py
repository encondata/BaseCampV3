"""Closed Dock passes -> the portal (dock station spec: offline sending,
a late pass never overwrites newer packing).

The grouper leaves each closed live `pack` with `send_state = 'pending'`.
Every 5 s (and at once when the grouper closes one) the OLDEST pending pass
goes to `POST /kiosk/station/dock/passes` under the station key, with no
person session needed. One pass at a time and strictly in order: a pass
that keeps failing holds the line and later passes never jump ahead, so
crates pack on the portal in the order they went through the curtain. A
resend reuses the pass's `pass_id`, so the portal never packs a pass twice
(a replay gets its first answer back).

Nothing is sent off a Dock setup, without a key, or while dry run is on
(dry run is a dry run: nothing reaches the portal), checked again after an
internet probe, which takes a while.

The body carries the pass's crate, its distinct asset ids in first-read
order, and its close time moved by the portal's clock offset from the last
check-in, so the portal can refuse any asset whose membership changed after
the pass. While the offset is unknown the close time goes as is. The close
time is the grouper's (the reader's clock) while the reader stamped the
pass's last new read within `READER_SKEW_MAX_S` of when the laptop got it;
otherwise the reader's clock is off (an FX9600 without NTP) and the laptop's
close goes instead: that read's `received_at` plus the quiet gap.

Answers, with the scan uploader's retry rules (edge.rfid.uploader):
- 200: each asset tag keeps its `result`, `moved_from` (the crate's name)
  and `reason`; the pass is `sent` with its counts (packed counts packed and
  moved). A `clear_setup` in the reply applies Clear Setup, as the heartbeat
  does, which drops the passes and stops sending.
- no key, 401 (`station_key` drops the key), 403 `kiosk_not_registered`
  (the key is kept, uploads pause), 423 read-only mode: no attempt is
  spent; the last three are due again after 60 s.
- network error, timeout, 5xx, 429, an unreadable reply: a failed attempt,
  retried after GAPS[attempt], behind the internet probe once 5 have failed.
- any other 4xx: refused for good (`refuse_code`); the next pass goes at
  once.

`last_error` and `refuse_code` are short codes or exception type names,
never anything that could carry the key."""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from edge import config_sync
from edge.db import Store, iso
from edge.dock import state as dock_state
from edge.rfid import station_key
from edge.rfid.uploader import GAPS, PAUSE_S, PROBE_AFTER, WAIT_S, _code, probe_200
from edge.upstream import CloudOffline

log = logging.getLogger("edge.dock.sender")

PATH = "/kiosk/station/dock/passes"
INTERVAL_S = 5.0
# a reader clock further off the laptop's than this sends the laptop-clock close
READER_SKEW_MAX_S = 60


def _text(value) -> str | None:
    return value if isinstance(value, str) else None


def _aware(stored: str) -> datetime:
    """A stored time; one with no offset is UTC."""
    value = datetime.fromisoformat(stored)
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _closed_at(p, offset_ms: int | None) -> str:
    """The pass's close time in portal time: UTC ISO with milliseconds. The
    reader's close while its clock agrees with the laptop's on the last new
    read, else the laptop's (that read's arrival plus the quiet gap)."""
    received = _aware(p["last_new_received_at"])
    if abs(_aware(p["last_new_at"]) - received) <= timedelta(seconds=READER_SKEW_MAX_S):
        closed = _aware(p["closed_at"])
    else:
        closed = received + timedelta(seconds=p["quiet_gap_s"])
    closed += timedelta(milliseconds=offset_ms or 0)
    return closed.astimezone(UTC).isoformat(timespec="milliseconds")


def _answers(data) -> dict[str, tuple[str | None, str | None, str | None]]:
    """asset id -> (result, moved-from crate name, reason) from a 200 reply.
    Raises on a reply that isn't the route's shape."""
    out = {}
    for item in data["assets"]:
        moved = item.get("moved_from")
        out[str(item["asset_id"])] = (_text(item.get("result")),
                                      _text(moved.get("name")) if isinstance(moved, dict)
                                      else None,
                                      _text(item.get("reason")))
    return out


class DockSender:
    def __init__(self, store: Store, st, *, clock: Callable[[], float] = time.time,
                 probe: Callable[[], Awaitable[bool]] | None = None) -> None:
        self.store = store
        self.st = st
        self.clock = clock
        self.probe = probe or (lambda: probe_200(st.upstream))
        self.lock = asyncio.Lock()

    def _at(self, offset: float = 0) -> str:
        return iso(datetime.fromtimestamp(self.clock() + offset, UTC))

    def _set(self, p, **cols) -> None:
        sets = ", ".join(f"{k} = ?" for k in cols)
        self.store.run(f"UPDATE dock_passes SET {sets} WHERE id = ?", (*cols.values(), p["id"]))

    def head(self):
        """The oldest pending pass: the only one that may go."""
        return self.store.one("SELECT * FROM dock_passes WHERE send_state = 'pending' "
                              "ORDER BY id LIMIT 1")

    async def send_once(self) -> bool:
        """Send the oldest pending pass if it is due. True when it got a final
        answer (sent, or refused for good), so the next may go at once."""
        async with self.lock:
            return await self._send()

    def _may_send(self) -> bool:
        return station_key.is_dock_setup(self.store) and not dock_state.dry_run_on(self.store) \
            and station_key.has_key(self.store)

    async def _send(self) -> bool:
        if not self._may_send():
            return False
        p = self.head()
        if p is None or (p["next_attempt_at"] is not None and p["next_attempt_at"] > self._at()):
            return False   # not due: the passes behind it wait too
        if p["attempts"] >= PROBE_AFTER:
            if not await self.probe():
                self._set(p, waiting_for_internet=1, next_attempt_at=self._at(WAIT_S))
                return False
            self._set(p, waiting_for_internet=0)
            if not self._may_send():   # dry run or the setup changed while it probed
                return False
        body = self._body(p)
        try:
            resp = await station_key.station_request(self.st, "POST", PATH, json=body)
        except CloudOffline:
            self._failed(p, "CloudOffline")
            return False
        except Exception as exc:  # noqa: BLE001 — a background caller must never break
            self._failed(p, type(exc).__name__)
            return False
        if resp is None:  # the key went away between the check and the send
            return False
        code = _code(resp)
        if resp.status_code in (401, 423) or (
                resp.status_code == 403 and code == station_key.NOT_REGISTERED):
            self._set(p, last_error=code, next_attempt_at=self._at(PAUSE_S))
            log.info("dock pass send paused: portal answered %s", resp.status_code)
            return False
        if resp.status_code == 200:
            try:
                data = resp.json()
                answers = _answers(data)
                clear = data.get("clear_setup")
            except (ValueError, AttributeError, KeyError, TypeError):
                self._failed(p, "bad_answer")
                return False
            self._sent(p, answers)
            if clear:
                station_key.apply_clear_setup(self.store)
                log.info("clear setup received with a dock pass: setup and station key dropped")
            return True
        if 400 <= resp.status_code < 500 and resp.status_code != 429:
            self._set(p, send_state="refused", refuse_code=code, waiting_for_internet=0,
                      next_attempt_at=None)
            log.info("dock pass refused: portal answered %s", resp.status_code)
            return True
        self._failed(p, code)
        return False

    def _body(self, p) -> dict:
        tags = self.store.all("SELECT matched_id FROM dock_pass_tags WHERE pass_id = ? "
                              "AND kind = 'asset' AND matched_id IS NOT NULL "
                              "ORDER BY first_read_at, rowid", (p["id"],))
        return {"serial": self.st.identity.serial, "pass_id": p["pass_id"],
                "container_id": p["container_id"],
                "closed_at": _closed_at(p, config_sync.server_offset_ms(self.store)),
                "asset_ids": list(dict.fromkeys(t["matched_id"] for t in tags))}

    def _sent(self, p, answers: dict) -> None:
        results = [result for result, _, _ in answers.values()]
        with self.store.tx() as c:
            for asset_id, (result, moved_from, reason) in answers.items():
                c.execute("UPDATE dock_pass_tags SET result = ?, moved_from = ?, reason = ? "
                          "WHERE pass_id = ? AND kind = 'asset' AND matched_id = ?",
                          (result, moved_from, reason, p["id"], asset_id))
            c.execute("UPDATE dock_passes SET send_state = 'sent', sent_at = ?, "
                      "packed_count = ?, moved_count = ?, refused_count = ?, last_error = NULL, "
                      "waiting_for_internet = 0, next_attempt_at = NULL WHERE id = ?",
                      (self._at(), results.count("packed") + results.count("moved"),
                       results.count("moved"), results.count("refused"), p["id"]))

    def _failed(self, p, error: str) -> None:
        log.info("dock pass send failed: %s", error)
        attempts = p["attempts"] + 1
        gap = GAPS[min(attempts, len(GAPS)) - 1]
        self._set(p, attempts=attempts, next_attempt_at=self._at(gap), last_error=error,
                  waiting_for_internet=0)
