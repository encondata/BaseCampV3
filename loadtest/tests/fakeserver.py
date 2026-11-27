"""An in-memory stand-in for the BaseCamp kiosk and portal API (portal routes:
fakeserver_portal.py).

It copies what the load test depends on from the real routes in
api/src/serversherpa/api/routes/kiosk.py and auth.py: the same paths, the same
required request fields and limits, the same response field names and the same
error codes (`{"detail": {"code": ...}}`). Everything else is left out.

Every endpoint is `async def` and nothing sleeps or uses a thread: tests drive the
fake under `FakeClock.run`, which only sees work on the event loop. Time (token and
session expiry, registration, `processed_at`) reads the injected clock.

Use it through `fake.transport()`, which wraps `httpx.ASGITransport(app=fake.app)`
and raises `httpx.ConnectError` while `fake.down(True)` is on.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import formatdate
from ipaddress import IPv4Address
from typing import Annotated, Any, Literal

import httpx
from fakeserver_portal import register_portal_routes
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)

from loadtest.clock import Clock

REFRESH_COOKIE = "ss_refresh"
PORTAL_REFRESH_COOKIE = "ss_portal_refresh"
LABEL_STATION_SCAN_STATUS = "labeled"
STATION_TYPES = ("rfid", "label", "timeclock", "dock")
UPLOAD_STATION_TYPES = ("rfid", "label", "dock")
READER_STATION_TYPES = ("rfid", "dock")
HISTORICAL_INITIATIVE_STATUSES = ("completed", "cancelled")
MOVE_LOGIN_BLOCKED_STATUSES = ("completed", "cancelled", "historical")
KIOSK_AUTO_REGISTER_SECONDS = 30 * 86400
RFID_LENGTH = 24

# Active asset status values (checkpoints). An RFID checkpoint's label names RFID,
# as Kiosk Setup's station rule reads it.
ASSET_STATUSES: dict[str, str] = {
    "pre_stage": "Pre-Stage",
    "rfid_1_cage_exit": "RFID 1 - Cage Exit",
    "labeled": "Labeled",
    "rfid_2_loading_dock": "RFID 2 - Loading Dock",
    "pack_logistics": "Pack Logistics",
    "in_container": "In Container",
    "on_truck": "On Truck",
    "received": "Received",
    "un_pack": "Un-Pack",
    "staged": "Staged",
    "rfid_3_staging": "RFID 3 - Staging",
    "rfid_4_into_cage": "RFID 4 - Into Cage",
    "re_racked": "Re-Racked",
    "qa": "QA",
    "complete": "Complete",
}
SCAN_TYPES = ("rfid", "barcode")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _strip_nonblank(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("blank")
    return v


# ── request models: the real ones' required fields and limits ──────────


class MoveLoginIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class HeartbeatIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=80)
    mode: Literal["web", "laptop", "pi", "android", "ios"]
    version: str | None = Field(default=None, max_length=40)
    raw_info: dict[str, Any] = Field(default_factory=dict)
    sign_in: bool = False
    login_method: Literal["password", "link", "biometric"] | None = None
    setup_cleared: uuid.UUID | None = None
    reader: dict[str, Any] | None = None
    config: dict[str, Any] | None = None
    config_changed_at: datetime | None = None
    config_applied_version: int | None = Field(default=None, ge=0)

    @field_validator("serial", "name")
    @classmethod
    def _strip(cls, v: str) -> str:
        return _strip_nonblank(v)

    @field_validator("raw_info")
    @classmethod
    def _raw_info_bounded(cls, v: dict[str, Any]) -> dict[str, Any]:
        if len(v) > 32 or len(json.dumps(v)) > 4096:
            raise ValueError("raw_info too large")
        return v


class KioskReaderIn(BaseModel):
    ip: IPv4Address
    serial: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=64)
    versions: dict[str, Annotated[str, Field(max_length=64)]] = Field(max_length=10)


class KioskSetupIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    initiative_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    scan_status: str | None = Field(default=None, min_length=1)
    station_type: Literal["label", "rfid", "timeclock", "dock"] | None = None
    reader: KioskReaderIn | None = None


class KioskStationKeyIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)


class KioskScanIn(BaseModel):
    client_scan_id: uuid.UUID
    scanned_value: str = Field(min_length=1, max_length=200)
    scan_type: Literal["rfid", "barcode"]
    scanned_at: datetime
    asset_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None
    scan_status: str | None = Field(default=None, max_length=120)
    off_move: bool = False

    @field_validator("scanned_value")
    @classmethod
    def _strip(cls, v: str) -> str:
        return _strip_nonblank(v)


class KioskScanBatchIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    scans: list[KioskScanIn] = Field(min_length=1, max_length=100)


class KioskStationScanBatchIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    scans: list[KioskScanIn] = Field(min_length=1, max_length=50)


class KioskStationHeartbeatIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    version: str | None = Field(default=None, max_length=40)
    reader: dict[str, Any] | None = None
    config: dict[str, Any] | None = None
    config_changed_at: datetime | None = None
    config_applied_version: int | None = Field(default=None, ge=0)


_Str64 = Annotated[str, StringConstraints(max_length=64)]
_Count = Annotated[int, Field(ge=0)]


class KioskReaderReport(BaseModel):
    """services/fixed_readers.py: validated inside the route, so a bad one never
    fails the heartbeat."""

    model_config = ConfigDict(extra="ignore")

    serial: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    make: _Str64 | None = None
    model: _Str64 | None = None
    name: _Str64 | None = None
    firmware: _Str64 | None = None
    mac: Annotated[str, StringConstraints(
        strip_whitespace=True,
        pattern=r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")] | None = None
    ip: IPv4Address | None = None
    uptime_seconds: _Count | None = None
    antennas_connected: _Count | None = None
    antennas_total: _Count | None = None
    tags_24h: _Count | None = None
    reading: bool | None = None
    reachable: bool | None = None
    taken_at: datetime | None = None


class KioskRfidEnrollIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    rfid_tag: str = Field(min_length=1, max_length=200)
    scan_status: str = Field(min_length=1, max_length=120)
    client_scan_id: uuid.UUID
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None


class KioskContainerAssetIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    asset_id: uuid.UUID
    action: Literal["pack", "unpack"]
    scanned_value: str = Field(min_length=1, max_length=200)
    scan_type: Literal["rfid", "barcode"]
    scan_status: str = Field(min_length=1, max_length=120)
    client_scan_id: uuid.UUID
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None


class KioskTruckContainerIn(BaseModel):
    serial: str = Field(min_length=1, max_length=120)
    container_id: uuid.UUID
    action: Literal["load", "unload"]
    scanned_value: str = Field(min_length=1, max_length=200)
    scan_type: str = Field(min_length=1, max_length=120)
    scan_status: str = Field(min_length=1, max_length=120)
    client_scan_id: uuid.UUID
    site_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None


def _sid(v: uuid.UUID | None) -> str | None:
    return str(v) if v is not None else None


# ── state ──────────────────────────────────────────────────────────────


@dataclass
class _Family:
    """One sign-in: every refresh token rotated from it shares the deadline."""

    id: str
    person_id: str
    client: str
    initiative_id: str | None
    expires_at: float
    kiosk_serial: str | None = None
    revoked: bool = False


@dataclass
class _Refresh:
    family: _Family
    rotated: bool = False


@dataclass
class _Access:
    family: _Family
    expires_at: float


@dataclass
class _Actor:
    person_id: str
    family: _Family


@dataclass
class _Failure:
    method: str
    pattern: re.Pattern
    status: int
    times: int
    after_effect: bool


@dataclass
class _PortalUser:
    email: str
    password: str
    totp: Literal["verify", "enroll"] | None
    code: str
    permissions: set[str] | None
    person_id: str = field(default_factory=lambda: str(uuid.uuid4()))


class _FailureMiddleware:
    """Pure ASGI: logs every request, then plays any matching injected failure.

    A plain failure answers without running the route. An `after_effect` one runs
    the route and throws its answer away (Set-Cookie included), so the client sees
    only the failing status: the work landed, the answer was lost."""

    def __init__(self, app, fake: FakeBaseCamp) -> None:
        self.app = app
        self.fake = fake

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        method, path = scope["method"], scope["path"]
        self.fake.requests.append((method, path))
        auth = dict(scope["headers"]).get(b"authorization", b"").decode()
        self.fake.auth_schemes.append((method, path, auth.partition(" ")[0] or None))
        rule = self.fake._take_failure(method, path)
        if rule is None:
            await self.app(scope, receive, send)
            return
        if rule.after_effect:
            async def swallow(message):
                return None

            await self.app(scope, receive, swallow)
        reply = JSONResponse({"detail": {"code": "fake_failure"}}, status_code=rule.status)
        await reply(scope, receive, send)


class _DateHeader:
    """Pure ASGI, outermost: every answer carries a Date header from the fake's clock, as
    uvicorn adds one from the real server's."""

    def __init__(self, app, fake: FakeBaseCamp) -> None:
        self.app = app
        self.fake = fake

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def dated(message):
            if message["type"] == "http.response.start":
                stamp = formatdate(math.floor(self.fake.clock.now()), usegmt=True)
                message = {**message, "headers": [
                    *[(k, v) for k, v in message.get("headers", []) if k.lower() != b"date"],
                    (b"date", stamp.encode())]}
            await send(message)

        await self.app(scope, receive, dated)


class _DownTransport(httpx.AsyncBaseTransport):
    def __init__(self, fake: FakeBaseCamp) -> None:
        self._fake = fake
        self._inner = httpx.ASGITransport(app=fake.app)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._fake._down:
            raise httpx.ConnectError("connection refused", request=request)
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self._inner.aclose()


class FakeBaseCamp:
    session_seconds: float = 86400
    token_seconds: float = 900

    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.session_seconds = type(self).session_seconds
        self.token_seconds = type(self).token_seconds
        self.moves: dict[str, dict] = {}
        self.sites: dict[str, dict] = {}
        self.assets: dict[str, dict] = {}
        self.containers: dict[str, dict] = {}
        self.trucks: dict[str, dict] = {}
        self.container_of: dict[str, str] = {}   # asset id -> container id
        self.truck_of: dict[str, str] = {}       # container id -> truck id
        self.devices: dict[str, dict] = {}
        self.raw_scans: list[dict] = []
        self.processed_scans: list[dict] = []
        self.requests: list[tuple[str, str]] = []
        # (method, path, "Bearer" | "Station" | None): the scheme only, never the secret
        self.auth_schemes: list[tuple[str, str, str | None]] = []
        self.portal_users: dict[str, _PortalUser] = {}
        # reader serial -> what the RFID Stations' heartbeats reported about it
        self.fixed_readers: dict[str, dict] = {}
        self.dropped_reader_reports = 0
        self._failures: list[_Failure] = []
        self._down = False
        self._refresh: dict[str, _Refresh] = {}
        self._access: dict[str, _Access] = {}
        self._kiosk_person: dict[str, str] = {}   # move id -> its kiosk identity
        self._never_again: set[str] = set()        # client_scan_ids a replay may not re-add
        self._raw_seq = itertools.count(1)
        self._legacy_seq = itertools.count(1001)
        self.app = FastAPI()
        self.app.add_middleware(_FailureMiddleware, fake=self)
        self.app.add_middleware(_DateHeader, fake=self)      # outermost
        self._register_auth_routes()
        self._register_kiosk_setup_routes()
        self._register_sync_routes()
        self._register_scan_routes()
        self._register_station_routes()
        self._register_container_truck_routes()
        register_portal_routes(self)

    # ── test controls ──────────────────────────────────────────────────

    def transport(self) -> httpx.AsyncBaseTransport:
        return _DownTransport(self)

    def down(self, on: bool) -> None:
        self._down = on

    def fail(self, method: str, path_regex: str, *, status: int = 503, times: int = 1,
             after_effect: bool = False) -> None:
        self._failures.append(_Failure(method.upper(), re.compile(path_regex), status, times,
                                       after_effect))

    def _take_failure(self, method: str, path: str) -> _Failure | None:
        for rule in self._failures:
            if rule.times > 0 and rule.method == method and rule.pattern.fullmatch(path):
                rule.times -= 1
                return rule
        return None

    def add_move(self, *, servers: int, containers: int, trucks: int,
                 status: str = "in_progress", password: str = "move-pass-1") -> str:
        move_id = str(uuid.uuid4())
        n = len(self.moves) + 1
        origin = self._add_site(f"Origin {n}", 39.0997, -94.5786)
        destination = self._add_site(f"Destination {n}", 41.2565, -95.9345)
        self.moves[move_id] = {
            "id": move_id, "name": f"Load test move {n}", "status": status,
            "initiative_type": "move", "password": password,
            "origin_site_id": origin, "destination_site_id": destination,
        }
        for i in range(1, servers + 1):
            aid = str(uuid.uuid4())
            self.assets[aid] = {
                "id": aid, "legacy_id": next(self._legacy_seq), "name": f"Server {i:05d}",
                "serial_number": f"SN{n:02d}{i:06d}", "rfid_tag": None,
                "initiative_id": move_id, "asset_status": None,
            }
        for i in range(1, containers + 1):
            cid = str(uuid.uuid4())
            self.containers[cid] = {"id": cid, "name": f"Crate {n}-{i:03d}",
                                    "initiative_id": move_id, "site_id": origin,
                                    "status": "available"}
        for i in range(1, trucks + 1):
            tid = str(uuid.uuid4())
            self.trucks[tid] = {"id": tid, "name": f"Truck {n}-{i:02d}", "initiative_id": move_id,
                                "status": "created", "start_site_id": origin,
                                "end_site_id": destination}
        return move_id

    def _add_site(self, name: str, lat: float, lng: float) -> str:
        sid = str(uuid.uuid4())
        self.sites[sid] = {"id": sid, "name": name, "latitude": lat, "longitude": lng}
        return sid

    def add_portal_user(self, email: str, password: str, *,
                        totp: Literal["verify", "enroll"] | None = None, code: str = "123456",
                        permissions: set[str] | None = None) -> None:
        """`permissions` holds "resource:action" strings; None holds every one the
        portal routes check (fakeserver_portal.PORTAL_PERMISSIONS)."""
        self.portal_users[email.lower()] = _PortalUser(email, password, totp, code, permissions)

    def process_scans(self, *, duplicate_on_replay: bool = True) -> None:
        """Drain raw scans into processed scans, like the scan-matching worker.

        A processed raw row is deleted, so its `client_scan_id` is free again: a replay
        lands as a new raw scan and is processed twice (the real server's behavior).
        With `duplicate_on_replay=False` the ids processed here are never re-added."""
        keep: list[dict] = []
        for raw in self.raw_scans:
            if raw["match_attempted_at"] is not None:
                keep.append(raw)
                continue
            match = self._match(raw["scanned_value"], raw["scan_type"])
            if match is None:
                raw["match_attempted_at"] = self._iso(self.clock.now())
                keep.append(raw)
                continue
            match_type, target = match
            self.processed_scans.append({
                **{k: raw[k] for k in ("scanned_value", "scan_type", "status", "scan_status",
                                       "scanned_at", "device_id", "operator_id", "site_id",
                                       "initiative_id", "source", "off_move", "kiosk_asset_id",
                                       "client_scan_id")},
                "id": len(self.processed_scans) + 1, "raw_scan_id": raw["id"],
                "match_type": match_type,
                "asset_id": target if match_type == "asset" else None,
                "container_id": target if match_type == "container" else None,
                "processed_at": self._iso(self.clock.now()),
            })
            if match_type == "asset":
                self.assets[target]["asset_status"] = raw["status"]
            if not duplicate_on_replay and raw["client_scan_id"] is not None:
                self._never_again.add(raw["client_scan_id"])
        self.raw_scans = keep

    def _match(self, value: str, scan_type: str) -> tuple[str, str] | None:
        """Asset first, then container, as scans/matching.py orders them."""
        upper = value.upper()
        for a in self.assets.values():
            if scan_type == "rfid":
                if a["rfid_tag"] and a["rfid_tag"] == upper.rjust(RFID_LENGTH, "0"):
                    return "asset", a["id"]
            elif value in (a["serial_number"], str(a["legacy_id"])):
                return "asset", a["id"]
        for c in self.containers.values():
            if value == c["name"]:
                return "container", c["id"]
        return None

    # ── helpers ────────────────────────────────────────────────────────

    def _iso(self, t: float) -> str:
        return datetime.fromtimestamp(t, UTC).isoformat()

    def _registration(self, device: dict) -> str:
        expires = device.get("token_expires_at")
        if expires is None:
            return "none"
        return "ok" if expires > self.clock.now() else "expired"

    def _actor(self, request: Request) -> _Actor:
        """The kiosk bearer session, with the real 401 codes."""
        scheme, _, token = (request.headers.get("authorization") or "").partition(" ")
        access = self._access.get(token.strip()) if scheme.lower() == "bearer" else None
        if access is None or access.expires_at <= self.clock.now():
            raise HTTPException(401, {"code": "invalid_token"},
                                headers={"WWW-Authenticate": "Bearer"})
        fam = access.family
        if fam.revoked or fam.expires_at <= self.clock.now():
            raise HTTPException(401, {"code": "session_ended"},
                                headers={"WWW-Authenticate": "Bearer"})
        return _Actor(fam.person_id, fam)

    def _require_move(self, actor: _Actor, initiative_id: str | None) -> None:
        locked = actor.family.initiative_id
        if locked is not None and initiative_id != locked:
            raise _err(403, "move_locked")

    def _kiosk_device(self, serial: str) -> dict:
        device = self.devices.get(serial)
        if device is None:
            raise _err(404, "device_not_found")
        return device

    def _station_device(self, request: Request, serial: str,
                        types: tuple[str, ...] = UPLOAD_STATION_TYPES) -> dict:
        scheme, _, raw = (request.headers.get("authorization") or "").partition(" ")
        raw = raw.strip()
        device = self.devices.get(serial)
        if (not (scheme == "Station" and raw) or device is None
                or not device.get("station_key_hash")
                or not secrets.compare_digest(_hash(raw), device["station_key_hash"])
                or device["sub_type"] != "laptop"
                or device.get("station_type") not in STATION_TYPES):
            raise HTTPException(401, {"code": "station_key_invalid"},
                                headers={"WWW-Authenticate": "Bearer"})
        if self._registration(device) != "ok":
            raise _err(403, "kiosk_not_registered")
        if device["station_type"] not in types:
            raise _err(403, "wrong_station_type")
        return device

    def _session_body(self, family: _Family, access_token: str) -> dict:
        move = self.moves.get(family.initiative_id) if family.initiative_id else None
        return {
            "status": "ok", "access_token": access_token, "token_type": "bearer",
            "expires_in": int(self.token_seconds),
            "session_expires_at": self._iso(family.expires_at),
            "person": {"id": family.person_id, "display_name": "Kiosk"},
            "roles": ["worker"], "must_change_password": False, "must_change_reason": None,
            "password_expires_at": None, "preferences": {},
            "perms": {"kiosk": {"view": True}}, "max_rank": 10,
            "scope": {"global": False, "client_ids": [], "partner_ids": [],
                      "restricted_client_ids": []},
            "password_min_length": 8,
            "totp": {"enrolled": False, "enrolled_at": None, "required": False,
                     "backup_codes_remaining": 0},
            "kiosk_move": ({"initiative_id": move["id"], "name": move["name"]}
                           if move else None),
        }

    def _issue(self, family: _Family, response: Response) -> dict:
        refresh = secrets.token_urlsafe(24)
        access = secrets.token_urlsafe(24)
        self._refresh[refresh] = _Refresh(family)
        self._access[access] = _Access(family, self.clock.now() + self.token_seconds)
        # The real cookie is Secure outside development and carries `expires`; this
        # one is neither, so it travels over the fake's plain http:// base URL.
        cookie = REFRESH_COOKIE if family.client == "kiosk" else PORTAL_REFRESH_COOKIE
        response.set_cookie(cookie, refresh, httponly=True, samesite="lax", path="/auth")
        return self._session_body(family, access)

    def _insert_raw(self, row: dict) -> None:
        """INSERT ... ON CONFLICT (client_scan_id) DO NOTHING against raw rows only."""
        csid = row.get("client_scan_id")
        if csid is not None and (csid in self._never_again
                                 or any(r["client_scan_id"] == csid for r in self.raw_scans)):
            return
        self.raw_scans.append({"id": next(self._raw_seq), "match_attempted_at": None,
                               "off_move": False, "kiosk_asset_id": None, **row})

    def _checkpoint(self, key: str) -> str:
        if key not in ASSET_STATUSES:
            raise _err(422, "bad_status")
        return key

    def _check_site_move(self, site_id: str | None, initiative_id: str | None) -> None:
        if site_id is not None and site_id not in self.sites:
            raise _err(422, "bad_site")
        if initiative_id is not None and initiative_id not in self.moves:
            raise _err(422, "bad_initiative")

    def _require_move_asset(self, actor: _Actor, asset: dict) -> None:
        locked = actor.family.initiative_id
        if locked is not None and asset["initiative_id"] != locked:
            raise _err(403, "move_locked")

    # ── /auth, /kiosk/move-login ───────────────────────────────────────

    def _register_auth_routes(self) -> None:
        app = self.app

        @app.post("/kiosk/move-login")
        async def move_login(body: MoveLoginIn, response: Response) -> dict:
            move = next((m for m in self.moves.values() if m["password"] == body.password), None)
            if move is None:
                raise _err(401, "invalid_move_password")
            if move["status"] in MOVE_LOGIN_BLOCKED_STATUSES:
                raise _err(401, "move_not_active")
            person = self._kiosk_person.setdefault(move["id"], str(uuid.uuid4()))
            family = _Family(id=str(uuid.uuid4()), person_id=person, client="kiosk",
                             initiative_id=move["id"],
                             expires_at=self.clock.now() + self.session_seconds)
            return self._issue(family, response)

        @app.post("/auth/refresh")
        async def refresh(request: Request, response: Response,
                          client: Literal["portal", "kiosk"] | None = None) -> Any:
            cookie = PORTAL_REFRESH_COOKIE if client == "portal" else REFRESH_COOKIE
            token = request.cookies.get(cookie)
            if not token:
                raise _err(401, "missing_refresh")
            row = self._refresh.get(token)
            code: str | None = None
            if row is None:
                code = "invalid_session"
            elif client is not None and row.family.client != client:
                raise _err(401, "wrong_client")
            elif row.family.revoked:
                code = "invalid_session"
            elif row.rotated:
                row.family.revoked = True          # replay: the whole sign-in ends
                code = "session_reuse_detected"
            elif row.family.expires_at <= self.clock.now():
                code = "session_expired"
            if code is not None:
                failed = JSONResponse({"detail": {"code": code}}, status_code=401)
                failed.delete_cookie(cookie, path="/auth")
                return failed
            row.rotated = True
            return self._issue(row.family, response)

    # ── heartbeat, setup, station key ──────────────────────────────────

    def _register_kiosk_setup_routes(self) -> None:
        app = self.app

        @app.post("/kiosk/heartbeat")
        async def heartbeat(body: HeartbeatIn, request: Request) -> dict:
            actor = self._actor(request)
            now = self.clock.now()
            device = self.devices.get(body.serial)
            if device is None:
                device = {
                    "id": str(uuid.uuid4()), "device_type": "kiosk", "serial": body.serial,
                    "token_expires_at": None, "current_initiative_id": None, "site_id": None,
                    "scan_status": None, "station_type": None, "station_key_hash": None,
                    "station_key_initiative_id": None, "raw_info": {},
                    "session_person_id": None, "session_login_method": None,
                }
                self.devices[body.serial] = device
            device.update(name=body.name, mode=body.mode, sub_type=body.mode,
                          last_seen_at=now, raw_info={**device["raw_info"], **body.raw_info})
            if body.version is not None:
                device["version"] = body.version
            if body.sign_in:
                device["session_person_id"] = actor.person_id
                device["session_login_method"] = body.login_method
                device["session_started_at"] = now
                if self._registration(device) != "ok":
                    device["token_expires_at"] = now + KIOSK_AUTO_REGISTER_SECONDS
            if actor.family.kiosk_serial is None:
                actor.family.kiosk_serial = body.serial
            expires = device["token_expires_at"]
            return {
                "device_id": device["id"], "name": device["name"],
                "registration": self._registration(device),
                "token_expires_at": self._iso(expires) if expires else None,
                "client_ip": "127.0.0.1", "clear_setup": None,
                "server_time": self._iso(now), "config_version": 0, "config": None,
                "scan_status": device["scan_status"],
                "scan_status_label": ASSET_STATUSES.get(device["scan_status"] or ""),
            }

        @app.post("/kiosk/setup")
        async def setup(body: KioskSetupIn, request: Request) -> dict:
            actor = self._actor(request)
            initiative_id = _sid(body.initiative_id)
            self._require_move(actor, initiative_id)
            device = self._kiosk_device(body.serial)
            move = self.moves.get(initiative_id) if initiative_id else None
            if move is None or move["status"] in HISTORICAL_INITIATIVE_STATUSES:
                raise _err(422, "bad_initiative")
            scan_key = (LABEL_STATION_SCAN_STATUS if body.station_type == "label"
                        else body.scan_status)
            if scan_key not in ASSET_STATUSES:
                raise _err(422, "bad_scan_status")
            site_id = _sid(body.site_id)
            if site_id is not None and site_id == move["origin_site_id"]:
                site_role = "source"
            elif site_id is not None and site_id == move["destination_site_id"]:
                site_role = "destination"
            else:
                raise _err(422, "bad_site")
            if body.station_type in READER_STATION_TYPES:
                if body.reader is None:
                    raise _err(422, "reader_required")
                if device["sub_type"] != "laptop":
                    raise _err(422, "rfid_needs_laptop")
            if device["station_key_hash"] is not None and (
                    device["station_type"] != body.station_type
                    or device["current_initiative_id"] != initiative_id):
                device["station_key_hash"] = None
                device["station_key_initiative_id"] = None
            device["station_type"] = body.station_type
            if body.reader is not None and body.station_type in READER_STATION_TYPES:
                device.update(rfid_reader_ip=str(body.reader.ip),
                              rfid_reader_serial=body.reader.serial,
                              rfid_reader_model=body.reader.model,
                              rfid_reader_versions=dict(body.reader.versions))
            else:
                device.update(rfid_reader_ip=None, rfid_reader_serial=None,
                              rfid_reader_model=None, rfid_reader_versions=None)
            device.update(current_initiative_id=initiative_id, site_id=site_id,
                          scan_status=scan_key)
            return {
                "device_id": device["id"], "initiative_id": initiative_id,
                "initiative_name": move["name"], "site_id": site_id,
                "site_name": self.sites[site_id]["name"], "site_role": site_role,
                "scan_status": scan_key, "scan_status_label": ASSET_STATUSES[scan_key],
            }

        @app.post("/kiosk/station-key")
        async def station_key(body: KioskStationKeyIn, request: Request) -> dict:
            actor = self._actor(request)
            device = self._kiosk_device(body.serial)
            if (device["sub_type"] != "laptop" or device["station_type"] not in STATION_TYPES
                    or device["current_initiative_id"] is None):
                raise _err(409, "not_rfid_station")
            if self._registration(device) != "ok":
                raise _err(409, "kiosk_not_registered")
            if device["session_person_id"] != actor.person_id:
                raise _err(403, "not_signed_in_here")
            self._require_move(actor, device["current_initiative_id"])
            key = secrets.token_urlsafe(32)
            device["station_key_hash"] = _hash(key)
            device["station_key_initiative_id"] = device["current_initiative_id"]
            return {"key": key}

    # ── sync ───────────────────────────────────────────────────────────

    def _sync_move(self, request: Request, initiative_id: uuid.UUID) -> dict:
        actor = self._actor(request)
        self._require_move(actor, str(initiative_id))
        move = self.moves.get(str(initiative_id))
        if move is None:
            raise _err(404, "initiative_not_found")
        return move

    def _register_sync_routes(self) -> None:
        app = self.app

        @app.get("/kiosk/sync/assets")
        async def sync_assets(request: Request, initiative_id: uuid.UUID = Query(...)) -> dict:
            move = self._sync_move(request, initiative_id)
            assets = []
            for a in self.assets.values():
                if a["initiative_id"] != move["id"]:
                    continue
                assets.append({
                    "id": a["id"], "asset_id": str(a["legacy_id"]), "legacy_id": a["legacy_id"],
                    "name": a["name"], "rfid": a["rfid_tag"], "serial_number": a["serial_number"],
                    "make": None, "model": None, "make_model": "",
                    "container_id": self.container_of.get(a["id"]),
                    "asset_status": a["asset_status"],
                    "asset_status_label": ASSET_STATUSES.get(a["asset_status"] or ""),
                    "label": {},
                })
            return {"initiative_id": move["id"], "initiative_name": move["name"],
                    "generated_at": self._iso(self.clock.now()), "assets": assets,
                    "label_context": None}

        @app.get("/kiosk/sync/people")
        async def sync_people(request: Request) -> dict:
            self._actor(request)
            return {"generated_at": self._iso(self.clock.now()), "people": []}

        @app.get("/kiosk/sync/containers")
        async def sync_containers(request: Request,
                                  initiative_id: uuid.UUID = Query(...)) -> dict:
            move = self._sync_move(request, initiative_id)
            rows = [{
                "id": c["id"], "name": c["name"], "legacy_id": None, "rfid_tag": None,
                "label_tag": None, "container_type": None, "container_type_label": None,
                "status": c["status"], "status_label": c["status"].title(),
                "site_id": c["site_id"], "site_name": self.sites[c["site_id"]]["name"],
                "asset_count": self._asset_count(c["id"]),
            } for c in self.containers.values() if c["initiative_id"] == move["id"]]
            return {"initiative_id": move["id"], "generated_at": self._iso(self.clock.now()),
                    "containers": rows}

        @app.get("/kiosk/sync/trucks")
        async def sync_trucks(request: Request, initiative_id: uuid.UUID = Query(...)) -> dict:
            move = self._sync_move(request, initiative_id)
            rows = [{
                "id": t["id"], "name": t["name"], "load_number": None, "status": t["status"],
                "status_label": t["status"].replace("_", " ").title(), "driver_name": None,
                "start_site_id": t["start_site_id"],
                "start_site_name": self.sites[t["start_site_id"]]["name"],
                "end_site_id": t["end_site_id"],
                "end_site_name": self.sites[t["end_site_id"]]["name"],
                "container_count": self._container_count(t["id"]),
            } for t in self.trucks.values() if t["initiative_id"] == move["id"]]
            return {"initiative_id": move["id"], "generated_at": self._iso(self.clock.now()),
                    "trucks": rows}

        @app.get("/kiosk/sync/label-templates")
        async def sync_label_templates(request: Request,
                                       initiative_id: uuid.UUID = Query(...)) -> dict:
            move = self._sync_move(request, initiative_id)
            return {"initiative_id": move["id"], "generated_at": self._iso(self.clock.now()),
                    "templates": []}

    def _asset_count(self, container_id: str) -> int:
        return sum(1 for c in self.container_of.values() if c == container_id)

    def _container_count(self, truck_id: str) -> int:
        return sum(1 for t in self.truck_of.values() if t == truck_id)

    # ── scans and RFID enroll ──────────────────────────────────────────

    def _store_scan_batch(self, device: dict, scans: list[KioskScanIn], *,
                          operator_id: str | None, locked: str | None,
                          allowed_moves: set[str] | None, allowed_sites: set[str] | None,
                          rfid_only: bool = False, barcode_only: bool = False,
                          forced_status: str | None = None, check_inactive: bool = False,
                          off_move_allowed: bool = False) -> dict:
        """The real `_store_scan_batch`. `check_inactive` is the station route's
        `inactive_moves` (the person route passes an empty set, so it never rejects
        `move_inactive`); `off_move_allowed` is `not label` on the station route and
        False on the person route."""
        accepted: list[str] = []
        rejected: list[dict] = []
        for scan in scans:
            site_id, initiative_id = _sid(scan.site_id), _sid(scan.initiative_id)
            move = initiative_id or device["current_initiative_id"]
            if (scan.scan_type not in SCAN_TYPES or (rfid_only and scan.scan_type != "rfid")
                    or (barcode_only and scan.scan_type != "barcode")):
                code = "bad_scan_type"
            elif site_id is not None and site_id not in self.sites:
                code = "bad_site"
            elif initiative_id is not None and initiative_id not in self.moves:
                code = "bad_initiative"
            elif (forced_status is None and scan.scan_status is not None
                    and scan.scan_status not in ASSET_STATUSES):
                code = "bad_status"
            elif locked is not None and move != locked:
                code = "move_locked"
            elif allowed_moves is not None and move not in allowed_moves:
                code = "move_locked"
            elif (check_inactive and move in self.moves
                    and self.moves[move]["status"] in HISTORICAL_INITIATIVE_STATUSES):
                code = "move_inactive"
            elif allowed_sites is not None and (site_id or device["site_id"]) not in allowed_sites:
                code = "bad_site"
            else:
                code = ""
            if code:
                rejected.append({"client_scan_id": str(scan.client_scan_id), "code": code})
                continue
            checkpoint = forced_status or scan.scan_status or device["scan_status"]
            self._insert_raw({
                "scanned_value": scan.scanned_value, "scan_type": scan.scan_type,
                "status": checkpoint, "scan_status": checkpoint,
                "scanned_at": scan.scanned_at.isoformat(), "device_id": device["name"],
                "operator_id": operator_id, "off_move": scan.off_move and off_move_allowed,
                "site_id": site_id or device["site_id"], "initiative_id": move,
                "source": "kiosk", "client_scan_id": str(scan.client_scan_id),
                "kiosk_asset_id": _sid(scan.asset_id),
            })
            accepted.append(str(scan.client_scan_id))
        device["last_seen_at"] = self.clock.now()
        return {"accepted": accepted, "rejected": rejected}

    def _register_scan_routes(self) -> None:
        app = self.app

        @app.post("/kiosk/scans")
        async def scans(body: KioskScanBatchIn, request: Request) -> dict:
            actor = self._actor(request)
            device = self._kiosk_device(body.serial)
            return self._store_scan_batch(device, body.scans, operator_id=actor.person_id,
                                          locked=actor.family.initiative_id,
                                          allowed_moves=None, allowed_sites=None)

        @app.post("/kiosk/assets/{asset_id}/rfid")
        async def enroll(asset_id: uuid.UUID, body: KioskRfidEnrollIn, request: Request) -> dict:
            actor = self._actor(request)
            tag = "".join(body.rfid_tag.split()).upper()
            if not tag or not tag.isascii() or not tag.isalnum():
                raise _err(422, "bad_rfid")
            if len(tag) > RFID_LENGTH:
                raise _err(422, "rfid_too_long")
            tag = tag.rjust(RFID_LENGTH, "0")
            device = self._kiosk_device(body.serial)
            self._require_move(actor, _sid(body.initiative_id) or device["current_initiative_id"])
            asset = self.assets.get(str(asset_id))
            if asset is None:
                raise _err(404, "asset_not_found")
            self._require_move_asset(actor, asset)
            checkpoint = self._checkpoint(body.scan_status)
            self._check_site_move(_sid(body.site_id), _sid(body.initiative_id))
            holder = next((a for a in self.assets.values()
                           if a["rfid_tag"] == tag and a["id"] != asset["id"]), None)
            if holder is not None:
                raise _err(409, "rfid_in_use", asset_id=holder["id"], asset_name=holder["name"])
            already = (asset["rfid_tag"] or "").upper() == tag
            asset["rfid_tag"] = tag
            self._insert_raw({
                "scanned_value": tag, "scan_type": "rfid", "status": checkpoint,
                "scan_status": checkpoint, "scanned_at": self._iso(self.clock.now()),
                "device_id": device["name"], "operator_id": actor.person_id,
                "site_id": _sid(body.site_id) or device["site_id"],
                "initiative_id": _sid(body.initiative_id) or device["current_initiative_id"],
                "source": "kiosk", "client_scan_id": str(body.client_scan_id),
                "kiosk_asset_id": asset["id"],
            })
            return {"asset_id": asset["id"], "asset_name": asset["name"],
                    "asset_tag": str(asset["legacy_id"]),
                    "serial_number": asset["serial_number"], "rfid_tag": tag,
                    "already_had_tag": already}

    # ── station-key routes ─────────────────────────────────────────────

    def _register_station_routes(self) -> None:
        app = self.app

        @app.post("/kiosk/station/scans")
        async def station_scans(body: KioskStationScanBatchIn, request: Request) -> dict:
            device = self._station_device(request, body.serial)
            move_id = device["station_key_initiative_id"]
            move = self.moves.get(move_id) if move_id else None
            sites = ({x for x in (move["origin_site_id"], move["destination_site_id"]) if x}
                     if move else set())
            label = device["station_type"] == "label"
            out = self._store_scan_batch(
                device, body.scans, operator_id=None, locked=None,
                allowed_moves={move_id} if move_id else set(), allowed_sites=sites,
                rfid_only=not label, barcode_only=label,
                forced_status=LABEL_STATION_SCAN_STATUS if label else None,
                check_inactive=True, off_move_allowed=not label)
            return {**out, "clear_setup": None}

        @app.post("/kiosk/station/heartbeat")
        async def station_heartbeat(body: KioskStationHeartbeatIn, request: Request) -> dict:
            device = self._station_device(request, body.serial)
            if device["station_type"] not in READER_STATION_TYPES:
                raise HTTPException(401, {"code": "station_key_invalid"},
                                    headers={"WWW-Authenticate": "Bearer"})
            now = self.clock.now()
            device["last_seen_at"] = now
            if body.version is not None:
                device["version"] = body.version
            if body.reader is not None:
                self._apply_reader_report(device, body.reader)
            return {"registration": self._registration(device),
                    "token_expires_at": self._iso(device["token_expires_at"]),
                    "clear_setup": None, "server_time": self._iso(now),
                    "config_version": 0, "config": None,
                    "scan_status": device["scan_status"],
                    "scan_status_label": ASSET_STATUSES.get(device["scan_status"] or "")}

    def _apply_reader_report(self, kiosk: dict, report: dict) -> None:
        """services/fixed_readers.apply_reader_report: a valid report for the kiosk's
        paired reader upserts one fixed reader by serial; anything else is dropped
        and never fails the beat."""
        try:
            parsed = KioskReaderReport.model_validate(report)
        except ValidationError:
            self.dropped_reader_reports += 1
            return
        if (kiosk["station_type"] not in READER_STATION_TYPES
                or not kiosk.get("rfid_reader_serial")
                or parsed.serial.lower() != kiosk["rfid_reader_serial"].lower()):
            self.dropped_reader_reports += 1
            return
        reader = self.fixed_readers.setdefault(parsed.serial, {"serial": parsed.serial})
        reader.update({k: v for k, v in parsed.model_dump(mode="json").items()
                       if k in parsed.model_fields_set and v is not None})
        reader.update(via_kiosk_serial=kiosk["serial"], site_id=kiosk["site_id"],
                      current_initiative_id=kiosk["current_initiative_id"],
                      reachable=parsed.reachable)

    # ── pack / unpack, load / unload ───────────────────────────────────

    def _register_container_truck_routes(self) -> None:
        app = self.app

        @app.post("/kiosk/containers/{container_id}/assets")
        async def container_asset(container_id: uuid.UUID, body: KioskContainerAssetIn,
                                  request: Request) -> dict:
            actor = self._actor(request)
            device = self._kiosk_device(body.serial)
            self._require_move(actor, _sid(body.initiative_id) or device["current_initiative_id"])
            container = self.containers.get(str(container_id))
            if container is None:
                raise _err(404, "container_not_found")
            self._require_move(actor, container["initiative_id"])
            asset = self.assets.get(str(body.asset_id))
            if asset is None:
                raise _err(404, "asset_not_found")
            self._require_move_asset(actor, asset)
            checkpoint = self._checkpoint(body.scan_status)
            self._check_site_move(_sid(body.site_id), _sid(body.initiative_id))
            holder_id = self.container_of.get(asset["id"])
            moved_from = None
            already_there = False
            if body.action == "pack":
                if holder_id == container["id"]:
                    already_there = True
                else:
                    if holder_id is not None:
                        holder = self.containers[holder_id]
                        moved_from = {"id": holder["id"], "name": holder["name"]}
                    self.container_of[asset["id"]] = container["id"]
            else:
                if holder_id != container["id"]:
                    extra = ({"container_id": holder_id,
                              "container_name": self.containers[holder_id]["name"]}
                             if holder_id is not None else {})
                    raise _err(409, "not_in_container", **extra)
                del self.container_of[asset["id"]]
            self._insert_raw({
                "scanned_value": body.scanned_value, "scan_type": body.scan_type,
                "status": checkpoint, "scan_status": checkpoint,
                "scanned_at": self._iso(self.clock.now()), "device_id": device["name"],
                "operator_id": actor.person_id,
                "site_id": _sid(body.site_id) or device["site_id"],
                "initiative_id": _sid(body.initiative_id) or device["current_initiative_id"],
                "source": "kiosk", "client_scan_id": str(body.client_scan_id),
                "kiosk_asset_id": asset["id"],
            })
            return {
                "container": {"id": container["id"], "name": container["name"],
                              "asset_count": self._asset_count(container["id"])},
                "asset": {"id": asset["id"], "name": asset["name"],
                          "asset_tag": str(asset["legacy_id"]),
                          "serial_number": asset["serial_number"], "rfid": asset["rfid_tag"]},
                "action": body.action, "moved_from": moved_from, "already_there": already_there,
            }

        @app.post("/kiosk/trucks/{truck_id}/containers")
        async def truck_container(truck_id: uuid.UUID, body: KioskTruckContainerIn,
                                  request: Request) -> dict:
            actor = self._actor(request)
            device = self._kiosk_device(body.serial)
            self._require_move(actor, _sid(body.initiative_id) or device["current_initiative_id"])
            truck = self.trucks.get(str(truck_id))
            if truck is None:
                raise _err(404, "truck_not_found")
            self._require_move(actor, truck["initiative_id"])
            container = self.containers.get(str(body.container_id))
            if container is None:
                raise _err(404, "container_not_found")
            self._require_move(actor, container["initiative_id"])
            checkpoint = self._checkpoint(body.scan_status)
            if body.scan_type not in SCAN_TYPES:
                raise _err(422, "bad_scan_type")
            self._check_site_move(_sid(body.site_id), _sid(body.initiative_id))
            holder_id = self.truck_of.get(container["id"])
            moved_from = None
            already_there = False
            if body.action == "load":
                if holder_id == truck["id"]:
                    already_there = True
                else:
                    if holder_id is not None:
                        holder = self.trucks[holder_id]
                        moved_from = {"id": holder["id"], "name": holder["name"]}
                    self.truck_of[container["id"]] = truck["id"]
            else:
                if holder_id != truck["id"]:
                    extra = ({"truck_id": holder_id, "truck_name": self.trucks[holder_id]["name"]}
                             if holder_id is not None else {})
                    raise _err(409, "not_on_truck", **extra)
                del self.truck_of[container["id"]]
            self._insert_raw({
                "scanned_value": body.scanned_value, "scan_type": body.scan_type,
                "status": checkpoint, "scan_status": checkpoint,
                "scanned_at": self._iso(self.clock.now()), "device_id": device["name"],
                "operator_id": actor.person_id,
                "site_id": _sid(body.site_id) or device["site_id"],
                "initiative_id": _sid(body.initiative_id) or device["current_initiative_id"],
                "source": "kiosk", "client_scan_id": str(body.client_scan_id),
            })
            return {
                "truck": {"id": truck["id"], "name": truck["name"],
                          "container_count": self._container_count(truck["id"])},
                "container": {"id": container["id"], "name": container["name"],
                              "asset_count": self._asset_count(container["id"])},
                "action": body.action, "moved_from": moved_from, "already_there": already_there,
            }
