"""The Time Clock station's armed screens (kiosk time clock station spec §6,
with the plan-time adjustment): the signed-out /edge/timeclock/* routes
answer only a browser holding a display cookie, which the edge issues to
the station's own screen when a signed-in person presses Start Time Clock
(POST /edge/timeclock/arm). A LAN device without one gets 403
`not_timeclock_display`.

Only the cookie's sha256 is stored. Displays are dropped by Clear Setup
(`station_key.apply_clear_setup`), Wipe, and a Kiosk Setup saving any
station type other than `timeclock`."""

import hashlib
import secrets

from edge.db import Store, now_iso

DISPLAY_COOKIE = "ss_tc_display"
DISPLAY_PATH = "/edge/timeclock"
DISPLAY_MAX_AGE_S = 400 * 86400  # the longest lifetime browsers keep a cookie


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_display(store: Store) -> str:
    """A new display token (raw; only its hash is kept)."""
    token = secrets.token_urlsafe(32)
    store.run("INSERT INTO timeclock_displays (token_hash, created_at) VALUES (?, ?)",
              (_hash(token), now_iso()))
    return token


def is_display(store: Store, token: str | None) -> bool:
    if not token:
        return False
    return store.one("SELECT 1 FROM timeclock_displays WHERE token_hash = ?",
                     (_hash(token),)) is not None


def clear_displays(store: Store) -> None:
    store.run("DELETE FROM timeclock_displays")
