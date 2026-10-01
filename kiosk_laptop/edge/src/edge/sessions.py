"""Sessions the edge issues to the browser. Same SessionOut shape as the
cloud (so the kiosk's auth code is unchanged), but the access token is an
edge JWT and the refresh token lives in edge_sessions — the cloud's own
tokens never reach the browser (see upstream.py)."""

import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

from edge.crypto import Keys
from edge.db import Store, iso, now_iso

ACCESS_TTL_S = 900
OFFLINE_SESSION_HOURS = 12
TOKEN_FIELDS = ("status", "access_token", "token_type", "expires_in", "session_expires_at")


@dataclass(frozen=True)
class EdgeSession:
    id: str
    person_id: str
    offline: bool
    session: dict
    expires_at: str

    @property
    def move_id(self) -> str | None:
        move = self.session.get("kiosk_move")
        return str(move["initiative_id"]) if move else None

    @property
    def max_rank(self) -> int:
        return int(self.session.get("max_rank", 0))

    @property
    def person_name(self) -> str:
        person = self.session.get("person") or {}
        return person.get("display_name") or self.person_id


def template_from(session_out: dict) -> dict:
    return {k: v for k, v in session_out.items() if k not in TOKEN_FIELDS}


def offline_expiry() -> str:
    return iso(datetime.now(UTC) + timedelta(hours=OFFLINE_SESSION_HOURS))


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _access_token(keys: Keys, sid: str) -> str:
    exp = int((datetime.now(UTC) + timedelta(seconds=ACCESS_TTL_S)).timestamp())
    return jwt.encode({"sid": sid, "typ": "edge", "exp": exp}, keys.jwt_secret, algorithm="HS256")


def _out(template: dict, token: str, expires_at: str) -> dict:
    return {**template, "status": "ok", "access_token": token, "token_type": "bearer",
            "expires_in": ACCESS_TTL_S, "session_expires_at": expires_at}


def _session(row) -> EdgeSession:
    return EdgeSession(id=row["id"], person_id=row["person_id"], offline=bool(row["offline"]),
                       session=json.loads(row["session_json"]), expires_at=row["expires_at"])


def issue(store: Store, keys: Keys, *, template: dict, offline: bool,
          expires_at: str) -> tuple[dict, str]:
    sid = str(uuid.uuid4())
    refresh_token = secrets.token_urlsafe(32)
    expires = iso(expires_at)
    store.run(
        "INSERT INTO edge_sessions (id, person_id, refresh_hash, offline, session_json, "
        "expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, str(template["person"]["id"]), _hash(refresh_token), int(offline),
         json.dumps(template), expires, now_iso()))
    return _out(template, _access_token(keys, sid), expires), refresh_token


def from_access_token(store: Store, keys: Keys, token: str) -> EdgeSession | None:
    try:
        claims = jwt.decode(token, keys.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("typ") != "edge":
        return None
    row = store.one("SELECT * FROM edge_sessions WHERE id = ? AND revoked_at IS NULL "
                    "AND expires_at > ?", (claims.get("sid"), now_iso()))
    return _session(row) if row else None


def refresh(store: Store, keys: Keys, refresh_token: str) -> tuple[dict, str] | None:
    row = store.one("SELECT * FROM edge_sessions WHERE refresh_hash = ? AND revoked_at IS NULL "
                    "AND expires_at > ?", (_hash(refresh_token), now_iso()))
    if row is None:
        return None
    new_refresh = secrets.token_urlsafe(32)
    # compare-and-swap: two requests that read the same row rotate it once
    rotated = store.run("UPDATE edge_sessions SET refresh_hash = ? WHERE id = ? AND refresh_hash = ?",
                        (_hash(new_refresh), row["id"], _hash(refresh_token)))
    if rotated == 0:
        return None
    return (_out(json.loads(row["session_json"]), _access_token(keys, row["id"]),
                 row["expires_at"]), new_refresh)


def revoke(store: Store, refresh_token: str) -> EdgeSession | None:
    row = store.one("SELECT * FROM edge_sessions WHERE refresh_hash = ? AND revoked_at IS NULL",
                    (_hash(refresh_token),))
    if row is None:
        return None
    store.run("UPDATE edge_sessions SET revoked_at = ? WHERE id = ?", (now_iso(), row["id"]))
    return _session(row)


def has_live_session(store: Store, person_id: str) -> bool:
    return store.one("SELECT 1 FROM edge_sessions WHERE person_id = ? AND revoked_at IS NULL "
                     "AND expires_at > ?", (person_id, now_iso())) is not None
