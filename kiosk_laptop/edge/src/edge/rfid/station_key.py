"""The station key (rfid scan processing spec §3): a portal-issued secret
that lets an unattended station (RFID, Label or Time Clock) sync its move
and upload scans, or punch the time clock, with nobody signed in.

Issued by `POST /kiosk/station-key` as the person who just saved an RFID or
Label Kiosk Setup (or, when that failed, retried by the background loop at
most once a minute while someone signed in here has a usable cloud session
and the setup is still a station). Stored only encrypted with edge.key;
cleared on every new setup (it covered the previous one), a Clear Setup
from the portal, and Wipe.

`is_station_setup` (any station type) gates the key, sync and upload
paths; `is_rfid_setup` stays RFID-only for the reader-specific code, and
`is_timeclock_setup` marks the Time Clock Station (a key with or without a
move, a people-only sync, the /edge/timeclock routes).

A 403 `kiosk_not_registered` on any station route (the laptop's kiosk
registration lapsed) keeps the key: renewing on the portal's Kiosk Devices
page brings uploads back with no sign-in. The edge marks itself paused in
`station_status` and records one "Uploads paused" System Event on that
transition, and one "Uploads resumed" on the next 200 from any station
route. The flag is in the store, so a restart never repeats an event.

The key never appears in a log line, an edge response, `last_error` or an
event: failures are logged by HTTP status (or exception type) only."""

import asyncio
import logging

import httpx
from cryptography.fernet import InvalidToken

from edge import laptop_setup, timeclock
from edge.crypto import Keys, decrypt, encrypt
from edge.db import Store, now_iso
from edge.rfid import events
from edge.upstream import CloudOffline, Upstream

log = logging.getLogger("edge.rfid.station_key")

ISSUE_PATH = "/kiosk/station-key"
RETRY_S = 60.0
NOT_REGISTERED = "kiosk_not_registered"
EVENT_KIND = "station"
PAUSED_TITLE = "Uploads paused"
PAUSED_DETAIL = ("This laptop's kiosk registration has expired. "
                 "Sign in here or renew it on Kiosk Devices.")
RESUMED_TITLE = "Uploads resumed"


def store_key(store: Store, keys: Keys, raw: str) -> None:
    """Store (or replace) the key. Screens armed under a previous key are
    revoked: a display cookie is good for one key."""
    timeclock.clear_displays(store)
    store.run("INSERT INTO station_key (id, key_enc, stored_at) VALUES (1, ?, ?) "
              "ON CONFLICT (id) DO UPDATE SET key_enc = excluded.key_enc, "
              "stored_at = excluded.stored_at", (encrypt(keys, raw), now_iso()))


def load_key(store: Store, keys: Keys) -> str | None:
    """The stored key, or None. A row this edge.key can't read is dropped
    (the background retry then asks the portal for a new one)."""
    row = store.one("SELECT key_enc FROM station_key WHERE id = 1")
    if row is None:
        return None
    try:
        return decrypt(keys, row["key_enc"])
    except InvalidToken:
        clear(store)
        return None


def has_key(store: Store) -> bool:
    return store.one("SELECT 1 FROM station_key WHERE id = 1") is not None


def clear(store: Store) -> None:
    """Drop the key, and with it the Time Clock's armed screens."""
    store.run("DELETE FROM station_key")
    _dropped(store)


def _dropped(store: Store) -> None:
    """After the key is gone: no pause flag, no armed screens."""
    _clear_pause(store)
    timeclock.clear_displays(store)


def _clear_pause(store: Store) -> None:
    """The key is gone, so there is nothing left to be paused: drop the flag
    silently (no event), or a later 200 would report an "Uploads resumed"
    for a pause that no longer means anything."""
    store.run("UPDATE station_status SET paused = NULL WHERE id = 1")


def apply_clear_setup(store: Store) -> None:
    """Clear Setup from the portal (on a heartbeat reply, or a station 401
    or RFID upload reply on an unattended laptop): drop the laptop's shared setup, or the
    shell would load it straight back (GET /edge/setup), and the station key
    (the portal revoked it when Clear Setup was requested). The reader
    pairing stays: Kiosk Setup reuses it. A Time Clock station's armed
    screens go with the key."""
    laptop_setup.clear(store)
    clear(store)


def is_paused(store: Store) -> bool:
    """The portal refused this laptop's station calls because its kiosk
    registration lapsed, and no station route has answered 200 since."""
    row = store.one("SELECT paused FROM station_status WHERE id = 1")
    return row is not None and row["paused"] is not None


def _pause(store: Store) -> None:
    """Mark paused; the event is recorded only on the transition (the
    conditional upsert changes no row when already paused)."""
    changed = store.run(
        "INSERT INTO station_status (id, paused) VALUES (1, ?) "
        "ON CONFLICT (id) DO UPDATE SET paused = excluded.paused "
        "WHERE station_status.paused IS NULL", (NOT_REGISTERED,))
    if changed:
        log.warning("station uploads paused: kiosk registration lapsed")
        events.record(store, EVENT_KIND, PAUSED_TITLE, PAUSED_DETAIL)


def _resume(store: Store) -> None:
    changed = store.run("UPDATE station_status SET paused = NULL "
                        "WHERE id = 1 AND paused IS NOT NULL")
    if changed:
        log.info("station uploads resumed")
        events.record(store, EVENT_KIND, RESUMED_TITLE)


STATION_TYPES = ("rfid", "label", "timeclock")


def is_rfid_setup(store: Store) -> bool:
    """An RFID Station setup (the reader-specific paths)."""
    station = _station(store)
    return station is not None and station[0] == "rfid"


def is_timeclock_setup(store: Store) -> bool:
    """A Time Clock Station setup (its move may be empty)."""
    station = _station(store)
    return station is not None and station[0] == "timeclock"


def is_station_setup(store: Store) -> bool:
    """An RFID, Label or Time Clock Station setup: one that holds a station key."""
    return _station(store) is not None


def station_type(store: Store) -> str | None:
    station = _station(store)
    return station[0] if station is not None else None


def _station(store: Store) -> tuple[str, str] | None:
    """(station type, move) of the laptop's station setup; None for any other.
    A Time Clock Station with no move reads as the move "None"."""
    setup = laptop_setup.load(store)
    if isinstance(setup, dict) and setup.get("station_type") in STATION_TYPES:
        return setup["station_type"], str(setup.get("initiative_id"))
    return None


def usable_session(store: Store, person_id: str | None) -> bool:
    """A cloud session the edge may act on (not being logged out)."""
    return person_id is not None and store.one(
        "SELECT 1 FROM cloud_sessions WHERE person_id = ? AND ending = 0",
        (person_id,)) is not None


def _lock(st) -> asyncio.Lock:
    lock = getattr(st, "station_key_lock", None)
    if lock is None:
        lock = st.station_key_lock = asyncio.Lock()
    return lock


def needs_key(store: Store) -> bool:
    return is_station_setup(store) and not has_key(store)


async def issue(st, person_id: str) -> bool:
    """Ask the portal for a key as `person_id` and store it. Never raises.

    One issue at a time: a second caller (the Confirm check racing the
    background retry) finds the first one's key and makes no call, so a key
    the portal already replaced is never stored. The answer is kept only if
    the laptop is still the same station type for the move it was asked for."""
    async with _lock(st):
        if has_key(st.store):
            return True
        return await _issue(st, person_id)


async def _issue(st, person_id: str) -> bool:
    station = _station(st.store)
    try:
        resp = await st.upstream.as_person(person_id, "POST", ISSUE_PATH,
                                           json={"serial": st.identity.serial})
    except CloudOffline:
        log.info("station key not issued: portal unreachable")
        return False
    except Exception as exc:  # noqa: BLE001 — a background caller must never break
        log.warning("station key not issued: %s", type(exc).__name__)
        return False
    if resp is None:
        log.info("station key not issued: no usable cloud session")
        return False
    if resp.status_code != 200:
        # expected, retried every minute: not signed in here, or a portal from
        # before Label Station keys (409 not_rfid_station) — not warnings
        level = (logging.INFO if _code(resp) in ("not_signed_in_here", "not_rfid_station")
                 else logging.WARNING)
        log.log(level, "station key not issued: portal answered %s", resp.status_code)
        return False
    try:
        raw = resp.json()["key"]
    except (ValueError, KeyError, TypeError):
        raw = None
    if not isinstance(raw, str) or not raw:
        log.warning("station key not issued: unexpected answer")
        return False
    if station is None or _station(st.store) != station:
        # set up again (another move or station type) while this was in flight
        log.info("station key discarded: the setup changed while it was issued")
        return False
    store_key(st.store, st.keys, raw)
    log.info("station key stored")
    return True


def _code(resp: httpx.Response) -> str | None:
    try:
        return resp.json()["detail"]["code"]
    except (ValueError, KeyError, TypeError):
        return None


def _clear_setup_id(resp: httpx.Response) -> str | None:
    """The pending Clear Setup id the portal puts on a station 401 (spec
    §3.3): requesting Clear Setup revoked the key, so the refusal is the only
    reply an unattended laptop gets."""
    try:
        value = resp.json()["detail"]["clear_setup"]
    except (ValueError, KeyError, TypeError):
        return None
    return value if isinstance(value, str) and value else None


async def request_as_station(upstream: Upstream, method: str, path: str,
                             **kw) -> httpx.Response | None:
    """`upstream.request` with `Authorization: Station <key>`; None with no
    key. CloudOffline propagates like any upstream call. A 401 means the
    portal no longer knows this key (revoked, replaced): it is dropped, so
    the background retry asks for a new one, unless a newer key was stored
    while the request was in flight. A 401 carrying `clear_setup` (a Clear
    Setup requested for this laptop) also applies Clear Setup, as a
    heartbeat reply would, but only when it dropped the key that was sent:
    a stale refusal never wipes a newer setup and key. A 403
    `kiosk_not_registered` keeps the key and pauses (one event per
    transition); a 200 resumes."""
    row = upstream.store.one("SELECT key_enc FROM station_key WHERE id = 1")
    raw = load_key(upstream.store, upstream.keys)
    if raw is None or row is None:
        return None
    headers = dict(kw.pop("headers", None) or {})
    headers["Authorization"] = f"Station {raw}"
    resp = await upstream.request(method, path, headers=headers, **kw)
    if resp.status_code == 401:
        dropped = upstream.store.run("DELETE FROM station_key WHERE key_enc = ?",
                                     (row["key_enc"],))
        if not dropped:  # a newer key (a new setup) arrived meanwhile: this refusal is stale
            log.info("stale station refusal (%s): newer key kept", path.split("?", 1)[0])
            return resp
        _dropped(upstream.store)
        log.warning("station key refused (%s): dropped", path.split("?", 1)[0])
        if _clear_setup_id(resp) is not None:
            apply_clear_setup(upstream.store)
            log.info("clear setup received with a station refusal: setup and station key dropped")
    elif resp.status_code == 403 and _code(resp) == NOT_REGISTERED:
        _pause(upstream.store)  # the key is kept: renewing the registration resumes
    elif resp.status_code == 200:
        _resume(upstream.store)
    else:
        log.info("station %s %s answered %s", method, path.split("?", 1)[0], resp.status_code)
    return resp


async def station_request(st, method: str, path: str, **kw) -> httpx.Response | None:
    return await request_as_station(st.upstream, method, path, **kw)
