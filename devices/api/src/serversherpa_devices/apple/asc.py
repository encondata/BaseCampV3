"""The App Store Connect API, for the provisioning calls this service makes:
devices, bundle ids, distribution certificates and Ad Hoc profiles.

Every request carries an ES256 JWT signed with the team API key (.p8); a
token lasts 20 minutes and is reused until 60 s before it expires. Apple's
error answers become AscError (AscRateLimited for a 429). Only links on
Apple's own API are ever followed, so the token never goes anywhere else."""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Self
from urllib.parse import quote

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

BASE_URL = "https://api.appstoreconnect.apple.com/v1"
AUDIENCE = "appstoreconnect-v1"
TOKEN_SECONDS = 1200
TOKEN_REFRESH_MARGIN = 60
PAGE_LIMIT = 200
MAX_PAGES = 50
TIMEOUT = httpx.Timeout(30.0, connect=5.0)
DISTRIBUTION_TYPES = ("DISTRIBUTION", "IOS_DISTRIBUTION")
DEVICE_STATUSES = ("ENABLED", "DISABLED")
_DETAIL_MAX = 500


class AscError(Exception):
    """App Store Connect refused a request, or couldn't be reached
    (status 0). `detail` is Apple's own explanation."""

    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(f"{status} {code}: {detail}")
        self.status = status
        self.code = code
        self.detail = detail


class AscRateLimited(AscError):
    """A 429: try again later."""


@dataclass(frozen=True)
class AscDevice:
    id: str
    udid: str
    name: str
    device_class: str | None     # IPHONE, IPAD, …
    status: str                  # ENABLED | DISABLED
    model: str | None


@dataclass(frozen=True)
class AscCertificate:
    id: str
    serial: str                  # normalize_serial form
    name: str
    certificate_type: str
    expires_at: dt.datetime | None


@dataclass(frozen=True)
class AscProfile:
    id: str
    uuid: str
    name: str
    content: bytes               # the .mobileprovision
    expires_at: dt.datetime | None


def normalize_serial(serial_hex: str) -> str:
    """A certificate serial as hex, uppercase, with leading zeros stripped."""
    cleaned = serial_hex.strip().replace(":", "").replace(" ", "").upper().lstrip("0")
    return cleaned or "0"


def _when(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _error(response: httpx.Response) -> AscError:
    code, detail = "UNKNOWN", f"App Store Connect answered {response.status_code}."
    try:
        errors = response.json().get("errors")
    except (ValueError, AttributeError):
        errors = None
    if isinstance(errors, list) and errors and isinstance(errors[0], dict):
        first = errors[0]
        code = _text(first.get("code")) or code
        detail = _text(first.get("detail")) or _text(first.get("title")) or detail
    kind = AscRateLimited if response.status_code == 429 else AscError
    return kind(response.status_code, code, detail[:_DETAIL_MAX])


def _unreadable(status: int) -> AscError:
    return AscError(status, "UNREADABLE", "App Store Connect sent an answer that can't be read.")


def _device(resource: dict) -> AscDevice:
    attrs = resource["attributes"]
    return AscDevice(id=str(resource["id"]), udid=str(attrs["udid"]), name=str(attrs["name"]),
                     device_class=_text(attrs.get("deviceClass")), status=str(attrs["status"]),
                     model=_text(attrs.get("model")))


def _certificate(resource: dict) -> AscCertificate:
    attrs = resource["attributes"]
    return AscCertificate(
        id=str(resource["id"]), serial=normalize_serial(str(attrs["serialNumber"])),
        name=_text(attrs.get("name")) or _text(attrs.get("displayName")) or "",
        certificate_type=str(attrs.get("certificateType")),
        expires_at=_when(attrs.get("expirationDate")))


def _profile(resource: dict) -> AscProfile:
    attrs = resource["attributes"]
    try:
        content = base64.b64decode(attrs.get("profileContent") or "", validate=True)
    except (binascii.Error, ValueError, TypeError):
        raise _unreadable(200) from None
    return AscProfile(id=str(resource["id"]), uuid=str(attrs["uuid"]), name=str(attrs["name"]),
                      content=content, expires_at=_when(attrs.get("expirationDate")))


def _load_key(p8_pem: bytes) -> ec.EllipticCurvePrivateKey:
    try:
        key = serialization.load_pem_private_key(p8_pem, password=None)
    # Bad PEM, an encrypted key, an unsupported algorithm.
    except Exception:  # noqa: BLE001
        raise ValueError("not an App Store Connect API key") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        # A ValueError like the unreadable case: callers treat both the same.
        raise ValueError("not an App Store Connect API key")  # noqa: TRY004
    return key


class AscClient:
    """`team_key_id` is the Key ID of a team API key (individual keys can't
    use the provisioning endpoints). A client passed as `http` stays the
    caller's to close."""

    def __init__(self, team_key_id: str, issuer_id: str, p8_pem: bytes, *,
                 http: httpx.AsyncClient | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self._key_id = team_key_id
        self._issuer_id = issuer_id
        self._key = _load_key(p8_pem)     # ValueError when it isn't a P-256 key
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(timeout=TIMEOUT)
        self._clock = clock
        self._token: str | None = None
        self._token_expires = 0

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    # Plumbing.

    def _bearer(self) -> str:
        now = int(self._clock())
        if self._token is None or now >= self._token_expires - TOKEN_REFRESH_MARGIN:
            expires = now + TOKEN_SECONDS
            self._token = jwt.encode(
                {"iss": self._issuer_id, "iat": now, "exp": expires, "aud": AUDIENCE},
                self._key, algorithm="ES256", headers={"kid": self._key_id, "typ": "JWT"})
            self._token_expires = expires
        return self._token

    async def _request(self, method: str, url: str, *, params: dict | None = None,
                       json: dict | None = None) -> dict | None:
        if not url.startswith(BASE_URL + "/"):
            raise AscError(0, "BAD_LINK", "App Store Connect sent a link outside its API.")
        try:
            response = await self._http.request(
                method, url, params=params, json=json, timeout=TIMEOUT,
                headers={"Authorization": f"Bearer {self._bearer()}"})
        except httpx.HTTPError:
            raise AscError(0, "UNREACHABLE", "App Store Connect couldn't be reached.") from None
        if response.status_code >= 400:
            raise _error(response)
        if response.status_code == 204 or not response.content:
            return None
        try:
            body = response.json()
        except ValueError:
            raise _unreadable(response.status_code) from None
        if not isinstance(body, dict):
            raise _unreadable(response.status_code)
        return body

    async def _one(self, method: str, path: str, body: dict) -> dict:
        answer = await self._request(method, BASE_URL + path, json=body)
        data = answer.get("data") if answer else None
        if not isinstance(data, dict):
            raise _unreadable(200)
        return data

    async def _all(self, path: str, params: dict[str, str | int]) -> list[dict]:
        """Every resource a list call returns, following links.next."""
        url: str | None = BASE_URL + path
        query: dict | None = {**params, "limit": PAGE_LIMIT}
        found: list[dict] = []
        for _ in range(MAX_PAGES):
            answer = await self._request("GET", url, params=query) or {}
            data = answer.get("data")
            if not isinstance(data, list):
                raise _unreadable(200)
            found.extend(item for item in data if isinstance(item, dict))
            links = answer.get("links")
            url = links.get("next") if isinstance(links, dict) else None
            if not isinstance(url, str) or not url:
                return found
            query = None   # the next link carries the query
        raise AscError(0, "TOO_MANY_PAGES", "App Store Connect sent too many pages.")

    def _parsed(self, parse: Callable[[dict], Any], resource: dict) -> Any:
        try:
            return parse(resource)
        except (KeyError, TypeError, AttributeError):
            raise _unreadable(200) from None

    # Devices.

    async def find_device(self, udid: str) -> AscDevice | None:
        for resource in await self._all("/devices", {"filter[udid]": udid}):
            device = self._parsed(_device, resource)
            if device.udid.lower() == udid.lower():
                return device
        return None

    async def register_device(self, name: str, udid: str) -> AscDevice:
        data = await self._one("POST", "/devices", {"data": {
            "type": "devices", "attributes": {"name": name, "platform": "IOS", "udid": udid}}})
        return self._parsed(_device, data)

    async def set_device_status(self, device_id: str, status: str) -> AscDevice:
        if status not in DEVICE_STATUSES:
            raise ValueError(f"status must be one of {DEVICE_STATUSES}")
        data = await self._one("PATCH", f"/devices/{quote(device_id, safe='')}", {"data": {
            "type": "devices", "id": device_id, "attributes": {"status": status}}})
        return self._parsed(_device, data)

    async def list_devices(self) -> list[AscDevice]:
        return [self._parsed(_device, r) for r in await self._all("/devices", {})]

    # Bundle ids.

    async def find_bundle_id(self, identifier: str) -> str | None:
        """The bundle id resource's id. Apple's filter matches loosely, so
        the identifier is compared exactly here."""
        for resource in await self._all("/bundleIds", {"filter[identifier]": identifier}):
            attrs = resource.get("attributes")
            if isinstance(attrs, dict) and attrs.get("identifier") == identifier:
                return str(resource["id"])
        return None

    async def create_bundle_id(self, identifier: str, name: str) -> str:
        data = await self._one("POST", "/bundleIds", {"data": {
            "type": "bundleIds",
            "attributes": {"identifier": identifier, "name": name, "platform": "IOS"}}})
        if "id" not in data:
            raise _unreadable(201)
        return str(data["id"])

    # Certificates.

    async def find_certificate_by_serial(self, serial_hex: str) -> AscCertificate | None:
        """The team's distribution certificate with this serial. Serials are
        compared in normalize_serial form (Apple may keep leading zeros)."""
        wanted = normalize_serial(serial_hex)
        resources = await self._all(
            "/certificates", {"filter[certificateType]": ",".join(DISTRIBUTION_TYPES)})
        for resource in resources:
            cert = self._parsed(_certificate, resource)
            if cert.serial == wanted and cert.certificate_type in DISTRIBUTION_TYPES:
                return cert
        return None

    # Profiles.

    async def list_profiles(self, name: str) -> list[AscProfile]:
        """Ad Hoc profiles named exactly `name`."""
        resources = await self._all(
            "/profiles", {"filter[name]": name, "filter[profileType]": "IOS_APP_ADHOC"})
        profiles = [self._parsed(_profile, r) for r in resources]
        return [p for p in profiles if p.name == name]

    async def delete_profile(self, profile_id: str) -> None:
        await self._request("DELETE", f"{BASE_URL}/profiles/{quote(profile_id, safe='')}")

    async def create_adhoc_profile(self, name: str, bundle_id_res: str, cert_id: str,
                                   device_ids: Sequence[str]) -> AscProfile:
        data = await self._one("POST", "/profiles", {"data": {
            "type": "profiles",
            "attributes": {"name": name, "profileType": "IOS_APP_ADHOC"},
            "relationships": {
                "bundleId": {"data": {"type": "bundleIds", "id": bundle_id_res}},
                "certificates": {"data": [{"type": "certificates", "id": cert_id}]},
                "devices": {"data": [{"type": "devices", "id": d} for d in device_ids]},
            }}})
        return self._parsed(_profile, data)
