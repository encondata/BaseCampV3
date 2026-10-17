"""The laptop's finished Kiosk Setup, shared with every browser (D2): a
phone on the LAN loads the laptop's setup instead of starting blank.

Saved after the cloud accepts `/kiosk/setup`: the fields the kiosk caches
(move, site and role, scan type with its label, station type) plus, for an
RFID station, the paired reader's summary (never its token). Wipe clears it."""

import json

from edge.db import Store, now_iso
from edge.rfid import alarm, pairing

SETUP_FIELDS = ("initiative_id", "initiative_name", "site_id", "site_name", "site_role",
                "scan_status", "scan_status_label")


def save(store: Store, result: dict, station_type: str | None) -> dict:
    setup = {key: result.get(key) for key in SETUP_FIELDS}
    setup["station_type"] = station_type if station_type in ("label", "rfid") else None
    reader = pairing.cloud_reader(store) if setup["station_type"] == "rfid" else None
    setup["reader"] = reader
    setup["updated_at"] = now_iso()
    with store.tx() as c:
        row = c.execute("SELECT setup_json FROM laptop_setup WHERE id = 1").fetchone()
        before = json.loads(row["setup_json"]).get("initiative_id") if row else None
        if before != setup["initiative_id"]:
            alarm.clear_state(c)   # the old move's alarms mean nothing on the new one
        c.execute("INSERT INTO laptop_setup (id, setup_json, updated_at) VALUES (1, ?, ?) "
                  "ON CONFLICT (id) DO UPDATE SET setup_json = excluded.setup_json, "
                  "updated_at = excluded.updated_at", (json.dumps(setup), setup["updated_at"]))
    return setup


def load(store: Store) -> dict | None:
    row = store.one("SELECT setup_json FROM laptop_setup WHERE id = 1")
    return json.loads(row["setup_json"]) if row else None


def clear(store: Store) -> None:
    """Forget the shared setup (Clear Setup from the portal, or Wipe), and
    with it the setup move's off-move alarms."""
    with store.tx() as c:
        c.execute("DELETE FROM laptop_setup")
        alarm.clear_state(c)
