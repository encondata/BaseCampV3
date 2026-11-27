"""The one way the tool makes an HTTP call: timed, retried, counted."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

import httpx

from .clock import Clock
from .metrics import Metrics
from .profile import RetrySpec


class TokenExpired(Exception):
    """The server answered 401: the caller must refresh or sign in again.

    `attempts` is how many requests the call sent, the 401 included; every one before
    the 401 was a retryable failure whose work may have landed."""

    def __init__(self, call: str, attempts: int = 1) -> None:
        super().__init__(call, attempts)
        self.call = call
        self.attempts = attempts


class CallFailed(Exception):
    def __init__(self, call: str, status: int | None, code: str | None, retries: int) -> None:
        super().__init__(call, status, code, retries)
        self.call = call
        self.status = status
        self.code = code
        self.retries = retries

    def __str__(self) -> str:
        return f"{self.call} failed (status={self.status}, code={self.code}, retries={self.retries})"


def error_code(response: httpx.Response) -> str | None:
    """The server's error code: its `_err` helper raises HTTPException(detail={"code": ...}),
    which FastAPI sends as {"detail": {"code": ...}}. Anything else gives None."""
    try:
        body = response.json()
    except ValueError:
        return None
    detail = body.get("detail") if isinstance(body, dict) else None
    code = detail.get("code") if isinstance(detail, dict) else None
    return code if isinstance(code, str) else None


def sendable_cookie(client: httpx.AsyncClient, name: str) -> bool:
    """True when the client's jar holds cookie `name` and will send it: a Secure
    cookie is kept but never sent over a plain http:// address."""
    https = client.base_url.scheme == "https"
    return any(c.name == name and (https or not c.secure) for c in client.cookies.jar)


def _retryable(status: int) -> bool:
    return status >= 500 or status == 423


async def timed_call(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    name: str,
    metrics: Metrics,
    clock: Clock,
    retry: RetrySpec,
    already_done: Callable[[httpx.Response], bool] | None = None,
    already_done_first: bool = False,
    token_call: bool = True,
    prior_attempts: int = 0,
    **request_kwargs,
) -> httpx.Response:
    """`token_call=False` is for a call that is itself a sign-in: a 401 there means the
    credentials were refused, so it is a final failure carrying the server's code
    instead of a `TokenExpired` for the caller to renew.

    `already_done` names an answer that says the work is already done. It counts as
    success on a retry (an earlier try landed and only its answer was lost), and on the
    first try too when `already_done_first` is set: a continued run resending a step
    that may have landed before the interruption.

    `prior_attempts` is for a redo after a 401: the requests of the first try that may
    have landed (its attempts before the 401). They count toward the recorded
    retries, and `already_done` applies from the redo's first answer."""
    attempts = max(1, retry.attempts)
    for attempt in range(attempts):
        retries = attempt + prior_attempts
        started = time.perf_counter()
        response: httpx.Response | None = None
        try:
            response = await client.request(method, url, **request_kwargs)
        except httpx.TransportError:
            pass  # retryable; the exception text may name the request, so it is dropped
        ms = (time.perf_counter() - started) * 1000

        if response is not None:
            status = response.status_code
            if status == 401 and token_call:
                raise TokenExpired(name, attempt + 1)
            if not _retryable(status):
                if status < 300:
                    metrics.record(name, ms, True, retries)
                    return response
                if status < 400:
                    # httpx does not follow redirects: treating one as success would hide a
                    # wrong address behind calls that do nothing.
                    metrics.record(name, ms, False, retries)
                    raise CallFailed(name, status, "redirected", retries)
                if ((retries > 0 or already_done_first) and already_done is not None
                        and already_done(response)):
                    metrics.record(name, ms, True, retries)
                    return response
                metrics.record(name, ms, False, retries)
                raise CallFailed(name, status, error_code(response), retries)

        if attempt == attempts - 1:
            metrics.record(name, ms, False, retries)
            status = response.status_code if response is not None else None
            code = error_code(response) if response is not None else None
            raise CallFailed(name, status, code, retries) from None
        backoff = retry.backoff_seconds
        if backoff:
            await clock.sleep(backoff[min(attempt, len(backoff) - 1)])
    raise AssertionError("unreachable")


async def renewing_call(
    name: str,
    *,
    metrics: Metrics,
    ensure_token: Callable[[], Awaitable[None]],
    current_token: Callable[[], str | None],
    renew_after_401: Callable[[str | None], Awaitable[None]],
    send: Callable[[int], Awaitable[tuple[httpx.Response, int]]],
) -> tuple[httpx.Response, int]:
    """A call under a sign-in: renew first when due; on a 401 renew once and redo the
    call once. Every logical call is recorded exactly once, even when a sign-in step
    is what failed (with no latency sample: nothing was timed).

    `send(prior_attempts)` makes one timed try and returns (response, requests sent);
    on CallFailed or TokenExpired it puts the requests sent on the exception as
    `attempts`. Requests before a 401 were retryable failures whose work may have
    landed, so they ride on to the redo (`prior_attempts`), its count, and any
    CallFailed raised here (`attempts`)."""
    try:
        await ensure_token()
    except CallFailed as exc:
        metrics.record(name, None, False)
        raise CallFailed(name, exc.status, exc.code, 0) from None
    used = current_token()
    try:
        return await send(0)
    except TokenExpired as exc:
        landed = exc.attempts - 1
    try:
        await renew_after_401(used)
    except CallFailed as exc:
        metrics.record(name, None, False, landed)
        failed = CallFailed(name, exc.status, exc.code, landed)
        failed.attempts = landed
        raise failed from None
    try:
        response, sent = await send(landed)
    except CallFailed as exc:
        exc.attempts = getattr(exc, "attempts", 0) + landed
        raise
    except TokenExpired as exc:
        landed += exc.attempts - 1
        metrics.record(name, None, False, landed)
        failed = CallFailed(name, 401, None, landed)
        failed.attempts = landed
        raise failed from None
    return response, sent + landed
