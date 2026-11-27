"""The tool's one portal sign-in.

It reads what the readiness check and the result need, and makes the truck calls a
kiosk sign-in may not make (depart, location update, arrive). Paths, parameters and
field names are the real ones (api/src/serversherpa/api/routes/, and the portal's own
client portal/src/lib/api.ts).

Secrets (password, 2FA challenge, access token, refresh and ss_trust cookies) live
only on the instance and in its own cookie jar; `repr` and every exception leave
them out.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Literal

import httpx

from ..clock import Clock
from ..http import CallFailed, TokenExpired, renewing_call, sendable_cookie, timed_call
from ..metrics import Metrics
from ..profile import RetrySpec

REFRESH_COOKIE = "ss_portal_refresh"
REFRESH_MARGIN = 60.0       # refresh when the token has this little left
# a refresh cannot outlive the sign-in, and one sent just before its end can reach the
# server after it (401 session_expired): this close to the end, sign in again instead
SESSION_END_MARGIN = 5.0
ASSET_SCANS_LIMIT = 500     # GET /scans/asset/{id} caps limit at 500
ASSET_MATCH_TYPE = "asset"  # a status rule's trigger_match_type for asset scans
NO_RETRY = RetrySpec(attempts=1, backoff_seconds=())

_attempts: contextvars.ContextVar[list[int] | None] = contextvars.ContextVar(
    "portal_attempts", default=None)


async def _count_attempt(request: httpx.Request) -> None:
    box = _attempts.get()
    if box is not None:
        box[0] += 1


@dataclass(frozen=True)
class SiteInfo:
    id: str
    name: str
    lat: float | None
    lng: float | None


@dataclass(frozen=True)
class MoveInfo:
    id: str
    name: str
    status: str
    origin: SiteInfo | None
    destination: SiteInfo | None


@dataclass(frozen=True)
class RosterRow:
    asset_id: str
    serial: str | None
    rfid_tag: str | None
    status: str | None


@dataclass(frozen=True)
class ContainerInfo:
    id: str
    name: str
    asset_count: int
    truck_id: str | None


@dataclass(frozen=True)
class TruckInfo:
    id: str
    name: str
    status: str
    container_count: int


@dataclass(frozen=True)
class AssetScan:
    status: str | None
    scanned_at: datetime
    processed_at: datetime
    device_id: str


@dataclass(frozen=True)
class SystemStatus:
    read_only: bool
    workers_running: int
    workers_total: int


class TotpEnrollRequired(Exception):
    """The account must set up two-factor sign-in in the portal before it can be used."""


def _site(site_id: str | None, name: str | None) -> SiteInfo | None:
    return SiteInfo(str(site_id), name or "", None, None) if site_id else None


class PortalClient:
    def __init__(self, *, base_url: str, metrics: Metrics, clock: Clock, retry: RetrySpec,
                 timeout: float, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.metrics = metrics
        self.clock = clock
        self.retry = retry
        self._client = httpx.AsyncClient(
            base_url=base_url, timeout=timeout, transport=transport,
            event_hooks={"request": [_count_attempt]})
        self._lock = asyncio.Lock()
        self._email: str | None = None
        self._password: str | None = None
        self._challenge: str | None = None
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._session_expires_at = 0.0
        self._me: dict | None = None        # /auth/me, cached per sign-in

    def __repr__(self) -> str:
        return f"PortalClient(base_url={str(self._client.base_url)!r})"

    @property
    def has_refresh_cookie(self) -> bool:
        return sendable_cookie(self._client, REFRESH_COOKIE)

    async def close(self) -> None:
        """Closes the connection and forgets the email, password, 2FA challenge and token."""
        self._email = self._password = self._challenge = self._token = None
        self._me = None
        await self._client.aclose()

    # ── sign-in and tokens ─────────────────────────────────────────────

    async def login(self, email: str, password: str) -> Literal["ok", "totp_required"]:
        """Email and password sign-in. "totp_required": call verify_totp with the code.
        Raises TotpEnrollRequired when the account has not set up two-factor yet."""
        self._email, self._password = email, password
        async with self._lock:
            return await self._login_locked()

    async def _login_locked(self) -> Literal["ok", "totp_required"]:
        if self._email is None or self._password is None:
            raise CallFailed("portal-login", None, "not_signed_in", 0)
        # token_call=False: a 401 here is refused credentials (invalid_credentials),
        # a final failure with the server's code
        response = await timed_call(
            self._client, "POST", "/auth/login", name="portal-login", metrics=self.metrics,
            clock=self.clock, retry=self.retry, token_call=False,
            json={"email": self._email, "password": self._password})
        body = response.json()
        status = body.get("status")
        if status == "totp_verify":
            self._challenge = body["challenge_token"]
            return "totp_required"
        if status == "totp_enroll":
            raise TotpEnrollRequired("this account must set up two-factor sign-in first")
        self._take_session(body, signed_in=True)
        return "ok"

    async def verify_totp(self, code: str) -> None:
        """The 2FA code for the challenge `login` got. Asks the server to remember this
        client (ss_trust), so a later sign-in needs no code."""
        async with self._lock:
            if self._challenge is None:
                raise CallFailed("portal-login", None, "no_challenge", 0)
            response = await timed_call(
                self._client, "POST", "/auth/totp/verify", name="portal-login",
                metrics=self.metrics, clock=self.clock, retry=self.retry, token_call=False,
                headers={"X-Totp-Challenge": self._challenge},
                json={"code": code, "remember": True})
            self._challenge = None
            self._take_session(response.json(), signed_in=True)

    async def _sign_in_again_locked(self) -> None:
        """A new sign-in with the kept email and password. The kept ss_trust cookie
        means no code; a server that asks for one anyway fails the call."""
        try:
            outcome = await self._login_locked()
        except TotpEnrollRequired:
            raise CallFailed("portal-login", None, "totp_enroll_required", 0) from None
        if outcome == "totp_required":
            self._challenge = None
            raise CallFailed("portal-login", None, "totp_required", 0)

    def _take_session(self, body: dict, *, signed_in: bool) -> None:
        self._token = body["access_token"]
        self._token_expires_at = self.clock.now() + float(body["expires_in"])
        self._session_expires_at = datetime.fromisoformat(body["session_expires_at"]).timestamp()
        if signed_in:
            self._me = None

    async def _refresh_locked(self) -> None:
        """One refresh, never retried: a refresh whose answer was lost already rotated
        the cookie, and replaying the old one would end the sign-in. Any failure, or
        no refresh cookie to send, signs in again instead."""
        if self.has_refresh_cookie:
            try:
                response = await timed_call(
                    self._client, "POST", "/auth/refresh", name="portal-refresh",
                    metrics=self.metrics, clock=self.clock, retry=NO_RETRY,
                    params={"client": "portal"})
            except TokenExpired:
                self.metrics.record("portal-refresh", None, False)
            except CallFailed:
                pass
            else:
                self._take_session(response.json(), signed_in=False)
                return
        await self._sign_in_again_locked()

    async def _ensure_token(self) -> None:
        async with self._lock:
            now = self.clock.now()
            if self._token is None or now >= self._session_expires_at - SESSION_END_MARGIN:
                await self._sign_in_again_locked()
            elif now >= self._token_expires_at - REFRESH_MARGIN:
                await self._refresh_locked()

    async def _renew_after_401(self, used: str | None) -> None:
        async with self._lock:
            if self._token != used:
                return                      # another call already renewed it
            if self.clock.now() >= self._session_expires_at - SESSION_END_MARGIN:
                await self._sign_in_again_locked()
            else:
                await self._refresh_locked()

    async def _timed(self, method: str, url: str, *, name: str, prior_attempts: int,
                     **kwargs) -> tuple[httpx.Response, int]:
        """timed_call, also returning how many requests it sent. On CallFailed or
        TokenExpired the count rides on the exception as `attempts`."""
        box = [0]
        reset = _attempts.set(box)
        try:
            response = await timed_call(
                self._client, method, url, name=name, metrics=self.metrics, clock=self.clock,
                retry=self.retry, headers={"Authorization": f"Bearer {self._token}"},
                prior_attempts=prior_attempts, **kwargs)
        except (CallFailed, TokenExpired) as exc:
            exc.attempts = box[0]
            raise
        finally:
            _attempts.reset(reset)
        return response, box[0]

    async def _call(self, method: str, url: str, *, name: str,
                    **kwargs) -> tuple[httpx.Response, int]:
        """A call under the sign-in (http.renewing_call): refresh first when due; on a
        401 renew once and redo the call once, recorded exactly once. Returns the
        response and every request sent that may have landed, the answered one
        included."""
        async def send(prior: int) -> tuple[httpx.Response, int]:
            return await self._timed(method, url, name=name, prior_attempts=prior, **kwargs)

        return await renewing_call(
            name, metrics=self.metrics, ensure_token=self._ensure_token,
            current_token=lambda: self._token, renew_after_401=self._renew_after_401,
            send=send)

    async def _get(self, url: str, *, name: str = "portal-read", **kwargs):
        response, _ = await self._call("GET", url, name=name, **kwargs)
        return response.json()

    # ── readiness reads ────────────────────────────────────────────────

    async def can(self, resource: str, action: str) -> bool:
        """What /auth/me says this sign-in may do: the server's require_permission is a
        plain perms[resource][action] lookup, with no rank or super-admin shortcut."""
        if self._me is None:
            self._me = await self._get("/auth/me")
        perms = self._me.get("perms") or {}
        return bool((perms.get(resource) or {}).get(action, False))

    async def moves(self) -> list[MoveInfo]:
        """Moves (initiative type "move") that are not archived."""
        rows = await self._get("/initiatives")
        return [MoveInfo(str(r["id"]), r["name"], r["status"],
                         _site(r.get("origin_site_id"), r.get("origin_site_name")),
                         _site(r.get("destination_site_id"), r.get("destination_site_name")))
                for r in rows
                if r.get("initiative_type") == "move" and r.get("archived_at") is None]

    async def _site_info(self, site_id: str | None) -> SiteInfo | None:
        if not site_id:
            return None
        site = await self._get(f"/sites/{site_id}")
        return SiteInfo(str(site["id"]), site["name"], site.get("latitude"),
                        site.get("longitude"))

    async def move(self, move_id: str) -> MoveInfo:
        r = await self._get(f"/initiatives/{move_id}")
        origin = await self._site_info(r.get("origin_site_id"))
        destination = await self._site_info(r.get("destination_site_id"))
        return MoveInfo(str(r["id"]), r["name"], r["status"], origin, destination)

    async def roster(self, move_id: str) -> list[RosterRow]:
        rows = await self._get(f"/initiatives/{move_id}/assets")
        return [RosterRow(str(r["asset_id"]), r["asset"].get("serial_number"),
                          r["asset"].get("rfid_tag"), r.get("status")) for r in rows]

    async def containers(self, move_id: str) -> list[ContainerInfo]:
        """The move's containers that are not archived (the route does not filter
        `archived_at` itself). The list has no truck, so each loaded truck's detail
        (GET /trucks/{id}, its `containers`) says which crates are on it."""
        rows = await self._get("/containers", params={"initiative_id": move_id})
        on_truck: dict[str, str] = {}
        for t in await self.trucks(move_id):
            if t.container_count:
                detail = await self._get(f"/trucks/{t.id}")
                for c in detail.get("containers") or []:
                    on_truck[str(c["id"])] = t.id
        return [ContainerInfo(str(r["id"]), r["name"], int(r.get("asset_count") or 0),
                              on_truck.get(str(r["id"]))) for r in rows
                if r.get("archived_at") is None]

    async def trucks(self, move_id: str) -> list[TruckInfo]:
        rows = await self._get("/trucks", params={"initiative_id": move_id})
        return [TruckInfo(str(r["id"]), r["name"], r["status"],
                          int(r.get("container_count") or 0)) for r in rows]

    async def rule_checkpoints(self) -> set[str]:
        """Trigger statuses that have an enabled rule for asset scans."""
        rules = await self._get("/status-rules")
        return {r["trigger_status"] for r in rules
                if r.get("enabled") and r.get("trigger_match_type") == ASSET_MATCH_TYPE}

    async def asset_statuses(self) -> set[str]:
        rows = await self._get("/status-values", params={"record_type": "asset"})
        return {r["key"] for r in rows if r.get("is_active", True)}

    async def system_status(self) -> SystemStatus:
        """Public: needs no sign-in."""
        response = await timed_call(
            self._client, "GET", "/system/status", name="system-status",
            metrics=self.metrics, clock=self.clock, retry=self.retry, token_call=False)
        body = response.json()
        background = body.get("background") or {}
        return SystemStatus(bool(body.get("read_only")), int(background.get("running") or 0),
                            int(background.get("total") or 0))

    async def clock_offset(self) -> float | None:
        """Seconds the server's clock is ahead of this machine's (negative: behind), from
        the Date header of one public read, good to about a second. None when no usable
        Date came back; never raises (but a cancel)."""
        try:
            before = self.clock.now()
            response = await self._client.get("/system/status")
            after = self.clock.now()
            stamp = parsedate_to_datetime(response.headers["date"])
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=UTC)
        except Exception:  # noqa: BLE001 - no clock reading is never a failure
            return None
        # the header is the server's time cut to the whole second: on average half a
        # second behind
        return stamp.timestamp() + 0.5 - (before + after) / 2

    # ── truck calls ────────────────────────────────────────────────────

    async def set_truck_status(self, truck_id: str, status: str) -> bool:
        try:
            await self._call("PATCH", f"/trucks/{truck_id}", name="truck-status",
                             json={"status": status})
        except CallFailed:
            return False
        return True

    async def add_truck_location(self, truck_id: str, lat: float, lng: float) -> bool:
        """The route has no idempotency key: a retried update may land twice."""
        try:
            _, attempts = await self._call(
                "POST", f"/trucks/{truck_id}/updates", name="truck-location",
                json={"location": {"lat": lat, "lng": lng}, "source": "loadtest"})
        except CallFailed as exc:
            if getattr(exc, "attempts", 0) > 1:
                self.metrics.count("locations_retried")
            return False
        if attempts > 1:
            self.metrics.count("locations_retried")
        return True

    # ── result reads (background) ──────────────────────────────────────

    async def waiting_scans(self, device_prefix: str = "Load test") -> int:
        """Raw scans not yet processed whose device name contains `device_prefix`.
        The server's device filter is a case-insensitive contains, not a prefix
        match; every load-test device name starts with the prefix, so all of them
        are counted."""
        filters = json.dumps({"device": {"text": device_prefix}})
        body = await self._get("/scans/raw/page", name="waiting-scans",
                               params={"limit": 1, "filters": filters})
        return int(body["total"])

    async def asset_totals(self, move_id: str) -> dict[str, int]:
        """Servers per move status (`by_status`)."""
        body = await self._get(f"/initiatives/{move_id}/asset-totals", name="asset-totals")
        return {str(k): int(v) for k, v in (body.get("by_status") or {}).items()}

    async def asset_scans(self, asset_id: str) -> list[AssetScan]:
        rows = await self._get(f"/scans/asset/{asset_id}", name="asset-scans",
                               params={"limit": ASSET_SCANS_LIMIT})
        return [AssetScan(r.get("status"), datetime.fromisoformat(r["scanned_at"]),
                          datetime.fromisoformat(r["processed_at"]), r["device_id"])
                for r in rows]

    async def db_health(self) -> dict | None:
        """Developer › Database › Health: the summary's fields plus
        `connection_groups`. None when the account may not read it (403)."""
        try:
            summary = await self._get("/devtools/health/summary", name="db-health")
            connections = await self._get("/devtools/health/connections", name="db-health")
        except CallFailed as exc:
            if exc.status == 403:
                return None
            raise
        return {**summary, "connection_groups": connections.get("groups") or []}
