"""The RFID station's event log: what happened to the reader and the setup,
newest 200 kept. It feeds the /rfid_status System Events panel. Recording is
best effort — a failure here is logged and never reaches the request."""

import logging

from edge.db import Store, now_iso

log = logging.getLogger("edge.rfid.events")

KEEP = 200


def record(store: Store, kind: str, title: str, detail: str = "") -> None:
    try:
        store.run("INSERT INTO rfid_events (at, kind, title, detail) VALUES (?, ?, ?, ?)",
                  (now_iso(), kind, title, detail))
        store.run("DELETE FROM rfid_events WHERE id <= "
                  f"(SELECT MAX(id) FROM rfid_events) - {KEEP}")
    except Exception:  # noqa: BLE001 — never fail the caller
        log.warning("couldn't record RFID event %s", kind, exc_info=True)


def recent(store: Store, limit: int = 50) -> list[dict]:
    limit = max(1, min(200, int(limit)))
    return [dict(r) for r in store.all(
        "SELECT id, at, kind, title, detail FROM rfid_events ORDER BY id DESC LIMIT ?",
        (limit,))]
