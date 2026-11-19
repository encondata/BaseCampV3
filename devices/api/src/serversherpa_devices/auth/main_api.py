"""The main API, as this service sees it: who a bearer token belongs to
(`/app-distribution/internal/authorize`) and where audit rows go
(`/app-distribution/internal/audit`). Both calls present the shared service
token (X-Devices-Service-Token).

Successful authorize answers are cached for `authorize_cache_seconds`,
keyed by sha256(bearer); failures never are. Logs name an error's class
and status only: never a token, a response body or a user's details."""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import httpx

from serversherpa_devices.config import Settings, get_settings

log = logging.getLogger(__name__)

AUTHORIZE_PATH = "/app-distribution/internal/authorize"
AUDIT_PATH = "/app-distribution/internal/audit"
SERVICE_TOKEN_HEADER = "X-Devices-Service-Token"
_TIMEOUT = httpx.Timeout(5.0, connect=2.0)


class MainApiUnavailable(Exception):
    """The main API couldn't answer: down, unreachable, a 5xx, or it refused
    this service (bad or unset service token). Never the user's fault."""


@dataclass(frozen=True)
class Principal:
    person_id: uuid.UUID
    display_name: str
    client: Literal["portal", "kiosk"]
    kiosk_serial: str | None
    actions: frozenset[str]
    password_change_required: bool
    read_only: bool
    read_only_message: str | None

    def can(self, action: str) -> bool:
        return action in self.actions


def _principal(body: dict) -> Principal:
    client = body["client"]
    if client not in ("portal", "kiosk"):
        raise ValueError("unknown client")
    return Principal(
        person_id=uuid.UUID(str(body["person_id"])),
        display_name=str(body["display_name"]),
        client=client,
        kiosk_serial=body.get("kiosk_serial"),
        actions=frozenset(body["actions"]),
        password_change_required=bool(body["password_change_required"]),
        read_only=bool(body["read_only"]),
        read_only_message=body.get("read_only_message"),
    )


def _is_unauthenticated(response: httpx.Response) -> bool:
    """A 401 about the user's session, as opposed to our service token."""
    try:
        detail = response.json().get("detail")
    except ValueError:
        return False
    return isinstance(detail, dict) and detail.get("code") == "unauthenticated"


class MainApiClient:
    def __init__(self, *, base_url: str, service_token: str, cache_seconds: int,
                 transport: httpx.AsyncBaseTransport | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), transport=transport, timeout=_TIMEOUT,
            headers={SERVICE_TOKEN_HEADER: service_token})
        self._cache_seconds = cache_seconds
        self._clock = clock
        self._cache: dict[str, tuple[float, Principal]] = {}

    @classmethod
    def from_settings(cls, settings: Settings, **kwargs) -> MainApiClient:
        return cls(base_url=settings.main_api_url,
                   service_token=settings.service_token.get_secret_value(),
                   cache_seconds=settings.authorize_cache_seconds, **kwargs)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def authorize(self, bearer: str) -> Principal | None:
        """The bearer's Principal, or None when the main API says it isn't
        a live session (401 unauthenticated). Raises MainApiUnavailable."""
        key = hashlib.sha256(bearer.encode()).hexdigest()
        now = self._clock()
        cached = self._cache.get(key)
        if cached is not None and cached[0] > now:
            return cached[1]

        try:
            response = await self._http.get(
                AUTHORIZE_PATH, headers={"Authorization": f"Bearer {bearer}"})
        except httpx.HTTPError as exc:
            log.warning("main API authorize failed: %s", type(exc).__name__)
            raise MainApiUnavailable(type(exc).__name__) from None

        if response.status_code == 401 and _is_unauthenticated(response):
            self._cache.pop(key, None)
            return None
        if response.status_code != 200:
            log.warning("main API authorize failed: status %s", response.status_code)
            raise MainApiUnavailable(f"status {response.status_code}")
        try:
            principal = _principal(response.json())
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            log.warning("main API authorize answer unreadable: %s", type(exc).__name__)
            raise MainApiUnavailable("unreadable answer") from None

        if self._cache_seconds > 0:
            self._cache = {k: v for k, v in self._cache.items() if v[0] > now}
            self._cache[key] = (now + self._cache_seconds, principal)
        return principal

    async def audit(self, *, actor: uuid.UUID | None, entity_type: str, entity_id: str,
                    action: str, changes: dict, ip: str | None) -> None:
        """Write one audit row on the main API. A failure is logged and
        swallowed: auditing never fails the request that triggered it."""
        body = {"actor_person_id": str(actor) if actor is not None else None,
                "entity_type": entity_type, "entity_id": entity_id,
                "action": action, "changes": changes, "ip": ip}
        try:
            response = await self._http.post(AUDIT_PATH, json=body)
        # Whatever went wrong, the caller's request still succeeds.
        except Exception as exc:  # noqa: BLE001
            log.warning("main API audit failed: %s", type(exc).__name__)
            return
        if response.status_code != 204:
            log.warning("main API audit failed: status %s", response.status_code)


_main_api: MainApiClient | None = None


def get_main_api() -> MainApiClient:
    """The FastAPI dependency: one shared client per process (overridden in
    tests)."""
    global _main_api
    if _main_api is None:
        _main_api = MainApiClient.from_settings(get_settings())
    return _main_api
