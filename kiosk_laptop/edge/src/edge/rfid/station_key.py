"""The RFID station key (rfid scan processing spec §3): a portal-issued
secret that lets an unattended RFID Station sync its move and upload scans
with nobody signed in.

Issued by `POST /kiosk/station-key` as the person who just saved an RFID
Kiosk Setup (or, when that failed, retried by the background loop at most
once a minute while someone signed in here has a usable cloud session and
the setup is still RFID). Stored only encrypted with edge.key; cleared on a
Label setup, a Clear Setup from the portal, and Wipe.

The key never appears in a log line, an edge response, `last_error` or an
event: failures are logged by HTTP status (or exception type) only."""

import logging

import httpx
from cryptography.fernet import InvalidToken

from edge import laptop_setup
from edge.crypto import Keys, decrypt, encrypt
from edge.db import Store, now_iso
from edge.upstream import CloudOffline, Upstream

log = logging.getLogger("edge.rfid.station_key")

ISSUE_PATH = "/kiosk/station-key"
RETRY_S = 60.0


def store_key(store: Store, keys: Keys, raw: str) -> None:
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
    store.run("DELETE FROM station_key")


def is_rfid_setup(store: Store) -> bool:
    setup = laptop_setup.load(store)
    return isinstance(setup, dict) and setup.get("station_type") == "rfid"


def needs_key(store: Store) -> bool:
    return is_rfid_setup(store) and not has_key(store)


async def issue(st, person_id: str) -> bool:
    """Ask the portal for a key as `person_id` and store it. Never raises."""
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
        log.warning("station key not issued: portal answered %s", resp.status_code)
        return False
    try:
        raw = resp.json()["key"]
    except (ValueError, KeyError, TypeError):
        raw = None
    if not isinstance(raw, str) or not raw:
        log.warning("station key not issued: unexpected answer")
        return False
    if not is_rfid_setup(st.store):
        # the laptop became a Label Station while this was in flight
        log.info("station key discarded: the setup is no longer an RFID Station")
        return False
    store_key(st.store, st.keys, raw)
    log.info("station key stored")
    return True


async def request_as_station(upstream: Upstream, method: str, path: str,
                             **kw) -> httpx.Response | None:
    """`upstream.request` with `Authorization: Station <key>`; None with no
    key. CloudOffline propagates like any upstream call."""
    raw = load_key(upstream.store, upstream.keys)
    if raw is None:
        return None
    headers = dict(kw.pop("headers", None) or {})
    headers["Authorization"] = f"Station {raw}"
    resp = await upstream.request(method, path, headers=headers, **kw)
    if resp.status_code != 200:
        log.info("station %s %s answered %s", method, path, resp.status_code)
    return resp


async def station_request(st, method: str, path: str, **kw) -> httpx.Response | None:
    return await request_as_station(st.upstream, method, path, **kw)
