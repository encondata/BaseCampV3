"""The RFID station's "Asset Not Part Of Move" alarm, held on the edge.

The processor hands its fresh off-move matches to `raise_for` inside the pass's
own transaction. Each asset alarms at most once an hour, counted from its last
alarm (`alarm_last`; a re-read inside the hour doesn't extend it). The open
alarm (`alarm_open`, one row per asset) lives here rather than in a browser, so
a reloaded page or a second screen shows the same thing, and timed mode expires
from the last raise time decided here. A dismiss clears only up to the id the
screen showed, so an asset raised after its last poll stays open."""

from datetime import datetime, timedelta

from edge.db import Store, iso
from edge.rfid import events

DEFAULTS = {"mode": "until_dismissed", "timed_seconds": 10}
MODES = ("until_dismissed", "timed")
MIN_SECONDS = 3
MAX_SECONDS = 600
REPEAT_S = 3600
FRESH_S = 30
TITLE = "Asset Not Part Of Move"
EVENT_NAMES = 5


def make_model(make, model) -> str | None:
    return " ".join(str(x).strip() for x in (make, model) if x and str(x).strip()) or None


def _label(item: dict) -> str:
    return str(item.get("name") or item.get("serial") or item.get("rfid") or item["asset_id"])


def raise_for(c, items: list[dict], now: datetime) -> list[dict]:
    """Alarm each item whose asset hasn't alarmed in the last hour; returns those."""
    at = iso(now)
    window_start = iso(now - timedelta(seconds=REPEAT_S))
    _drop_expired(c, now)
    raised = []
    for item in items:
        asset_id = str(item["asset_id"])
        last = c.execute("SELECT alarmed_at FROM alarm_last WHERE asset_id = ?",
                         (asset_id,)).fetchone()
        if last is not None and last["alarmed_at"] > window_start:
            continue
        c.execute("INSERT INTO alarm_last (asset_id, alarmed_at) VALUES (?, ?) "
                  "ON CONFLICT (asset_id) DO UPDATE SET alarmed_at = excluded.alarmed_at",
                  (asset_id, at))
        # a still-open row is replaced, so the refreshed alarm gets a new, higher id:
        # a dismiss of what the screen showed before can't clear it
        c.execute("DELETE FROM alarm_open WHERE asset_id = ?", (asset_id,))
        c.execute("INSERT INTO alarm_open (asset_id, make_model, name, serial, rfid, raised_at) "
                  "VALUES (?, ?, ?, ?, ?, ?)",
                  (asset_id, make_model(item.get("make"), item.get("model")), item.get("name"),
                   item.get("serial"), item.get("rfid"), at))
        raised.append(item)
    return raised


def _drop_expired(c, now: datetime) -> None:
    """Timed mode: an open alarm whose window already ran out (no screen polled
    to expire it) must not come back with the next raise."""
    row = c.execute("SELECT mode, timed_seconds FROM alarm_settings WHERE id = 1").fetchone()
    if row is None or row["mode"] != "timed":
        return
    newest = c.execute("SELECT MAX(raised_at) AS at FROM alarm_open").fetchone()["at"]
    if newest is None:
        return
    if now > datetime.fromisoformat(newest) + timedelta(seconds=row["timed_seconds"]):
        c.execute("DELETE FROM alarm_open")


def clear_state(c) -> None:
    """Forget open alarms and the once-an-hour memory (the setup move changed
    or was cleared). Settings stay."""
    c.execute("DELETE FROM alarm_open")
    c.execute("DELETE FROM alarm_last")


def record_event(store: Store, raised: list[dict]) -> None:
    """One System Events entry per non-empty raise (after the pass commits)."""
    if not raised:
        return
    labels = [_label(item) for item in raised]
    detail = ", ".join(labels[:EVENT_NAMES])
    if len(labels) > EVENT_NAMES:
        detail += f" and {len(labels) - EVENT_NAMES} more"
    events.record(store, "alarm", TITLE, detail)


def settings(store: Store) -> dict:
    row = store.one("SELECT mode, timed_seconds FROM alarm_settings WHERE id = 1")
    return {"mode": row["mode"], "timed_seconds": row["timed_seconds"]} if row \
        else dict(DEFAULTS)


def save_settings(store: Store, mode: str, timed_seconds: int) -> dict:
    if mode not in MODES:
        raise ValueError("mode")
    if (not isinstance(timed_seconds, int) or isinstance(timed_seconds, bool)
            or not MIN_SECONDS <= timed_seconds <= MAX_SECONDS):
        raise ValueError("timed_seconds")
    store.run("INSERT INTO alarm_settings (id, mode, timed_seconds) VALUES (1, ?, ?) "
              "ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, "
              "timed_seconds = excluded.timed_seconds", (mode, timed_seconds))
    return {"mode": mode, "timed_seconds": timed_seconds}


def empty(conf: dict) -> dict:
    return {**conf, "alarms": [], "latest_id": None, "expires_at": None}


def open_alarm(store: Store, now: datetime) -> dict:
    conf = settings(store)
    with store.tx() as c:
        rows = c.execute("SELECT id, make_model, name, serial, rfid, raised_at "
                         "FROM alarm_open ORDER BY id").fetchall()
        if not rows:
            return empty(conf)
        latest_id = max(r["id"] for r in rows)
        expires_at = None
        if conf["mode"] == "timed":
            newest = max(datetime.fromisoformat(r["raised_at"]) for r in rows)
            expires = newest + timedelta(seconds=conf["timed_seconds"])
            if now > expires:
                c.execute("DELETE FROM alarm_open WHERE id <= ?", (latest_id,))
                return empty(conf)
            expires_at = iso(expires)
    return {**conf, "alarms": [dict(r) for r in rows], "latest_id": latest_id,
            "expires_at": expires_at}


def dismiss(store: Store, up_to_id: int) -> int:
    return store.run("DELETE FROM alarm_open WHERE id <= ?", (up_to_id,))
