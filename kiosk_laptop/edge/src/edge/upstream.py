"""The edge's line to the cloud API.

Transport failures (connect refused, DNS, timeouts) and an unhealthy
cloud (502/503/504 — a proxy with nothing behind it, a deploy, an
overloaded gateway) mean "offline": every caller then gets its offline
behavior (offline sign-in, cached reads, the outbox spending no attempts).
Any other HTTP answer — 401, 500, anything — is the cloud's answer and is
returned to the caller. Each person who signed in online has their own
cloud session here (encrypted); the edge always acts on the cloud AS that
person, so attribution is never forged. A per-person lock keeps two
concurrent requests from both spending one rotating refresh token.

An environment switch re-points the edge at another server while it runs
(`repoint`). Every call made before it belongs to the old server: an answer
that lands after the switch is dropped (`ServerChanged`, a CloudOffline, so
callers take their offline path and write nothing from it), and a call
under way (a refresh, a retry after a 401) never carries its old-server
token on to the new server."""

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta
from http.cookiejar import DefaultCookiePolicy

import httpx
from cryptography.fernet import InvalidToken

from edge.config import Settings
from edge.crypto import Keys, decrypt, encrypt
from edge.db import Store, iso, now_iso

REFRESH_COOKIE = "ss_refresh"
UNHEALTHY = {502, 503, 504}


class CloudOffline(Exception):
    pass


class ServerChanged(CloudOffline):
    """The laptop switched servers while this call was under way."""


def refresh_cookie_from(resp: httpx.Response) -> str | None:
    for header in resp.headers.get_list("set-cookie"):
        name, _, rest = header.partition("=")
        if name.strip() == REFRESH_COOKIE:
            value = rest.split(";", 1)[0].strip()
            return value or None
    return None


def _detail_code(resp: httpx.Response) -> str | None:
    try:
        return resp.json()["detail"]["code"]
    except (ValueError, KeyError, TypeError):
        return None


class Upstream:
    def __init__(self, settings: Settings, store: Store, keys: Keys, *, transport=None,
                 base_url: str | None = None) -> None:
        """`base_url` is the server the laptop's saved environment names
        (environment_store); without one, the installer's URL."""
        self.store = store
        self.keys = keys
        self._transport = transport
        self.client = self._client(base_url or settings.cloud_api_url)
        self.generation = 0  # counts re-points: which server a call was made for
        self.online = False
        self.last_contact: str | None = None
        self._locks: dict[str, asyncio.Lock] = {}

    def _client(self, base_url: str) -> httpx.AsyncClient:
        client = httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(15.0, connect=5.0),
                                   transport=self._transport)
        # Cloud cookies belong to one person: make the jar structurally unable
        # to store or return any. Callers pass explicit Cookie headers.
        client.cookies.jar.set_policy(DefaultCookiePolicy(allowed_domains=[]))
        return client

    async def aclose(self) -> None:
        await self.client.aclose()

    async def repoint(self, base_url: str) -> None:
        """Talk to another server from now on. The client is swapped in place:
        the outbox worker and the syncer hold this same Upstream. Nothing is
        known about the new server yet, so the edge counts as offline until
        it answers. The swap happens before the first await, so a caller that
        wipes and then re-points leaves no gap where an old-server answer
        could still be taken."""
        old, self.client = self.client, self._client(base_url)
        self.generation += 1
        self.online = False
        self.last_contact = None
        await old.aclose()

    async def request(self, method: str, path: str, *, generation: int | None = None,
                      **kw) -> httpx.Response:
        """One call to the current server. `generation` pins a multi-step call
        (as_person) to the server it started on: once that server is gone,
        nothing more is sent. An answer from a server switched away from
        meanwhile is ServerChanged, whatever it was."""
        gen = self.generation if generation is None else generation
        if gen != self.generation:
            raise ServerChanged("the server changed")
        try:
            resp = await self.client.request(method, path, **kw)
        except Exception as exc:
            if gen != self.generation:  # the old client was closed under it
                raise ServerChanged("the server changed") from exc
            if isinstance(exc, httpx.TransportError):
                self.online = False
                raise CloudOffline(str(exc)) from exc
            raise
        if gen != self.generation:
            with contextlib.suppress(Exception):  # its client may be closed already
                await resp.aclose()
            raise ServerChanged("the server changed")
        if resp.status_code in UNHEALTHY:
            await resp.aclose()
            self.online = False
            raise CloudOffline(f"cloud answered {resp.status_code}")
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

    def _decrypt(self, person_id: str, value: str) -> str | None:
        """A token this key can't read (edge.key replaced, row corrupted) is
        dropped: the person simply has no cloud session until they sign in."""
        try:
            return decrypt(self.keys, value)
        except InvalidToken:
            self.drop_session(person_id)
            return None

    def _refresh_token(self, person_id: str) -> str | None:
        row = self.store.one("SELECT refresh_enc FROM cloud_sessions WHERE person_id = ?",
                             (person_id,))
        return self._decrypt(person_id, row["refresh_enc"]) if row else None

    def _fresh_access(self, person_id: str) -> str | None:
        row = self.store.one("SELECT access_enc, access_expires_at FROM cloud_sessions "
                             "WHERE person_id = ?", (person_id,))
        if row and row["access_enc"] and row["access_expires_at"] > now_iso():
            return self._decrypt(person_id, row["access_enc"])
        return None

    async def _refresh(self, person_id: str, stale: str | None, gen: int) -> str | None:
        lock = self._locks.setdefault(person_id, asyncio.Lock())
        async with lock:
            current = self._fresh_access(person_id)
            if current is not None and current != stale:
                return current  # another request refreshed while we waited
            refresh_token = self._refresh_token(person_id)
            if refresh_token is None:
                return None
            resp = await self.request("POST", "/auth/refresh", generation=gen,
                                      headers={"Cookie": f"{REFRESH_COOKIE}={refresh_token}"})
            if resp.status_code in (401, 403):
                self.drop_session(person_id)
                if _detail_code(resp) != "session_expired":
                    # revoked, disabled, replayed: their offline sign-in goes too
                    self.store.run("DELETE FROM offline_logins WHERE person_id = ?", (person_id,))
                return None
            if resp.status_code != 200:
                raise CloudOffline(f"refresh answered {resp.status_code}")
            data = resp.json()
            self._store_tokens(person_id, refresh_cookie_from(resp) or refresh_token,
                               data["access_token"], data["expires_in"])
            return data["access_token"]

    async def as_person(self, person_id: str, method: str, path: str,
                        **kw) -> httpx.Response | None:
        """The call as the person; None when they have no usable cloud
        session. ServerChanged when the server was switched while it ran,
        even if it would have answered None (their session was wiped with
        the switch), so a caller never mistakes it for "no session"."""
        gen = self.generation
        resp = await self._as_person(gen, person_id, method, path, **kw)
        if gen != self.generation:
            raise ServerChanged("the server changed")
        return resp

    async def _as_person(self, gen: int, person_id: str, method: str, path: str,
                         **kw) -> httpx.Response | None:
        if not self.has_session(person_id):
            return None
        token = self._fresh_access(person_id) or await self._refresh(person_id, None, gen)
        if token is None:
            return None
        headers = dict(kw.pop("headers", None) or {})
        headers["Authorization"] = f"Bearer {token}"
        resp = await self.request(method, path, generation=gen, headers=headers, **kw)
        if resp.status_code == 401:
            token = await self._refresh(person_id, token, gen)
            if token is None:
                return None
            headers["Authorization"] = f"Bearer {token}"
            resp = await self.request(method, path, generation=gen, headers=headers, **kw)
        return resp

    async def end_session(self, person_id: str) -> bool:
        """Log the person's ENDING cloud session out and drop it. A session
        that is no longer ending (they signed in again) is left alone."""
        async with self._locks.setdefault(person_id, asyncio.Lock()):
            row = self.store.one("SELECT refresh_enc FROM cloud_sessions "
                                 "WHERE person_id = ? AND ending = 1", (person_id,))
            refresh_token = self._decrypt(person_id, row["refresh_enc"]) if row else None
            if refresh_token is None:
                return True
            try:
                await self.request("POST", "/auth/logout",
                                   headers={"Cookie": f"{REFRESH_COOKIE}={refresh_token}"})
            except CloudOffline:
                return False
            # only the session that was ending: a sign-in that landed while
            # the logout was in flight saved a fresh one (ending = 0)
            self.store.run("DELETE FROM cloud_sessions WHERE person_id = ? AND ending = 1",
                           (person_id,))
            return True
