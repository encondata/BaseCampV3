"""The edge's line to the cloud API.

Only transport failures (connect refused, DNS, timeouts) mean "offline";
any HTTP answer — 401, 5xx, anything — is the cloud's answer and is
returned to the caller. Each person who signed in online has their own
cloud session here (encrypted); the edge always acts on the cloud AS that
person, so attribution is never forged. A per-person lock keeps two
concurrent requests from both spending one rotating refresh token."""

import asyncio
from datetime import UTC, datetime, timedelta

from http.cookiejar import DefaultCookiePolicy

import httpx

from edge.config import Settings
from edge.crypto import Keys, decrypt, encrypt
from edge.db import Store, iso, now_iso

REFRESH_COOKIE = "ss_refresh"


class CloudOffline(Exception):
    pass


def refresh_cookie_from(resp: httpx.Response) -> str | None:
    for header in resp.headers.get_list("set-cookie"):
        name, _, rest = header.partition("=")
        if name.strip() == REFRESH_COOKIE:
            value = rest.split(";", 1)[0].strip()
            return value or None
    return None


class Upstream:
    def __init__(self, settings: Settings, store: Store, keys: Keys, *, transport=None) -> None:
        self.store = store
        self.keys = keys
        self.client = httpx.AsyncClient(base_url=settings.cloud_api_url,
                                        timeout=httpx.Timeout(15.0, connect=5.0),
                                        transport=transport)
        # Cloud cookies belong to one person: make the jar structurally unable
        # to store or return any. Callers pass explicit Cookie headers.
        self.client.cookies.jar.set_policy(DefaultCookiePolicy(allowed_domains=[]))
        self.online = False
        self.last_contact: str | None = None
        self._locks: dict[str, asyncio.Lock] = {}

    async def aclose(self) -> None:
        await self.client.aclose()

    async def request(self, method: str, path: str, **kw) -> httpx.Response:
        try:
            resp = await self.client.request(method, path, **kw)
        except httpx.TransportError as exc:
            self.online = False
            raise CloudOffline(str(exc)) from exc
        self.online = True
        self.last_contact = now_iso()
        return resp

    async def probe(self) -> bool:
        try:
            await self.request("GET", "/system/status")
        except CloudOffline:
            return False
        return True

    # ── stored cloud sessions ──────────────────────────────────────

    def save_session(self, person_id: str, *, refresh_token: str, access_token: str,
                     expires_in: int) -> None:
        expires = iso(datetime.now(UTC) + timedelta(seconds=expires_in - 30))
        self.store.run(
            "INSERT INTO cloud_sessions (person_id, refresh_enc, access_enc, access_expires_at, "
            "ending, updated_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(person_id) DO UPDATE SET "
            "refresh_enc = excluded.refresh_enc, access_enc = excluded.access_enc, "
            "access_expires_at = excluded.access_expires_at, ending = 0, "
            "updated_at = excluded.updated_at",
            (person_id, encrypt(self.keys, refresh_token), encrypt(self.keys, access_token),
             expires, now_iso()))

    def _store_tokens(self, person_id: str, refresh_token: str, access_token: str,
                      expires_in: int) -> None:
        """Refresh path: tokens and expiry only; never touches `ending`."""
        expires = iso(datetime.now(UTC) + timedelta(seconds=expires_in - 30))
        self.store.run(
            "UPDATE cloud_sessions SET refresh_enc = ?, access_enc = ?, access_expires_at = ?, "
            "updated_at = ? WHERE person_id = ?",
            (encrypt(self.keys, refresh_token), encrypt(self.keys, access_token), expires,
             now_iso(), person_id))

    def has_session(self, person_id: str) -> bool:
        return self.store.one("SELECT 1 FROM cloud_sessions WHERE person_id = ?",
                              (person_id,)) is not None

    def latest_session_person(self) -> str | None:
        row = self.store.one("SELECT person_id FROM cloud_sessions WHERE ending = 0 "
                             "ORDER BY updated_at DESC LIMIT 1")
        return row["person_id"] if row else None

    def drop_session(self, person_id: str) -> None:
        self.store.run("DELETE FROM cloud_sessions WHERE person_id = ?", (person_id,))

    def mark_ending(self, person_id: str) -> None:
        self.store.run("UPDATE cloud_sessions SET ending = 1 WHERE person_id = ?", (person_id,))

    def ending_people(self) -> list[str]:
        return [r["person_id"] for r in
                self.store.all("SELECT person_id FROM cloud_sessions WHERE ending = 1")]

    def _refresh_token(self, person_id: str) -> str | None:
        row = self.store.one("SELECT refresh_enc FROM cloud_sessions WHERE person_id = ?",
                             (person_id,))
        return decrypt(self.keys, row["refresh_enc"]) if row else None

    def _fresh_access(self, person_id: str) -> str | None:
        row = self.store.one("SELECT access_enc, access_expires_at FROM cloud_sessions "
                             "WHERE person_id = ?", (person_id,))
        if row and row["access_enc"] and row["access_expires_at"] > now_iso():
            return decrypt(self.keys, row["access_enc"])
        return None

    async def _refresh(self, person_id: str, stale: str | None) -> str | None:
        lock = self._locks.setdefault(person_id, asyncio.Lock())
        async with lock:
            current = self._fresh_access(person_id)
            if current is not None and current != stale:
                return current  # another request refreshed while we waited
            refresh_token = self._refresh_token(person_id)
            if refresh_token is None:
                return None
            resp = await self.request("POST", "/auth/refresh",
                                      headers={"Cookie": f"{REFRESH_COOKIE}={refresh_token}"})
            if resp.status_code in (401, 403):
                self.drop_session(person_id)
                return None
            if resp.status_code != 200:
                raise CloudOffline(f"refresh answered {resp.status_code}")
            data = resp.json()
            self._store_tokens(person_id, refresh_cookie_from(resp) or refresh_token,
                               data["access_token"], data["expires_in"])
            return data["access_token"]

    async def as_person(self, person_id: str, method: str, path: str,
                        **kw) -> httpx.Response | None:
        if not self.has_session(person_id):
            return None
        token = self._fresh_access(person_id) or await self._refresh(person_id, None)
        if token is None:
            return None
        headers = dict(kw.pop("headers", None) or {})
        headers["Authorization"] = f"Bearer {token}"
        resp = await self.request(method, path, headers=headers, **kw)
        if resp.status_code == 401:
            token = await self._refresh(person_id, token)
            if token is None:
                return None
            headers["Authorization"] = f"Bearer {token}"
            resp = await self.request(method, path, headers=headers, **kw)
        return resp

    async def end_session(self, person_id: str) -> bool:
        async with self._locks.setdefault(person_id, asyncio.Lock()):
            refresh_token = self._refresh_token(person_id)
            if refresh_token is None:
                return True
            try:
                await self.request("POST", "/auth/logout",
                                   headers={"Cookie": f"{REFRESH_COOKIE}={refresh_token}"})
            except CloudOffline:
                return False
            self.drop_session(person_id)
            return True
