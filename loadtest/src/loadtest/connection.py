"""The page's portal sign-in, and the runner's error vocabulary.

`Connection` holds the one portal sign-in (and its password) between connect and the
end of a run. `RunnerError` messages are safe to show on the page; `log` writes one
line to stderr and never an exception's text, which could quote a request.
"""

from __future__ import annotations

import sys
import traceback
from urllib.parse import urlsplit

import httpx

from .client.kiosk import NO_RETRY, KioskDevice
from .client.portal import MoveInfo, PortalClient, TotpEnrollRequired
from .clock import Clock
from .fleet import FleetError
from .http import CallFailed
from .metrics import Metrics
from .preflight import CHECK_NAME, CHECK_SERIAL, SIGN_IN_FAILURES
from .profile import Profile, RetrySpec

CONNECT_RETRY = RetrySpec(attempts=3, backoff_seconds=(1.0, 2.0))
CONNECT_TIMEOUT = 30.0
BAD_ANSWER = (ValueError, KeyError, TypeError)

MESSAGES = {
    "bad_phase": "That cannot be done right now.",
    "bad_server": "Enter the server's address, like https://api.example.com",
    "redirected": "The server address redirects. Use the address it redirects to (usually https).",
    "unreachable": "The server could not be reached. Check the address and that the server is "
                   "running.",
    "bad_answer": "The server sent an answer this tool does not understand. Check the server "
                  "address.",
    "password_refused": "The email or password was not accepted.",
    "code_refused": "The 2FA code was not accepted.",
    "totp_enroll": "This account still has to set up 2FA. Finish that in the portal, then "
                   "connect again.",
    "not_ready": "Run the readiness check first; Start needs every line to pass.",
    "no_unfinished_run": "There is no unfinished run to continue.",
    "bad_journal": "The unfinished run's journal could not be read, so it cannot be continued.",
    "cannot_write": "The run folder could not be written. Check that the disk has room and the "
                    "runs folder can be written.",
    "move_unreadable": "The run's move could not be read from the server.",
}


class RunnerError(Exception):
    """`message` is safe to show on the page."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        self.message = message if message is not None else MESSAGES[code]
        super().__init__(code, self.message)


def normalize_server(server: str) -> str:
    text = (server or "").strip().rstrip("/")
    parts = urlsplit(text)
    try:
        parts.port
    except ValueError:
        raise RunnerError("bad_server") from None
    if (parts.scheme not in ("http", "https") or not parts.hostname
            or parts.username is not None or parts.password is not None
            or "?" in text or "#" in text):
        raise RunnerError("bad_server")
    return text


def sign_in_error(exc: Exception, refused: str) -> RunnerError:
    """A failed portal sign-in step; `refused` names the message for a refused one."""
    if isinstance(exc, TotpEnrollRequired):
        return RunnerError("totp_enroll")
    if isinstance(exc, CallFailed):
        if exc.code == "redirected":
            return RunnerError("redirected")
        if exc.status is None:
            return RunnerError("unreachable")
        if 400 <= exc.status < 500 and exc.status != 429:
            return RunnerError("sign_in_failed", MESSAGES[refused])
        return RunnerError("sign_in_failed",
                           f"The server refused the sign-in (HTTP {exc.status}).")
    return RunnerError("bad_answer")


def _leaf(exc: BaseException) -> BaseException:
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return exc


def safe_error(exc: BaseException) -> str:
    leaf = _leaf(exc)
    if isinstance(leaf, FleetError):
        return str(leaf)
    return f"The run stopped because of an unexpected problem: {type(leaf).__name__}."


def log(what: str, exc: BaseException | None = None) -> None:
    """One line on stderr: never the exception text, which could quote a request."""
    where = ""
    if exc is not None:
        leaf = _leaf(exc)
        frames = traceback.extract_tb(leaf.__traceback__)
        where = f" ({type(leaf).__name__} at {frames[-1].filename}:{frames[-1].lineno})" \
            if frames else f" ({type(leaf).__name__})"
    print(f"loadtest: {what}{where}", file=sys.stderr)


class Connection:
    def __init__(self, *, clock: Clock, transport: httpx.AsyncBaseTransport | None = None):
        self.clock = clock
        self._transport = transport
        self.portal: PortalClient | None = None
        self.server: str | None = None
        self.email: str | None = None
        self.password: str | None = None
        self.used_totp = False
        self.needs_totp = False

    @property
    def connected(self) -> bool:
        return self.portal is not None

    async def sign_in(self, url: str, email: str, password: str,
                      totp_code: str | None) -> bool:
        """Signs the portal in and keeps it; False when the server asks for a 2FA code."""
        portal = PortalClient(base_url=url, metrics=Metrics(), clock=self.clock,
                              retry=CONNECT_RETRY, timeout=CONNECT_TIMEOUT,
                              transport=self._transport)
        used_totp = False
        try:
            try:
                outcome = await portal.login(email, password)
            except Exception as exc:
                raise sign_in_error(exc, "password_refused") from None
            if outcome == "totp_required":
                code = (totp_code or "").strip()
                if not code:
                    await portal.close()
                    self.needs_totp = True
                    return False
                try:
                    await portal.verify_totp(code)
                except Exception as exc:
                    raise sign_in_error(exc, "code_refused") from None
                used_totp = True
        except BaseException:
            await portal.close()
            raise
        self.portal, self.server, self.email, self.password = portal, url, email, password
        self.used_totp, self.needs_totp = used_totp, False
        return True

    async def forget(self) -> None:
        """Closes the portal and drops everything the sign-in kept."""
        portal, self.portal = self.portal, None
        self.server = self.email = self.password = None
        self.used_totp = self.needs_totp = False
        if portal is not None:
            await portal.close()

    async def read_move(self, move_id: str) -> MoveInfo:
        try:
            return await self.portal.move(move_id)
        except CallFailed as exc:
            if exc.code == "redirected":
                raise RunnerError("redirected") from None
            if exc.status is None:
                raise RunnerError("unreachable") from None
            raise RunnerError("move_unreadable",
                              f"{MESSAGES['move_unreadable'][:-1]} (HTTP {exc.status}).") from None
        except BAD_ANSWER:
            raise RunnerError("bad_answer") from None

    async def verify_move_password(self, url: str, move_password: str,
                                   profile: Profile) -> None:
        """One kiosk sign-in, the way every device of the fleet signs in."""
        device = KioskDevice(base_url=url, serial=CHECK_SERIAL, name=CHECK_NAME,
                             kind="handheld", metrics=Metrics(), clock=self.clock,
                             retry=NO_RETRY, timeout=profile.request_timeout_seconds,
                             transport=self._transport)
        try:
            await device.sign_in(move_password)
        except CallFailed as exc:
            if exc.status is None and exc.code is None:
                raise RunnerError("unreachable") from None
            raise RunnerError("move_password", SIGN_IN_FAILURES.get(exc.code or "") or (
                f"The kiosk sign-in failed (HTTP {exc.status}).")) from None
        except BAD_ANSWER:
            raise RunnerError("bad_answer") from None
        finally:
            await device.close()
