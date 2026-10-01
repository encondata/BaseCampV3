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
"""

import base64
import copy
import secrets

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse

PASSWORDS = ("Cumulus$G0", "Cumulu$SG.", "33q44w40x5", "change")

NOT_FOUND_HTML = (
    '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n'
    "<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n"
    "<p>The requested URL was not found on this server.</p>\n</body></html>")

TOO_MANY_ENDPOINTS = ("Invalid endpoint configuration - more than 2 endpoints "
                      "cannot be mapped to data interfaces")
EMPTY_PAYLOAD = "Invalid Payload expected atleast one configuration field"

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
                "management": {},
                "control": {},
            },
        },
    }


class FakeReader:
    def __init__(self, *, password_index: int = 3, mode: str = "normal",
                 model: str = "FX9600", serial: str = "84248dee5721",
                 login_style: str = "json_message", password: str | None = None) -> None:
        self.password_index = password_index
        # a password that isn't on our list (a reader we can't sign in to)
        self.password = password
        self.mode = mode
        self.login_style = login_style  # json_message | json_token | text
        self.version = {**VERSION, "model": model, "serialNumber": serial}
        self.status = copy.deepcopy(STATUS)
        self.config = default_config()
        self.login_attempts: list[int | None] = []  # index of each password tried
        self.puts: list[dict] = []
        self.tokens: set[str] = set()
        # path -> (status, body); the next request to it answers this, once
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
        async def gate(request: Request, call_next):
            if reader.mode == "not_iotc":
                return HTMLResponse(NOT_FOUND_HTML, status_code=404)
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
                if len(connections) > 2:
                    return JSONResponse({"code": 1, "message": TOO_MANY_ENDPOINTS},
                                        status_code=422)
            if reader.mode != "verify_mismatch":
                reader.config = {**reader.config, **copy.deepcopy(payload)}
            return HTMLResponse("Command Successful")

        @app.api_route("/{rest:path}", methods=["GET", "PUT", "POST", "DELETE"])
        async def other(rest: str):
            return JSONResponse({"code": 7, "message": f"/{rest} is not a valid URI"},
                                status_code=404)

        return app


class _FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, reader: FakeReader) -> None:
        self.reader = reader
        self.inner = httpx.ASGITransport(app=reader.app)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.reader.mode == "unreachable":
            raise httpx.ConnectError("All connection attempts failed", request=request)
        return await self.inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self.inner.aclose()
