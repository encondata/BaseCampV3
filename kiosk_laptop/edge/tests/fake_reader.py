"""A fake Zebra FX reader in IoT Connector (Local REST) mode, for tests.

Shapes come from Zebra's ZIOTC OpenAPI spec (readerversion.v1, readerstats.v1,
readerConfigResponse and the 404/422 examples). The sign-in answer follows
Zebra's support article 000022894: `GET /cloud/localRestLogin` with basic auth
returns `{"message": "JWT Token: <token>"}`.

Hand the client `reader.transport()`; it serves this app through
httpx.ASGITransport, and in `unreachable` mode raises httpx.ConnectError
instead, as a dead host would.

Modes:
- `normal`
- `not_iotc`: 404 everywhere (a host with no IoT Connector API)
- `unreachable`: every request raises a transport error
- `verify_mismatch`: PUT /cloud/config succeeds, GET keeps returning the old config

Unauthenticated, the fake answers like ZIOTC does in the OpenAPI examples:
`/cloud/localRestLogin` and every `/cloud/*` call are 401 with the JSON error
shape `{"code": 2, "message": "Unauthorized"}` (the edge's fingerprint, spec
§2.2). `server=` adds a `Server` header to every answer, `realm=` a
`WWW-Authenticate` header to every 401.

`ports` are the ports the fake listens on (443 = https, 80 = http); a request
to any other port fails like a closed port. `FakeNas` is a generic basic-auth
box (realm "NAS") that answers 401 everywhere; `RoutingTransport` serves
several fakes, one per IP.
"""

import base64
import copy
import secrets

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse

PASSWORDS = ("Cumulu$SG0", "Cumulus$G0", "Cumulu$SG.", "33q44w40x5", "change")

NOT_FOUND_HTML = (
    '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n'
    "<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n"
    "<p>The requested URL was not found on this server.</p>\n</body></html>")

TOO_MANY_ENDPOINTS = ("Invalid endpoint configuration - more than 2 endpoints "
                      "cannot be mapped to data interfaces")
BATCHING_MISMATCH = ("Invalid global batching payload fields: Batching configuration "
                     "error: Incorrect number of batching objects for the given endpoints")
EMPTY_PAYLOAD = "Invalid Payload expected atleast one configuration field"
# Zebra's httpPostSecurity.v1 requires all three fields
HTTP_POST_SECURITY = ("verifyPeer", "verifyHost", "authenticationType")


def missing_security(conn) -> str | None:
    """The Zebra-style error for an httpPost connection whose security block
    lacks a required field, or None when it is complete."""
    if not isinstance(conn, dict) or conn.get("type") != "httpPost":
        return None
    options = conn.get("options") if isinstance(conn.get("options"), dict) else {}
    security = options.get("security") if isinstance(options.get("security"), dict) else {}
    for field in HTTP_POST_SECURITY:
        if field not in security:
            return (f"Invalid endpoint configuration - httpPost security: "
                    f"'{field}' is a required property")
    return None

VERSION = {
    "readerApplication": "2.7.19.0", "radioFirmware": "2.1.14.0",
    "radioControlApplication": "1.0.0", "cloudAgentApplication": "1.0.0",
    "availableOsUpgrades": {}, "model": "FX9600", "serialNumber": "84248dee5721",
    "revertBackFirmware": {"readerApplication": "3.32.7.0"},
}

STATUS = {
    "uptime": "26 days 01:11:17", "systemTime": "2020-01-08T15:36:53+00:00",
    "ram": {"total": "26098076", "free": "195612672", "used": "65368064"},
    "cpu": {"user": "42", "system": "32"},
    "radioConnection": "connected",
    "antennas": {"1": "connected", "2": "connected", "3": "disconnected",
                 "4": "disconnected"},
    "temperature": 31, "radioActivitiy": "active", "powerSource": "DC",
    "powerNegotiation": "DISABLED", "ntp": {"offset": 120, "reach": 377},
    "interfaceConnectionStatus": {"data": []},
}


def default_config() -> dict:
    return {
        "xml": "string",
        "GPIO-LED": {},
        "READER-GATEWAY": {
            "endpointConfig": {
                "data": {"event": {"connections": []}},
                "management": {"connection": {
                    "type": "mqtt", "name": "Fleet MQTT",
                    "options": {"endpoint": {"hostName": "mqtt.example.test", "port": 1883}}}},
                "control": {"connection": {
                    "type": "mqtt", "name": "Fleet control",
                    "options": {"endpoint": {"hostName": "mqtt.example.test", "port": 1883}}}},
            },
            # one entry per data connection, as a real FX9600 keeps them
            "batching": [],
            "retention": [],
        },
    }


class FakeReader:
    def __init__(self, *, password_index: int = 3, mode: str = "normal",
                 model: str = "FX9600", serial: str = "84248dee5721",
                 login_style: str = "json_message", password: str | None = None,
                 ports: tuple[int, ...] = (443,), server: str | None = None,
                 realm: str | None = None) -> None:
        self.password_index = password_index
        self.ports = ports
        self.server = server
        self.realm = realm
        # a password that isn't on our list (a reader we can't sign in to)
        self.password = password
        self.mode = mode
        self.login_style = login_style  # json_message | json_token | text
        self.version = {**VERSION, "model": model, "serialNumber": serial}
        self.status = copy.deepcopy(STATUS)
        self.config = default_config()
        # index of each password tried (None: one not on our list); only
        # requests that carried credentials count
        self.login_attempts: list[int | None] = []
        self.puts: list[dict] = []
        self.tokens: set[str] = set()
        # path or "METHOD path" -> (status, body); the next matching request answers this, once
        self.fail_next: dict[str, tuple[int, object]] = {}
        self.app = self._build()

    def transport(self) -> httpx.AsyncBaseTransport:
        return _FakeTransport(self)

    def expire_tokens(self) -> None:
        self.tokens.clear()

    def _build(self) -> FastAPI:
        app = FastAPI()
        reader = self

        @app.middleware("http")
        async def headers(request: Request, call_next):
            response = await call_next(request)
            if reader.server:
                response.headers["server"] = reader.server
            if reader.realm and response.status_code == 401:
                response.headers["www-authenticate"] = f'Basic realm="{reader.realm}"'
            return response

        @app.middleware("http")
        async def gate(request: Request, call_next):
            if reader.mode == "not_iotc":
                return HTMLResponse(NOT_FOUND_HTML, status_code=404)
            failure = reader.fail_next.pop(f"{request.method} {request.url.path}", None)
            if failure is None:
                failure = reader.fail_next.pop(request.url.path, None)
            if failure is not None:
                status, body = failure
                if isinstance(body, str):
                    return HTMLResponse(body, status_code=status)
                return JSONResponse(body, status_code=status)
            return await call_next(request)

        def bearer_ok(request: Request) -> bool:
            auth = request.headers.get("authorization", "")
            return auth.startswith("Bearer ") and auth[7:] in reader.tokens

        unauthorized = lambda: JSONResponse({"code": 2, "message": "Unauthorized"},  # noqa: E731
                                            status_code=401)

        @app.get("/cloud/localRestLogin")
        async def login(request: Request):
            auth = request.headers.get("authorization", "")
            password = None
            if auth.startswith("Basic "):
                user, _, password = base64.b64decode(auth[6:]).decode().partition(":")
                if user != "admin":
                    password = None
            if auth:
                reader.login_attempts.append(
                    PASSWORDS.index(password) if password in PASSWORDS else None)
            expected = reader.password or PASSWORDS[reader.password_index]
            if password != expected:
                return unauthorized()
            token = secrets.token_urlsafe(16)
            reader.tokens.add(token)
            if reader.login_style == "json_token":
                return JSONResponse({"token": token})
            if reader.login_style == "text":
                return PlainTextResponse(token)
            return JSONResponse({"message": f"JWT Token: {token}"})

        @app.get("/cloud/version")
        async def version(request: Request):
            return reader.version if bearer_ok(request) else unauthorized()

        @app.get("/cloud/status")
        async def status(request: Request):
            return reader.status if bearer_ok(request) else unauthorized()

        @app.get("/cloud/config")
        async def get_config(request: Request):
            return reader.config if bearer_ok(request) else unauthorized()

        @app.put("/cloud/config")
        async def put_config(request: Request):
            if not bearer_ok(request):
                return unauthorized()
            payload = await request.json()
            reader.puts.append(payload)
            if not isinstance(payload, dict) or not payload:
                return JSONResponse({"code": 1, "message": EMPTY_PAYLOAD}, status_code=422)
            gateway = payload.get("READER-GATEWAY")
            if gateway is not None:
                connections = (gateway.get("endpointConfig", {}).get("data", {})
                               .get("event", {}).get("connections", []))
                batching = gateway.get("batching")
                if isinstance(batching, list) and len(batching) != len(connections):
                    return JSONResponse({"code": 1, "message": BATCHING_MISMATCH},
                                        status_code=422)
                if len(connections) > 2:
                    return JSONResponse({"code": 1, "message": TOO_MANY_ENDPOINTS},
                                        status_code=422)
                for conn in connections:
                    problem = missing_security(conn)
                    if problem:
                        return JSONResponse({"code": 1, "message": problem}, status_code=422)
            if reader.mode != "verify_mismatch":
                reader.config = {**reader.config, **copy.deepcopy(payload)}
            return HTMLResponse("Command Successful")

        @app.api_route("/{rest:path}", methods=["GET", "PUT", "POST", "DELETE"])
        async def other(rest: str):
            return JSONResponse({"code": 7, "message": f"/{rest} is not a valid URI"},
                                status_code=404)

        return app


NAS_PAGE = "<html><body><h1>401 Unauthorized</h1><p>Synology DiskStation</p></body></html>"


class FakeNas:
    """A generic box behind basic auth (realm "NAS"): 401 on every path,
    with or without credentials. `credential_attempts` counts requests that
    carried an Authorization header — a scan must never send one here."""

    def __init__(self, *, ports: tuple[int, ...] = (443,)) -> None:
        self.ports = ports
        self.mode = "normal"
        self.credential_attempts = 0
        self.requests = 0
        app = FastAPI()
        nas = self

        @app.api_route("/{rest:path}", methods=["GET", "PUT", "POST", "DELETE"])
        async def everything(request: Request, rest: str):
            nas.requests += 1
            if request.headers.get("authorization"):
                nas.credential_attempts += 1
            return HTMLResponse(NAS_PAGE, status_code=401,
                                headers={"www-authenticate": 'Basic realm="NAS"'})

        self.app = app

    def transport(self) -> httpx.AsyncBaseTransport:
        return _FakeTransport(self)


def _port(url: httpx.URL) -> int:
    return url.port or {"https": 443, "http": 80}[url.scheme]


class _FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, reader) -> None:
        self.reader = reader
        self.inner = httpx.ASGITransport(app=reader.app)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.reader.mode == "unreachable" or _port(request.url) not in self.reader.ports:
            raise httpx.ConnectError("All connection attempts failed", request=request)
        return await self.inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self.inner.aclose()


class RoutingTransport(httpx.AsyncBaseTransport):
    """Several fakes on one transport, chosen by the request's host; an IP
    with no fake behaves like a dead host."""

    def __init__(self, hosts: dict) -> None:
        self.hosts = {ip: fake.transport() for ip, fake in hosts.items()}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        inner = self.hosts.get(request.url.host)
        if inner is None:
            raise httpx.ConnectError("All connection attempts failed", request=request)
        return await inner.handle_async_request(request)

    def open_ports(self, ip: str) -> tuple[int, ...]:
        inner = self.hosts.get(ip)
        return () if inner is None or inner.reader.mode == "unreachable" else inner.reader.ports
