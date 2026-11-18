"""A respx-mocked App Store Connect API, reached through an
httpx.MockTransport (so no_real_http never sees it). State lives in memory:
devices, bundle ids, certificates and profiles. Every request must carry a
bearer JWT that verifies with the test key (ES256, kid, iss, aud, a lifetime
of at most 20 minutes, live on `clock`); anything else gets Apple's 401.

    fake = FakeAsc()
    fake.add_certificate("1A2B3C")            # a team distribution certificate
    client = fake.client()                     # an AscClient on the fake
    fake.page_size = 2                         # paginate lists
    fake.rate_limit(1)                         # the next request gets a 429
    fake.refuse("This key can't use this API.")   # every request gets a 403
    fake.tokens                                # [(header, claims)] per request
"""

import base64
import datetime as dt
import itertools
import json
import time
import uuid
from collections.abc import Callable
from urllib.parse import urlencode

import httpx
import jwt
import respx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from serversherpa_devices.apple.asc import BASE_URL, AscClient

from .package_fixtures import make_provision

HOST = "api.appstoreconnect.apple.com"
TEAM_ID = "TEAM123456"
KEY_ID = "ABC123DEFG"
ISSUER_ID = "69a6de7e-1111-47e3-e053-5b8c7c11a4d1"


def _pem(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


_TEST_KEY = ec.generate_private_key(ec.SECP256R1())
TEST_P8 = _pem(_TEST_KEY)
# A well-formed key Apple doesn't know: its tokens fail to verify.
OTHER_P8 = _pem(ec.generate_private_key(ec.SECP256R1()))

_NOT_AUTHORIZED = ("Provide a properly configured and signed bearer token, and make sure "
                   "that it has not expired.")


def _iso(value: dt.datetime) -> str:
    return value.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%S.000+0000")


def error(status: int, code: str, detail: str, title: str = "An error occurred.") -> httpx.Response:
    return httpx.Response(status, json={"errors": [{
        "id": str(uuid.uuid4()), "status": str(status), "code": code,
        "title": title, "detail": detail}]})


class FakeAsc:
    def __init__(self, *, key_id: str = KEY_ID, issuer_id: str = ISSUER_ID,
                 team_id: str = TEAM_ID, public_key=None,
                 clock: Callable[[], float] = time.time) -> None:
        self.key_id = key_id
        self.clock = clock
        self.issuer_id = issuer_id
        self.team_id = team_id
        self.public_key = public_key or _TEST_KEY.public_key()
        self.devices: dict[str, dict] = {}
        self.bundle_ids: dict[str, dict] = {}
        self.certificates: dict[str, dict] = {}
        self.profiles: dict[str, dict] = {}
        self.tokens: list[tuple[dict, dict]] = []
        self.page_size = 200
        self.next_base = BASE_URL           # where links.next points
        self._rate_limited = 0
        self._refused: str | None = None
        self._ids = itertools.count(1)
        self.router = respx.Router(assert_all_called=False)
        self.route = self.router.route(host=HOST)
        self.route.side_effect = self._handle

    # Wiring.

    def transport(self) -> httpx.AsyncBaseTransport:
        return httpx.MockTransport(self.router.async_handler)

    def http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self.transport())

    def client(self, p8: bytes = TEST_P8, **kwargs) -> AscClient:
        return AscClient(self.key_id, self.issuer_id, p8, http=self.http(), **kwargs)

    @property
    def calls(self) -> list[httpx.Request]:
        return [call.request for call in self.route.calls]

    # Behavior switches.

    def rate_limit(self, count: int = 1) -> None:
        self._rate_limited = count

    def refuse(self, detail: str) -> None:
        self._refused = detail

    # State.

    def _new_id(self, prefix: str) -> str:
        return f"{prefix}{next(self._ids):04d}"

    def add_certificate(self, serial_hex: str, *, name: str = "Apple Distribution: Test",
                        certificate_type: str = "DISTRIBUTION",
                        expires: dt.datetime = dt.datetime(2027, 11, 17, 12, 0, tzinfo=dt.UTC),
                        ) -> str:
        cert_id = self._new_id("CERT")
        self.certificates[cert_id] = {
            "serialNumber": serial_hex, "name": name, "displayName": name,
            "certificateType": certificate_type, "expirationDate": _iso(expires),
            "platform": "IOS"}
        return cert_id

    def add_device(self, udid: str, *, name: str = "Test iPhone", status: str = "ENABLED",
                   device_class: str = "IPHONE", model: str = "iPhone 15") -> str:
        device_id = self._new_id("DEV")
        self.devices[device_id] = {
            "name": name, "platform": "IOS", "udid": udid, "deviceClass": device_class,
            "model": model, "status": status, "addedDate": _iso(dt.datetime.now(dt.UTC))}
        return device_id

    def add_bundle_id(self, identifier: str, name: str = "App") -> str:
        bundle_id = self._new_id("BUNDLE")
        self.bundle_ids[bundle_id] = {"identifier": identifier, "name": name,
                                      "platform": "IOS", "seedId": self.team_id}
        return bundle_id

    def add_profile(self, name: str, *, profile_type: str = "IOS_APP_ADHOC",
                    content: bytes = b"profile") -> str:
        profile_id = self._new_id("PROF")
        self.profiles[profile_id] = {
            "name": name, "profileType": profile_type, "profileState": "ACTIVE",
            "uuid": str(uuid.uuid4()), "expirationDate": _iso(dt.datetime(2027, 11, 17, tzinfo=dt.UTC)),
            "profileContent": base64.b64encode(content).decode(), "relationships": {}}
        return profile_id

    # The API.

    def _authorized(self, request: httpx.Request) -> httpx.Response | None:
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return error(401, "NOT_AUTHORIZED", _NOT_AUTHORIZED)
        token = auth.removeprefix("Bearer ")
        try:
            header = jwt.get_unverified_header(token)
            claims = jwt.decode(token, self.public_key, algorithms=["ES256"],
                                audience="appstoreconnect-v1", issuer=self.issuer_id,
                                options={"require": ["iss", "iat", "exp", "aud"],
                                         "verify_exp": False, "verify_iat": False})
        except jwt.PyJWTError:
            return error(401, "NOT_AUTHORIZED", _NOT_AUTHORIZED)
        now = self.clock()
        live = claims["iat"] <= now + 60 and now < claims["exp"]
        if header.get("kid") != self.key_id or claims["exp"] - claims["iat"] > 1200 or not live:
            return error(401, "NOT_AUTHORIZED", _NOT_AUTHORIZED)
        self.tokens.append((header, claims))
        return None

    def _handle(self, request: httpx.Request) -> httpx.Response:
        refused = self._authorized(request)
        if refused is not None:
            return refused
        if self._refused is not None:
            return error(403, "FORBIDDEN_ERROR", self._refused)
        if self._rate_limited > 0:
            self._rate_limited -= 1
            return error(429, "RATE_LIMIT_EXCEEDED",
                         "The request rate limit has been reached.")
        path = request.url.path.removeprefix("/v1/").split("/")
        method = request.method
        body = json.loads(request.content) if request.content else None
        kind, item = path[0], (path[1] if len(path) > 1 else None)
        handler = getattr(self, f"_{method.lower()}_{kind}", None)
        if handler is None:
            return error(404, "NOT_FOUND", f"No {method} /{'/'.join(path)}.")
        return handler(request, item, body)

    def _list(self, request: httpx.Request, kind: str, store: dict[str, dict],
              filters: dict[str, Callable[[dict, str], bool]]) -> httpx.Response:
        params = request.url.params
        rows = [(rid, attrs) for rid, attrs in store.items()
                if all(match(attrs, params[f"filter[{name}]"])
                       for name, match in filters.items() if f"filter[{name}]" in params)]
        start = int(params.get("cursor", "0"))
        limit = min(int(params.get("limit", "20")), self.page_size)
        page = rows[start:start + limit]
        links = {"self": str(request.url)}
        if start + limit < len(rows):
            query = {k: v for k, v in params.items() if k != "cursor"}
            query["cursor"] = str(start + limit)
            links["next"] = f"{self.next_base}/{kind}?{urlencode(query)}"
        return httpx.Response(200, json={
            "data": [self._resource(kind, rid, attrs) for rid, attrs in page],
            "links": links, "meta": {"paging": {"total": len(rows), "limit": limit}}})

    @staticmethod
    def _resource(kind: str, rid: str, attrs: dict) -> dict:
        shown = {k: v for k, v in attrs.items() if k != "relationships"}
        return {"type": kind, "id": rid, "attributes": shown,
                "links": {"self": f"{BASE_URL}/{kind}/{rid}"}}

    @staticmethod
    def _one_of(field: str):
        return lambda attrs, value: attrs.get(field) in value.split(",")

    # /devices

    def _get_devices(self, request, item, body):
        return self._list(request, "devices", self.devices, {
            "udid": self._one_of("udid"), "status": self._one_of("status"),
            "platform": self._one_of("platform")})

    def _post_devices(self, request, item, body):
        attrs = body["data"]["attributes"]
        assert body["data"]["type"] == "devices"
        assert attrs["platform"] == "IOS"
        if any(d["udid"].lower() == attrs["udid"].lower() for d in self.devices.values()):
            return error(409, "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE",
                         f"A device with number '{attrs['udid']}' already exists on this team.")
        device_id = self.add_device(attrs["udid"], name=attrs["name"])
        return httpx.Response(201, json={"data": self._resource(
            "devices", device_id, self.devices[device_id])})

    def _patch_devices(self, request, item, body):
        if item not in self.devices:
            return error(404, "NOT_FOUND", "There is no resource of type 'devices' with id.")
        assert body["data"]["id"] == item
        self.devices[item].update(body["data"]["attributes"])
        return httpx.Response(200, json={"data": self._resource(
            "devices", item, self.devices[item])})

    # /bundleIds

    def _get_bundleIds(self, request, item, body):
        # Apple matches identifiers loosely (a prefix finds longer ones).
        return self._list(request, "bundleIds", self.bundle_ids, {
            "identifier": lambda attrs, value: attrs["identifier"].startswith(value)})

    def _post_bundleIds(self, request, item, body):
        attrs = body["data"]["attributes"]
        assert body["data"]["type"] == "bundleIds" and attrs["platform"] == "IOS"
        if any(b["identifier"] == attrs["identifier"] for b in self.bundle_ids.values()):
            return error(409, "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE",
                         "An App ID with Identifier is not available.")
        bundle_id = self.add_bundle_id(attrs["identifier"], attrs["name"])
        return httpx.Response(201, json={"data": self._resource(
            "bundleIds", bundle_id, self.bundle_ids[bundle_id])})

    # /certificates

    def _get_certificates(self, request, item, body):
        return self._list(request, "certificates", self.certificates, {
            "certificateType": self._one_of("certificateType"),
            "serialNumber": self._one_of("serialNumber")})

    # /profiles

    def _get_profiles(self, request, item, body):
        # Apple matches names loosely too.
        return self._list(request, "profiles", self.profiles, {
            "name": lambda attrs, value: value in attrs["name"],
            "profileType": self._one_of("profileType")})

    def _post_profiles(self, request, item, body):
        data = body["data"]
        attrs, rel = data["attributes"], data["relationships"]
        assert data["type"] == "profiles" and attrs["profileType"] == "IOS_APP_ADHOC"
        bundle = rel["bundleId"]["data"]
        certs = [c["id"] for c in rel["certificates"]["data"]]
        devices = [d["id"] for d in rel["devices"]["data"]]
        if bundle["type"] != "bundleIds" or bundle["id"] not in self.bundle_ids:
            return error(409, "ENTITY_ERROR.RELATIONSHIP.INVALID", "The bundle ID is invalid.")
        if not certs or any(c not in self.certificates for c in certs):
            return error(409, "ENTITY_ERROR.RELATIONSHIP.INVALID", "A certificate is invalid.")
        if any(d not in self.devices for d in devices):
            return error(409, "ENTITY_ERROR.RELATIONSHIP.INVALID", "A device is invalid.")
        profile_uuid = str(uuid.uuid4())
        expires = dt.datetime(2027, 11, 17, 12, 0, tzinfo=dt.UTC)
        identifier = self.bundle_ids[bundle["id"]]["identifier"]
        content = make_provision(
            devices=[self.devices[d]["udid"] for d in devices], team_id=self.team_id,
            uuid=profile_uuid, name=attrs["name"], expires=expires,
            extra_entitlements={"application-identifier": f"{self.team_id}.{identifier}"})
        profile_id = self._new_id("PROF")
        self.profiles[profile_id] = {
            "name": attrs["name"], "profileType": "IOS_APP_ADHOC", "profileState": "ACTIVE",
            "uuid": profile_uuid, "expirationDate": _iso(expires),
            "profileContent": base64.b64encode(content).decode(),
            "relationships": {"bundleId": bundle["id"], "certificates": certs,
                              "devices": devices}}
        return httpx.Response(201, json={"data": self._resource(
            "profiles", profile_id, self.profiles[profile_id])})

    def _delete_profiles(self, request, item, body):
        if self.profiles.pop(item, None) is None:
            return error(404, "NOT_FOUND", "There is no resource of type 'profiles' with id.")
        return httpx.Response(204)
