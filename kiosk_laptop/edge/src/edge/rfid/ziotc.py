"""The edge's client for Zebra FX readers in IoT Connector (Local REST) mode.

Sign-in is `GET https://<ip>/cloud/localRestLogin` with basic auth
`admin:<password>`; the reader answers with a token (Zebra support article
000022894: `{"message": "JWT Token: <token>"}`), sent afterwards as
`Authorization: Bearer <token>`. The passwords are tried in a fixed order,
starting with the one that worked last time for this reader (the caller
remembers its index per serial). A 401/403 tries the next password; any
other failure stops the attempt.

Failures map to stable codes on ReaderError:
- reader_unreachable: transport error or timeout
- reader_auth_failed: no password worked
- reader_not_iotc: a 404 on /cloud/* (no IoT Connector API)
- reader_error: any other answer (422, 500, ...), carrying the reader's message

Passwords never appear in an exception, a log line or a repr: errors carry
only fixed text and the reader's own message, and httpx exceptions are not
chained (their request carries the basic-auth header)."""

import logging

import httpx

log = logging.getLogger("edge.rfid.ziotc")

USERNAME = "admin"
PASSWORDS: tuple[str, ...] = ("Cumulus$G0", "Cumulu$SG.", "33q44w40x5", "change")
TIMEOUT = httpx.Timeout(10.0, connect=3.0)
LOGIN_PATH = "/cloud/localRestLogin"
TOKEN_PREFIX = "JWT Token:"


class ReaderError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _password_order(first: int | None) -> list[int]:
    order = list(range(len(PASSWORDS)))
    if first is not None and 0 <= first < len(PASSWORDS):
        order.remove(first)
        order.insert(0, first)
    return order


def _reader_message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and isinstance(body.get("message"), str) and body["message"]:
        return body["message"]
    return f"The reader answered {resp.status_code}."


def _token_from(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        raw = body.get("message") or body.get("token") or ""
    elif isinstance(body, str):
        raw = body
    else:
        raw = resp.text
    token = str(raw).strip()
    if token.startswith(TOKEN_PREFIX):
        token = token[len(TOKEN_PREFIX):].strip()
    return token


class ZiotcClient:
    def __init__(self, ip: str, *, transport=None, password_first: int | None = None,
                 timeout: httpx.Timeout = TIMEOUT) -> None:
        self.ip = ip
        self.password_first = password_first
        self.password_index: int | None = None
        self._token: str | None = None
        self._http = httpx.AsyncClient(base_url=f"https://{ip}", verify=False,
                                       timeout=timeout, transport=transport)

    def __repr__(self) -> str:
        return f"ZiotcClient(ip={self.ip!r}, password_index={self.password_index!r})"

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "ZiotcClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def _send(self, method: str, path: str, **kw) -> httpx.Response:
        try:
            return await self._http.request(method, path, **kw)
        except httpx.TransportError:
            # not chained: the request on the httpx error carries the auth header
            raise ReaderError("reader_unreachable", f"Can't reach {self.ip}.") from None

    def _check(self, resp: httpx.Response) -> None:
        if resp.status_code == 404:
            raise ReaderError("reader_not_iotc",
                              "This reader isn't in IoT Connector (Local REST) mode.")
        if not resp.is_success:
            raise ReaderError("reader_error", _reader_message(resp))

    async def login(self) -> int:
        first = self.password_index if self.password_index is not None else self.password_first
        for index in _password_order(first):
            resp = await self._send("GET", LOGIN_PATH,
                                    auth=httpx.BasicAuth(USERNAME, PASSWORDS[index]))
            if resp.status_code in (401, 403):
                log.debug("reader %s refused password #%d", self.ip, index)
                continue
            self._check(resp)
            token = _token_from(resp)
            if not token:
                raise ReaderError("reader_error", "The reader's sign-in returned no token.")
            self._token = token
            self.password_index = index
            return index
        raise ReaderError("reader_auth_failed", "Couldn't sign in to this reader.")

    async def _call(self, method: str, path: str, **kw) -> httpx.Response:
        if self._token is None:
            await self.login()
        resp = await self._send(method, path, headers=self._bearer(), **kw)
        if resp.status_code == 401:  # token expired: sign in again, once
            await self.login()
            resp = await self._send(method, path, headers=self._bearer(), **kw)
            if resp.status_code in (401, 403):
                raise ReaderError("reader_auth_failed", "Couldn't sign in to this reader.")
        self._check(resp)
        return resp

    def _bearer(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    async def _json(self, path: str) -> dict:
        resp = await self._call("GET", path)
        try:
            body = resp.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise ReaderError("reader_error", f"The reader's {path} answer wasn't JSON.")
        return body

    async def version(self) -> dict:
        return await self._json("/cloud/version")

    async def status(self) -> dict:
        return await self._json("/cloud/status")

    async def get_config(self) -> dict:
        return await self._json("/cloud/config")

    async def put_config(self, payload: dict) -> None:
        await self._call("PUT", "/cloud/config", json=payload)


async def probe(ip: str, transport=None, password_first: int | None = None, *,
                quiet: bool = False, with_config: bool = False,
                timeout: httpx.Timeout = TIMEOUT) -> dict | None:
    """Sign in and read version + status. None when the host isn't an FX
    reader (no IoT Connector API, or a model not starting with FX). Auth,
    unreachable and reader errors raise ReaderError — unless `quiet`
    (discovery), where every failure is just None."""
    async with ZiotcClient(ip, transport=transport, password_first=password_first,
                           timeout=timeout) as client:
        try:
            version = await client.version()
            model = str(version.get("model") or "")
            if not model.startswith("FX"):
                return None
            status = await client.status()
            config = await client.get_config() if with_config else None
        except ReaderError as exc:
            if quiet or exc.code == "reader_not_iotc":
                return None
            raise
        found = {
            "ip": ip,
            "model": model,
            "serial": version.get("serialNumber"),
            "versions": {key: version.get(key) for key in
                         ("readerApplication", "radioFirmware", "cloudAgentApplication")},
            "status": status,
            "password_index": client.password_index,
        }
        if with_config:
            found["config"] = config
        return found
