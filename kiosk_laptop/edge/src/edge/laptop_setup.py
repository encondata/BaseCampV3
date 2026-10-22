"""The laptop's finished Kiosk Setup, shared with every browser (D2): a
phone on the LAN loads the laptop's setup instead of starting blank.

Saved after the cloud accepts `/kiosk/setup`: the fields the kiosk caches
(move, site and role, scan type with its label, station type) plus, for an
RFID station, the paired reader's summary (never its token). Wipe clears it.

A Label Station's label settings (`label_station`: label kind, printer, DPI,
offsets and peel-off printing) are saved with PUT /edge/label-station once the setup exists.
They survive setting up again as a Label Station and are dropped by Clear
Setup or a change of station type; the config document's `label_station`
section mirrors them (config_sync), marked dirty whenever they change.

Every Label Station setup leaves the settings unconfirmed (`label_unconfirmed`
in the shared setup, never in `label_station`) until setup step 5 saves them
again: no labels are generated in between, so a re-setup never builds the
new move's labels from the old printer and kind. A setup saved before the
flag existed reads as confirmed."""

import json
from collections.abc import Callable

from edge.db import Store, now_iso
from edge.rfid import alarm, pairing

LABEL_KINDS = ("top", "front")
PRINTER_TYPES = ("usb", "network")
MAX_TEXT = 128          # a printer's model or serial
DPI_RANGE = (1, 1200)
OFFSET_RANGE = (-9999, 9999)  # dots; the ^LS range

SETUP_FIELDS = ("initiative_id", "initiative_name", "site_id", "site_name", "site_role",
                "scan_status", "scan_status_label")


def save(store: Store, result: dict, station_type: str | None) -> dict:
    setup = {key: result.get(key) for key in SETUP_FIELDS}
    setup["station_type"] = (station_type if station_type in ("label", "rfid", "timeclock")
                             else None)
    reader = pairing.cloud_reader(store) if setup["station_type"] == "rfid" else None
    setup["reader"] = reader
    setup["updated_at"] = now_iso()
    with store.tx() as c:
        row = c.execute("SELECT setup_json FROM laptop_setup WHERE id = 1").fetchone()
        previous = json.loads(row["setup_json"]) if row else {}
        if previous.get("initiative_id") != setup["initiative_id"]:
            alarm.clear_state(c)   # the old move's alarms mean nothing on the new one
        # a Label Station set up again keeps its printer; any other change drops it
        kept = previous.get("station_type") == "label" and setup["station_type"] == "label"
        setup["label_station"] = previous.get("label_station") if kept else None
        if setup["station_type"] == "label":
            setup["label_unconfirmed"] = True
        c.execute("INSERT INTO laptop_setup (id, setup_json, updated_at) VALUES (1, ?, ?) "
                  "ON CONFLICT (id) DO UPDATE SET setup_json = excluded.setup_json, "
                  "updated_at = excluded.updated_at", (json.dumps(setup), setup["updated_at"]))
        if previous.get("label_station") != setup["label_station"]:
            _note_config(c)
    return setup


def load(store: Store) -> dict | None:
    row = store.one("SELECT setup_json FROM laptop_setup WHERE id = 1")
    if not row:
        return None
    setup = json.loads(row["setup_json"])
    if "label_station" in setup:
        setup["label_station"] = _with_defaults(setup["label_station"])
    return setup


def _with_defaults(settings):
    """Settings saved before a key existed read with its default: `peel`
    false (tear off)."""
    if isinstance(settings, dict) and "peel" not in settings:
        return {**settings, "peel": False}
    return settings


def clear(store: Store) -> None:
    """Forget the shared setup (Clear Setup from the portal, or Wipe), and
    with it the setup move's off-move alarms."""
    with store.tx() as c:
        had = label_station_in(c) is not None
        c.execute("DELETE FROM laptop_setup")
        alarm.clear_state(c)
        if had:
            _note_config(c)


# ── the Label Station's settings ────────────────────────────────────

class BadLabelStation(ValueError):
    """A PUT /edge/label-station body that can't be stored; `code` is the 422's."""

    def __init__(self, code: str = "bad_request") -> None:
        super().__init__(code)
        self.code = code


def _note_config(c) -> None:
    from edge import config_sync  # config_sync imports this module
    config_sync.note_label_station(c)


def label_station_in(c) -> dict | None:
    """The stored settings, read on an open transaction."""
    row = c.execute("SELECT setup_json FROM laptop_setup WHERE id = 1").fetchone()
    return _with_defaults(json.loads(row["setup_json"]).get("label_station")) if row else None


def label_confirmed(setup: dict | None) -> bool:
    """False between a Label Station setup and step 5 saving its settings."""
    return not (isinstance(setup, dict) and setup.get("label_unconfirmed"))


def label_station(store: Store) -> dict | None:
    setup = load(store)
    return setup.get("label_station") if setup else None


def _int_in(value, bounds: tuple[int, int]) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) \
        and bounds[0] <= value <= bounds[1]


def _text(value, *, required: bool) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or len(value) > MAX_TEXT or (required and not value.strip()):
        raise BadLabelStation()
    return value


def normalize_label_station(body, printer_ip) -> dict:
    """The settings as stored: `{label_kind, printer: {type, ip, model,
    serial}, dpi, offset_x, offset_y, peel}` (`peel`: print in peel-off mode;
    false when left out, for kiosks from before it). `printer_ip(value)` is the transport's
    address check: a network printer's `ip` must pass it (`bad_printer_ip`),
    and a USB printer has none. Raises BadLabelStation."""
    if not isinstance(body, dict) or body.get("label_kind") not in LABEL_KINDS:
        raise BadLabelStation()
    printer = body.get("printer")
    if not isinstance(printer, dict) or printer.get("type") not in PRINTER_TYPES:
        raise BadLabelStation()
    ip = printer.get("ip")
    if printer["type"] == "network":
        if not printer_ip(ip):
            raise BadLabelStation("bad_printer_ip")
    elif ip is not None:
        raise BadLabelStation()
    model = _text(printer.get("model"), required=False)
    serial = _text(printer.get("serial"), required=False)
    if not _int_in(body.get("dpi"), DPI_RANGE):
        raise BadLabelStation()
    for key in ("offset_x", "offset_y"):
        if not _int_in(body.get(key), OFFSET_RANGE):
            raise BadLabelStation()
    peel = body.get("peel", False)
    if not isinstance(peel, bool):
        raise BadLabelStation()
    return {"label_kind": body["label_kind"],
            "printer": {"type": printer["type"], "ip": ip, "model": model, "serial": serial},
            "dpi": body["dpi"], "offset_x": body["offset_x"], "offset_y": body["offset_y"],
            "peel": peel}


REGENERATE_KEYS = ("dpi", "label_kind", "printer")  # offsets and peel apply when sending


def save_label_station(store: Store, settings: dict, *,
                       on_regenerate: Callable[[str], None] | None = None) -> dict:
    """Store normalized settings in the shared setup and confirm them.
    Raises LookupError when the laptop isn't set up as a Label Station.
    `on_regenerate(reason)` is called with 'setup' when this confirms a new
    setup (always, even with unchanged settings), else with 'updates' when
    the labels' inputs changed (DPI, label kind or printer)."""
    reason = None
    with store.tx() as c:
        row = c.execute("SELECT setup_json FROM laptop_setup WHERE id = 1").fetchone()
        setup = json.loads(row["setup_json"]) if row else None
        if setup is None or setup.get("station_type") != "label":
            raise LookupError("not_label_station")
        previous = setup.get("label_station")
        unconfirmed = not label_confirmed(setup)
        if previous != settings:
            if not isinstance(previous, dict) or any(
                    previous.get(k) != settings.get(k) for k in REGENERATE_KEYS):
                reason = "updates"
            setup["label_station"] = settings
        if unconfirmed:
            reason = "setup"
            setup.pop("label_unconfirmed", None)
        if previous != settings or unconfirmed:
            c.execute("UPDATE laptop_setup SET setup_json = ? WHERE id = 1",
                      (json.dumps(setup),))
        if previous != settings:
            _note_config(c)
    if reason is not None and on_regenerate is not None:
        on_regenerate(reason)
    return settings


def set_scan_type(store: Store, status, label) -> bool:
    """The portal's scan type for this laptop (a check-in reply), written into
    the shared setup when it differs; a missing label uses the key. No setup
    yet: nothing to change. True when it changed."""
    if not isinstance(status, str) or not status:
        return False
    label = label if isinstance(label, str) and label else status
    with store.tx() as c:
        row = c.execute("SELECT setup_json FROM laptop_setup WHERE id = 1").fetchone()
        if row is None:
            return False
        setup = json.loads(row["setup_json"])
        if setup.get("scan_status") == status and setup.get("scan_status_label") == label:
            return False
        setup["scan_status"], setup["scan_status_label"] = status, label
        c.execute("UPDATE laptop_setup SET setup_json = ? WHERE id = 1", (json.dumps(setup),))
    return True
