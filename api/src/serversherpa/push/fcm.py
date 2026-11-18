"""Firebase Cloud Messaging HTTP v1 client.

Standalone: no database access. The access token, the private key and device
tokens are never logged and never placed in error text.
"""

from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Literal

import httpx
import jwt

from serversherpa.config import get_settings

_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_AUDIENCE = "https://oauth2.googleapis.com/token"
_SEND_URL = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
_TOKEN_LIFETIME = 3600
_REFRESH_MARGIN = 300
_TIMEOUT = 15.0
_MAX_B64 = 8192
_B64_RE = re.compile(r"[A-Za-z0-9+/]+={0,2}")

Outcome = Literal["sent", "token_dead", "retry", "fatal"]


@dataclass
class SendResult:
    outcome: Outcome
    error: str | None = None


class FcmClient:
    def __init__(
        self,
        service_account: dict,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        clock=time.time,
    ) -> None:
        self._project_id = service_account["project_id"]
        self._client_email = service_account["client_email"]
        self._private_key = service_account["private_key"]
        self._token_uri = service_account.get("token_uri") or _AUDIENCE
        self._transport = transport
        self._clock = clock
        self._access_token: str | None = None
        self._expires_at = 0.0

    @classmethod
    def from_settings(cls) -> FcmClient | None:
        settings = get_settings()
        path = settings.fcm_service_account_file
        if not path:
            if settings.fcm_service_account_b64:
                return cls._from_b64(settings.fcm_service_account_b64)
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                account = json.load(fh)
            return cls(account)
        except (OSError, ValueError, KeyError) as exc:
            # Only the exception type: the message could echo file contents.
            raise RuntimeError(
                f"FCM service account file at {path} is unreadable or invalid "
                f"({type(exc).__name__})"
            ) from None

    @classmethod
    def _from_b64(cls, value: str) -> FcmClient:
        try:
            return cls(parse_b64_account(value))
        except (ValueError, KeyError):
            # Never the value or the decoded text: both are the secret.
            raise RuntimeError(
                "FCM service account in SS_FCM_SERVICE_ACCOUNT_B64 is not valid "
                "base64 of a service-account JSON key"
            ) from None

    def _assertion(self, now: float) -> str:
        iat = int(now)
        claims = {
            "iss": self._client_email,
            "sub": self._client_email,
            "aud": _AUDIENCE,
            "scope": _SCOPE,
            "iat": iat,
            "exp": iat + _TOKEN_LIFETIME,
        }
        return jwt.encode(claims, self._private_key, algorithm="RS256")

    async def _token(self, http: httpx.AsyncClient, *, force: bool = False) -> str:
        now = self._clock()
        if (
            not force
            and self._access_token is not None
            and now < self._expires_at - _REFRESH_MARGIN
        ):
            return self._access_token
        resp = await http.post(
            self._token_uri,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": self._assertion(now),
            },
        )
        if resp.status_code != 200:
            raise _TokenError(resp.status_code)
        body = resp.json()
        self._access_token = body["access_token"]
        self._expires_at = now + float(body.get("expires_in", _TOKEN_LIFETIME))
        return self._access_token

    async def _post(
        self, http: httpx.AsyncClient, access: str, payload: dict[str, Any]
    ) -> httpx.Response:
        return await http.post(
            _SEND_URL.format(project_id=self._project_id),
            json=payload,
            headers={"Authorization": f"Bearer {access}"},
        )

    async def send(
        self, token: str, data: dict[str, str], *, high_priority: bool
    ) -> SendResult:
        payload = {
            "message": {
                "token": token,
                "data": {k: str(v) for k, v in data.items()},
                "android": {"priority": "HIGH" if high_priority else "NORMAL"},
            }
        }
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=_TIMEOUT
            ) as http:
                resp = await self._post(http, await self._token(http), payload)
                if resp.status_code == 401:
                    resp = await self._post(
                        http, await self._token(http, force=True), payload
                    )
        except _TokenError as exc:
            if exc.status >= 500 or exc.status == 429:
                return SendResult("retry", f"token exchange HTTP {exc.status}")
            return SendResult("fatal", f"token exchange HTTP {exc.status}")
        except httpx.HTTPError as exc:
            return SendResult("retry", f"network error {type(exc).__name__}")
        except Exception as exc:  # noqa: BLE001 - e.g. a bad private key
            return SendResult("fatal", f"auth error {type(exc).__name__}")
        return _classify(resp)


def parse_b64_account(value: str) -> dict:
    """Decode and validate SS_FCM_SERVICE_ACCOUNT_B64; ValueError when invalid."""
    if len(value) > _MAX_B64 or not _B64_RE.fullmatch(value):
        raise ValueError("invalid")
    account = json.loads(base64.b64decode(value, validate=True))
    if (
        not isinstance(account, dict)
        or account.get("type") != "service_account"
        or not all(
            isinstance(account.get(k), str) and account[k]
            for k in ("project_id", "client_email", "private_key")
        )
    ):
        raise ValueError("invalid")
    return account


@lru_cache(maxsize=8)
def b64_account_valid(value: str) -> bool:
    """Cached validity of a base64 key value (the key text is never kept apart
    from the cache entry itself)."""
    try:
        parse_b64_account(value)
    except ValueError:
        return False
    return True


class _TokenError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"token exchange HTTP {status}")
        self.status = status


def _classify(resp: httpx.Response) -> SendResult:
    code = resp.status_code
    if code == 200:
        return SendResult("sent", None)
    if code == 429 or code >= 500:
        return SendResult("retry", f"HTTP {code}")
    if code in (400, 404):
        try:
            err = resp.json().get("error", {})
        except ValueError:
            err = {}
        text = json.dumps(err).upper() if isinstance(err, dict) else ""
        if code == 404 and "UNREGISTERED" in text:
            return SendResult("token_dead", "UNREGISTERED")
        if (
            code == 400
            and isinstance(err, dict)
            and err.get("status") == "INVALID_ARGUMENT"
            and "TOKEN" in str(err.get("message", "")).upper()
        ):
            return SendResult("token_dead", "INVALID_ARGUMENT")
    return SendResult("fatal", f"HTTP {code}")
