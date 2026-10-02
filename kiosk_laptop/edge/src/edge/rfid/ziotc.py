"""The edge's client for Zebra FX readers in IoT Connector (Local REST) mode.

A reader answers on 443 (HTTPS, self-signed, verify off) and/or 80 (plain
HTTP); the client takes the scheme and port to use.

Sign-in is `GET <scheme>://<ip>/cloud/localRestLogin` with basic auth
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

import json
import logging
import re
from collections.abc import Sequence

import httpx

log = logging.getLogger("edge.rfid.ziotc")

USERNAME = "admin"
PASSWORDS: tuple[str, ...] = ("Cumulu$SG0", "Cumulus$G0", "Cumulu$SG.", "33q44w40x5", "change")
TIMEOUT = httpx.Timeout(10.0, connect=3.0)
LOGIN_PATH = "/cloud/localRestLogin"
TOKEN_PREFIX = "JWT Token:"
VERSION_PATH = "/cloud/version"
SCHEME_PORTS = {"https": 443, "http": 80}
# where a manually entered reader is tried, in order
DEFAULT_ENDPOINTS: tuple[tuple[str, int], ...] = (("https", 443), ("http", 80))


def is_reading(status: dict) -> bool:
    """Whether a /cloud/status answer says the radio is reading. The real FX9600
    spells the field `radioActivity`; Zebra's OpenAPI example misspells it
    `radioActivitiy`, so either one counts."""
    return "active" in (status.get("radioActivity"), status.get("radioActivitiy"))


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


def base_url(ip: str, scheme: str = "https", port: int | None = None) -> str:
    if scheme not in SCHEME_PORTS:
        raise ValueError(f"unsupported scheme {scheme!r}")
    if port is None or port == SCHEME_PORTS[scheme]:
        return f"{scheme}://{ip}"
    return f"{scheme}://{ip}:{port}"


# ── fingerprint: is this a Zebra reader? (no credentials sent) ──

# Text a Zebra reader is known or expected to put in its WWW-Authenticate
# realm or Server header. Word boundaries keep "fx" inside another word
# ("firefox") and "ZebraNet" (Zebra's label-printer servers) from counting.
HEADER_TEXT = re.compile(r"\bzebra\b|\bfx\d{0,4}\b|\biot\s*connector\b", re.IGNORECASE)
# Body text alone proves nothing (a Zebra label printer's page says "Zebra
# Technologies"); it counts only alongside a /cloud/*-specific answer.
BODY_TEXT = re.compile(r"\bzebra\b|\biot\s*connector\b", re.IGNORECASE)
_BODY_SNIFF = 4096  # characters of a body the text signal looks at


def _header_names_zebra(resp: httpx.Response | None) -> bool:
    if resp is None:
        return False
    return any(HEADER_TEXT.search(resp.headers.get(name, ""))
               for name in ("www-authenticate", "server"))


def _body_names_zebra(resp: httpx.Response | None) -> bool:
    return resp is not None and bool(BODY_TEXT.search(resp.text[:_BODY_SNIFF]))


def _ziotc_error_shape(resp: httpx.Response | None) -> bool:
    """ZIOTC's error body: `{"code": <int>, "message": <str>}` on a refusal."""
    if resp is None or resp.is_success:
        return False
    try:
        body = json.loads(resp.text)
    except ValueError:
        return False
    return (isinstance(body, dict) and isinstance(body.get("code"), int)
            and not isinstance(body.get("code"), bool) and isinstance(body.get("message"), str))


def _signal_names_zebra(login, version) -> bool:
    """(a) the WWW-Authenticate realm or Server header names Zebra, FX or IoT
    Connector; or a body mentions Zebra or IoT Connector AND /cloud/version
    answered in ZIOTC's own JSON error shape."""
    if _header_names_zebra(login) or _header_names_zebra(version):
        return True
    return (_body_names_zebra(login) or _body_names_zebra(version)) and _ziotc_error_shape(version)


def _signal_ziotc_refusal(login, version) -> bool:
    """(b) sign-in refused with 401 AND /cloud/version refused in ZIOTC's
    JSON error shape. A bare 401 on both isn't enough: any basic-auth box
    (a NAS, a printer) answers 401 on every path."""
    return login is not None and login.status_code == 401 and _ziotc_error_shape(version)


# Captured from a real FX9600 (ZIOTC, firmware at 10.10.48.119, 2026-10-02):
# an unauthenticated GET of /cloud/localRestLogin or /cloud/version answers
# HTTP 500, "Server: Apache", body {"code":-1, "message":"Authorization header
# missing!"} — no 401 and no WWW-Authenticate. Port 80 doesn't answer.
_MISSING_AUTH = re.compile(r"authorization header missing", re.IGNORECASE)


def _signal_fx_missing_auth(login, version) -> bool:
    """(c) the real FX9600 refusal: both paths answer in ZIOTC's JSON error
    shape and say the Authorization header is missing."""
    return all(resp is not None and _ziotc_error_shape(resp)
               and bool(_MISSING_AUTH.search(json.loads(resp.text)["message"]))
               for resp in (login, version))


# A device is a Zebra candidate when any signal fires. (a) and (b) come from
# Zebra's ZIOTC OpenAPI and support articles; (c) is a real FX9600 capture.
# Keep Zebra's label printers (ZebraNet, "Zebra Technologies" pages) out.
ZEBRA_SIGNALS = (_signal_names_zebra, _signal_ziotc_refusal, _signal_fx_missing_auth)


def looks_like_ziotc(login: httpx.Response | None, version: httpx.Response | None) -> bool:
    """Whether unauthenticated answers from `/cloud/localRestLogin` and
    `/cloud/version` look like a Zebra FX reader (None: no answer)."""
    return any(signal(login, version) for signal in ZEBRA_SIGNALS)


async def fingerprint(ip: str, *, scheme: str = "https", port: int | None = None,
                      transport=None, timeout: httpx.Timeout = TIMEOUT) -> bool:
    """Unauthenticated GETs of the sign-in and version paths, then the
    matcher. No credentials are ever sent here; any failure is False."""
    async with httpx.AsyncClient(base_url=base_url(ip, scheme, port), verify=False,
                                 timeout=timeout, transport=transport) as http:
        answers: list[httpx.Response | None] = []
        for path in (LOGIN_PATH, VERSION_PATH):
            try:
                answers.append(await http.get(path))
            except httpx.HTTPError:
                answers.append(None)
    if answers == [None, None]:
        return False
    return looks_like_ziotc(*answers)


class ZiotcClient:
    """`passwords`, when given, is the only password indexes tried (in that
    order); otherwise all of them, starting with `password_first`."""

    def __init__(self, ip: str, *, scheme: str = "https", port: int | None = None,
                 transport=None, password_first: int | None = None,
                 passwords: Sequence[int] | None = None,
                 timeout: httpx.Timeout = TIMEOUT) -> None:
        self.ip = ip
        self.scheme = scheme
        self.port = port if port is not None else SCHEME_PORTS.get(scheme)
        self.password_first = password_first
        self.passwords = list(passwords) if passwords is not None else None
        self.password_index: int | None = None
        self._token: str | None = None
        self._http = httpx.AsyncClient(base_url=base_url(ip, scheme, port), verify=False,
                                       timeout=timeout, transport=transport)

    def __repr__(self) -> str:
        return (f"ZiotcClient(ip={self.ip!r}, scheme={self.scheme!r}, port={self.port!r}, "
                f"password_index={self.password_index!r})")

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
        if self.passwords is not None:
            order = [i for i in self.passwords if 0 <= i < len(PASSWORDS)]
            if self.password_index is not None and self.password_index in order:
                order.remove(self.password_index)
                order.insert(0, self.password_index)
        else:
            order = _password_order(first)
        for index in order:
            resp = await self._send("GET", LOGIN_PATH,
                                    auth=httpx.BasicAuth(USERNAME, PASSWORDS[index]))
            # A real FX9600 refuses a missing Authorization header with a JSON
            # 500 rather than 401, so a JSON-shaped 500 on sign-in is treated
            # as "this password didn't work" too (a wrong password's exact
            # answer is still unconfirmed on hardware).
            if resp.status_code in (401, 403) or (
                    resp.status_code == 500 and _ziotc_error_shape(resp)):
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

    async def stop(self) -> None:
        """Stop reading tags (`PUT /cloud/stop`, empty body). A reader that is
        reading can refuse an endpoint change, so pairing stops it first."""
        await self._call("PUT", "/cloud/stop")


    async def start(self, persist: bool = True) -> None:
        """Start reading tags (`PUT /cloud/start`)."""
        await self._call("PUT", "/cloud/start", json={"doNotPersistState": not persist})


async def probe(ip: str, transport=None, password_first: int | None = None, *,
                scheme: str = "https", port: int | None = None,
                passwords: Sequence[int] | None = None,
                quiet: bool = False, with_config: bool = False,
                timeout: httpx.Timeout = TIMEOUT) -> dict | None:
    """Sign in and read version + status. None when the host isn't an FX
    reader (no IoT Connector API, or a model not starting with FX). Auth,
    unreachable and reader errors raise ReaderError — unless `quiet`,
    where every failure is just None."""
    async with ZiotcClient(ip, scheme=scheme, port=port, transport=transport,
                           password_first=password_first, passwords=passwords,
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
            "scheme": client.scheme,
            "port": client.port,
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


async def discover(ip: str, *, scheme: str = "https", port: int | None = None,
                   password_index: int | None, transport=None,
                   timeout: httpx.Timeout = TIMEOUT) -> dict | None:
    """What a scan learns about one responding host (spec §2.2, D1).

    - Not a Zebra candidate by the unauthenticated fingerprint: None, and no
      credentials were sent.
    - A candidate with no remembered password index: a `needs_connect` card
      (model and serial unknown); still no credentials sent.
    - With a remembered index: sign in with that one password only. It
      failing (or anything else going wrong) is a `needs_connect` card; a
      host that turns out not to be an FX is None.
    The full password list is only ever tried by an explicit Connect."""
    if not await fingerprint(ip, scheme=scheme, port=port, transport=transport,
                             timeout=timeout):
        return None
    card = {"ip": ip, "scheme": scheme, "port": port if port is not None else SCHEME_PORTS[scheme],
            "model": None, "serial": None, "needs_connect": True}
    if password_index is None or not 0 <= password_index < len(PASSWORDS):
        return card
    try:
        found = await probe(ip, transport, scheme=scheme, port=port, passwords=[password_index],
                            with_config=True, timeout=timeout)
    except ReaderError as exc:
        log.debug("reader %s: remembered password didn't open it (%s)", ip, exc.code)
        return card
    if found is None:
        return None
    return {**found, "needs_connect": False}
