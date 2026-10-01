"""What lets someone sign in with no internet: an argon2 verifier of the
password they last used successfully online on this laptop (kept for
EDGE_OFFLINE_LOGIN_DAYS), and the hashed password of the move this laptop
is set up for (from the cloud, see sync.py). Failures are rate-limited
locally — the cloud's lockout can't help while it is unreachable."""

import json
from datetime import UTC, datetime, timedelta

from edge.crypto import check_verifier, make_verifier
from edge.db import Store, iso, now_iso

FAIL_LIMIT = 10
FAIL_WINDOW_S = 300


def cache_login(store: Store, email: str, password: str, template: dict) -> None:
    store.run(
        "INSERT INTO offline_logins (email, person_id, verifier, session_json, cached_at) "
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET person_id = excluded.person_id, "
        "verifier = excluded.verifier, session_json = excluded.session_json, "
        "cached_at = excluded.cached_at",
        (email, str(template["person"]["id"]), make_verifier(password), json.dumps(template),
         now_iso()))


def forget_login(store: Store, email: str) -> None:
    store.run("DELETE FROM offline_logins WHERE email = ?", (email,))


def check_login(store: Store, email: str, password: str, days: int) -> dict | None:
    row = store.one("SELECT * FROM offline_logins WHERE email = ?", (email,))
    oldest = iso(datetime.now(UTC) - timedelta(days=days))
    if row is None or row["cached_at"] < oldest or not check_verifier(row["verifier"], password):
        return None
    return json.loads(row["session_json"])


def check_move_password(store: Store, password: str) -> dict | None:
    for row in store.all("SELECT verifier, session_json FROM move_passwords"):
        if check_verifier(row["verifier"], password):
            return json.loads(row["session_json"])
    return None


def too_many_failures(store: Store, key: str) -> bool:
    since = iso(datetime.now(UTC) - timedelta(seconds=FAIL_WINDOW_S))
    store.run("DELETE FROM login_failures WHERE at < ?", (since,))
    row = store.one("SELECT COUNT(*) AS n FROM login_failures WHERE key = ?", (key,))
    return row["n"] >= FAIL_LIMIT


def record_failure(store: Store, key: str) -> None:
    store.run("INSERT INTO login_failures (key, at) VALUES (?, ?)", (key, now_iso()))
