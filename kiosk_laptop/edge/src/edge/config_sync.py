"""The laptop's kiosk config, held on the edge (kiosk config spec §4).

The laptop is one device to the portal, however many browsers use it, so
the edge holds its config document (`device_config`, one row) and syncs it
on the check-ins it already makes, with the web kiosk's rules
(kiosk/src/lib/kioskConfig.ts):

- **The whole document** passes through. The browsers own `appearance`,
  `sound`, `checkpoints` and `developer` (their stores); the edge owns
  `alarm`, which always mirrors `alarm_settings`, and `label_station`,
  which always mirrors the Label Station's settings in the shared setup
  (null when there are none, so a cleared station clears the portal's copy;
  read-only here: neither a browser nor the portal changes it); every other
  section is kept as the portal sent it.
- **Browsers** read it at GET /edge/config (polled every 60 s; `version`
  counts changes here) and write it with PUT /edge/config. The first browser
  to find no document seeds it from its own stores, unstamped and not dirty,
  so the first report is unstamped and a portal edit made before it wins. A
  write names the version it started from; a stale one is refused (409) so
  the browser can merge rather than roll back another browser's change.
- **A local change** (a browser write, or an edit of the alarm settings)
  marks the config dirty, stamped with portal-corrected time (edge clock +
  the offset from the last reply's `server_time`). A change made before the
  offset is known keeps its raw time and is held back until a reply supplies
  the clock.
- **A check-in** always carries `config_applied_version`; it carries the
  whole document (`config`, `config_changed_at`) when it is dirty, on the
  first report, and every 60 minutes. Nothing is reported until a document
  exists, so a laptop no browser has seeded never reports defaults over its
  settings.
- **A reply's config** newer than the applied version is applied (its
  `alarm` to `alarm_settings`) when nothing local is pending. While a local
  change is pending, the reply's other sections are taken and the local
  sections kept; the stamped report then settles it on the portal. Beats
  never overlap, so a reply below the applied version means the portal's
  row was recreated (versions restarted): it is taken like any other.

Which check-in carries it: an RFID Station with a station key syncs only on
its station heartbeat (the portal ignores config on a station-keyed device's
person heartbeat); otherwise the proxied person heartbeat carries it. One
config beat at a time (`lock`), so the two never overlap."""

import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from edge import laptop_setup
from edge.db import Store
from edge.rfid import alarm

REPORT_INTERVAL = timedelta(minutes=60)
MAX_BYTES = 65536  # the portal's limit on a reported document
BROWSER_SECTIONS = ("appearance", "sound", "checkpoints", "developer")
LOCAL_SECTIONS = (*BROWSER_SECTIONS, "alarm", "label_station")
BEAT_FIELDS = ("config", "config_changed_at", "config_applied_version")
# The browser sections' fields on a fresh kiosk (the kiosk stores' defaults,
# the portal's DEFAULT_CONFIG): a seed holding only these is a browser nobody
# customized, which a customized browser's seed may replace.
BROWSER_DEFAULTS = {
    "appearance": {"good_scan": {"h": 150, "s": 60, "l": 45},
                   "not_found_scan": {"h": 0, "s": 70, "l": 50},
                   "duplicate_scan": {"h": 38, "s": 92, "l": 50}, "flash_ms": 350},
    "sound": {"good": {"kind": "builtin", "id": "chime"},
              "not_found": {"kind": "builtin", "id": "buzz"},
              "duplicate": {"kind": "builtin", "id": "double_beep"},
              "alarm": {"kind": "siren"}, "volume": 0.8},
    "checkpoints": {"enroll": "pre_stage", "container_pack": "in_container",
                    "container_unpack": "un_pack", "truck_load": "on_truck",
                    "truck_unload": "received"},
    "developer": {"dev_mode": False},
}


class ConfigConflict(Exception):
    """A browser wrote from a version that is no longer current."""

    def __init__(self, current: dict) -> None:
        super().__init__("config_changed")
        self.current = current


def lock(st) -> asyncio.Lock:
    found = getattr(st, "config_lock", None)
    if found is None:
        found = st.config_lock = asyncio.Lock()
    return found


def _now() -> datetime:
    return datetime.now(UTC)


def _stamp(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds")


def _parse(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _int(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _canon(doc) -> str:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"))


def fits(doc: dict) -> bool:
    return len(json.dumps(doc).encode()) <= MAX_BYTES


def _row(c) -> dict:
    row = c.execute("SELECT * FROM device_config WHERE id = 1").fetchone()
    if row is None:
        return {"doc": None, "version": 0, "changed_at": None, "changed_at_local": None,
                "dirty": 0, "applied_version": None, "server_offset_ms": None,
                "reported_at": None}
    return dict(row)


def _write(c, **fields) -> None:
    c.execute("INSERT OR IGNORE INTO device_config (id) VALUES (1)")
    cols = ", ".join(f"{k} = ?" for k in fields)
    c.execute(f"UPDATE device_config SET {cols} WHERE id = 1", tuple(fields.values()))


def _doc(row: dict) -> dict | None:
    return json.loads(row["doc"]) if row["doc"] else None


def browser_defaults_only(doc: dict | None) -> bool:
    """Every browser-owned field of `doc` equals the default (a field that
    is missing does not)."""
    if not isinstance(doc, dict):
        return False
    for name, fields in BROWSER_DEFAULTS.items():
        section = doc.get(name)
        if not isinstance(section, dict):
            return False
        for key, value in fields.items():
            if key not in section or _canon(section[key]) != _canon(value):
                return False
    return True


def _replaceable_seed(row: dict, stored: dict | None) -> bool:
    """A defaults-only seed nothing has built on yet: never reported, no
    portal config applied, no local change."""
    return stored is not None and row["reported_at"] is None \
        and row["applied_version"] is None and not row["dirty"] \
        and row["changed_at_local"] is None and browser_defaults_only(stored)


def _view(row: dict) -> dict:
    return {"doc": _doc(row), "version": row["version"], "changed_at": row["changed_at"]}


# ── the alarm section ↔ alarm_settings ──────────────────────────────

def _alarm_conf(c) -> dict:
    row = c.execute("SELECT mode, timed_seconds FROM alarm_settings WHERE id = 1").fetchone()
    return {"mode": row["mode"], "timed_seconds": row["timed_seconds"]} if row \
        else dict(alarm.DEFAULTS)


def _apply_alarm(c, section) -> None:
    """Each valid field of a document's `alarm` goes to alarm_settings; a
    field that isn't valid keeps its previous value."""
    if not isinstance(section, dict):
        return
    conf = _alarm_conf(c)
    new = dict(conf)
    if section.get("mode") in alarm.MODES:
        new["mode"] = section["mode"]
    seconds = _int(section.get("timed_seconds"))
    if seconds is not None and alarm.MIN_SECONDS <= seconds <= alarm.MAX_SECONDS:
        new["timed_seconds"] = seconds
    if new != conf:
        c.execute("INSERT INTO alarm_settings (id, mode, timed_seconds) VALUES (1, ?, ?) "
                  "ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, "
                  "timed_seconds = excluded.timed_seconds", (new["mode"], new["timed_seconds"]))


def _with_alarm(c, doc: dict) -> dict:
    """`doc` with the sections the edge owns: its `alarm` mirroring
    alarm_settings (other alarm keys kept) and `label_station` mirroring the
    shared setup's Label Station settings."""
    section = doc.get("alarm") if isinstance(doc.get("alarm"), dict) else {}
    return {**doc, "alarm": {**section, **_alarm_conf(c)},
            "label_station": laptop_setup.label_station_in(c)}


def _changed(c, row: dict, doc: dict | None) -> None:
    """A local change: dirty, stamped with corrected time (or the raw time,
    corrected later, while the portal's clock is unknown)."""
    now = _now()
    offset = row["server_offset_ms"]
    stamp = {"changed_at": _stamp(now + timedelta(milliseconds=offset)),
             "changed_at_local": None} if offset is not None \
        else {"changed_at_local": _stamp(now)}
    _write(c, doc=json.dumps(doc) if doc is not None else row["doc"],
           version=row["version"] + 1, dirty=1, **stamp)


# ── /edge/config ────────────────────────────────────────────────────

def get(store: Store) -> dict:
    with store.tx() as c:
        return _view(_row(c))


def put(store: Store, doc: dict, base_version: int | None, *, seed: bool = False) -> dict:
    """A browser's document. `seed`: stored only when there is none yet, not
    as a change. Otherwise its alarm is applied and it replaces the stored
    one as a local change (an identical one changes nothing). Raises
    ConfigConflict when `base_version` isn't the current version."""
    with store.tx() as c:
        row = _row(c)
        stored = _doc(row)
        if seed:
            # stored only when there is none, or when the stored one is an
            # unreported defaults-only seed and this one is customized
            if stored is None or (_replaceable_seed(row, stored)
                                  and not browser_defaults_only(doc)):
                _write(c, doc=json.dumps(_with_alarm(c, {**doc, "schema": 1})),
                       version=row["version"] + 1)
            return _view(_row(c))
        if base_version is not None and base_version != row["version"]:
            raise ConfigConflict(_view(row))
        _apply_alarm(c, doc.get("alarm"))
        new = _with_alarm(c, {**doc, "schema": 1})
        if stored is None or _canon(new) != _canon(stored):
            _changed(c, row, new)
        return _view(_row(c))


def note_alarm_edit(store: Store) -> None:
    """The Sound tab saved the alarm settings: the document's `alarm` follows,
    as a local change. With no document yet the change is still marked, and
    the first report (once a browser seeds) carries it stamped."""
    with store.tx() as c:
        row = _row(c)
        stored = _doc(row)
        if stored is None:
            _changed(c, row, None)
            return
        new = _with_alarm(c, stored)
        if _canon(new) != _canon(stored):
            _changed(c, row, new)


def note_label_station(c) -> None:
    """The Label Station's settings changed (saved, or dropped by Clear Setup
    or a station type change), on the caller's transaction: the document's
    `label_station` follows, as a local change. With no document yet the
    change is still marked, as for the alarm."""
    row = _row(c)
    stored = _doc(row)
    if stored is None:
        _changed(c, row, None)
        return
    new = _with_alarm(c, stored)
    if _canon(new) != _canon(stored):
        _changed(c, row, new)


# ── the check-ins ───────────────────────────────────────────────────

@dataclass
class Beat:
    fields: dict
    reported: bool
    version: int
    sent_at: datetime


def prepare_beat(store: Store) -> Beat:
    now = _now()
    with store.tx() as c:
        row = _row(c)
        fields: dict = {"config_applied_version": row["applied_version"]}
        reported = False
        doc = _doc(row)
        if doc is not None:
            last = _parse(row["reported_at"])
            due = bool(row["dirty"]) or last is None or now - last >= REPORT_INTERVAL \
                or now < last
            held = row["changed_at_local"] is not None and row["server_offset_ms"] is None
            if due and not held:
                fields["config"] = _with_alarm(c, doc)
                fields["config_changed_at"] = row["changed_at"]
                reported = True
        return Beat(fields=fields, reported=reported, version=row["version"], sent_at=now)


def add_fields(body: bytes, beat: Beat) -> bytes:
    """The beat's fields into a JSON heartbeat body (any the browser sent are
    replaced)."""
    try:
        data = json.loads(body) if body else {}
    except ValueError:
        return body
    if not isinstance(data, dict):
        return body
    for key in BEAT_FIELDS:
        data.pop(key, None)
    data.update(beat.fields)
    return json.dumps(data).encode()


def handle_reply(store: Store, beat: Beat, data) -> None:
    """A 200 check-in reply: the portal's clock, the report settled, the
    reply's config applied (or merged while a local change is pending), and
    its scan type into the shared setup. Never raises on a bad reply."""
    if not isinstance(data, dict):
        return
    received = _now()
    with store.tx() as c:
        row = _row(c)
        server = _parse(data.get("server_time"))
        if server is not None:
            midpoint = beat.sent_at + (received - beat.sent_at) / 2
            offset = round((server - midpoint).total_seconds() * 1000)
            updates: dict = {"server_offset_ms": offset}
            local = _parse(row["changed_at_local"])
            if local is not None:
                updates["changed_at"] = _stamp(local + timedelta(milliseconds=offset))
                updates["changed_at_local"] = None
            _write(c, **updates)
        if beat.reported:
            # a change that landed while the beat was in flight stays dirty
            settled = {"dirty": 0} if row["version"] == beat.version else {}
            _write(c, reported_at=_stamp(received), **settled)
        row = _row(c)
        cfg, version = data.get("config"), _int(data.get("config_version"))
        applied = row["applied_version"]
        # Beats are serialized (lock), so a reply is never from an older,
        # overlapping beat: any version other than the applied one is taken,
        # including a lower one (the portal's row was recreated by Clear
        # Offline, a delete or a database revert, and restarted its versions).
        if not isinstance(cfg, dict) and version is not None and applied is not None \
                and version < applied:
            # reset, nothing stored there yet: acknowledge it and report the
            # whole config on the next beat
            _write(c, applied_version=version, reported_at=None)
        if isinstance(cfg, dict) and version is not None and version != applied:
            stored = _doc(row)
            if not row["dirty"]:
                _apply_alarm(c, cfg.get("alarm"))
                new = _with_alarm(c, cfg)
                changed = stored is None or _canon(new) != _canon(stored)
                _write(c, doc=json.dumps(new), applied_version=version,
                       version=row["version"] + (1 if changed else 0))
            else:
                # the pending local change is reported first and judged by its
                # stamp; meanwhile the portal's other sections become ours
                merged = dict(cfg)
                for section in LOCAL_SECTIONS:
                    if stored is not None and section in stored:
                        merged[section] = stored[section]
                merged = _with_alarm(c, merged)
                if stored is None or _canon(merged) != _canon(stored):
                    _write(c, doc=json.dumps(merged), version=row["version"] + 1)
    laptop_setup.set_scan_type(store, data.get("scan_status"), data.get("scan_status_label"))
