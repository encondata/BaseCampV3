"""One simulated kiosk (handheld, RFID Station or Label Station).

It makes exactly the calls a real device makes (kiosk/src/lib/api.ts, sync.ts,
heartbeat.ts, outbox.ts): move-password sign-in, a sign-in heartbeat, Kiosk Setup,
a station key for stations, the setup sync, heartbeats, and the scan-bearing calls.

Secrets (move password, access token, station key, refresh cookie) live only on the
instance and in its own cookie jar; `repr` and every exception leave them out.
"""

from __future__ import annotations

import asyncio
import contextvars
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

import httpx

from ..clock import Clock
from ..http import CallFailed, TokenExpired, renewing_call, sendable_cookie, timed_call
from ..metrics import Metrics
from ..profile import DeviceKind, RetrySpec
from ..throughput import SCANS_REJECTED, SCANS_SENT

VERSION = "loadtest"
RAW_INFO = {"loadtest": True}
HANDHELD_BATCH = 100        # KioskScanBatchIn.scans max_length
STATION_BATCH = 50          # KioskStationScanBatchIn.scans max_length
REFRESH_MARGIN = 60.0       # refresh when the token has this little left
# a refresh cannot outlive the sign-in, and one sent just before its end can reach the
# server after it (401 session_expired): this close to the end, sign in again instead
SESSION_END_MARGIN = 5.0
NO_RETRY = RetrySpec(attempts=1, backoff_seconds=())

# Requests sent inside one timed_call: more than one means the call was retried.
_attempts: contextvars.ContextVar[list[int] | None] = contextvars.ContextVar(
    "kiosk_attempts", default=None)


async def _count_attempt(request: httpx.Request) -> None:
    box = _attempts.get()
    if box is not None:
        box[0] += 1


@dataclass(frozen=True)
class ScanOut:
    client_scan_id: uuid.UUID
    scanned_value: str
    scan_type: Literal["rfid", "barcode"]
    scanned_at: datetime
    scan_status: str
    site_id: str
    initiative_id: str


@dataclass(frozen=True)
class SyncData:
    assets: list[dict]
    containers: list[dict]
    trucks: list[dict]


def _detail(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        return {}
    detail = body.get("detail") if isinstance(body, dict) else None
    return detail if isinstance(detail, dict) else {}


def _unpacked(response: httpx.Response) -> bool:
    """A repeated unpack: 409 not_in_container naming no container (the asset is in none)."""
    detail = _detail(response)
    return (response.status_code == 409 and detail.get("code") == "not_in_container"
            and "container_id" not in detail)


def _unloaded(response: httpx.Response) -> bool:
    """A repeated unload: 409 not_on_truck naming no truck (the crate is on none)."""
    detail = _detail(response)
    return (response.status_code == 409 and detail.get("code") == "not_on_truck"
            and "truck_id" not in detail)


def _number(serial: str) -> int:
    match = re.search(r"(\d+)$", serial)
    return int(match.group(1)) if match else 1


def _epoch(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


class KioskDevice:
    def __init__(self, *, base_url: str, serial: str, name: str, kind: DeviceKind,
                 metrics: Metrics, clock: Clock, retry: RetrySpec, timeout: float,
                 transport: httpx.AsyncBaseTransport | None = None,
                 reader_number: int | None = None) -> None:
        """`reader_number` numbers an RFID Station's made-up reader (the fleet numbers
        them across its stations); without it, the serial's trailing number is used."""
        self.serial = serial
        self.name = name
        self.kind = kind
        self.metrics = metrics
        self.clock = clock
        self.retry = retry
        self.initiative_id: str | None = None
        self.site_id: str | None = None
        self.scan_status: str | None = None
        self._reader_number = reader_number
        self._client = httpx.AsyncClient(
            base_url=base_url, timeout=timeout, transport=transport,
            event_hooks={"request": [_count_attempt]})
        self._lock = asyncio.Lock()
        self._password: str | None = None
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._session_expires_at = 0.0
        self._key: str | None = None

    def __repr__(self) -> str:
        return f"KioskDevice(serial={self.serial!r}, name={self.name!r}, kind={self.kind!r})"

    @property
    def is_station(self) -> bool:
        return self.kind != "handheld"

    @property
    def has_key(self) -> bool:
        return self._key is not None

    @property
    def has_refresh_cookie(self) -> bool:
        return sendable_cookie(self._client, "ss_refresh")

    async def close(self) -> None:
        """Closes the connection and forgets the move password, token and station key."""
        self._password = self._token = self._key = None
        await self._client.aclose()

    # ── sign-in and tokens ─────────────────────────────────────────────

    async def sign_in(self, move_password: str) -> None:
        """Move-password sign-in, then a sign-in heartbeat under this serial."""
        self._password = move_password
        async with self._lock:
            await self._sign_in_locked()

    async def _sign_in_locked(self) -> None:
        """Move-login and the sign-in heartbeat. A 401 on either (a wrong move
        password, a token refused at once) is a plain CallFailed here: there is
        nothing left to renew."""
        if self._password is None:
            raise CallFailed("move-login", None, "not_signed_in", 0)
        # token_call=False: a 401 here is a refused password (invalid_move_password,
        # move_not_active), a final failure with the server's code
        response = await timed_call(
            self._client, "POST", "/kiosk/move-login", name="move-login",
            metrics=self.metrics, clock=self.clock, retry=self.retry, token_call=False,
            json={"password": self._password})
        self._take_session(response)
        try:
            await timed_call(
                self._client, "POST", "/kiosk/heartbeat", name="heartbeat",
                metrics=self.metrics, clock=self.clock, retry=self.retry,
                headers=self._bearer(), json=self._heartbeat_body(sign_in=True))
        except TokenExpired:
            self.metrics.record("heartbeat", None, False)
            raise CallFailed("heartbeat", 401, None, 0) from None

    def _take_session(self, response: httpx.Response) -> None:
        body = response.json()
        self._token = body["access_token"]
        self._token_expires_at = self.clock.now() + float(body["expires_in"])
        self._session_expires_at = _epoch(body["session_expires_at"])

    async def _refresh_locked(self) -> None:
        """One refresh, never retried: a refresh whose answer was lost already
        rotated the cookie, and replaying the old one would end the sign-in. Any
        failure signs in again instead."""
        try:
            response = await timed_call(
                self._client, "POST", "/auth/refresh", name="refresh",
                metrics=self.metrics, clock=self.clock, retry=NO_RETRY,
                params={"client": "kiosk"})
        except TokenExpired:
            self.metrics.record("refresh", None, False)
        except CallFailed:
            pass
        else:
            self._take_session(response)
            return
        await self._sign_in_locked()

    async def _ensure_token(self) -> None:
        async with self._lock:
            now = self.clock.now()
            if self._token is None or now >= self._session_expires_at - SESSION_END_MARGIN:
                await self._sign_in_locked()
            elif now >= self._token_expires_at - REFRESH_MARGIN:
                await self._refresh_locked()

    async def _renew_after_401(self, used: str | None) -> None:
        async with self._lock:
            if self._token != used:
                return                      # another call already renewed it
            if self.clock.now() >= self._session_expires_at - SESSION_END_MARGIN:
                await self._sign_in_locked()
            else:
                await self._refresh_locked()

    def _bearer(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def _station(self) -> dict[str, str]:
        return {"Authorization": f"Station {self._key}"}

    async def _timed(self, method: str, url: str, *, name: str, headers: dict[str, str],
                     already_done: Callable[[httpx.Response], bool] | None = None,
                     already_done_first: bool = False,
                     **kwargs) -> tuple[httpx.Response, int]:
        """timed_call, also returning how many requests it sent. On CallFailed the
        count rides on the exception as `attempts`."""
        box = [0]
        reset = _attempts.set(box)
        try:
            response = await timed_call(
                self._client, method, url, name=name, metrics=self.metrics, clock=self.clock,
                retry=self.retry, already_done=already_done,
                already_done_first=already_done_first, headers=headers, **kwargs)
        except CallFailed as exc:
            exc.attempts = box[0]
            raise
        except TokenExpired as exc:
            exc.attempts = box[0]
            raise
        finally:
            _attempts.reset(reset)
        return response, box[0]

    async def _bearer_call(self, method: str, url: str, *, name: str,
                           already_done: Callable[[httpx.Response], bool] | None = None,
                           already_done_first: bool = False,
                           **kwargs) -> tuple[httpx.Response, int]:
        """A call under the sign-in (http.renewing_call): refresh first when due; on a
        401 renew once and redo the call once, recorded exactly once."""
        async def send(prior: int) -> tuple[httpx.Response, int]:
            return await self._timed(method, url, name=name, headers=self._bearer(),
                                     already_done=already_done,
                                     already_done_first=already_done_first,
                                     prior_attempts=prior, **kwargs)

        return await renewing_call(
            name, metrics=self.metrics, ensure_token=self._ensure_token,
            current_token=lambda: self._token, renew_after_401=self._renew_after_401,
            send=send)

    async def _station_call(self, url: str, *, name: str, json: dict) -> tuple[httpx.Response, int]:
        """A station-key call. A 401 means the key is gone; it is a plain failure."""
        try:
            return await self._timed("POST", url, name=name, headers=self._station(), json=json)
        except TokenExpired as exc:
            landed = exc.attempts - 1
            self.metrics.record(name, None, False, landed)
            failed = CallFailed(name, 401, "station_key_invalid", landed)
            failed.attempts = landed
            raise failed from None

    # ── setup and sync ─────────────────────────────────────────────────

    def _heartbeat_body(self, *, sign_in: bool) -> dict:
        body = {"serial": self.serial, "name": self.name,
                "mode": "laptop" if self.is_station else "web", "version": VERSION,
                "raw_info": RAW_INFO, "sign_in": sign_in}
        if sign_in:
            body["login_method"] = "password"
        return body

    async def setup(self, *, initiative_id: str, site_id: str, scan_status: str) -> None:
        """Kiosk Setup for the move, site and checkpoint; stations then fetch their key."""
        body: dict = {"serial": self.serial, "initiative_id": initiative_id,
                      "site_id": site_id, "scan_status": scan_status}
        if self.kind == "rfid_station":
            ip, serial, model = self._reader()
            body["station_type"] = "rfid"
            body["reader"] = {"ip": ip, "serial": serial, "model": model, "versions": {}}
        elif self.kind == "label_station":
            body["station_type"] = "label"
        response, _ = await self._bearer_call("POST", "/kiosk/setup", name="setup", json=body)
        answer = response.json()
        self.initiative_id = initiative_id
        self.site_id = site_id
        self.scan_status = answer.get("scan_status") or scan_status
        if self.is_station:
            # a failed key call raises: a station never falls back to the person routes
            self._key = None
            response, _ = await self._bearer_call("POST", "/kiosk/station-key",
                                                  name="station-key",
                                                  json={"serial": self.serial})
            self._key = response.json()["key"]

    def _reader(self) -> tuple[str, str, str]:
        """This RFID Station's made-up FX9600: ip, serial, model."""
        n = self._reader_number or _number(self.serial)
        return f"10.254.0.{n}", f"LOADTEST-READER-{n}", "FX9600"

    def _reader_snapshot(self) -> dict:
        """The reader report the edge attaches to the station heartbeat
        (kiosk_laptop edge rfid/reader_report.py), with fixed values: reachable,
        reading, four of four antennas connected. Fields the edge leaves out when
        the reader does not report them (name, firmware, mac, uptime) are left out."""
        ip, serial, model = self._reader()
        return {"serial": serial, "make": "Zebra", "model": model, "ip": ip,
                "antennas_connected": 4, "antennas_total": 4, "reading": True,
                "reachable": True, "tags_24h": 0,
                "taken_at": datetime.fromtimestamp(self.clock.now(), UTC).isoformat()}

    async def sync(self, initiative_id: str) -> SyncData:
        """Every call runSync makes: the four move downloads together, then the
        label templates as a soft step (a failure there is recorded, not raised).
        One failed download cancels the other three and raises its CallFailed."""
        q = {"initiative_id": initiative_id}
        try:
            async with asyncio.TaskGroup() as group:
                assets = group.create_task(
                    self._bearer_call("GET", "/kiosk/sync/assets", name="sync", params=q))
                group.create_task(self._bearer_call("GET", "/kiosk/sync/people", name="sync"))
                containers = group.create_task(
                    self._bearer_call("GET", "/kiosk/sync/containers", name="sync", params=q))
                trucks = group.create_task(
                    self._bearer_call("GET", "/kiosk/sync/trucks", name="sync", params=q))
        except BaseExceptionGroup as group_error:
            failed = [e for e in group_error.exceptions if isinstance(e, CallFailed)]
            if failed and len(failed) == len(group_error.exceptions):
                raise failed[0] from None
            raise
        try:
            await self._bearer_call("GET", "/kiosk/sync/label-templates", name="sync", params=q)
        except CallFailed:
            pass
        return SyncData(assets=assets.result()[0].json()["assets"],
                        containers=containers.result()[0].json()["containers"],
                        trucks=trucks.result()[0].json()["trucks"])

    async def heartbeat(self) -> None:
        """The 60-second beat. Never raises CallFailed: the outcome is in the metrics."""
        try:
            if self._key is not None:
                if self.kind == "rfid_station":
                    await self._station_call("/kiosk/station/heartbeat",
                                             name="station-heartbeat",
                                             json={"serial": self.serial, "version": VERSION,
                                                   "reader": self._reader_snapshot()})
                return                      # a keyed Label Station sends no heartbeat
            await self._bearer_call("POST", "/kiosk/heartbeat", name="heartbeat",
                                    json=self._heartbeat_body(sign_in=False))
        except CallFailed:
            return

    # ── scan-bearing calls ─────────────────────────────────────────────

    def _note_retry(self, attempts: int, ids: list[uuid.UUID]) -> None:
        if attempts > 1:
            self.metrics.count("scans_retried", len(ids))

    async def _scan_call(self, url: str, *, name: str, body: dict, scan_ids: list[uuid.UUID],
                         already_done: Callable[[httpx.Response], bool] | None = None,
                         already_done_first: bool = False,
                         station: bool = False) -> httpx.Response | None:
        try:
            if station:
                response, attempts = await self._station_call(url, name=name, json=body)
            else:
                response, attempts = await self._bearer_call(
                    "POST", url, name=name, already_done=already_done,
                    already_done_first=already_done_first, json=body)
        except CallFailed as exc:
            self._note_retry(getattr(exc, "attempts", 0), scan_ids)
            return None
        self._note_retry(attempts, scan_ids)
        self.metrics.count(SCANS_SENT, len(scan_ids))
        return response

    @staticmethod
    def _scan_row(scan: ScanOut) -> dict:
        return {"client_scan_id": str(scan.client_scan_id), "scanned_value": scan.scanned_value,
                "scan_type": scan.scan_type, "scanned_at": scan.scanned_at.isoformat(),
                "site_id": scan.site_id, "initiative_id": scan.initiative_id,
                "scan_status": scan.scan_status}

    async def send_scans(self, scans: list[ScanOut]) -> int:
        """Upload scans in batches the route allows; returns how many the server took.
        A station with no key sends nothing (counted as `scans_not_sent`): it never
        falls back to the person route."""
        if self.is_station and self._key is None:
            self.metrics.count("scans_not_sent", len(scans))
            return 0
        station = self._key is not None
        url, name, size = (("/kiosk/station/scans", "station-scans", STATION_BATCH) if station
                           else ("/kiosk/scans", "scans", HANDHELD_BATCH))
        accepted = 0
        for start in range(0, len(scans), size):
            batch = scans[start:start + size]
            body = {"serial": self.serial, "scans": [self._scan_row(s) for s in batch]}
            response = await self._scan_call(url, name=name, body=body, station=station,
                                             scan_ids=[s.client_scan_id for s in batch])
            if response is None:
                continue
            answer = response.json()
            rejected = len(answer.get("rejected") or [])
            if rejected:
                self.metrics.count(SCANS_REJECTED, rejected)
            accepted += len(answer.get("accepted") or [])
        return accepted

    async def enroll(self, *, asset_id: str, tag: str, scan: ScanOut) -> bool:
        body = {"serial": self.serial, "rfid_tag": tag, "scan_status": scan.scan_status,
                "client_scan_id": str(scan.client_scan_id), "site_id": scan.site_id,
                "initiative_id": scan.initiative_id}
        response = await self._scan_call(f"/kiosk/assets/{asset_id}/rfid", name="enroll",
                                         body=body, scan_ids=[scan.client_scan_id])
        return response is not None

    def _move_body(self, scan: ScanOut) -> dict:
        return {"serial": self.serial, "scanned_value": scan.scanned_value,
                "scan_type": scan.scan_type, "scan_status": scan.scan_status,
                "client_scan_id": str(scan.client_scan_id), "site_id": scan.site_id,
                "initiative_id": scan.initiative_id}

    async def _container(self, action: str, container_id: str, asset_id: str,
                         scan: ScanOut, already_done_first: bool = False) -> bool:
        body = {**self._move_body(scan), "asset_id": asset_id, "action": action}
        response = await self._scan_call(
            f"/kiosk/containers/{container_id}/assets", name=action, body=body,
            scan_ids=[scan.client_scan_id],
            already_done=_unpacked if action == "unpack" else None,
            already_done_first=already_done_first)
        return response is not None

    async def _truck(self, action: str, truck_id: str, container_id: str,
                     scan: ScanOut, already_done_first: bool = False) -> bool:
        body = {**self._move_body(scan), "container_id": container_id, "action": action}
        response = await self._scan_call(
            f"/kiosk/trucks/{truck_id}/containers", name=action, body=body,
            scan_ids=[scan.client_scan_id],
            already_done=_unloaded if action == "unload" else None,
            already_done_first=already_done_first)
        return response is not None

    async def pack(self, *, container_id: str, asset_id: str, scan: ScanOut) -> bool:
        """A repeated pack into the same crate is a 200 (`already_there`), so it needs
        no already-done rule."""
        return await self._container("pack", container_id, asset_id, scan)

    async def unpack(self, *, container_id: str, asset_id: str, scan: ScanOut,
                     already_done_first: bool = False) -> bool:
        """`already_done_first`: the answer "this server is in no container" counts as
        success on the first try too (a continued run's resend of an unpack that may have
        landed before the interruption)."""
        return await self._container("unpack", container_id, asset_id, scan,
                                     already_done_first)

    async def load(self, *, truck_id: str, container_id: str, scan: ScanOut) -> bool:
        """A repeated load onto the same truck is a 200 (`already_there`)."""
        return await self._truck("load", truck_id, container_id, scan)

    async def unload(self, *, truck_id: str, container_id: str, scan: ScanOut,
                     already_done_first: bool = False) -> bool:
        """`already_done_first`: as for unpack, "this crate is on no truck"."""
        return await self._truck("unload", truck_id, container_id, scan, already_done_first)

