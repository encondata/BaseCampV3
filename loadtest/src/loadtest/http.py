"""The one way the tool makes an HTTP call: timed, retried, counted."""

from __future__ import annotations

import time
from collections.abc import Callable

import httpx

from .clock import Clock
from .metrics import Metrics
from .profile import RetrySpec


class TokenExpired(Exception):
    """The server answered 401: the caller must refresh or sign in again."""


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
    token_call: bool = True,
    **request_kwargs,
) -> httpx.Response:
    """`token_call=False` is for a call that is itself a sign-in: a 401 there means the
    credentials were refused, so it is a final failure carrying the server's code
    instead of a `TokenExpired` for the caller to renew."""
    attempts = max(1, retry.attempts)
    for attempt in range(attempts):
        retries = attempt
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
                raise TokenExpired(name)
            if not _retryable(status):
                if status < 300:
                    metrics.record(name, ms, True, retries)
                    return response
                if status < 400:
                    # httpx does not follow redirects: treating one as success would hide a
                    # wrong address behind calls that do nothing.
                    metrics.record(name, ms, False, retries)
                    raise CallFailed(name, status, "redirected", retries)
                if retries > 0 and already_done is not None and already_done(response):
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
